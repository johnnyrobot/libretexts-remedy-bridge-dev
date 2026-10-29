import { PreviewCache, PreviewPool } from './preview-cache.js';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createExpertClient, resolvePageRef, fetchPageHtml, writePageRevision, revertPage, WriteOutcomeError, type PageRef, type SnapshotEntry, WriteEligibilityError } from '@libretexts/remedy-core';
import { DurableLedger, LedgerError, type Reason } from './durable-ledger.js';
import { ReviewerVerifier, ReviewAuthError, type ReviewBinding } from './reviewer-auth.js';

export type ReviewedPreview = {
  token: string; expiresAt: number; pageId: number; pagePath: string; hostname: string;
  beforeHtml: string; afterHtml: string; mode: 'deterministic' | 'pipeline' | 'restore';
  tier: 1 | 2 | 3 | null; noiseOnlyChange?:boolean; snapshotTs?: string; rules: string[];
};
type StoredPreview = ReviewedPreview & { binding: ReviewBinding };
export class SignedRequestError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) { super(String(body.error)); }
}
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
function rejected(status: number, error: string, invalidate = false): never { throw new SignedRequestError(status, {
  error, outcome: 'not_attempted', retryable: false, operation_id: null,
  evidence_effect: invalidate ? 'invalidate' : 'preserve',
}); }

