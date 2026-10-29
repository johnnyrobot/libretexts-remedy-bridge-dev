// PUBLIC, deterministic, forgeable TEST MATERIAL. No product imports or real keys.
// This fixture generator is not a Conductor signer or Bridge verifier.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const phrase = 'LibreTexts LT-1 PUBLIC TEST KEY - never use in production';
const seed = createHash('sha256').update(phrase, 'utf8').digest();
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
const publicKey = createPublicKey(privateKey);
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const encode = bytes => Buffer.from(bytes).toString('base64url');
const header = { alg: 'Ed25519', kid: 'lt1-public-test-only-v1', typ: 'remedy-review+jwt' };
const before = '<p>Example</p>\n<img src="/test.png">';
const after = '<p>Example</p>\n<img src="/test.png" alt="Test diagram">';
const binding = {
  action: 'cxone.apply', target: { hostname: 'dev.libretexts.org', page_id: '42', page_path: 'Sandboxes/johnnyphung/LT-1-fixture' },
  preview_token: '00000000-0000-4000-8000-000000000001', before_sha256: sha256(before), after_sha256: sha256(after),
  fix_mode: 'deterministic', tier: null, snapshot: null,
};
const claims = { v: 1, iss: 'urn:libretexts:conductor:test', aud: 'urn:libretexts:remedy-bridge:test', sub: 'synthetic-reviewer-42',
  iat: 1793255340, nbf: 1793255340, exp: 1793255400, jti: Buffer.alloc(32, 1).toString('base64url'), binding };
const restore = { ...claims, jti: Buffer.alloc(32, 2).toString('base64url'), binding: { ...binding,
  action: 'cxone.restore', fix_mode: 'restore', preview_token: '00000000-0000-4000-8000-000000000002',
  before_sha256: sha256(after), after_sha256: sha256(before), snapshot: { timestamp: '2026-10-29T06:00:00.000Z', sha256: sha256(before) } } };
const pipeline = { ...claims, jti: Buffer.alloc(32, 3).toString('base64url'), binding: { ...binding, fix_mode: 'pipeline', tier: 1 } };
const baseContext = { now: 1793255370, expected_binding: binding, preview_expires_at: 1793255500,
  key_policy: { enabled: true, not_before: 1793255240, not_after: 1793255500, revoked_at: null } };
function signedCase(name, payload = claims, options = {}) {
  const headerBytes = options.header_bytes ?? Buffer.from(options.header_json ?? JSON.stringify(header));
  const payloadBytes = options.payload_bytes ?? Buffer.from(options.payload_json ?? JSON.stringify(payload));
  const h = options.header_segment ?? encode(headerBytes), p = options.payload_segment ?? encode(payloadBytes);
  const signing_input = `${h}.${p}`;
  const signature = sign(null, Buffer.from(signing_input, 'ascii'), privateKey);
  assert.equal(signature.length, 64);
  assert.equal(verify(null, Buffer.from(signing_input, 'ascii'), publicKey, signature), true);
  return { name, header_bytes_base64url: encode(headerBytes), payload_bytes_base64url: encode(payloadBytes), signing_input,
    compact: `${signing_input}.${encode(signature)}`, raw_signature_valid: true,
    expected: options.expected ?? 'accept', context: { ...baseContext, ...options.context } };
}
const positive = [signedCase('valid-apply'), signedCase('valid-restore', restore, { context: { expected_binding: restore.binding } }),
  signedCase('valid-pipeline', pipeline, { context: { expected_binding: pipeline.binding } })];
