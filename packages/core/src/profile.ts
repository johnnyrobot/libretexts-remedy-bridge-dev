export type BridgeProfile = 'full-write' | 'review-only';
function configured(env: NodeJS.ProcessEnv): BridgeProfile {
  const value = env.REMEDY_BRIDGE_PROFILE ?? 'full-write';
  if (value !== 'full-write' && value !== 'review-only') throw new Error('bridge_profile_invalid');
  return value;
}
// A review-only process cannot reopen writes by changing NODE_ENV or call options.
let reviewOnlyLatched = configured(process.env) === 'review-only';
export function readBridgeProfile(env: NodeJS.ProcessEnv = process.env): BridgeProfile {
  const selected = configured(env);
  if (selected === 'review-only') reviewOnlyLatched = true;
  return reviewOnlyLatched ? 'review-only' : selected;
}
export class ReviewOnlyProfileError extends Error {
  readonly status = 503;
  readonly body = { error: 'review_only_profile', outcome: 'not_attempted', evidence_effect: 'preserve', retryable: false, operation_id: null };
  constructor() { super('Automatic CXone apply and restore are unavailable in the review-only profile.'); this.name = 'ReviewOnlyProfileError'; }
}
export function assertMutationProfileAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (readBridgeProfile(env) === 'review-only') throw new ReviewOnlyProfileError();
}
