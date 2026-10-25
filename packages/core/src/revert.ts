/**
 * Revert path — restore a page to a saved snapshot.
 *
 * Every `--apply` writes a pre-write HTML snapshot under
 * `.remedy/snapshots/{pageId}/` plus a `.json` metadata file. This module
 * exposes the read side: list snapshots, fetch a single snapshot's HTML,
 * and push it back to CXone as a new revision (so the revert itself is
 * auditable and reversible — the previous state is captured in a fresh
 * snapshot before the restore write).
 */
import type Expert from '@libretexts/cxone-expert-node';
import { createExpertClient, normalizePageInput, resolvePageRef } from './client.js';
import {
  appendAudit,
  assertWriteAllowed,
  extractRevisionId,
  hashContent,
  listSnapshots,
  operatorFromEnv,
  readSnapshot,
  saveSnapshot,
  type SnapshotEntry,
} from './guardrails.js';
import { fetchPageHtml } from './scan.js';

export interface RevertOptions {
  expert?: Expert;
  env?: NodeJS.ProcessEnv;
  /** Pin a specific snapshot by its meta.ts (ISO). Newest-first if omitted. */
  snapshotTs?: string;
  /** Alternatively, a direct path to the snapshot's `.json` or `.html`. */
  snapshotPath?: string;
  /** Dry-run — don't write, return the diff candidate only. Default false. */
  dryRun?: boolean;
  /** Application user this restore is made on behalf of; recorded alongside the process operator. */
  requestedBy?: string;
  /** Reject a restore if the live page changed since the reviewed preview. */
  expectedCurrentHash?: string;
  /** Custom revision summary written to CXone. */
  revisionSummary?: string;
}

export interface RevertResult {
  pageId: number;
  pagePath: string;
  hostname: string;
  snapshotUsed: {
    metaPath: string;
    htmlPath: string;
    ts: string;
    hash: string;
  };
  /** The HTML currently live on the page before the revert. */
  currentHtml: string;
  /** The HTML that will be (or was) written. */
  revertedToHtml: string;
  /** Path to the extra safety snapshot of currentHtml (taken before restore). */
  preRevertSnapshotPath?: string;
  written: boolean;
  cxoneRevisionId?: string | number;
}

export async function listPageSnapshots(
  pageInput: string | number,
  opts: { expert?: Expert; env?: NodeJS.ProcessEnv } = {},
): Promise<SnapshotEntry[]> {
  const env = opts.env ?? process.env;
  const expert = opts.expert ?? createExpertClient(env);
  const page = await resolvePageRef(expert, pageInput, env);
  return listSnapshots(page.id, env);
}

