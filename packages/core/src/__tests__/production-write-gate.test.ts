import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { DurableLedger } from '../../../conductor-panel/server/durable-ledger.js';
import { assertWriteAllowed } from '../guardrails.js';
const io = vi.hoisted(() => ({ writes: 0 }));
vi.mock('dotenv', () => ({ config: () => ({}) }));
vi.mock('@libretexts/cxone-expert-node', () => ({ default: class { pages = {
  getPageInfo: async () => ({ '@id': 904, path: 'Sandboxes/johnnyphung/Test' }),
  getPageContents: async () => ({ body: '<p><strong>Heading</strong></p>' }),
  postPageContents: async () => { io.writes++; return {}; },
}; } }));
let server: Server, base: string;
const keys = generateKeyPairSync('ed25519'), issuer = 'urn:libretexts:conductor:production', audience = 'urn:libretexts:remedy-bridge:production', service = 'd'.repeat(64);
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'production-gate-')); await mkdir(join(dir, 'ledger'));
  await (await DurableLedger.open({ directory: join(dir, 'ledger'), fencePath: join(dir, 'fence.json'), trustEpoch: 'production-test', initialize: true })).close();
  await writeFile(join(dir, 'service'), service);
  await writeFile(join(dir, 'keys.json'), JSON.stringify({ issuer, audience, environment: 'production', trust_epoch: 'production-test', keys: [{ kid: 'synthetic-production-gate', issuer, audience, environment: 'production', trust_epoch: 'production-test', kty: 'OKP', crv: 'Ed25519', x: keys.publicKey.export({ format: 'jwk' }).x, not_before: 0, not_after: 4102444800, enabled: true, revoked_at: null }] }));
  for (const [key, value] of Object.entries({ NODE_ENV: 'production', REMEDY_REVIEWER_REQUIRED: 'true', REMEDY_REVIEWER_TRUST_EPOCH: 'production-test', REMEDY_REVIEWER_KEYRING_FILE: join(dir, 'keys.json'), REMEDY_BRIDGE_SERVICE_KEY_FILE: join(dir, 'service'), REMEDY_CLAIM_DB: join(dir, 'ledger', 'claims.sqlite3'), REMEDY_CLAIM_FENCE_DIR: dir, CXONE_INTEGRATION_ENABLED: 'true', SERVER_DOMAIN: 'dev.libretexts.org', SERVER_KEY: 'fake', SERVER_SECRET: 'fake', SERVER_USER: 'fake' })) vi.stubEnv(key, value);
  server = (await import('../../../conductor-panel/server/server.js')).server;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllEnvs(); });
async function post(path: string, body: unknown) { return fetch(base + path, { method: 'POST', headers: { 'X-Remedy-Service-Key': service }, body: JSON.stringify(body) }); }
it('advertises production mutation unavailable while preserving authenticated read/status capabilities', async () => {
  const r = await fetch(base + '/readyz', { headers: { 'X-Remedy-Service-Key': service } });
  expect(r.status).toBe(503); expect(await r.json()).toMatchObject({ capabilities: { scan: true, preview: true, mutate: false, operation_status: true } });
});
it('rejects even a valid signed production apply before claim or CXone dispatch', async () => {
  const p = await (await post('/v1/cxone/page/preview-fix', { page_id: 904 })).json();
  const now = Math.floor(Date.now() / 1000), jti = randomBytes(32).toString('base64url');
  const header = Buffer.from(JSON.stringify({ alg: 'Ed25519', kid: 'synthetic-production-gate', typ: 'remedy-review+jwt' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ v: 1, iss: issuer, aud: audience, sub: 'synthetic-reviewer', iat: now, nbf: now, exp: now + 60, jti, binding: p.review_binding })).toString('base64url');
  const assertion = `${header}.${claims}.${sign(null, Buffer.from(`${header}.${claims}`), keys.privateKey).toString('base64url')}`;
  const r = await post('/v1/cxone/page/apply-fix', { page_id: 904, preview_token: p.preview_token, preview_hash: p.preview_hash, reviewer_assertion: assertion });
  expect(r.status).toBe(503); expect(await r.json()).toMatchObject({ error: 'conditional_write_unproven', outcome: 'not_attempted', evidence_effect: 'preserve' });
  expect(io.writes).toBe(0);
  expect((await post('/v1/cxone/page/operation-status', { issuer, jti })).status).toBe(404);
});
it('keeps production core/CLI HTML and tag authorization closed too', () => {
  expect(() => assertWriteAllowed({ hostname: 'dev.libretexts.org', path: 'Sandboxes/johnnyphung/Test' }, process.env)).toThrow('conditional');
});

it('keeps signed mutation held for an unspecified environment and cannot reopen by changing it later', async () => {
  const { SignedWriter } = await import('../../../conductor-panel/server/signed-writer.js');
  const { ReviewerVerifier } = await import('../../../conductor-panel/server/reviewer-auth.js');
  const dir = await mkdtemp(join(tmpdir(), 'unspecified-gate-')); await mkdir(join(dir, 'ledger'));
  const epoch = 'unspecified-test';
  await (await DurableLedger.open({ directory: join(dir, 'ledger'), fencePath: join(dir, 'fence.json'), trustEpoch: epoch, initialize: true })).close();
  const verifier = new ReviewerVerifier({ issuer, audience, environment: 'production', trust_epoch: epoch, production: true, keys: [{ kid: 'synthetic-unspecified', issuer, audience, environment: 'production', trust_epoch: epoch, kty: 'OKP', crv: 'Ed25519', x: keys.publicKey.export({ format: 'jwk' }).x!, not_before: 0, not_after: 4102444800, enabled: true, revoked_at: null }] });
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: undefined, REMEDY_CLAIM_DB: join(dir, 'ledger', 'claims.sqlite3'), REMEDY_CLAIM_FENCE_DIR: dir, REMEDY_REVIEWER_TRUST_EPOCH: epoch };
  const writer = await SignedWriter.open(verifier, env);
  try {
    expect(await writer.ready()).toBe(false);
    env.NODE_ENV = 'development';
    await expect(writer.mutate('cxone.apply', {}, 904)).rejects.toMatchObject({ body: { error: 'conditional_write_unproven' } });
    expect(io.writes).toBe(0);
  } finally { await writer.close(); }
});
