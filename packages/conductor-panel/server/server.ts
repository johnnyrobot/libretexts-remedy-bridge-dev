/**
 * Minimal Node API server for the Conductor panel.
 *
 * Exposes /api/scan, /api/preview, /api/apply — thin wrappers around
 * @libretexts/remedy-core. Only runs locally for staff use; do not
 * expose to the public internet without auth.
 */
import { createPatch } from 'diff';
import { requireLoopbackHost } from './loopback.js';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import {
  reviseAltText,
  reviewableImages,
  describeComplexImage,
  listPageSnapshots,
  revertPage,
  createExpertClient,
  resolvePageRef,
  scanPage,
  scanRenderedPage,
  mergeRenderedFindings,
  fetchPageHtml,
  fixPage,
  runPipeline,
  canonicalizeHtml,
  runLocalPipeline,
  hashContent,
  writePageRevision,
  WriteOutcomeError,
  conductorScanKeys,
  buildConductorCriteria,
  toConductorFindings,
  buildWcagReview,
  CXONE_ALLOWED_HOST,
  CXONE_ALLOWED_ROOT,
  isCxoneIntegrationEnabled,
  validateCxoneConfiguration,
  type PageRef,
  type PipelineResult,
  type DojException,
  type WcagReview,
} from '@libretexts/remedy-core';

// Repo root = three dirs up from packages/conductor-panel/server/server.ts.
// Resolve from this file's URL so the server works regardless of cwd.
const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

loadDotenv({ path: resolve(REPO_ROOT, '.env') });

const PORT = Number(process.env.CONDUCTOR_API_PORT ?? 5175);
// This unauthenticated staff tool must remain on loopback (ADR-0001).
const HOST = requireLoopbackHost(process.env.CONDUCTOR_API_HOST ?? '127.0.0.1');
const MAX_REQUEST_BYTES = Number(process.env.REMEDY_MAX_REQUEST_BYTES ?? 5_000_000);
const FIXTURE_ROOT = resolve(REPO_ROOT, 'fixtures/local-lab');
const STATIC_ROOT = resolve(HERE, '../dist');
const PIPELINE_PREVIEW_TTL_MS = Number(process.env.REMEDY_PIPELINE_PREVIEW_TTL_MS ?? 30 * 60 * 1000);

type FixEngineMode = 'deterministic' | 'pipeline';

interface PipelinePreviewSession {
  token: string;
  expiresAt: number;
  pageId: number;
  pagePath: string;
  hostname: string;
  tier: 1 | 2 | 3;
  beforeHash: string;
  beforeHtml: string;
  afterHtml: string;
  diff: string;
  finalFindingsCount: number;
  appliedRuleIds: string[];
}

const restoreSessions = new Map<string, { pageId: number; pagePath: string; hostname: string; snapshotTs: string; hash: string; afterHash: string; expiresAt: number }>();

const pipelinePreviewSessions = new Map<string, PipelinePreviewSession>();
const targetedPreviewSessions = new Map<string, {
  token: string;
  expiresAt: number;
  pageId: number;
  pagePath: string;
  hostname: string;
  beforeHash: string;
  beforeHtml: string;
  afterHtml: string;
  diff: string;
  attemptedRuleIds: string[];
  appliedRuleIds: string[];
  attemptedFindingIds?: string[];
  appliedFindingIds?: string[];
  fixErrors?: unknown[];
  llmCalls?: number;
  bytePreserved?: boolean;
  fallbackReason?: string;
  splicesApplied?: number;
  editableImages?: Array<{ src: string; findingId: string }>;
}>();

type Handler = (body: Record<string, unknown>) => Promise<unknown>;

