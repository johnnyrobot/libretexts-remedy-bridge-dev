import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authenticateService, parseStrictJson, readServiceKey, ReviewAuthError, ReviewerVerifier, type ReviewerConfig, type ReviewBinding } from '../../../conductor-panel/server/reviewer-auth.js';

const corpus = JSON.parse(readFileSync(new URL('../../../../docs/proposals/lt-1-reviewer-wire-v1-vectors.json', import.meta.url), 'utf8'));
const issuer = 'urn:libretexts:conductor:test';
const audience = 'urn:libretexts:remedy-bridge:test';
const environment = 'test';
const trust_epoch = 'synthetic-epoch-1';

function verifier(vector = corpus.positive[0]) {
  return new ReviewerVerifier({ issuer, audience, environment, trust_epoch, production: false, keys: [{
    kid: corpus.kid, issuer, audience, environment, trust_epoch,
    kty: 'OKP', crv: 'Ed25519', x: corpus.public_jwk.x, ...vector.context.key_policy,
  }] });
}

const defaultVector = corpus.positive[0];
const defaultPayload = JSON.parse(Buffer.from(defaultVector.payload_bytes_base64url, 'base64url').toString('utf8'));
const syntheticKeys = generateKeyPairSync('ed25519');
const syntheticPublic = syntheticKeys.publicKey.export({ format: 'jwk' });
function config(): ReviewerConfig {
  return { issuer, audience, environment, trust_epoch, production: false, keys: [{
    kid: 'synthetic-reviewer-key', issuer, audience, environment, trust_epoch,
    kty: 'OKP', crv: 'Ed25519', x: syntheticPublic.x!, ...defaultVector.context.key_policy,
  }] };
}
function signed(payload = defaultPayload, header: unknown = { alg: 'Ed25519', kid: 'synthetic-reviewer-key', typ: 'remedy-review+jwt' }) {
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${input}.${sign(null, Buffer.from(input, 'ascii'), syntheticKeys.privateKey).toString('base64url')}`;
}
function verify(compact: unknown, instance = new ReviewerVerifier(config()), binding = defaultVector.context.expected_binding, expires = defaultVector.context.preview_expires_at, now = defaultVector.context.now) {
  return instance.verify(compact, binding as ReviewBinding, expires, now);
}

describe('native reviewer verification', () => {
  it('accepts the exact frozen reviewed apply bytes', () => {
    const vector = corpus.positive[0];
    const claims = verifier(vector).verify(vector.compact, vector.context.expected_binding as ReviewBinding, vector.context.preview_expires_at, vector.context.now);
    expect(claims.sub).toBe('synthetic-reviewer-42');
    expect(claims.binding).toEqual(vector.context.expected_binding);
  });

  it.each(corpus.positive)('accepts frozen $name through the product verifier', vector => {
    expect(verifier(vector).verify(vector.compact, vector.context.expected_binding, vector.context.preview_expires_at, vector.context.now).binding).toEqual(vector.context.expected_binding);
  });
  it.each(corpus.negative)('rejects frozen $name through the product verifier', vector => {
    expect(() => verifier(vector).verify(vector.compact, vector.context.expected_binding, vector.context.preview_expires_at, vector.context.now)).toThrow(ReviewAuthError);
    try {
      verifier(vector).verify(vector.compact, vector.context.expected_binding, vector.context.preview_expires_at, vector.context.now);
    } catch (error) {
      expect(error).toMatchObject({ status: vector.expected === 'binding' ? 403 : 401, code: vector.expected === 'binding' ? 'reviewer_binding_mismatch' : 'reviewer_assertion_invalid' });
    }
  });

  it('does not accept a line terminator in a signed reviewer subject', () => {
    expect(() => verify(signed({ ...defaultPayload, sub: 'reviewer\n' }))).toThrow(ReviewAuthError);
  });

  it('accepts independently signed received JSON member order and whitespace', () => {
    const header = '{ "typ":"remedy-review+jwt", "kid":"synthetic-reviewer-key", "alg":"Ed25519" }';
    const payload = JSON.stringify(defaultPayload, null, 2);
    const input = `${Buffer.from(header).toString('base64url')}.${Buffer.from(payload).toString('base64url')}`;
    const compact = `${input}.${sign(null, Buffer.from(input, 'ascii'), syntheticKeys.privateKey).toString('base64url')}`;
    const reversed = Object.fromEntries(Object.entries(defaultVector.context.expected_binding).reverse());
    expect(verify(compact, undefined, reversed).sub).toBe('synthetic-reviewer-42');
  });

  it.each([undefined, null, 3, [], '', ' ', 'a.b', 'a.b.c.d', 'a..c', 'a.b.c=', 'é.b.c', 'a'.repeat(8193)])('rejects invalid assertion transport %j', compact => {
    expect(() => verify(compact)).toThrow(ReviewAuthError);
  });

  it.each([
    ['array audience', { aud: [audience] }],
    ['empty subject', { sub: '' }],
    ['long subject', { sub: 'x'.repeat(129) }],
    ['spaced subject', { sub: 'two words' }],
    ['unsafe timestamp', { iat: Number.MAX_SAFE_INTEGER + 1 }],
    ['noncanonical nonce', { jti: 'A'.repeat(42) + 'B' }],
    ['unknown claim', { environment }],
    ['array binding', { binding: [] }],
  ])('rejects signed %s', (_label, changes) => {
    expect(() => verify(signed({ ...defaultPayload, ...changes }))).toThrow(ReviewAuthError);
  });

  it('enforces five seconds future skew, strict expiry and authoritative integer preview expiry', () => {
    const now = defaultVector.context.now;
    expect(verify(signed({ ...defaultPayload, iat: now + 5, nbf: now + 5, exp: now + 60 }))).toMatchObject({ iat: now + 5 });
    expect(() => verify(signed({ ...defaultPayload, iat: now + 6, nbf: now + 6, exp: now + 60 }))).toThrow(ReviewAuthError);
    expect(() => verify(signed(), undefined, undefined, undefined, defaultPayload.exp)).toThrow(ReviewAuthError);
    expect(() => verify(signed(), undefined, undefined, defaultPayload.exp - 1)).toThrow(ReviewAuthError);
    expect(() => verify(signed(), undefined, undefined, defaultPayload.exp + 0.5)).toThrow(ReviewAuthError);
  });

  it.each([
    { action: 'cxone.restore' },
    { target: { ...defaultPayload.binding.target, page_id: 42 } },
    { target: { ...defaultPayload.binding.target, page_id: '9007199254740992' } },
    { target: { ...defaultPayload.binding.target, hostname: 'EXAMPLE.org' } },
    { target: { ...defaultPayload.binding.target, hostname: 'example.org.' } },
    { target: { ...defaultPayload.binding.target, hostname: 'example..org' } },
    { target: { ...defaultPayload.binding.target, hostname: 'example.org:443' } },
    { before_sha256: 'A'.repeat(64) },
    { tier: 1 },
    { snapshot: {} },
    { fix_mode: 'pipeline', tier: 4 },
  ])('rejects malformed signed binding %j', changes => {
    expect(() => verify(signed({ ...defaultPayload, binding: { ...defaultPayload.binding, ...changes } }))).toThrow(ReviewAuthError);
  });

  it('separates a signed binding mismatch from a malformed assertion without echoing input', () => {
    try {
      verify(signed(), undefined, { ...defaultPayload.binding, preview_token: 'another-preview' });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toMatchObject({ status: 403, code: 'reviewer_binding_mismatch', message: 'reviewer_binding_mismatch' });
    }
  });

  it('checks expiry again at pre-dispatch instead of retaining successful authorization', () => {
    const instance = new ReviewerVerifier(config());
    expect(verify(signed(), instance).sub).toBe('synthetic-reviewer-42');
    expect(() => verify(signed(), instance, undefined, undefined, defaultPayload.exp)).toThrow(ReviewAuthError);
  });
});

describe('pinned reviewer key configuration and effective revocation', () => {
  it('accepts fresh synthetic production Ed25519 keys', () => {
    expect(() => new ReviewerVerifier({ ...config(), production: true })).not.toThrow();
  });
  it('rejects either the public fixture ID or its public key in production even when renamed', () => {
    const current = config();
    for (const changes of [{ kid: corpus.kid }, { x: corpus.public_jwk.x }]) {
      expect(() => new ReviewerVerifier({ ...current, production: true, keys: [{ ...current.keys[0]!, ...changes }] })).toThrow('reviewer_configuration_invalid');
    }
  });
  it.each([
    { issuer: 'foreign' }, { audience: 'foreign' }, { environment: 'foreign' }, { trust_epoch: 'foreign' },
    { kty: 'RSA' }, { crv: 'Ed448' }, { x: 'not-a-valid-key' }, { kid: '../key' },
    { not_before: 100, not_after: 100 }, { not_before: 0.5 }, { revoked_at: 0.5 }, { enabled: 'true' },
    { private_key: 'forbidden' },
  ])('rejects invalid or foreign key policy %j', changes => {
    const current = config();
    expect(() => new ReviewerVerifier({ ...current, keys: [{ ...current.keys[0]!, ...changes } as never] })).toThrow('reviewer_configuration_invalid');
  });
  it('rejects missing configuration and duplicate key IDs', () => {
    for (const changes of [{ issuer: '' }, { audience: '' }, { environment: '' }, { trust_epoch: '' }, { keys: [] }, { keys: [config().keys[0]!, config().keys[0]!] }]) {
      expect(() => new ReviewerVerifier({ ...config(), ...changes })).toThrow('reviewer_configuration_invalid');
    }
  });
  it('never re-enables an effectively revoked key after a clock rollback or restart', () => {
    const current = config();
    const now = defaultVector.context.now;
    current.keys = [{ ...current.keys[0]!, revoked_at: now + 1 }];
    const instance = new ReviewerVerifier(current);
    expect(verify(signed(), instance).sub).toBe('synthetic-reviewer-42');
    const persisted = instance.effectiveRevocations(now + 1);
    expect(persisted).toEqual(['synthetic-reviewer-key']);
    expect(() => verify(signed(), instance)).toThrow(ReviewAuthError);
    const restarted = new ReviewerVerifier({ ...config(), revokedKids: new Set(persisted) });
    expect(() => verify(signed(), restarted)).toThrow(ReviewAuthError);
    expect(restarted.effectiveRevocations(now)).toEqual(persisted);
  });
  it('installs independent configuration so a file object mutation is not a key reload', () => {
    const current = config();
    const instance = new ReviewerVerifier(current);
    current.keys[0]!.enabled = false;
    expect(verify(signed(), instance).sub).toBe('synthetic-reviewer-42');
    expect(() => verify(signed(), new ReviewerVerifier(current))).toThrow(ReviewAuthError);
  });
});

describe('strict JSON wire parsing', () => {
  const parse = (source: string) => parseStrictJson(Buffer.from(source, 'utf8'));
  it('preserves valid strings, scalar types, prototype-looking names and paired Unicode', () => {
    expect(parse(' {"__proto__":{"safe":true},"unicode":"\\ud83d\\ude00","array":[null,false,1.5]} \r\n')).toEqual({
      ['__proto__']: { safe: true }, unicode: '😀', array: [null, false, 1.5],
    });
  });
  it.each([
    '{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"outer":{"x":1,"x":2}}', '[{"x":1,"x":2}]',
    '"\\ud800"', '"\\udfff"', '{"\\ud800":1}', '"raw\nnewline"',
    '\ufeff{}', '{}{}', '{"a":1,}', '[1,]', '{"a":01}', 'undefined', '1e309', '',
    '"\\x41"', '{"a":true} garbage', '"unterminated', '[[[[',
  ])('rejects malformed/ambiguous JSON %j', source => {
    expect(() => parse(source)).toThrow(ReviewAuthError);
  });
  it.each([[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf0, 0x28, 0x8c, 0xbc], [0xff]])('rejects invalid UTF-8 %j', (...bytes) => {
    expect(() => parseStrictJson(Buffer.from(bytes))).toThrow(ReviewAuthError);
  });
  it('allows depth 32 and rejects depth 33 before recursion can grow unbounded', () => {
    expect(() => parse('['.repeat(32) + '0' + ']'.repeat(32))).not.toThrow();
    expect(() => parse('['.repeat(33) + '0' + ']'.repeat(33))).toThrow(ReviewAuthError);
  });
});

describe('service hop authentication', () => {
  const encoded = '19'.repeat(32);
  const key = Buffer.from(encoded, 'hex');
  it('rejects line terminators on the HTTP credential', () => {
    expect(authenticateService(['X-Remedy-Service-Key', encoded + '\n'], key)).toBe(false);
  });
  it('accepts exactly one correct credential with HTTP case-insensitive name', () => {
    expect(authenticateService(['Host', 'localhost', 'x-ReMeDy-SeRvIcE-kEy', encoded], key)).toBe(true);
  });
  it.each([
    [], ['X-API-Key', encoded], ['X-Remedy-Service-Key', ''], ['X-Remedy-Service-Key', '29'.repeat(32)],
    ['X-Remedy-Service-Key', encoded, 'x-remedy-service-key', encoded],
    ['X-Remedy-Service-Key', encoded + ', ' + encoded], ['X-Remedy-Service-Key', encoded + ' '],
    ['X-Remedy-Service-Key', 'ABCDEF'.repeat(10) + 'ABCD'], ['X-Remedy-Service-Key', encoded.slice(1)],
  ].map(headers => ({ headers })))('rejects missing, malformed, incorrect or duplicate credentials $headers', ({ headers }) => {
    expect(authenticateService(headers, key)).toBe(false);
  });
  it('rejects malformed raw header pairs and keys of the wrong length', () => {
    expect(authenticateService(['X-Remedy-Service-Key'], key)).toBe(false);
    expect(authenticateService(['X-Remedy-Service-Key', encoded], Buffer.alloc(31))).toBe(false);
  });
  it('loads only the fixed lowercase hex service key and optional one LF, with safe failures', () => {
    const directory = mkdtempSync(join(tmpdir(), 'remedy-service-key-test-'));
    const path = join(directory, 'synthetic-service-key');
    try {
      for (const value of [encoded, encoded + '\n']) {
        writeFileSync(path, value);
        expect(readServiceKey(path)).toEqual(key);
      }
      for (const value of ['', encoded + '\r\n', encoded + '\n\n', encoded + ' ', ' ' + encoded, 'ABCDEF'.repeat(10) + 'ABCD', 'g'.repeat(64), encoded.slice(1), '\ufeff' + encoded]) {
        writeFileSync(path, value);
        expect(() => readServiceKey(path)).toThrow('service_key_configuration_invalid');
      }
      expect(() => readServiceKey(join(directory, 'missing'))).toThrow('service_key_configuration_invalid');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