export async function revertPage(
  pageInput: string | number,
  opts: RevertOptions = {},
): Promise<RevertResult> {
  const env = opts.env ?? process.env;
  const expert = opts.expert ?? createExpertClient(env);
  const page = await resolvePageRef(expert, pageInput, env);

  let chosen: { metaPath: string; htmlPath: string; ts: string; hash: string; html: string };

  if (opts.snapshotPath) {
    const { html, meta } = await readSnapshot(opts.snapshotPath);
    if (meta.pageId !== page.id || meta.hostname !== page.hostname || meta.pagePath !== page.path || hashContent(html) !== meta.hash) {
      throw new Error('Snapshot does not match this page or failed integrity validation');
    }
    chosen = {
      metaPath: opts.snapshotPath.replace(/\.html$/, '.json'),
      htmlPath: opts.snapshotPath.replace(/\.json$/, '.html'),
      ts: meta.ts,
      hash: meta.hash,
      html,
    };
  } else {
    const snapshots = await listSnapshots(page.id, env);
    if (snapshots.length === 0) {
      throw new Error(
        `No snapshots on disk for page ${page.id} (${page.path}). Nothing to revert to.`,
      );
    }
    const pick = opts.snapshotTs
      ? snapshots.find((s) => s.meta.ts === opts.snapshotTs)
      : snapshots[0];
    if (!pick) {
      throw new Error(
        `Snapshot with ts="${opts.snapshotTs}" not found for page ${page.id}. ` +
        `Available: ${snapshots.map((s) => s.meta.ts).join(', ')}`,
      );
    }
    const { html, meta } = await readSnapshot(pick);
    if (meta.pageId !== page.id || meta.hostname !== page.hostname || meta.pagePath !== page.path || hashContent(html) !== meta.hash) {
      throw new Error('Snapshot does not match this page or failed integrity validation');
    }
    chosen = { ...pick, ts: pick.meta.ts, hash: pick.meta.hash, html };
  }

  // Fetch current live HTML — needed for a pre-revert safety snapshot and for
  // deciding whether a write is actually necessary.
  const currentHtml = await fetchPageHtml(expert, pageInput);

  if (opts.expectedCurrentHash && hashContent(currentHtml) !== opts.expectedCurrentHash) {
    throw new Error('Page changed since restore preview; preview again');
  }

  if (currentHtml === chosen.html) {
    return {
      pageId: page.id,
      pagePath: page.path,
      hostname: page.hostname,
      snapshotUsed: { metaPath: chosen.metaPath, htmlPath: chosen.htmlPath, ts: chosen.ts, hash: chosen.hash },
      currentHtml,
      revertedToHtml: chosen.html,
      written: false,
    };
  }

  if (opts.dryRun) {
    return {
      pageId: page.id,
      pagePath: page.path,
      hostname: page.hostname,
      snapshotUsed: { metaPath: chosen.metaPath, htmlPath: chosen.htmlPath, ts: chosen.ts, hash: chosen.hash },
      currentHtml,
      revertedToHtml: chosen.html,
      written: false,
    };
  }

  assertWriteAllowed(page, env);

  // Save an ADDITIONAL snapshot of the current state before reverting —
  // the revert is itself a write, and we want it reversible.
  const preRevertSnapshot = await saveSnapshot(currentHtml, {
    pageId: page.id,
    pagePath: page.path,
    hostname: page.hostname,
    operator: operatorFromEnv(env),
    requestedBy: opts.requestedBy,
    rules: ['__revert__'],
    revisionSummary: `pre-revert safety snapshot (→ ${chosen.ts})`,
    source: 'revert',
  }, env);

  const summary =
    opts.revisionSummary ?? `remedy revert: restore snapshot ${chosen.ts} (${chosen.hash})`;

  const postResponse = await expert.pages.postPageContents(
    normalizePageInput(pageInput, env) as number,
    chosen.html,
    {
      edittime: 'now',
      comment: summary,
    } as unknown as Parameters<typeof expert.pages.postPageContents>[2],
  );

  await appendAudit({
    ts: new Date().toISOString(),
    page: { id: page.id, path: page.path, hostname: page.hostname },
    rules: ['__revert__'],
    mode: 'revert',
    beforeHash: hashContent(currentHtml),
    afterHash: chosen.hash,
    operator: operatorFromEnv(env),
    requestedBy: opts.requestedBy,
    revisionSummary: summary,
    snapshotPath: preRevertSnapshot.metaPath,
    revertedFrom: chosen.metaPath,
    cxoneRevisionId: extractRevisionId(postResponse),
  }, env.REMEDY_AUDIT_LOG);

  return {
    pageId: page.id,
    pagePath: page.path,
    hostname: page.hostname,
    snapshotUsed: { metaPath: chosen.metaPath, htmlPath: chosen.htmlPath, ts: chosen.ts, hash: chosen.hash },
    currentHtml,
    revertedToHtml: chosen.html,
    preRevertSnapshotPath: preRevertSnapshot.metaPath,
    written: true,
    cxoneRevisionId: extractRevisionId(postResponse),
  };
}

/**
 * List CXone's native page revisions (separate from our on-disk snapshots).
 * Useful as a second recovery channel — CXone tracks a revision history
 * independently and can restore to any of them.
 */
export async function listCxoneRevisions(
  pageInput: string | number,
  opts: { expert?: Expert; env?: NodeJS.ProcessEnv } = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  const expert = opts.expert ?? createExpertClient(env);
  const id = normalizePageInput(pageInput);
  // The SDK exposes this as getPageRevisions; signature is loosely typed.
  // biome-ignore lint: SDK types are permissive.
  const anyExpert = expert.pages as unknown as {
    getPageRevisions: (id: string | number) => Promise<unknown>;
  };
  return anyExpert.getPageRevisions(id as number);
}