/** Owns the signed HTTP lifecycle. Legacy HTTP handlers cannot invoke this writer. */
export class SignedWriter {
  private admitting = true;
  private reloadGeneration = 0;
  private readonly observedRevocations = new Set<string>();
  private readonly previews: PreviewCache<StoredPreview>;
  private readonly productionWriteBlocked: boolean;
  private constructor(readonly ledger: DurableLedger, private verifier: ReviewerVerifier, private readonly env: NodeJS.ProcessEnv, pool:PreviewPool) {
    this.previews=new PreviewCache<StoredPreview>(pool);
    this.productionWriteBlocked = !['development', 'test'].includes(env.NODE_ENV ?? '');
  }
  static async open(verifier: ReviewerVerifier, env: NodeJS.ProcessEnv = process.env, pool = new PreviewPool()) {
    const db = env.REMEDY_CLAIM_DB, fence = env.REMEDY_CLAIM_FENCE_DIR, epoch = env.REMEDY_REVIEWER_TRUST_EPOCH;
    if (!db || basename(db) !== 'claims.sqlite3' || !fence || !epoch) throw new Error('claim_store_unavailable');
    const ledger = await DurableLedger.open({ directory: dirname(db), fencePath: join(fence, 'fence.json'), trustEpoch: epoch });
    try {
      await ledger.recordRevocations(verifier.effectiveRevocations());
      verifier.rememberRevocations(await ledger.getRevocations());
      const writer = new SignedWriter(ledger, verifier, env, pool);
      return writer;
    } catch { await ledger.close(); throw new Error('claim_store_unavailable'); }
  }
  preview(input: ReviewedPreview) {
    for (const [token, p] of this.previews) if (p.expiresAt <= Date.now()) this.previews.consume(token);
    const after = digest(input.afterHtml);
    const binding: ReviewBinding = { action: input.mode === 'restore' ? 'cxone.restore' : 'cxone.apply',
      target: { hostname: input.hostname, page_id: String(input.pageId), page_path: input.pagePath }, preview_token: input.token,
      before_sha256: digest(input.beforeHtml), after_sha256: after, fix_mode: input.mode, tier: input.tier,
      snapshot: input.mode === 'restore' ? { timestamp: input.snapshotTs!, sha256: after } : null };
    this.previews.set(input.token, { ...input, binding });
    return { review_binding: binding, review_expires_at: Math.floor(input.expiresAt / 1000),
      page_id: input.pageId, page_path: input.pagePath, hostname: input.hostname };
  }
  invalidate(token: string) { this.previews.consume(token); }
  async ready() {
    if (this.productionWriteBlocked || !this.admitting || !this.ledger.ready) return false;
    try {
      const generation = this.reloadGeneration, verifier = this.verifier;
      verifier.rememberRevocations(this.observedRevocations);
      const now = Math.floor(Date.now() / 1000);
      const active = verifier.hasActiveKey(now);
      await this.persistRevocations(verifier, now);
      return this.admitting && generation === this.reloadGeneration && active && await this.readable();
    } catch { return false; }
  }
  async readable() {
    if (!this.ledger.ready) return false;
    try { await this.ledger.status({ issuer: '', jti: '' }); return true; } catch { return false; }
  }
  async status(body: Record<string, unknown>) {
    if (Object.keys(body).length !== 2 || !this.verifier.matchesIssuer(body.issuer) || typeof body.issuer !== 'string' || typeof body.jti !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.jti) || Buffer.from(body.jti, 'base64url').toString('base64url') !== body.jti) rejected(400, 'invalid_request');
    const status = await this.ledger.status({ issuer: body.issuer, jti: body.jti });
    if (!status) throw new SignedRequestError(404, { error: 'operation_not_found' });
    return status;
  }
  pause() { this.admitting = false; return ++this.reloadGeneration; }
  async reload(verifier: ReviewerVerifier, generation = this.pause()) {
    await this.persistRevocations(verifier);
    verifier.rememberRevocations(await this.ledger.getRevocations());
    verifier.rememberRevocations(this.observedRevocations);
    if (generation !== this.reloadGeneration) throw new Error('reviewer_reload_superseded');
    this.verifier = verifier;
    this.admitting = true;
  }
  private collectRevocations(verifier: ReviewerVerifier, now?: number) {
    for (const kid of verifier.effectiveRevocations(now)) this.observedRevocations.add(kid);
  }
  private async persistRevocations(verifier = this.verifier, now?: number) {
    this.collectRevocations(verifier, now);
    await this.ledger.recordRevocations([...this.observedRevocations]);
  }
  private verify(assertion: unknown, preview: StoredPreview) {
    const verifier = this.verifier;
    verifier.rememberRevocations(this.observedRevocations);
    const now = Math.floor(Date.now() / 1000);
    try { return verifier.verify(assertion, preview.binding, Math.floor(preview.expiresAt / 1000), now); }
    finally { this.collectRevocations(verifier, now); }
  }
  private async authorize(assertion: unknown, preview: StoredPreview) {
    if (!this.admitting) throw new ReviewAuthError();
    await this.persistRevocations();
    const claims = this.verify(assertion, preview);
    if (await this.ledger.isRevoked(claims.kid)) throw new ReviewAuthError();
    return claims;
  }
  async mutate(action: 'cxone.apply' | 'cxone.restore', body: Record<string, unknown>, pageInput: string | number) {
    if (this.productionWriteBlocked) rejected(503, 'conditional_write_unproven');
    if (!this.admitting) rejected(503, 'reviewer_configuration_unavailable');
    if (typeof body.preview_token !== 'string' || !body.preview_token) rejected(409, 'preview_required');
    if ('reviewerAssertion' in body || 'previewToken' in body || 'previewHash' in body || 'fixMode' in body) rejected(400, 'invalid_request');
    const preview = this.previews.get(body.preview_token);
    if (!preview || preview.expiresAt <= Date.now()) rejected(409, 'expired_preview');
    // Verification is synchronous, so the token is consumed before any awaited eligibility read.
    let claims;
    try { claims = this.verify(body.reviewer_assertion, preview); }
    catch (error) {
      // An observed revocation remains effective after clock rollback/restart.
      await this.persistRevocations();
      throw error;
    }
    this.previews.consume(body.preview_token);
    // Persist observations before action or claim rejection can exit this path.
    await this.persistRevocations();
    if (preview.binding.action !== action) rejected(403, 'reviewer_binding_mismatch');
    const operation = await this.ledger.claim({ issuer: claims.iss, jti: claims.jti, preview_token: preview.token,
      subject: claims.sub, expires_at: claims.exp, target: preview.binding.target, binding: preview.binding });
    let started = false;
    let revertedFrom: string | undefined;
    const unavailable = () => new SignedRequestError(503, { error: 'claim_store_unavailable', outcome: 'pending', operation_id: operation.operation_id, retryable: false, evidence_effect: 'hold' });
    const terminal = async (reason: Reason, status: number, error: string): Promise<never> => {
      let result;
      try { result = await this.ledger.finish(operation.operation_id, { outcome: 'not_attempted', reason }); }
      catch { throw unavailable(); }
      throw new SignedRequestError(status, { ...result, error });
    };
    try {
      if (body.preview_hash !== createHash('sha256').update(preview.beforeHtml).digest('hex').slice(0, 16) || (body.fix_mode !== undefined && body.fix_mode !== preview.mode) || (body.tier !== undefined && body.tier !== preview.tier)) return await terminal('stale_preview', 409, 'stale_preview');
      const expert = createExpertClient(this.env);
      const supplied = await resolvePageRef(expert, pageInput, this.env);
      const canonical = await resolvePageRef(expert, preview.pageId, this.env);
      if (![supplied, canonical].every(p => this.matches(p, preview))) return await terminal('target_mismatch', 409, 'target_mismatch');
      const current = await fetchPageHtml(expert, canonical.id);
      if (current !== preview.beforeHtml) return await terminal('stale_preview', 409, 'stale_preview');
      if (preview.mode === 'restore') {
        const restored = await revertPage(canonical.id, { dryRun: true, snapshotTs: preview.snapshotTs, expert, env: this.env, expectedTarget: canonical });
        revertedFrom = restored.snapshotUsed.metaPath;
        if (restored.revertedToHtml !== preview.afterHtml || restored.snapshotUsed.ts !== preview.snapshotTs) return await terminal('stale_preview', 409, 'stale_preview');
      }
      await this.authorize(body.reviewer_assertion, preview);
      const result = await writePageRevision({ expert, pageInput: canonical.id, page: canonical,
        beforeHtml: preview.beforeHtml, noiseOnlyChange:preview.noiseOnlyChange, afterHtml: preview.afterHtml, rules: preview.rules, env: this.env,
        revisionSummary: preview.mode === 'restore' ? `Remedy: restore reviewed snapshot ${preview.snapshotTs}` : 'Remedy: apply signed reviewed output',
        source: preview.mode === 'restore' ? 'revert' : preview.mode === 'pipeline' ? 'pipeline' : 'fix',
        mode: preview.mode === 'restore' ? 'revert' : 'apply', requestedBy: claims.sub, revertedFrom,
        reviewer: { issuer: claims.iss, subject: claims.sub },
        beforeDispatch: async (snapshot: SnapshotEntry) => {
          await syncSnapshot(snapshot);
          await this.authorize(body.reviewer_assertion, preview);
          await this.ledger.start(operation.operation_id, { snapshot_path: snapshot.metaPath });
          started = true;
          // Failure after the durable marker is unknown, including failure before actual send.
          if (!this.admitting) throw new ReviewAuthError();
          this.verify(body.reviewer_assertion, preview);
          if (!this.ledger.ready) throw new LedgerError('claim_store_unavailable');
        },
      });
      await this.persistRevocations();
      return await this.ledger.finish(operation.operation_id, result.written
        ? { outcome: 'known_success', audit_recorded: result.auditRecorded === true, cxone_revision_id: result.cxoneRevisionId === undefined ? undefined : String(result.cxoneRevisionId) }
        : { outcome: 'not_attempted', reason: 'no_change' });
    } catch (error) {
      // Verification can first observe a scheduled revocation after any await.
      // Persist every observed tombstone before acknowledging any rejection/outcome.
      if (this.ledger.ready) { try { await this.persistRevocations(); } catch { /* globally unavailable below */ } }
      if (!this.ledger.ready) throw unavailable();
      if (error instanceof SignedRequestError) throw error;
      if (started || error instanceof WriteOutcomeError) {
        let result;
        try { result = await this.ledger.finish(operation.operation_id, { outcome: 'unknown_write' }); }
        catch { throw unavailable(); }
        throw new SignedRequestError(502, { ...result, error: 'write_outcome_unknown' });
      }
      const reason: Reason = error instanceof WriteEligibilityError ? error.reason : 'pre_dispatch_failure';
      return await terminal(reason, error instanceof ReviewAuthError ? error.status : 409, error instanceof ReviewAuthError ? error.code : reason);
    }
  }
  private matches(page: PageRef, preview: StoredPreview) { return page.id === preview.pageId && page.path === preview.pagePath && page.hostname === preview.hostname; }
  async close() { await this.ledger.close(); }
}

async function syncSnapshot(snapshot: SnapshotEntry) {
  for (const path of [snapshot.htmlPath, snapshot.metaPath]) {
    const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); }
  }
  // saveSnapshot creates directories recursively: flush each containing entry,
  // including the parent of a newly created root, before marking dispatch durable.
  let directory = dirname(resolve(snapshot.metaPath));
  while (true) {
    const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}
