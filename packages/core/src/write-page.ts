import type Expert from '@libretexts/cxone-expert-node';
import { canonicalWriteTarget, withPageWriteLock, markWriteUncertain, WriteEligibilityError } from './write-safety.js';
import { fetchPageHtml } from './scan.js';
import {
  appendAudit,
  assertWriteAllowed,
  extractRevisionId,
  hashContent,
  operatorFromEnv,
  saveSnapshot,
  type SnapshotMeta,
} from './guardrails.js';
import { isNoiseOnlyChange } from './serialize.js';
import type { FixMode, PageRef } from './types.js';

export interface WritePageRevisionOptions {
  expert: Expert;
  pageInput: string | number;
  page: PageRef;
  beforeHtml: string;
  afterHtml: string;
  rules: string[];
  env?: NodeJS.ProcessEnv;
  revisionSummary: string;
  source: NonNullable<SnapshotMeta['source']>;
  mode?: FixMode | 'revert';
  /** Application reviewer: caller-asserted, unverified, never used for authorization; separate from operator. */
  requestedBy?: string;
  /** Snapshot being restored, for the append-only audit trail. */
  revertedFrom?: string;
  /** Verified HTTP reviewer, distinct from the process operator. */
  reviewer?: { issuer: string; subject: string };
  /** Required-mode durable dispatch marker; must complete before the single remote call. */
  beforeDispatch?: (snapshot: import('./guardrails.js').SnapshotEntry) => Promise<void>;
}

export interface WritePageRevisionResult {
  written: boolean;
  writeOutcome?: 'succeeded';
  auditRecorded?: boolean;
  auditError?: 'audit_append_failed';
  revisionSummary: string;
  snapshotPath?: string;
  cxoneRevisionId?: string | number;
  bytePreserved?: boolean;
  fallbackReason?: 'unsupported-mutation' | 'no-source-location' | 'verification-mismatch' | 'parse-error';
  splicesApplied?: number;
}

export async function writePageRevision({
  expert,
  pageInput,
  page,
  beforeHtml,
  afterHtml,
  rules,
  env = process.env,
  revisionSummary,
  source,
  mode = 'apply',
  requestedBy,
  revertedFrom,
  reviewer,
  beforeDispatch,
}: WritePageRevisionOptions): Promise<WritePageRevisionResult> {
  if (beforeHtml === afterHtml || (mode !== 'revert' && isNoiseOnlyChange(beforeHtml, afterHtml))) {
    return { written: false, revisionSummary };
  }

  assertWriteAllowed(page, env);
  return withPageWriteLock(page, async () => {
    page = await canonicalWriteTarget(expert, pageInput, page, env);
    if (await fetchPageHtml(expert, page.id) !== beforeHtml) throw new WriteEligibilityError('stale_preview');

    const snapshot = await saveSnapshot(beforeHtml, {
      pageId: page.id,
      pagePath: page.path,
      hostname: page.hostname,
      operator: operatorFromEnv(env),
      requestedBy,
      reviewer,
      rules,
      revisionSummary,
      source,
    }, env);

    await beforeDispatch?.(snapshot);

    let postResponse: unknown;
    try {
      postResponse = await expert.pages.postPageContents(
        page.id,
        afterHtml,
        { edittime: 'now', comment: revisionSummary } as unknown as Parameters<typeof expert.pages.postPageContents>[2],
      );
    } catch {
      throw markWriteUncertain(page, snapshot.metaPath);
    }

    const cxoneRevisionId = extractRevisionId(postResponse);
    let auditRecorded = true;
    try {
      await appendAudit({
        ts: new Date().toISOString(),
        page: { id: page.id, path: page.path, hostname: page.hostname },
        rules,
        mode,
        beforeHash: hashContent(beforeHtml),
        afterHash: hashContent(afterHtml),
        operator: operatorFromEnv(env),
        requestedBy,
        reviewer,
        revertedFrom,
        revisionSummary,
        snapshotPath: snapshot.metaPath,
        cxoneRevisionId,
      }, env.REMEDY_AUDIT_LOG);
    } catch { auditRecorded = false; }

    return {
      written: true,
      writeOutcome: 'succeeded',
      auditRecorded,
      ...(auditRecorded ? {} : { auditError: 'audit_append_failed' as const }),
      revisionSummary,
      snapshotPath: snapshot.metaPath,
      cxoneRevisionId,
    };
  });
}
