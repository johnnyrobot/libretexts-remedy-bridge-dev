import { assertMutationProfileAllowed } from './profile.js';
import { JSDOM } from 'jsdom';
import { createPatch } from 'diff';
import type Expert from '@libretexts/cxone-expert-node';
import { createExpertClient, resolvePageRef } from './client.js';
import { defaultRules } from './rules/index.js';
import { fetchPageHtml, scanHtmlFull } from './scan.js';
import { isNoiseOnlyChange } from './serialize.js';
import { bytePreservePatch } from './patch/index.js';
import { LLMClient } from './ai/llm-client.js';
import { markUnavailableImageFixes } from './image-availability.js';
import type { Finding, FixError, FixMode, FixResult, PageRef, Rule } from './types.js';
import { writePageRevision, type WritePageRevisionResult } from './write-page.js';

export interface FixPageOptions {
  expert?: Expert;
  rules?: Rule[];
  env?: NodeJS.ProcessEnv;
  mode?: FixMode;
  onlyRuleIds?: string[];
  findingIds?: string[];
  revisionSummary?: string;
  /** Application reviewer: caller-asserted, unverified, never used for authorization; separate from operator. */
  requestedBy?: string;
  llm?: LLMClient;
  maxLlmCalls?: number;
}

interface WantedFinding {
  finding: Finding;
  findingId: string;
}

/**
 * Scan a page and apply fixes for findings whose rule has a fix() implementation.
 * By default runs in preview mode — no HTTP write. `mode: 'apply'` issues a
 * postPageContents call after passing guardrails and caller confirmation.
 */
export async function fixPage(
  pageInput: string | number,
  opts: FixPageOptions = {},
): Promise<FixResult & { findings: Finding[] }> {
  const env = opts.env ?? process.env;
  if (opts.mode === 'apply') assertMutationProfileAllowed(env);
  const expert = opts.expert ?? createExpertClient(env);
  const rules = opts.rules ?? defaultRules;
  const mode: FixMode = opts.mode ?? 'preview';

  const page: PageRef = await resolvePageRef(expert, pageInput, env);
  const before = await fetchPageHtml(expert, pageInput);
  let findings = await scanHtmlFull(before, { rules });
  findings = await markUnavailableImageFixes(findings, page, { env });

  const dom = new JSDOM(`<!doctype html><html><body>${before}</body></html>`);
  const doc = dom.window.document;
  const attempted: string[] = [];
  const applied: string[] = [];
  const attemptedFindingIds: string[] = [];
  const appliedFindingIds: string[] = [];
  const fixErrors: FixError[] = [];
  let sharedLlm = opts.llm;
  let llmCalls = 0;
  const maxLlmCalls = opts.maxLlmCalls ?? Number(env.REMEDY_FIX_MAX_LLM_CALLS ?? 50);
  const getLlm = () => {
    sharedLlm ??= new LLMClient();
    return sharedLlm;
  };
  const consumeLlmCall = () => {
    if (maxLlmCalls >= 0 && llmCalls >= maxLlmCalls) return false;
    llmCalls += 1;
    return true;
  };

  const wanted = filterWanted(findings, rules, opts);
  const ruleById = new Map(rules.map((r) => [r.id, r]));

  for (const { finding: f, findingId } of wanted) {
    const rule = ruleById.get(f.ruleId);
    if (!rule?.fix) continue;
    attempted.push(f.ruleId);
    attemptedFindingIds.push(findingId);
    try {
      const ok = await rule.fix(doc, f, {
        page,
        env,
        llm: sharedLlm,
        getLlm,
        consumeLlmCall,
        recordFixError: (message) => {
          fixErrors.push({
            ruleId: f.ruleId,
            findingId,
            selector: f.selector,
            message,
          });
        },
      });
      if (ok) {
        applied.push(f.ruleId);
        appliedFindingIds.push(findingId);
      }
    } catch (err) {
      if (env.DEBUG) console.error(`Fix ${f.ruleId} threw:`, err);
      fixErrors.push({
        ruleId: f.ruleId,
        findingId,
        selector: f.selector,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const afterRaw = doc.body.innerHTML;
  const rawHasContentChange = applied.length > 0 && !isNoiseOnlyChange(before, afterRaw);
  const patch = rawHasContentChange ? bytePreservePatch(before, afterRaw) : undefined;
  const patchedAfter = patch?.ok && patch.bytes !== undefined ? patch.bytes : afterRaw;
  const hasContentChange = applied.length > 0 && !isNoiseOnlyChange(before, patchedAfter);
  const effectiveApplied = hasContentChange ? applied : [];
  const after = hasContentChange ? patchedAfter : before;
  const diff = createPatch(
    page.path || `page-${page.id}`,
    before,
    after,
    'before',
    'after',
    { context: 3 },
  );

  let written = false;
  let writeOutcome: WritePageRevisionResult | undefined;
  let snapshotPath: string | undefined;
  let revisionSummary = opts.revisionSummary;
  if (mode === 'apply' && before !== after) {
    revisionSummary =
      revisionSummary ?? `remedy-v0: fix ${unique(effectiveApplied).join(',') || '(no-op)'}`;
    const write = await writePageRevision({
      expert,
      pageInput,
      page,
      beforeHtml: before,
      afterHtml: after,
      rules: unique(effectiveApplied),
      revisionSummary,
      source: 'fix',
      requestedBy: opts.requestedBy,
      env,
    });
    writeOutcome = write;
    written = write.written;
    snapshotPath = write.snapshotPath;
  }

  return {
    page,
    mode,
    attempted: unique(attempted),
    applied: unique(effectiveApplied),
    before,
    after,
    diff,
    written,
    writeOutcome: writeOutcome?.writeOutcome,
    auditRecorded: writeOutcome?.auditRecorded,
    auditError: writeOutcome?.auditError,
    revisionSummary,
    snapshotPath,
    bytePreserved: patch?.ok,
    fallbackReason: patch?.ok ? undefined : patch?.reason,
    splicesApplied: patch?.ok ? patch.splices.length : undefined,
    attemptedFindingIds,
    appliedFindingIds: hasContentChange ? appliedFindingIds : [],
    fixErrors,
    llmCalls,
    findings,
  };
}

function filterWanted(findings: Finding[], rules: Rule[], opts: FixPageOptions): WantedFinding[] {
  const fixableIds = new Set(rules.filter((r) => typeof r.fix === 'function').map((r) => r.id));
  let fixableIndex = 0;
  let f = findings.flatMap((finding): WantedFinding[] => {
    if (!finding.fixable || !fixableIds.has(finding.ruleId)) return [];
    const findingId = `${finding.ruleId}#${fixableIndex++}`;
    return [{ finding, findingId }];
  });
  if (opts.onlyRuleIds?.length) {
    const set = new Set(opts.onlyRuleIds);
    f = f.filter((x) => set.has(x.finding.ruleId));
  }
  if (opts.findingIds?.length) {
    const set = new Set(opts.findingIds);
    f = f.filter((x) => set.has(x.findingId));
  }
  return f;
}

function unique<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