const routes: Record<string, Handler> = {
  '/healthz': async () => {
    const enabled = isCxoneIntegrationEnabled(process.env);
    const config = enabled ? validateCxoneConfiguration(process.env) : { valid: true };
    return {
      ok: enabled ? config.valid : true,
      state: enabled ? (config.valid ? 'ready' : 'misconfigured') : 'disabled',
      enabled,
      write_scope: { host: CXONE_ALLOWED_HOST, root: CXONE_ALLOWED_ROOT },
      ...(enabled && !config.valid ? { error: 'cxone_configuration_invalid' } : {}),
    };
  },
  '/v1/cxone/page/scan': async (body) => {
    const page = requirePageInput(body);
    const result = await scanPage(page);
    const sourceHash = hashContent(result.html);
    const previous = optionalWcagReview(body.wcag_review ?? body.wcagReview) as any;
    const rendered = body.rendered === true
      ? { ...await scanRenderedPage(`https://${result.page.hostname}/${result.page.path.replace(/^\//, '')}`), sourceHash }
      : (previous?.sourceHash === sourceHash ? previous.rendered : undefined);
    if (body.rendered === true && rendered && hashContent(await fetchPageHtml(createExpertClient(), page)) !== sourceHash) {
      Object.assign(rendered, {state:'error',error:'Page content changed during the browser scan. Rescan before reviewing.'});
    }
    const merged = rendered ? mergeRenderedFindings(result.findings, rendered) : { findings: result.findings, resolvedSourceChecks: [] };
    const findings = toConductorFindings(merged.findings);
    const dojExceptions = optionalDojExceptions(body.doj_exceptions ?? body.dojExceptions);
    const wcagReview = buildWcagReview({
      html: result.html,
      findings: merged.findings,
      scannedAt: result.scannedAt,
      page: result.page,
      previousReview: optionalWcagReview(body.wcag_review ?? body.wcagReview),
      exceptions: dojExceptions,
    });
    Object.assign(wcagReview, { sourceHash, rendered, resolvedSourceChecks: merged.resolvedSourceChecks });
    return {
      page_id: result.page.id,
      page_path: result.page.path,
      page: result.page,
      page_url: optionalStr(body.page_url),
      section_title: optionalStr(body.section_title),
      criteria: buildConductorCriteria(merged.findings),
      evaluated_keys: Array.from(conductorScanKeys),
      wcag_review: wcagReview,
      wcagReview,
      doj_exceptions: dojExceptions,
      dojExceptions,
      findings,
      stats: {total:merged.findings.length,
        byRule:merged.findings.reduce((out:Record<string,number>,f)=>{out[f.ruleId]=(out[f.ruleId] || 0)+1;return out;},{}),
        bySeverity:merged.findings.reduce((out:Record<string,number>,f)=>{out[f.severity]++;return out;},{error:0,warning:0,info:0})},
      scanned_at: result.scannedAt,
    };
  },

  '/v1/cxone/page/snapshots': async body => {
    const entries = await listPageSnapshots(requirePageInput(body));
    return { snapshots: entries.map(s => ({ timestamp: s.meta.ts, hash: s.meta.hash,
      summary: s.meta.revisionSummary, source: s.meta.source, bytes: s.meta.bytes })) };
  },
  '/v1/cxone/page/restore-preview': async body => {
    const snapshotTs = requireStr(body.snapshot_timestamp, 'snapshot_timestamp');
    const result = await revertPage(requirePageInput(body), { snapshotTs, dryRun: true });
    for (const [key, session] of restoreSessions) if (session.expiresAt <= Date.now()) restoreSessions.delete(key);
    const token = randomUUID(), hash = hashContent(result.currentHtml);
    restoreSessions.set(token, { pageId: result.pageId, pagePath: result.pagePath, hostname: result.hostname, snapshotTs: result.snapshotUsed.ts, hash, afterHash: hashContent(result.revertedToHtml), expiresAt: Date.now() + PIPELINE_PREVIEW_TTL_MS });
    return { preview_token: token, preview_hash: hash, snapshot_timestamp: snapshotTs,
      before_html: result.currentHtml, after_html: result.revertedToHtml,
      unchanged: result.currentHtml === result.revertedToHtml };
  },
  '/v1/cxone/page/restore': async body => {
    const token = requireStr(body.preview_token, 'preview_token');
    const session = restoreSessions.get(token);
    if (!session || session.expiresAt <= Date.now()) throw new HttpError(409, { error: 'expired_preview', message: 'Restore preview expired; preview again.' });
    restoreSessions.delete(token);
    const page = requirePageInput(body);
    const pageRef = await resolvePageRef(createExpertClient(), page, process.env);
    if (!matchesPreviewTarget(pageRef, session) || body.preview_hash !== session.hash) throw new HttpError(409, { error: 'stale_preview', message: 'Restore preview does not match this page.' });
    try {
      const result = await revertPage(pageRef.id, { snapshotTs: session.snapshotTs, expectedCurrentHash: session.hash, expectedRestoredHash: session.afterHash, requestedBy: optionalStr(body.requested_by ?? body.requestedBy) });
      return { restored: result.written, write_outcome: result.writeOutcome, audit_recorded: result.auditRecorded, snapshot_timestamp: session.snapshotTs,
        snapshot_path: result.preRevertSnapshotPath, restored_hash: hashContent(result.revertedToHtml) };
    } catch (err) {
      if (err instanceof Error && err.message.includes('Page changed')) throw new HttpError(409, { error: 'stale_preview', message: err.message });
      throw err;
    }
  },

  '/v1/cxone/page/preview-fix': async (body) => {
    const page = requirePageInput(body);
    if (body.describe_image !== undefined) {
      const token = requireStr(body.preview_token, 'preview_token');
      const src = requireStr(body.describe_image, 'describe_image');
      const session = targetedPreviewSessions.get(token);
      if (!session || session.expiresAt <= Date.now()) throw new HttpError(409, {error:'expired_preview', message:'Generate an image review preview first.'});
      const ref = await resolvePageRef(createExpertClient(), page, process.env);
      if (ref.id !== session.pageId || !session.editableImages?.some(i => i.src === src)) throw new HttpError(400, {error:'invalid_image',message:'Image must belong to this page preview.'});
      const suggestion = await describeComplexImage(src, ref.hostname, session.beforeHtml);
      return { suggestion };
    }
    if (body.review_images === true) {
      const expert = createExpertClient();
      const ref = await resolvePageRef(expert, page, process.env);
      const html = await fetchPageHtml(expert, page);
      const images = reviewableImages(html);
      prunePreviewSessions();
      const token = randomUUID(), hash = hashContent(html);
      targetedPreviewSessions.set(token, { token, expiresAt: Date.now() + PIPELINE_PREVIEW_TTL_MS,
        pageId: ref.id, pagePath: ref.path, hostname: ref.hostname, beforeHash: hash,
        beforeHtml: html, afterHtml: html, diff: '', attemptedRuleIds: [], appliedRuleIds: [],
        appliedFindingIds: [], llmCalls: 0, bytePreserved: true,
        editableImages: images.map(i => ({src: i.data.src, findingId: i.id})) });
      return { preview_token: token, preview_hash: hash, before_html: html, after_html: html,
        review_images: images, fix_errors: [], llm_calls: 0 };
    }
    const fixMode = optionalFixMode(body.fix_mode ?? body.fixMode);
    if (fixMode === 'pipeline') {
      prunePipelinePreviewSessions();
      const tier = optionalTier(body.tier) ?? 1;
      const result = await runPipeline(page, {
        tier,
        mode: 'preview',
      });
      const session = cachePipelinePreview(result, tier);
      const token = session.token, previewHash = session.beforeHash;
      return {
        fix_mode: 'pipeline',
        page_wide: true,
        page_id: result.pageId,
        page_path: result.pagePath,
        hostname: result.hostname,
        tier,
        preview_hash: previewHash,
        preview_token: token,
        previewToken: token,
        before_html: result.beforeHtml,
        after_html: result.finalHtml,
        diff: result.diff,
        attempted_rule_ids: result.appliedRuleIds,
        applied_rule_ids: result.appliedRuleIds,
        tiers_run: result.tiersRun,
        final_findings_count: result.finalFindingsCount,
        noise_only_change: canonicalizeHtml(result.beforeHtml) === canonicalizeHtml(result.finalHtml),
      };
    }

    const findingIds = optionalStringArray(body.finding_ids ?? body.findingIds ?? body.findingIDs, 'finding_ids');
    const result = await fixPage(page, {
      mode: 'preview',
      findingIds,
    });
    prunePreviewSessions();
    const token = randomUUID();
    const previewHash = hashContent(result.before);
    targetedPreviewSessions.set(token, {
      token,
      expiresAt: Date.now() + PIPELINE_PREVIEW_TTL_MS,
      pageId: result.page.id,
      pagePath: result.page.path,
      hostname: result.page.hostname,
      beforeHash: previewHash,
      beforeHtml: result.before,
      afterHtml: result.after,
      diff: result.diff,
      attemptedRuleIds: result.attempted,
      appliedRuleIds: result.applied,
      attemptedFindingIds: result.attemptedFindingIds,
      appliedFindingIds: result.appliedFindingIds,
      fixErrors: result.fixErrors,
      llmCalls: result.llmCalls,
      bytePreserved: result.bytePreserved,
      fallbackReason: result.fallbackReason,
      splicesApplied: result.splicesApplied,
      editableImages: toConductorFindings(result.findings).filter(f => findingIds.includes(f.id) && f.ruleId === 'img-alt' && f.data?.src).map(f => ({ src: String(f.data!.src), findingId: f.id })),
    });
    return {
      fix_mode: 'deterministic',
      page_wide: false,
      page_id: result.page.id,
      page_path: result.page.path,
      hostname: result.page.hostname,
      preview_hash: previewHash,
      preview_token: token,
      previewToken: token,
      before_html: result.before,
      after_html: result.after,
      diff: result.diff,
      attempted_rule_ids: result.attempted,
      applied_rule_ids: result.applied,
      attempted_finding_ids: result.attemptedFindingIds,
      applied_finding_ids: result.appliedFindingIds,
      fix_errors: result.fixErrors,
      llm_calls: result.llmCalls,
      noise_only_change: canonicalizeHtml(result.before) === canonicalizeHtml(result.after),
      byte_preserved: result.bytePreserved,
      fallback_reason: result.fallbackReason,
      splices_applied: result.splicesApplied,
    };
  },

  '/v1/cxone/page/revise-preview': async body => {
    const oldToken = requireStr(body.preview_token, 'preview_token');
    const session = targetedPreviewSessions.get(oldToken);
    if (!session || session.expiresAt <= Date.now()) throw new HttpError(409, { error: 'expired_preview', message: 'Fix preview expired; generate it again.' });
    targetedPreviewSessions.delete(oldToken);
    const page = await resolvePageRef(createExpertClient(), requirePageInput(body), process.env);
    if (!matchesPreviewTarget(page, session)) throw new HttpError(409, { error: 'preview_page_mismatch', message: 'Preview belongs to a different page.' });
    const edits = body.alt_edits as Array<{ src: string; text: string }>;
    let after: string;
    try { after = reviseAltText(session.afterHtml, edits, (session.editableImages || []).map(i => i.src)); }
    catch (err) { throw new HttpError(400, { error: 'invalid_description', message: err instanceof Error ? err.message : 'Invalid description' }); }
    const token = randomUUID();
    const reviewedIds = (session.editableImages || []).filter(i => edits.some(e => e.src === i.src)).map(i => i.findingId);
    const diff = createPatch(session.pagePath, session.beforeHtml, after, 'before', 'after', { context: 3 });
    const revised = { ...session, token, afterHtml: after, diff,
      appliedRuleIds: [...new Set([...session.appliedRuleIds, 'img-alt'])],
      appliedFindingIds: [...new Set([...(session.appliedFindingIds || []), ...reviewedIds])],
      fixErrors: (session.fixErrors || []).filter((e: any) => !reviewedIds.includes(e.findingId)) };
    targetedPreviewSessions.set(token, revised);
    return { preview_token: token, preview_hash: session.beforeHash, before_html: session.beforeHtml, after_html: after,
      diff, review_images: (session.editableImages || []).map(i => ({id: i.findingId, ruleId: 'img-alt', data: {src: i.src}})), fix_errors: revised.fixErrors, applied_finding_ids: revised.appliedFindingIds, llm_calls: session.llmCalls };
  },

  '/v1/cxone/page/apply-fix': async (body) => {
    const page = requirePageInput(body);
    const fixMode = optionalFixMode(body.fix_mode ?? body.fixMode);
    if (!optionalStr(body.preview_token ?? body.previewToken)) {
      throw new HttpError(409, { error: 'preview_required', message: 'Apply requires the single-use token returned with the reviewed output. Preview again.' });
    }
    if (fixMode === 'pipeline') {
      prunePipelinePreviewSessions();
      const previewHash = requireStr(body.preview_hash ?? body.previewHash, 'preview_hash');
      const previewToken = requireStr(body.preview_token ?? body.previewToken, 'preview_token');
      const session = pipelinePreviewSessions.get(previewToken);
      if (!session || session.expiresAt <= Date.now()) {
        pipelinePreviewSessions.delete(previewToken);
        throw new HttpError(409, {
          error: 'expired_preview',
          message: 'Pipeline preview expired; refresh and preview again.',
        });
      }
      if (session.beforeHash !== previewHash) {
        throw new HttpError(409, {
          error: 'stale_preview',
          message: 'Preview hash does not match the cached pipeline preview; refresh and preview again.',
        });
      }

      pipelinePreviewSessions.delete(previewToken);
      if (body.tier !== undefined && requireTier(body.tier) !== session.tier) {
        throw new HttpError(409, { error: 'preview_tier_mismatch', message: 'Tier changed since preview; preview again.' });
      }
      const env = process.env;
      const expert = createExpertClient(env);
      const pageRef = await resolvePageRef(expert, page, env);
      if (!matchesPreviewTarget(pageRef, session)) {
        throw new HttpError(409, {
          error: 'preview_page_mismatch',
          message: 'Pipeline preview was created for a different page; refresh and preview again.',
        });
      }
      const currentHtml = await fetchPageHtml(expert, pageRef.id);
      const currentHash = hashContent(currentHtml);
      if (currentHash !== previewHash || currentHtml !== session.beforeHtml) {
        throw new HttpError(409, {
          error: 'stale_preview',
          message: 'Page content changed since preview; refresh and preview again.',
        });
      }

      const revisionSummary = `Remedy pipeline: applied Tier ${session.tier} page-wide preview`;
      const write = await writePageRevision({
        expert,
        pageInput: pageRef.id,
        page: pageRef,
        beforeHtml: currentHtml,
        afterHtml: session.afterHtml,
        rules: session.appliedRuleIds,
        revisionSummary,
        source: 'pipeline',
        env,
        requestedBy: optionalStr(body.requested_by ?? body.requestedBy),
      });
      return {
        fix_mode: 'pipeline',
        page_wide: true,
        applied: write.written,
        write_outcome: write.writeOutcome,
        audit_recorded: write.auditRecorded,
        revision_summary: write.revisionSummary,
        snapshot_path: write.snapshotPath,
        cxone_revision_id: write.cxoneRevisionId,
        attempted_rule_ids: session.appliedRuleIds,
        applied_rule_ids: session.appliedRuleIds,
        final_findings_count: session.finalFindingsCount,
      };
    }

    const findingIds = optionalStringArray(body.finding_ids ?? body.findingIds ?? body.findingIDs, 'finding_ids');
    const previewHash = requireStr(body.preview_hash ?? body.previewHash, 'preview_hash');
    const previewToken = optionalStr(body.preview_token ?? body.previewToken);
    if (previewToken) {
      prunePreviewSessions();
      const session = targetedPreviewSessions.get(previewToken);
      if (!session || session.expiresAt <= Date.now()) {
        targetedPreviewSessions.delete(previewToken);
        throw new HttpError(409, {
          error: 'expired_preview',
          message: 'Preview expired; refresh and preview again.',
        });
      }
      if (session.beforeHash !== previewHash) {
        throw new HttpError(409, {
          error: 'stale_preview',
          message: 'Preview hash does not match the cached preview; refresh and preview again.',
        });
      }

      targetedPreviewSessions.delete(previewToken);
      const env = process.env;
      const expert = createExpertClient(env);
      const pageRef = await resolvePageRef(expert, page, env);
      if (!matchesPreviewTarget(pageRef, session)) {
        throw new HttpError(409, {
          error: 'preview_page_mismatch',
          message: 'Preview was created for a different page; refresh and preview again.',
        });
      }
      const currentHtml = await fetchPageHtml(expert, pageRef.id);
      const currentHash = hashContent(currentHtml);
      if (currentHash !== previewHash || currentHtml !== session.beforeHtml) {
        throw new HttpError(409, {
          error: 'stale_preview',
          message: 'Page content changed since preview; refresh and preview again.',
        });
      }

      const revisionSummary = `Remedy: fixed ${session.appliedFindingIds?.length ?? findingIds.length} selected finding(s)`;
      const write = await writePageRevision({
        expert,
        pageInput: pageRef.id,
        page: pageRef,
        beforeHtml: currentHtml,
        afterHtml: session.afterHtml,
        rules: session.appliedRuleIds,
        revisionSummary,
        source: 'fix',
        env,
        requestedBy: optionalStr(body.requested_by ?? body.requestedBy),
      });
      return {
        fix_mode: 'deterministic',
        page_wide: false,
        applied: write.written,
        write_outcome: write.writeOutcome,
        audit_recorded: write.auditRecorded,
        revision_summary: write.revisionSummary,
        snapshot_path: write.snapshotPath,
        cxone_revision_id: write.cxoneRevisionId,
        attempted_rule_ids: session.attemptedRuleIds,
        applied_rule_ids: session.appliedRuleIds,
        attempted_finding_ids: session.attemptedFindingIds,
        applied_finding_ids: session.appliedFindingIds,
        fix_errors: session.fixErrors,
        llm_calls: session.llmCalls,
        byte_preserved: session.bytePreserved,
        fallback_reason: session.fallbackReason,
        splices_applied: session.splicesApplied,
      };
    }

    throw new HttpError(409, { error: 'preview_required', message: 'Apply requires the single-use token returned with the reviewed output. Preview again.' });
  },

  '/api/scan': async (body) => {
    const page = requireStr(body.page, 'page');
    const result = await scanPage(page);
    // Strip html payload — the UI doesn't need the full page source.
    const { html: _unused, ...rest } = result;
    void _unused;
    return rest;
  },

  '/api/preview': async (body) => {
    const page = requireStr(body.page, 'page');
    const tier = requireTier(body.tier);
    const r = await runPipeline(page, { tier, mode: 'preview' });
    const session = cachePipelinePreview(r, tier);
    return {
      previewToken: session.token,
      previewHash: session.beforeHash,
      pageId: r.pageId,
      pagePath: r.pagePath,
      hostname: r.hostname,
      tiersRun: r.tiersRun.map((t) => ({ tier: t.tier, before: t.before, after: t.after, elapsedMs: t.elapsedMs })),
      finalFindingsCount: r.finalFindingsCount,
      diff: r.diff,
      beforeHtml: r.beforeHtml,
      finalHtml: r.finalHtml,
      noiseOnlyChange: canonicalizeHtml(r.beforeHtml) === canonicalizeHtml(r.finalHtml),
    };
  },

  '/api/apply': async (body) => {
    const page = requireStr(body.page, 'page');
    const tier = requireTier(body.tier);
    const r = await routes['/v1/cxone/page/apply-fix']({ ...body, page, tier, fix_mode: 'pipeline' }) as Record<string, unknown>;
    return { ...r, revisionSummary: r.revision_summary, snapshotPath: r.snapshot_path };
  },

  '/api/local/fixtures': async () => {
    const entries = await readdir(FIXTURE_ROOT, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && e.name.endsWith('.html'));
    const out = await Promise.all(
      files.map(async (f) => {
        const full = resolve(FIXTURE_ROOT, f.name);
        const s = await stat(full);
        return { name: f.name, relPath: relative(REPO_ROOT, full), size: s.size };
      }),
    );
    out.sort((a, b) => a.name.localeCompare(b.name));
    return { fixtures: out };
  },

  '/api/local/run': async (body) => {
    const source = body.source as 'fixture' | 'inline' | undefined;
    let html: string;
    let fixtureName: string | undefined;

    if (source === 'fixture') {
      const relPath = requireStr(body.relPath, 'relPath');
      const resolved = resolve(REPO_ROOT, relPath);
      // Path-traversal guard (flagged by Aikido AIK_ts_generic_path_traversal):
      // confine reads to FIXTURE_ROOT. `resolve` collapses any ../ in relPath, so
      // a traversal attempt lands outside FIXTURE_ROOT and is rejected here. The
      // `+ sep` on the prefix check defeats the sibling bypass (…/local-lab-evil).
      if (resolved !== FIXTURE_ROOT && !resolved.startsWith(FIXTURE_ROOT + sep)) {
        throw new Error('fixture path escapes fixture root');
      }
      html = await readFile(resolved, 'utf8');
      fixtureName = relPath;
    } else if (source === 'inline') {
      html = requireStr(body.html, 'html');
    } else {
      throw new Error('source must be "fixture" or "inline"');
    }

    const result = await runLocalPipeline(html, {
      maxLlmCalls: typeof body.maxLlm === 'number' ? body.maxLlm : undefined,
      onlyRuleIds: Array.isArray(body.onlyRuleIds) ? (body.onlyRuleIds as string[]) : undefined,
    });

    return { fixtureName, ...result };
  },
};

