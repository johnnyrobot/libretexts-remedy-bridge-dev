/**
 * Restore attribution/license page tags on a sandbox page.
 *
 * The Biology sandbox clone dropped every page tag, so LicenseControl renders
 * an empty `<a href="#">` (axe `link-name`) on every page. Only the two tags
 * LicenseControl reads are restored. Everything else is reported as omitted:
 * `article:*` and `authorname:*` drive site templates (dev.libretexts.org
 * lacks Template:AutoDefinitionList; the author box renders `alt=" "`),
 * `showtoc:no` changes layout, `source@` is inert, and the CC attribution
 * sentence is already in every page body.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Expert from '@libretexts/cxone-expert-node';
import {
  appendAudit,
  assertWriteAllowed,
  hashContent,
  operatorFromEnv,
  snapshotDir,
} from './guardrails.js';
import type { PageRef } from './types.js';
import { canonicalWriteTarget, withPageWriteLock, markWriteUncertain } from './write-safety.js';

const RESTORE_PREFIXES = ['license:', 'licenseversion:'];

export interface TagSelection {
  restore: string[];
  omitted: string[];
}

export function selectRestorableTags(sourceTags: string[]): TagSelection {
  const restore: string[] = [];
  const omitted: string[] = [];
  for (const tag of sourceTags) {
    (RESTORE_PREFIXES.some((p) => tag.startsWith(p)) ? restore : omitted).push(tag);
  }
  return { restore, omitted };
}

export interface WritePageTagsOptions {
  expert: Expert;
  page: PageRef;
  /** Complete tag list the page should end up with. */
  tags: string[];
  /** Plan only: read the current tags and diff, never PUT. */
  dryRun?: boolean;
  /** Keep every tag the page already has; `tags` are added, never removed. */
  merge?: boolean;
  revisionSummary?: string;
  env?: NodeJS.ProcessEnv;
}

export interface WritePageTagsResult {
  written: boolean;
  writeOutcome?: 'succeeded';
  auditRecorded?: boolean;
  auditError?: 'audit_append_failed';
  before: string[];
  after: string[];
  added: string[];
  removed: string[];
  /** On-disk JSON copy of the pre-write tag list (apply only). */
  snapshotPath?: string;
}

/** Flatten the SDK's `OneOrMany<PageTag>` into plain `@value` strings. */
export function tagValues(response: { tag?: unknown } | undefined): string[] {
  const raw = response?.tag;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list
    .map((t) => (t && typeof t === 'object' ? (t as Record<string, unknown>)['@value'] : undefined))
    .filter((v): v is string => typeof v === 'string');
}

function xmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Deki `PUT /pages/{id}/tags` body — replaces the whole tag set. */
export function tagsToXml(tags: string[]): string {
  return `<tags>${tags.map((t) => `<tag value="${xmlAttr(t)}"/>`).join('')}</tags>`;
}

async function saveTagSnapshot(
  tags: string[],
  page: PageRef,
  operator: string,
  revisionSummary: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const ts = new Date().toISOString();
  const hash = hashContent(JSON.stringify(tags));
  const dir = snapshotDir(page.id, env);
  const path = join(dir, `${ts.replace(/[:.]/g, '-')}_${hash}.tags.json`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path,
    JSON.stringify(
      {
        meta: { ts, pageId: page.id, pagePath: page.path, hostname: page.hostname, operator, hash, revisionSummary },
        tags,
      },
      null,
      2,
    ),
    'utf8',
  );
  return path;
}

export async function writePageTags({
  expert,
  page,
  tags,
  dryRun = false,
  merge = false,
  revisionSummary,
  env = process.env,
}: WritePageTagsOptions): Promise<WritePageTagsResult> {
  assertWriteAllowed(page, env);
  return withPageWriteLock(page, async () => {
    page = await canonicalWriteTarget(expert, page.id, page, env);

    const before = tagValues(await expert.pages.getPageTags(page.id));
    const after = [...new Set(merge ? [...before, ...tags] : tags)];
    const added = after.filter((t) => !before.includes(t));
    const removed = before.filter((t) => !after.includes(t));
    const plan = { written: false, before, after, added, removed };

    if (dryRun || (added.length === 0 && removed.length === 0)) return plan;

    const write = await putTagsWithSnapshot(expert, page, before, after, { mode: 'apply', revisionSummary, env });
    return { ...plan, written: true, ...write };
  });
}

