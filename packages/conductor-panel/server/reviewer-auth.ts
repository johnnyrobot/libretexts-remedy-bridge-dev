import { createPublicKey, timingSafeEqual, verify as verifySignature, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type ReviewBinding = {
  action: 'cxone.apply' | 'cxone.restore';
  target: { hostname: string; page_id: string; page_path: string };
  preview_token: string;
  before_sha256: string;
  after_sha256: string;
  fix_mode: 'deterministic' | 'pipeline' | 'restore';
  tier: 1 | 2 | 3 | null;
  snapshot: { timestamp: string; sha256: string } | null;
};

/** Locally provisioned public keys only. No JOSE discovery or private key fields. */
export type ReviewerKey = {
  kid: string; issuer: string; audience: string; environment: string; trust_epoch: string;
  kty: 'OKP'; crv: 'Ed25519'; x: string;
  not_before: number; not_after: number; enabled: boolean; revoked_at: number | null;
};
export type ReviewerConfig = {
  issuer: string; audience: string; environment: string; trust_epoch: string;
  production: boolean;
  keys: readonly ReviewerKey[];
  /** Rehydrate these from the durable ledger before admitting requests or key reload. */
  revokedKids?: ReadonlySet<string>;
};
export type ReviewerClaims = {
  v: 1; iss: string; aud: string; sub: string; iat: number; nbf: number; exp: number;
  jti: string; binding: ReviewBinding;
  /** Selected locally pinned key, for durable pre-dispatch revocation rechecks. */
  kid: string;
};

export class ReviewAuthError extends Error {
  readonly status: 401 | 403;
  constructor(readonly code: 'reviewer_assertion_invalid' | 'reviewer_binding_mismatch' = 'reviewer_assertion_invalid') {
    super(code);
    this.name = 'ReviewAuthError';
    this.status = code === 'reviewer_binding_mismatch' ? 403 : 401;
  }
}
const invalid: () => never = () => { throw new ReviewAuthError(); };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const nonempty = (value: unknown): value is string => text(value) && value.length > 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value);
const hash = (value: unknown): value is string => text(value) && /^[a-f0-9]{64}$/.test(value);
const kidPattern = /^[A-Za-z0-9._-]{1,64}$/;
const fixtureKid = 'lt1-public-test-only-v1';
const fixtureX = 'W5zBuQB8Sgsyq_zEyl3ayl2idoWdGYhPXw6irKVur3Q';

function fields(value: unknown, names: readonly string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).length !== names.length || !names.every(name => Object.hasOwn(value, name))) invalid();
}

/** Fatal UTF-8 decoding plus duplicate-name checks at every object depth. */
export function parseStrictJson(bytes: Uint8Array): unknown {
  try {
    // TextDecoder normally strips a BOM; the wire protocol explicitly forbids it.
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) invalid();
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let offset = 0;
    const whitespace = () => { while (offset < source.length && /[\x20\t\r\n]/.test(source[offset]!)) offset++; };
    function stringValue(): string {
      if (source[offset++] !== '"') invalid();
      const start = offset - 1;
      while (offset < source.length) {
        const char = source[offset++];
        if (char === '\\') { offset++; continue; }
        if (char !== '"') continue;
        const value: string = JSON.parse(source.slice(start, offset));
        for (const scalar of value) {
          const cp = scalar.codePointAt(0)!;
          if (cp >= 0xd800 && cp <= 0xdfff) invalid();
        }
        return value;
      }
      return invalid();
    }
    function value(depth: number): unknown {
      if (depth > 32) invalid();
      whitespace();
      if (source[offset] === '"') return stringValue();
      if (source[offset] === '{') {
        offset++; whitespace();
        const result: Record<string, unknown> = Object.create(null);
        if (source[offset] === '}') { offset++; return result; }
        while (true) {
          whitespace();
          const name = stringValue();
          if (Object.hasOwn(result, name)) invalid();
          whitespace();
          if (source[offset++] !== ':') invalid();
          result[name] = value(depth + 1);
          whitespace();
          const delimiter = source[offset++];
          if (delimiter === '}') return result;
          if (delimiter !== ',') invalid();
        }
      }
      if (source[offset] === '[') {
        offset++; whitespace();
        const result: unknown[] = [];
        if (source[offset] === ']') { offset++; return result; }
        while (true) {
          result.push(value(depth + 1)); whitespace();
          const delimiter = source[offset++];
          if (delimiter === ']') return result;
          if (delimiter !== ',') invalid();
        }
      }
      const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(offset))?.[0];
      if (!token) return invalid();
      offset += token.length;
      const result: unknown = JSON.parse(token);
      if (typeof result === 'number' && !Number.isFinite(result)) invalid();
      return result;
    }
    const result = value(0);
    whitespace();
    if (offset !== source.length) invalid();
    return result;
  } catch { return invalid(); }
}