const negative = [];
const reject = (name, payload, expected, options = {}) => negative.push(signedCase(name, payload, { ...options, expected }));
reject('missing-version', Object.fromEntries(Object.entries(claims).filter(([key]) => key !== 'v')), 'schema');
reject('unknown-top-member', { ...claims, extra: true }, 'schema');
reject('version-string', { ...claims, v: '1' }, 'schema');
reject('nested-extra-member', { ...claims, binding: { ...binding, target: { ...binding.target, extra: true } } }, 'schema');
reject('unsafe-integer-time', { ...claims, iat: 9007199254740992 }, 'schema');
reject('fractional-time', { ...claims, iat: claims.iat + 0.5 }, 'schema');
reject('audience-array', { ...claims, aud: [claims.aud] }, 'schema');
reject('wrong-audience', { ...claims, aud: 'urn:libretexts:remedy-bridge:other' }, 'claims');
reject('wrong-issuer', { ...claims, iss: 'urn:libretexts:conductor:other' }, 'claims');
reject('expired', claims, 'time', { context: { now: claims.exp } });
reject('future-issued', claims, 'time', { context: { now: claims.iat - 6 } });
reject('lifetime-61-seconds', { ...claims, exp: claims.iat + 61 }, 'time');
reject('zero-lifetime', { ...claims, exp: claims.iat }, 'time');
reject('nbf-differs-from-iat', { ...claims, nbf: claims.iat + 1 }, 'time');
reject('exceeds-preview-expiry', claims, 'time', { context: { preview_expires_at: claims.exp - 1 } });
reject('action-swap', restore, 'binding');
reject('changed-target', { ...claims, binding: { ...binding, target: { ...binding.target, page_id: '43' } } }, 'binding');
reject('changed-output', { ...claims, binding: { ...binding, after_sha256: sha256('<p>Unreviewed</p>') } }, 'binding');
reject('changed-tier', { ...pipeline, binding: { ...pipeline.binding, tier: 2 } }, 'binding', { context: { expected_binding: pipeline.binding } });
reject('leading-zero-page-id', { ...claims, binding: { ...binding, target: { ...binding.target, page_id: '042' } } }, 'schema');
reject('duplicate-protected-header', claims, 'json', { header_json: '{"alg":"Ed25519","\\u0061lg":"Ed25519","kid":"lt1-public-test-only-v1","typ":"remedy-review+jwt"}' });
reject('duplicate-payload', claims, 'json', { payload_json: JSON.stringify(claims).replace('"v":1,', '"v":1,"v":1,') });
reject('duplicate-nested-payload', claims, 'json', { payload_json: JSON.stringify(claims).replace('"hostname":"dev.libretexts.org",', '"hostname":"dev.libretexts.org","hostname":"dev.libretexts.org",') });
reject('escaped-unpaired-surrogate', claims, 'json', { payload_json: JSON.stringify(claims).replace('synthetic-reviewer-42', '\\ud800') });
reject('invalid-header-json', claims, 'json', { header_json: '{"alg":"Ed25519",}' });
reject('payload-byte-order-mark', claims, 'encoding', { payload_bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(claims))]) });
reject('header-byte-order-mark', claims, 'encoding', { header_bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(header))]) });
reject('invalid-payload-utf8', claims, 'encoding', { payload_bytes: Buffer.from([0xc3, 0x28]) });
reject('wrong-algorithm-EdDSA', claims, 'header', { header_json: JSON.stringify({ ...header, alg: 'EdDSA' }) });
reject('embedded-key-url', claims, 'header', { header_json: JSON.stringify({ ...header, jku: 'https://example.invalid/key' }) });
reject('unknown-key-id', claims, 'key', { header_json: JSON.stringify({ ...header, kid: 'unknown-test-key' }) });
reject('disabled-key', claims, 'key', { context: { key_policy: { ...baseContext.key_policy, enabled: false } } });
reject('revoked-key', claims, 'key', { context: { key_policy: { ...baseContext.key_policy, revoked_at: baseContext.now } } });
reject('key-not-valid-at-iat', claims, 'key', { context: { key_policy: { ...baseContext.key_policy, not_before: claims.iat + 1 } } });
reject('key-not-valid-through-exp', claims, 'key', { context: { key_policy: { ...baseContext.key_policy, not_after: claims.exp - 1 } } });
reject('key-not-valid-now', claims, 'key', { context: { now: claims.iat - 3, key_policy: { ...baseContext.key_policy, not_before: claims.iat } } });
reject('padded-header-segment', claims, 'encoding', { header_segment: encode(JSON.stringify(header)) + '=' });
// Non-zero unused bits decode to the same 64 signature bytes in permissive Node decoders.
const first = positive[0], segments = first.compact.split('.');
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const finalIndex = alphabet.indexOf(segments[2].at(-1));
negative.push({ ...first, name: 'noncanonical-signature-base64url', compact: `${segments[0]}.${segments[1]}.${segments[2].slice(0, -1)}${alphabet[finalIndex + 1]}`, expected: 'encoding' });
negative.push({ ...first, name: 'tampered-payload', compact: `${segments[0]}.${encode(JSON.stringify({ ...claims, sub: 'forged-reviewer' }))}.${segments[2]}`, raw_signature_valid: false, expected: 'signature' });
const changed = Buffer.from(segments[2], 'base64url'); changed[0] ^= 1;
negative.push({ ...first, name: 'tampered-signature', compact: `${segments[0]}.${segments[1]}.${encode(changed)}`, raw_signature_valid: false, expected: 'signature' });
const result = { fixture_version: 'lt1-wire-v1-r2', status: 'PROPOSED; PUBLIC TEST MATERIAL; no product verification',
  algorithm: 'Ed25519', kid: header.kid, public_test_seed_phrase: phrase,
  public_jwk: { ...publicKey.export({ format: 'jwk' }), alg: 'Ed25519', use: 'sig', kid: header.kid },
  before_html: before, after_html: after, positive, negative };
const fixture = new URL('./lt-1-reviewer-wire-v1-vectors.json', import.meta.url);
if (process.argv.includes('--write')) await writeFile(fixture, `${JSON.stringify(result, null, 2)}\n`);
else assert.deepEqual(JSON.parse(await readFile(fixture, 'utf8')), result);
console.log(`PASS ${result.fixture_version}: ${positive.length} positive and ${negative.length} exact negative fixture definitions; deterministic raw signatures and equality.`);
console.log('Run the separate fixture checks for strict decoding/schema/time/action/key policy evidence. No product path or ledger is tested.');