function matchesPreviewTarget(page: PageRef, session: { pageId: number; pagePath: string; hostname: string }): boolean {
  return page.id === session.pageId && page.path === session.pagePath && page.hostname === session.hostname;
}

function cachePipelinePreview(result: PipelineResult, tier: 1 | 2 | 3): PipelinePreviewSession {
  prunePipelinePreviewSessions();
  const session: PipelinePreviewSession = {
    token: randomUUID(), expiresAt: Date.now() + PIPELINE_PREVIEW_TTL_MS,
    pageId: result.pageId, pagePath: result.pagePath, hostname: result.hostname, tier,
    beforeHash: hashContent(result.beforeHtml), beforeHtml: result.beforeHtml,
    afterHtml: result.finalHtml, diff: result.diff, finalFindingsCount: result.finalFindingsCount,
    appliedRuleIds: result.appliedRuleIds,
  };
  pipelinePreviewSessions.set(session.token, session);
  return session;
}

export const server = createServer(async (req, res) => {
  setSecurityHeaders(res);
  setCors(res, req);
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (req.method !== 'POST' && req.method !== 'GET') {
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  const handler = routes[pathname];
  if (!handler) {
    if (req.method === 'GET') {
      await serveStatic(pathname, res);
      return;
    }
    json(res, 404, { error: 'not found' });
    return;
  }

  try {
    if (isCxoneRoute(pathname) && !isCxoneIntegrationEnabled(process.env)) {
      json(res, 503, {
        error: 'cxone_integration_disabled',
        message: 'CXone integration is disabled on this environment.',
      });
      return;
    }
    const body = req.method === 'POST' ? await readJson(req) : {};
    const result = await handler(body);
    json(res, 200, result);
  } catch (err) {
    if (err instanceof WriteOutcomeError) {
      json(res, 409, { error: 'write_outcome_unknown', write_outcome: 'unknown', retry_safe: false, snapshot_path: err.snapshotPath,
        message: 'Write outcome is unknown. Do not retry. Reconcile CXone revision history and the saved snapshot before further writes.' });
      return;
    }
    if (err instanceof Error && err.message.startsWith('Page changed since')) {
      json(res, 409, { error: 'stale_preview', message: 'Page changed since preview; preview again.' });
      return;
    }
    if (err instanceof HttpError) {
      json(res, err.status, err.body);
      return;
    }
    // Log full detail server-side; return a generic message so internal error
    // text (paths, upstream messages, stack-adjacent details) never leaks to
    // the client.
    console.error('[conductor-api] request failed:', err instanceof Error ? err.name : 'UnknownError');
    json(res, 500, { error: 'internal server error' });
  }
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) server.listen(PORT, HOST, () => {
  console.log(`[conductor-api] listening on http://${HOST}:${PORT}`);
});

function isCxoneRoute(pathname: string): boolean {
  return pathname.startsWith('/v1/cxone/') || pathname === '/api/scan' || pathname === '/api/preview' || pathname === '/api/apply';
}

// --- helpers ---
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new HttpError(413, {
        error: 'payload_too_large',
        message: `Request body exceeds ${MAX_REQUEST_BYTES} bytes.`,
      });
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text);
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  if (pathname.startsWith('/api/') || pathname.startsWith('/v1/')) {
    json(res, 404, { error: 'not found' });
    return;
  }

  const requested = pathname === '/' ? '/index.html' : pathname;
  const safePath = resolve(STATIC_ROOT, `.${decodeURIComponent(requested)}`);
  if (safePath !== STATIC_ROOT && !safePath.startsWith(STATIC_ROOT + sep)) {
    json(res, 403, { error: 'forbidden' });
    return;
  }

  let filePath = safePath;
  try {
    const s = await stat(filePath);
    if (!s.isFile()) throw new Error('not a file');
  } catch {
    filePath = resolve(STATIC_ROOT, 'index.html');
  }

  try {
    const s = await stat(filePath);
    if (!s.isFile()) throw new Error('not a file');
    res.writeHead(200, { 'content-type': contentType(filePath) });
    createReadStream(filePath).pipe(res);
  } catch {
    json(res, 404, { error: 'panel build not found' });
  }
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    default:
      return 'application/octet-stream';
  }
}

