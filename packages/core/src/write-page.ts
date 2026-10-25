import type Expert from '@libretexts/cxone-expert-node';
import { normalizePageInput } from './client.js';
import {
  appendAudit,
  assertWriteAllowed,
  extractRevisionId,
  hashContent,
  operatorFromEnv,
  saveSnapshot,
  type SnapshotMeta,
} from './guardrails.js';
import { bytePreservePatch } from './patch/index.js';
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
}

export interface WritePageRevisionResult {
  written: boolean;
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
}: WritePageRevisionOptions): Promise<WritePageRevisionResult> {
  if (beforeHtml === afterHtml || isNoiseOnlyChange(beforeHtml, afterHtml)) {
    return { written: false, revisionSummary };
  }

  assertWriteAllowed(page, env);

  const snapshot = await saveSnapshot(beforeHtml, {
    pageId: page.id,
    pagePath: page.path,
    hostname: page.hostname,
    operator: operatorFromEnv(env),
    requestedBy,
    rules,
    revisionSummary,
    source,
  }, env);

  const patch = bytePreservePatch(beforeHtml, afterHtml);
  const bytesToWrite = patch.bytes ?? afterHtml;
  const postResponse = await expert.pages.postPageContents(
    normalizePageInput(pageInput) as number,
    bytesToWrite,
    {
      edittime: 'now',
      comment: revisionSummary,
    } as unknown as Parameters<typeof expert.pages.postPageContents>[2],
  );

  const cxoneRevisionId = extractRevisionId(postResponse);
  await appendAudit({
    ts: new Date().toISOString(),
    page: { id: page.id, path: page.path, hostname: page.hostname },
    rules,
    mode,
    beforeHash: hashContent(beforeHtml),
    afterHash: hashContent(afterHtml),
    operator: operatorFromEnv(env),
    requestedBy,
    revisionSummary,
    snapshotPath: snapshot.metaPath,
    cxoneRevisionId,
    bytePreserved: patch.ok,
    fallbackReason: patch.ok ? undefined : patch.reason,
    splicesApplied: patch.ok ? patch.splices.length : undefined,
  }, env.REMEDY_AUDIT_LOG);

  return {
    written: true,
    revisionSummary,
    snapshotPath: snapshot.metaPath,
    cxoneRevisionId,
    bytePreserved: patch.ok,
    fallbackReason: patch.ok ? undefined : patch.reason,
    splicesApplied: patch.ok ? patch.splices.length : undefined,
  };
}
