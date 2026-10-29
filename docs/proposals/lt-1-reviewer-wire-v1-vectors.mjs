// Public, deterministic, forgeable TEST FIXTURE ONLY. Never a production key.
// Generates proposal vectors; it is not an application signer or verifier.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const phrase = 'LibreTexts LT-1 PUBLIC TEST KEY - never use in production';
const seed = createHash('sha256').update(phrase, 'utf8').digest();
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
  format: 'der', type: 'pkcs8',
});
const publicKey = createPublicKey(privateKey);
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const encode = text => Buffer.from(text, 'utf8').toString('base64url');
const header = { alg: 'Ed25519', kid: 'lt1-public-test-only-v1', typ: 'remedy-review+jwt' };
const before = '<p>Example</p>\n<img src="/test.png">';
const after = '<p>Example</p>\n<img src="/test.png" alt="Test diagram">';
const target = { hostname: 'dev.libretexts.org', page_id: '42', page_path: 'Sandboxes/johnnyphung/LT-1-fixture' };
const binding = {
  action: 'cxone.apply', target,
  preview_token: '00000000-0000-4000-8000-000000000001',
  before_sha256: sha256(before), after_sha256: sha256(after),
  fix_mode: 'deterministic', tier: null, snapshot: null,
};
const claims = {
  v: 1, iss: 'urn:libretexts:conductor:test', aud: 'urn:libretexts:remedy-bridge:test',
  sub: 'synthetic-reviewer-42', iat: 1793255340, nbf: 1793255340, exp: 1793255400,
  jti: Buffer.alloc(32, 1).toString('base64url'), binding,
};
function vector(name, payload) {
  const header_json = JSON.stringify(header);
  const payload_json = JSON.stringify(payload);
  const signing_input = `${encode(header_json)}.${encode(payload_json)}`;
  const signature = sign(null, Buffer.from(signing_input, 'ascii'), privateKey);
  assert.equal(signature.length, 64);
  assert.equal(verify(null, Buffer.from(signing_input, 'ascii'), publicKey, signature), true);
  return { name, header_json, payload_json, signing_input, signature_base64url: signature.toString('base64url'),
    compact: `${signing_input}.${signature.toString('base64url')}` };
}
const restoreClaims = {
  ...claims, jti: Buffer.alloc(32, 2).toString('base64url'),
  binding: { ...binding, action: 'cxone.restore', fix_mode: 'restore',
    preview_token: '00000000-0000-4000-8000-000000000002',
    before_sha256: sha256(after), after_sha256: sha256(before),
    snapshot: { timestamp: '2026-10-29T06:00:00.000Z', sha256: sha256(before) } },
};
const vectors = [vector('valid-apply', claims), vector('valid-restore', restoreClaims)];
const first = vectors[0];
assert.equal(verify(null, Buffer.from(`${first.signing_input}x`, 'ascii'), publicKey,
  Buffer.from(first.signature_base64url, 'base64url')), false);
const changed = Buffer.from(first.signature_base64url, 'base64url');
changed[0] ^= 1;
assert.equal(verify(null, Buffer.from(first.signing_input, 'ascii'), publicKey, changed), false);
const result = {
  status: 'PROPOSED CONTRACT; PUBLIC TEST KEY ONLY; not an application verifier',
  algorithm: 'Ed25519', kid: header.kid, public_test_seed_phrase: phrase,
  public_jwk: { ...publicKey.export({ format: 'jwk' }), alg: 'Ed25519', use: 'sig', kid: header.kid },
  test_now_seconds: 1793255370, before_html: before, after_html: after, vectors,
  invalid_cases: [
    { name: 'tampered-payload', source: 'valid-apply', mutation: 'append x to encoded signing input', expected_crypto_valid: false },
    { name: 'tampered-signature', source: 'valid-apply', mutation: 'xor first signature byte with 1', expected_crypto_valid: false },
    { name: 'expired', source: 'valid-apply', verification_now: 1793255400, expected_error: 'invalid_reviewer_assertion' },
    { name: 'action-swap', source: 'valid-apply', route: '/v1/cxone/page/restore', expected_error: 'reviewer_binding_mismatch' },
    { name: 'changed-output', source: 'valid-apply', expected_after_sha256: sha256('<p>Unreviewed</p>'), expected_error: 'reviewer_binding_mismatch' },
    { name: 'wrong-target', source: 'valid-apply', expected_page_id: '43', expected_error: 'reviewer_binding_mismatch' },
    { name: 'replay', source: 'valid-apply', consumed: true, expected_error: 'preview_already_claimed' },
  ],
};
const fixture = new URL('./lt-1-reviewer-wire-v1-vectors.json', import.meta.url);
if (process.argv.includes('--write')) {
  await writeFile(fixture, `${JSON.stringify(result, null, 2)}\n`);
} else {
  assert.deepEqual(JSON.parse(await readFile(fixture, 'utf8')), result);
}
console.log('PASS: deterministic apply/restore signatures, fixture equality, tampered input and tampered signature rejected.');
console.log('Application time/binding/replay errors above are expected future-verifier cases, not executed product tests.');
