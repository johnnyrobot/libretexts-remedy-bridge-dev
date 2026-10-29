import type Expert from '@libretexts/cxone-expert-node';
import { normalizePageInput, resolvePageRef } from './client.js';
import { assertWriteAllowed } from './guardrails.js';
import type { PageRef } from './types.js';

/** The mutation may have reached CXone. Reconcile before attempting another write. */
export class WriteOutcomeError extends Error {
  readonly outcome = 'unknown';
  readonly retrySafe = false;
  constructor(readonly snapshotPath?: string) {
    super('Write outcome unknown; reconcile CXone revision history before retrying.');
    this.name = 'WriteOutcomeError';
  }
}

const pending = new Map<string, Promise<void>>();
const uncertain = new Map<string, WriteOutcomeError>();
const keyFor = (page: PageRef) => `${page.hostname.toLowerCase()}/${page.id}`;

/** One process owns writes; outside editors still require CXone conditional edits. */
export async function withPageWriteLock<T>(page: PageRef, operation: () => Promise<T>): Promise<T> {
  const key = keyFor(page);
  const previous = pending.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  pending.set(key, current);
  await previous;
  try {
    const blocked = uncertain.get(key);
    if (blocked) throw blocked;
    return await operation();
  } finally {
    release();
    if (pending.get(key) === current) pending.delete(key);
  }
}

export function markWriteUncertain(page: PageRef, snapshotPath?: string): WriteOutcomeError {
  const error = new WriteOutcomeError(snapshotPath);
  uncertain.set(keyFor(page), error);
  return error;
}

/** Resolve both the supplied locator and numeric ID; authorize exactly that page. */
export async function canonicalWriteTarget(expert: Expert, input: string | number, asserted: PageRef, env: NodeJS.ProcessEnv): Promise<PageRef> {
  assertWriteAllowed(asserted, env);
  if (!Number.isSafeInteger(asserted.id) || asserted.id <= 0) throw new Error('Write target has invalid page ID');
  const normalized = normalizePageInput(input, env);
  if (typeof normalized === 'number' && normalized !== asserted.id) throw new Error('Write target mismatch');
  const resolved = await resolvePageRef(expert, normalized, env);
  if (!Number.isSafeInteger(resolved.id) || resolved.id <= 0) throw new Error('Write target has invalid canonical page ID');
  assertWriteAllowed(resolved, env);
  const canonical = await resolvePageRef(expert, resolved.id, env);
  for (const candidate of [resolved, canonical]) {
    assertWriteAllowed(candidate, env);
    if (candidate.id !== asserted.id || candidate.path !== asserted.path || candidate.hostname !== asserted.hostname) throw new Error('Write target mismatch');
  }
  return canonical;
}
