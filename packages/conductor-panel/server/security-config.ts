import { readFileSync } from 'node:fs';
import { ReviewerVerifier, parseStrictJson, readServiceKey, type ReviewerConfig } from './reviewer-auth.js';

/** Required mode is immutable for a process lifetime. Invalid values never select local mode. */
export function loadSecurity(env: NodeJS.ProcessEnv = process.env) {
  const value = env.REMEDY_REVIEWER_REQUIRED;
  if (value !== undefined && value !== 'true' && value !== 'false') throw new Error('reviewer_configuration_invalid');
  const production = env.NODE_ENV === 'production';
  if (production && value !== 'true') throw new Error('reviewer_configuration_invalid');
  const required = value === 'true';
  if (!required) return { required, serviceKey: null, verifier: null };
  try {
    const config = parseStrictJson(readFileSync(env.REMEDY_REVIEWER_KEYRING_FILE!)) as ReviewerConfig;
    if (!env.REMEDY_REVIEWER_TRUST_EPOCH || config.trust_epoch !== env.REMEDY_REVIEWER_TRUST_EPOCH) throw new Error();
    if (production && config.environment !== 'production') throw new Error();
    return { required, serviceKey: readServiceKey(env.REMEDY_BRIDGE_SERVICE_KEY_FILE!), verifier: new ReviewerVerifier({ ...config, production }) };
  } catch { throw new Error('reviewer_configuration_invalid'); }
}