async function putTagsWithSnapshot(
  expert: Expert,
  page: PageRef,
  before: string[],
  after: string[],
  opts: { mode: 'apply' | 'revert'; revisionSummary?: string; revertedFrom?: string; env: NodeJS.ProcessEnv },
): Promise<{ snapshotPath: string; writeOutcome: 'succeeded'; auditRecorded: boolean; auditError?: 'audit_append_failed' }> {
  const operator = operatorFromEnv(opts.env);
  const snapshotPath = await saveTagSnapshot(before, page, operator, opts.revisionSummary, opts.env);

  try {
    await expert.pages.putPageTags(page.id, tagsToXml(after), undefined, {
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    });
  } catch { throw markWriteUncertain(page, snapshotPath); }

  let auditRecorded = true;
  try {
    await appendAudit(
      {
        ts: new Date().toISOString(),
        page: { id: page.id, path: page.path, hostname: page.hostname },
        rules: ['page-tags'],
        mode: opts.mode,
        beforeHash: hashContent(JSON.stringify(before)),
        afterHash: hashContent(JSON.stringify(after)),
        operator,
        revisionSummary: opts.revisionSummary,
        snapshotPath,
        revertedFrom: opts.revertedFrom,
      },
      opts.env.REMEDY_AUDIT_LOG,
    );
  } catch { auditRecorded = false; }
  return { snapshotPath, writeOutcome: 'succeeded', auditRecorded, ...(auditRecorded ? {} : { auditError: 'audit_append_failed' as const }) };
}

export interface RevertPageTagsOptions {
  expert: Expert;
  /** A `*.tags.json` file written by an earlier apply. */
  snapshotPath: string;
  env?: NodeJS.ProcessEnv;
}

/** Put a page's tag list back to exactly what a snapshot recorded. Replace, not merge. */
export async function revertPageTags({ expert, snapshotPath, env = process.env }: RevertPageTagsOptions): Promise<WritePageTagsResult> {
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as {
    meta: { pageId: number; pagePath: string; hostname: string };
    tags: string[];
  };
  let page: PageRef = { id: snapshot.meta.pageId, path: snapshot.meta.pagePath, hostname: snapshot.meta.hostname };
  assertWriteAllowed(page, env);
  return withPageWriteLock(page, async () => {
    page = await canonicalWriteTarget(expert, page.id, page, env);

    const before = tagValues(await expert.pages.getPageTags(page.id));
    const after = [...new Set(snapshot.tags)];
    const added = after.filter((t) => !before.includes(t));
    const removed = before.filter((t) => !after.includes(t));
    if (added.length === 0 && removed.length === 0) return { written: false, before, after, added, removed };

    const safety = await putTagsWithSnapshot(expert, page, before, after, {
      mode: 'revert',
      revisionSummary: `Revert page tags to snapshot ${snapshotPath}`,
      revertedFrom: snapshotPath,
      env,
    });
    return { written: true, before, after, added, removed, ...safety };
  });
}

/* -------------------------------------------------------------------------- *
 * Manifest-driven restore — one JSON file describing the 82 sandbox pages and
 * the source tags each should get back. Built read-only by
 * tools/build-biology-tag-manifest.mjs; consumed by `remedy tags-restore`.
 * -------------------------------------------------------------------------- */

export interface TagRestorePage {
  sandboxPageId: number;
  sandboxPath: string;
  sourcePath: string;
  sourcePageId: number | null;
  /** Did the sandbox page's `lt-bio-<id>` marker agree with the source page id? */
  crosscheck: 'match' | 'mismatch' | 'unavailable';
  tags: TagSelection;
}

export interface TagRestoreManifest {
  generatedAt: string;
  pages: TagRestorePage[];
}

export interface RestoreTagsOptions {
  expert: Expert;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
  /** Only touch this sandbox page id (the one-page trial before the full run). */
  onlyPageId?: number;
  revisionSummary?: string;
}

export interface RestoreTagsPageResult {
  sandboxPageId: number;
  sandboxPath: string;
  status: 'written' | 'planned' | 'unchanged' | 'skipped-crosscheck' | 'error';
  result?: WritePageTagsResult;
  error?: string;
}

export async function restoreTagsFromManifest(
  manifest: TagRestoreManifest,
  { expert, env = process.env, dryRun = false, onlyPageId, revisionSummary }: RestoreTagsOptions,
): Promise<RestoreTagsPageResult[]> {
  const hostname = env.SERVER_DOMAIN ?? 'dev.libretexts.org';
  const pages = onlyPageId === undefined ? manifest.pages : manifest.pages.filter((p) => p.sandboxPageId === onlyPageId);
  const out: RestoreTagsPageResult[] = [];

  for (const entry of pages) {
    const base = { sandboxPageId: entry.sandboxPageId, sandboxPath: entry.sandboxPath };
    if (entry.crosscheck === 'mismatch') {
      out.push({ ...base, status: 'skipped-crosscheck' });
      continue;
    }
    try {
      const result = await writePageTags({
        expert,
        page: { id: entry.sandboxPageId, path: entry.sandboxPath, hostname },
        tags: entry.tags.restore,
        merge: true,
        dryRun,
        revisionSummary,
        env,
      });
      const status = result.written ? 'written' : dryRun ? 'planned' : 'unchanged';
      out.push({ ...base, status, result });
    } catch (err) {
      out.push({ ...base, status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
