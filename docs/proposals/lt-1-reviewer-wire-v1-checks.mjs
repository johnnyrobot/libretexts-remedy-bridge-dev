// OFFLINE FIXTURE ORACLE ONLY. Not exported, installed, or used by any product.
// Accepts only the adjacent public synthetic corpus; no HTTP, external keys or ledger.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPublicKey, verify } from 'node:crypto';
const fixture = JSON.parse(await readFile(new URL('./lt-1-reviewer-wire-v1-vectors.json', import.meta.url), 'utf8'));
assert.equal(fixture.fixture_version, 'lt1-wire-v1-r2');
const key = createPublicKey({ key: fixture.public_jwk, format: 'jwk' });
const fail = stage => { throw new Error(stage); };
function decode(segment) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) fail('encoding');
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) fail('encoding');
  return bytes;
}
function strictJSON(bytes) {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) fail('encoding');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('encoding'); }
  let i = 0;
  const space = () => { while (/[\x20\t\r\n]/.test(text[i] ?? '\0')) i++; };
  function string() {
    if (text[i] !== '"') fail('json');
    const start = i++;
    while (i < text.length) {
      const char = text[i++];
      if (char === '\\') { i++; continue; }
      if (char === '"') {
        let value;
        try { value = JSON.parse(text.slice(start, i)); } catch { fail('json'); }
        for (const scalar of value) {
          const cp = scalar.codePointAt(0);
          if (cp >= 0xd800 && cp <= 0xdfff) fail('json');
        }
        return value;
      }
    }
    fail('json');
  }
  function value(depth = 0) {
    if (depth > 32) fail('json');
    space();
    if (text[i] === '"') return string();
    if (text[i] === '{') {
      i++; space(); const out = Object.create(null), names = new Set();
      if (text[i] === '}') { i++; return out; }
      while (true) {
        space(); const name = string();
        if (names.has(name)) fail('json');
        names.add(name); space(); if (text[i++] !== ':') fail('json');
        out[name] = value(depth + 1); space();
        const delimiter = text[i++];
        if (delimiter === '}') return out;
        if (delimiter !== ',') fail('json');
      }
    }
    if (text[i] === '[') {
      i++; space(); const out = [];
      if (text[i] === ']') { i++; return out; }
      while (true) {
        out.push(value(depth + 1)); space(); const delimiter = text[i++];
        if (delimiter === ']') return out;
        if (delimiter !== ',') fail('json');
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i))?.[0];
    if (!token) fail('json');
    i += token.length;
    try { return JSON.parse(token); } catch { fail('json'); }
  }
  const result = value(); space(); if (i !== text.length) fail('json');
  return result;
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value, expected, stage = 'schema') {
  if (!object(value) || Object.keys(value).length !== expected.length || !expected.every(name => Object.hasOwn(value, name))) fail(stage);
}
const isString = value => typeof value === 'string';
const digest = value => isString(value) && /^[a-f0-9]{64}$/.test(value);
function bindingSchema(b) {
  fields(b, ['action', 'target', 'preview_token', 'before_sha256', 'after_sha256', 'fix_mode', 'tier', 'snapshot']);
  fields(b.target, ['hostname', 'page_id', 'page_path']);
  if (!['cxone.apply', 'cxone.restore'].includes(b.action) || !['deterministic', 'pipeline', 'restore'].includes(b.fix_mode)) fail('schema');
  if (!isString(b.target.hostname) || !/^[a-z0-9.-]+$/.test(b.target.hostname) || b.target.hostname.endsWith('.')) fail('schema');
  if (!isString(b.target.page_id) || !/^[1-9]\d*$/.test(b.target.page_id) || !Number.isSafeInteger(Number(b.target.page_id))) fail('schema');
  if (!isString(b.target.page_path) || !b.target.page_path || !isString(b.preview_token) || !b.preview_token) fail('schema');
  if (!digest(b.before_sha256) || !digest(b.after_sha256)) fail('schema');
  if (b.fix_mode === 'pipeline' ? ![1, 2, 3].includes(b.tier) : b.tier !== null) fail('schema');
  if (b.action === 'cxone.restore') {
    if (b.fix_mode !== 'restore') fail('schema');
    fields(b.snapshot, ['timestamp', 'sha256']);
    if (!isString(b.snapshot.timestamp) || !Number.isFinite(Date.parse(b.snapshot.timestamp)) || !digest(b.snapshot.sha256) || b.snapshot.sha256 !== b.after_sha256) fail('schema');
  } else if (b.fix_mode === 'restore' || b.snapshot !== null) fail('schema');
}
function same(a, b) {
  if (a === b) return true;
  if (!object(a) || !object(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && same(a[k], b[k]));
}
function check(vector) {
  const compact = vector.compact;
  if (typeof compact !== 'string' || compact.length > 8192 || !/^[\x21-\x7e]+$/.test(compact)) fail('encoding');
  const parts = compact.split('.'); if (parts.length !== 3) fail('encoding');
  // Only the strict untrusted protected header is parsed to select a pinned key.
  const header = strictJSON(decode(parts[0]));
  fields(header, ['alg', 'kid', 'typ'], 'header');
  if (header.alg !== 'Ed25519' || header.typ !== 'remedy-review+jwt' || !isString(header.kid) || !/^[A-Za-z0-9._-]{1,64}$/.test(header.kid)) fail('header');
  const policy = vector.context.key_policy;
  if (header.kid !== fixture.kid || !policy.enabled || (policy.revoked_at !== null && policy.revoked_at <= vector.context.now)) fail('key');
  const payloadBytes = decode(parts[1]), signature = decode(parts[2]);
  if (signature.length !== 64 || !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), key, signature)) fail('signature');
  // No payload field is read before the signature succeeds.
  const p = strictJSON(payloadBytes);
  fields(p, ['v', 'iss', 'aud', 'sub', 'iat', 'nbf', 'exp', 'jti', 'binding']);
  if (p.v !== 1 || !isString(p.iss) || !isString(p.aud) || !isString(p.sub) || !/^[\x21-\x7e]{1,128}$/.test(p.sub)) fail('schema');
  if (![p.iat, p.nbf, p.exp].every(Number.isSafeInteger) || !isString(p.jti) || !/^[A-Za-z0-9_-]{43}$/.test(p.jti) || decode(p.jti).length !== 32) fail('schema');
  bindingSchema(p.binding);
  if (p.iss !== 'urn:libretexts:conductor:test' || p.aud !== 'urn:libretexts:remedy-bridge:test') fail('claims');
  const now = vector.context.now;
  if (p.nbf !== p.iat || p.exp <= p.iat || p.exp - p.iat > 60 || p.iat > now + 5 || p.nbf > now + 5 || now >= p.exp || p.exp > vector.context.preview_expires_at) fail('time');
  if (p.iat < policy.not_before || p.exp > policy.not_after || now < policy.not_before || now >= policy.not_after) fail('key');
  if (!same(p.binding, vector.context.expected_binding)) fail('binding');
}
// Every policy/schema negative below has a mathematically valid signature over
// its exact segments. Rejection is not explained away as a tampered signature.
for (const vector of [...fixture.positive, ...fixture.negative]) {
  const [h, p, s] = vector.compact.split('.');
  assert.ok(vector.signing_input === `${h}.${p}`, `${vector.name}: exact signing input`);
  assert.ok(Buffer.from(h, 'base64url').toString('base64url') === vector.header_bytes_base64url, `${vector.name}: exact header bytes`);
  assert.ok(Buffer.from(p, 'base64url').toString('base64url') === vector.payload_bytes_base64url, `${vector.name}: exact payload bytes`);
  assert.equal(verify(null, Buffer.from(`${h}.${p}`, 'ascii'), key, Buffer.from(s, 'base64url')), vector.raw_signature_valid, `${vector.name}: raw signature`);
  let actual = 'accept';
  try { check(vector); } catch (error) { actual = error.message; }
  assert.equal(actual, vector.expected, vector.name);
}
console.log(`PASS ${fixture.fixture_version} on ${process.version}: ${fixture.positive.length} accepted, ${fixture.negative.length} rejected at exact expected stages.`);
console.log('Native crypto JWS compatibility and this offline oracle only; no product auth, HTTP, durable claim/replay/lease/crash/state or evidence consumer is tested.');