function decode(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) invalid();
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) invalid();
  return bytes;
}

function bindingSchema(binding: unknown): asserts binding is ReviewBinding {
  fields(binding, ['action', 'target', 'preview_token', 'before_sha256', 'after_sha256', 'fix_mode', 'tier', 'snapshot']);
  fields(binding.target, ['hostname', 'page_id', 'page_path']);
  const target = binding.target;
  if (binding.action !== 'cxone.apply' && binding.action !== 'cxone.restore') invalid();
  if (binding.fix_mode !== 'deterministic' && binding.fix_mode !== 'pipeline' && binding.fix_mode !== 'restore') invalid();
  // DNS labels: no URL syntax, port, trailing dot, empty label or leading/trailing hyphen.
  if (!text(target.hostname) || target.hostname.length > 253 || !target.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) invalid();
  if (!text(target.page_id) || !/^[1-9]\d*$/.test(target.page_id) || !Number.isSafeInteger(Number(target.page_id))) invalid();
  if (!nonempty(target.page_path) || !nonempty(binding.preview_token) || !hash(binding.before_sha256) || !hash(binding.after_sha256)) invalid();
  if (binding.fix_mode === 'pipeline' ? binding.tier !== 1 && binding.tier !== 2 && binding.tier !== 3 : binding.tier !== null) invalid();
  if (binding.action === 'cxone.restore') {
    if (binding.fix_mode !== 'restore') invalid();
    fields(binding.snapshot, ['timestamp', 'sha256']);
    if (!text(binding.snapshot.timestamp) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(binding.snapshot.timestamp) || !Number.isFinite(Date.parse(binding.snapshot.timestamp)) || new Date(binding.snapshot.timestamp).toISOString() !== binding.snapshot.timestamp || !hash(binding.snapshot.sha256) || binding.snapshot.sha256 !== binding.after_sha256) invalid();
  } else if (binding.fix_mode === 'restore' || binding.snapshot !== null) invalid();
}

function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!object(left) || !object(right)) return false;
  const names = Object.keys(left);
  return names.length === Object.keys(right).length && names.every(name => Object.hasOwn(right, name) && equal(left[name], right[name]));
}

export class ReviewerVerifier {
  private readonly keys = new Map<string, { policy: ReviewerKey; publicKey: KeyObject }>();
  private readonly revoked = new Set<string>();
  private readonly issuer: string;
  private readonly audience: string;