const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

function setCors(res: ServerResponse, req: IncomingMessage) {
  // Local staff tool: reflect only localhost origins instead of a blanket
  // wildcard on an unauthenticated, state-changing API. Requests with no Origin
  // (curl, server-to-server) are unaffected and still work.
  const origin = req.headers.origin;
  if (origin && LOCALHOST_ORIGIN.test(origin)) {
    res.setHeader('access-control-allow-origin', origin);
  }
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}

function setSecurityHeaders(res: ServerResponse) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cache-control', 'no-store');
}

function requireStr(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new Error(`missing field: ${name}`);
  return v;
}

function requirePageInput(body: Record<string, unknown>): string | number {
  const pageUrl = optionalStr(body.page_url) ?? optionalStr(body.sectionURL) ?? optionalStr(body.page);
  if (pageUrl) return pageUrl;
  const pageId = body.page_id ?? body.pageID;
  if (typeof pageId === 'number' && Number.isFinite(pageId)) return pageId;
  if (typeof pageId === 'string' && pageId.trim()) return pageId;
  throw new Error('missing field: page_url or page_id');
}

function optionalStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function optionalStringArray(v: unknown, name: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`${name} must be an array`);
  return v.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function optionalFixMode(v: unknown): FixEngineMode {
  if (v === undefined || v === null || v === '') return 'deterministic';
  if (v === 'deterministic' || v === 'pipeline') return v;
  throw new Error('fix_mode must be deterministic|pipeline');
}

function optionalDojExceptions(v: unknown): DojException[] {
  return Array.isArray(v) ? (v as DojException[]) : [];
}

function optionalWcagReview(v: unknown): WcagReview | undefined {
  return v && typeof v === 'object' ? (v as WcagReview) : undefined;
}

function requireTier(v: unknown): 1 | 2 | 3 {
  const n = Number(v);
  if (n !== 1 && n !== 2 && n !== 3) throw new Error(`tier must be 1|2|3`);
  return n;
}

function optionalTier(v: unknown): 1 | 2 | 3 | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return requireTier(v);
}

function prunePreviewSessions(now = Date.now()): void {
  for (const [token, session] of pipelinePreviewSessions) {
    if (session.expiresAt <= now) pipelinePreviewSessions.delete(token);
  }
  for (const [token, session] of targetedPreviewSessions) {
    if (session.expiresAt <= now) targetedPreviewSessions.delete(token);
  }
}

const prunePipelinePreviewSessions = prunePreviewSessions;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.message === 'string' ? body.message : `HTTP ${status}`);
  }
}