  constructor(config: ReviewerConfig) {
    try {
      if (![config.issuer, config.audience, config.environment, config.trust_epoch].every(nonempty) || typeof config.production !== 'boolean' || !Array.isArray(config.keys) || !config.keys.length) invalid();
      this.issuer = config.issuer;
      this.audience = config.audience;
      for (const id of config.revokedKids ?? []) {
        if (!text(id) || !kidPattern.test(id)) invalid();
        this.revoked.add(id);
      }
      for (const entry of config.keys as readonly ReviewerKey[]) {
        fields(entry, ['kid', 'issuer', 'audience', 'environment', 'trust_epoch', 'kty', 'crv', 'x', 'not_before', 'not_after', 'enabled', 'revoked_at']);
        if (!text(entry.kid) || !kidPattern.test(entry.kid) || this.keys.has(entry.kid) || entry.kty !== 'OKP' || entry.crv !== 'Ed25519' || !text(entry.x) || decode(entry.x).length !== 32) invalid();
        if (entry.issuer !== config.issuer || entry.audience !== config.audience || entry.environment !== config.environment || entry.trust_epoch !== config.trust_epoch) invalid();
        if (!integer(entry.not_before) || !integer(entry.not_after) || entry.not_before >= entry.not_after || typeof entry.enabled !== 'boolean' || (entry.revoked_at !== null && !integer(entry.revoked_at))) invalid();
        if (config.production && (entry.kid === fixtureKid || entry.x === fixtureX)) invalid();
        const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: entry.x }, format: 'jwk' });
        if (publicKey.asymmetricKeyType !== 'ed25519') invalid();
        this.keys.set(entry.kid, { policy: { ...entry }, publicKey });
      }
    } catch { throw new Error('reviewer_configuration_invalid'); }
  }

  /** Persist this union before acknowledging reload/admission; never remove ledger tombstones. */
  effectiveRevocations(now = Math.floor(Date.now() / 1000)): string[] {
    if (!integer(now)) invalid();
    for (const { policy } of this.keys.values()) {
      if (policy.revoked_at !== null && policy.revoked_at <= now) this.revoked.add(policy.kid);
    }
    return [...this.revoked].sort();
  }

  /** Repeat immediately before durable dispatch; never cache an authorization decision. */
  verify(compact: unknown, expectedBinding: ReviewBinding, previewExpiresAt: number, now = Math.floor(Date.now() / 1000)): ReviewerClaims {
    try {
      if (!text(compact) || compact.length > 8192 || !/^[\x21-\x7e]+$/.test(compact) || !integer(now) || !integer(previewExpiresAt)) invalid();
      const segments = compact.split('.');
      if (segments.length !== 3) invalid();
      const [headerSegment, payloadSegment, signatureSegment] = segments as [string, string, string];
      const header = parseStrictJson(decode(headerSegment));
      fields(header, ['alg', 'kid', 'typ']);
      if (header.alg !== 'Ed25519' || header.typ !== 'remedy-review+jwt' || !text(header.kid) || !kidPattern.test(header.kid)) invalid();
      this.effectiveRevocations(now);
      const selected = this.keys.get(header.kid);
      if (!selected || !selected.policy.enabled || this.revoked.has(header.kid)) invalid();
      const { policy, publicKey } = selected;
      const payloadBytes = decode(payloadSegment);
      const signature = decode(signatureSegment);
      if (signature.length !== 64 || !verifySignature(null, Buffer.from(`${headerSegment}.${payloadSegment}`, 'ascii'), publicKey, signature)) invalid();
      // Payload JSON is deliberately not decoded until the received bytes verify.
      const claims = parseStrictJson(payloadBytes);
      fields(claims, ['v', 'iss', 'aud', 'sub', 'iat', 'nbf', 'exp', 'jti', 'binding']);
      if (claims.v !== 1 || claims.iss !== this.issuer || claims.aud !== this.audience || !text(claims.sub) || !/^[\x21-\x7e]{1,128}$/.test(claims.sub)) invalid();
      if (!integer(claims.iat) || !integer(claims.nbf) || !integer(claims.exp) || !text(claims.jti) || claims.jti.length !== 43 || decode(claims.jti).length !== 32) invalid();
      bindingSchema(claims.binding);
      if (claims.nbf !== claims.iat || claims.exp <= claims.iat || claims.exp - claims.iat > 60 || claims.iat > now + 5 || claims.nbf > now + 5 || now >= claims.exp || claims.exp > previewExpiresAt) invalid();
      if (claims.iat < policy.not_before || claims.exp > policy.not_after || now < policy.not_before || now >= policy.not_after) invalid();
      if (!equal(claims.binding, expectedBinding)) throw new ReviewAuthError('reviewer_binding_mismatch');
      return { ...claims, kid: header.kid } as ReviewerClaims;
    } catch (error) {
      if (error instanceof ReviewAuthError) throw error;
      return invalid();
    }
  }
}

/** Read once at startup. Only 32 random bytes encoded as 64 lowercase hex plus optional LF. */
export function readServiceKey(path: string): Buffer {
  try {
    const bytes = readFileSync(path);
    if (bytes.length !== 64 && bytes.length !== 65) throw new Error();
    const encoded = bytes.toString('utf8');
    if (!/^[0-9a-f]{64}\n?$/.test(encoded)) throw new Error();
    return Buffer.from(encoded.slice(0, 64), 'hex');
  } catch { throw new Error('service_key_configuration_invalid'); }
}

/** Use rawHeaders, before Node/framework header coalescing, including unknown routes. */
export function authenticateService(rawHeaders: readonly string[], key: Uint8Array): boolean {
  if (key.length !== 32 || rawHeaders.length % 2 !== 0) return false;
  let supplied: string | undefined;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]!.toLowerCase() !== 'x-remedy-service-key') continue;
    if (supplied !== undefined) return false;
    supplied = rawHeaders[index + 1];
  }
  if (supplied === undefined || !/^[0-9a-f]{64}$/.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(supplied, 'hex'), key);
}
