import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableLedger } from '../../../conductor-panel/server/durable-ledger.js';
import type { Server } from 'node:http';
import { request } from 'node:http';
vi.mock('dotenv', () => ({ config: () => ({}) }));
let server: Server, base: string;
const key = 'a'.repeat(64);
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'required-http-'));
  await (await import('node:fs/promises')).mkdir(join(dir,'ledger'));
  await (await DurableLedger.open({directory:join(dir,'ledger'),fencePath:join(dir,'fence.json'),trustEpoch:'test-epoch',initialize:true})).close();
  vi.stubEnv('REMEDY_CLAIM_DB', join(dir,'ledger','claims.sqlite3')); vi.stubEnv('REMEDY_CLAIM_FENCE_DIR', dir);
  const fixture = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../../../../docs/proposals/lt-1-reviewer-wire-v1-vectors.json', import.meta.url), 'utf8'));
  await writeFile(join(dir, 'service'), key + '\n');
  await writeFile(join(dir, 'keys.json'), JSON.stringify({issuer:'urn:libretexts:conductor:test',audience:'urn:libretexts:remedy-bridge:test',environment:'test',trust_epoch:'test-epoch', keys:[{kid:fixture.kid,kty:fixture.public_jwk.kty,crv:fixture.public_jwk.crv,x:fixture.public_jwk.x,issuer:'urn:libretexts:conductor:test',audience:'urn:libretexts:remedy-bridge:test',environment:'test',trust_epoch:'test-epoch',not_before:0,not_after:4102444800,enabled:true,revoked_at:null}]}));
  vi.stubEnv('REMEDY_REVIEWER_REQUIRED', 'true'); vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('REMEDY_BRIDGE_SERVICE_KEY_FILE', join(dir,'service')); vi.stubEnv('REMEDY_REVIEWER_KEYRING_FILE', join(dir,'keys.json')); vi.stubEnv('REMEDY_REVIEWER_TRUST_EPOCH', 'test-epoch');
  vi.stubEnv('CXONE_INTEGRATION_ENABLED','false');
  { const bridge = await import('../../../conductor-panel/server/server.js'); server = bridge.createBridgeServer(bridge.executeReadInline); }
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
afterAll(async () => { if(server) await new Promise<void>(r=>server.close(()=>r())); vi.unstubAllEnvs(); });
it('exposes sanitized liveness only and authenticates every other path before routing',async()=>{
  const health = await fetch(base+'/healthz'); expect(health.status).toBe(200); expect(await health.json()).toEqual({ok:true});
  for(const path of ['/readyz','/v1/cxone/page/scan','/v1/cxone/page/preview-fix','/v1/cxone/page/snapshots','/v1/cxone/page/restore-preview','/v1/cxone/page/operation-status','/api/apply','/api/local/run','/unknown','/']){
    const r=await fetch(base+path,{method:'POST',body:'{}'});expect(r.status,path).toBe(401);expect(await r.json()).toMatchObject({error:'service_authentication_required'});
  }
  expect((await fetch(base+'/healthz',{method:'POST'})).status).toBe(401);
});
it('denies duplicate credentials before coalescing and keeps panel unavailable',async()=>{
  const response = await new Promise<number>(resolve=>{const req=request(base+'/readyz',{headers:['Host','127.0.0.1','X-Remedy-Service-Key',key,'x-remedy-service-key',key]},res=>{res.resume();resolve(res.statusCode!);});req.end();});
  expect(response).toBe(401);
  expect((await fetch(base+'/',{headers:{'X-Remedy-Service-Key':key}})).status).toBe(404);
});
it('reports capabilities without leaking config and never allows a mutation alias in required mode without CXone',async()=>{
 const r=await fetch(base+'/readyz',{headers:{'X-Remedy-Service-Key':key}});expect(r.status).toBe(503);
 expect(await r.json()).toMatchObject({ok:false,state:'degraded',capabilities:{scan:false,preview:false,mutate:false,operation_status:true}});
 for(const path of ['/api/apply','/v1/cxone/page/apply-fix','/v1/cxone/page/restore']){
 const r=await fetch(base+path,{method:'POST',headers:{'X-Remedy-Service-Key':key},body:'{}'});expect(r.status).toBe(path === '/api/apply' ? 403 : 503);
 }
});

it('rejects duplicate decoded request members before executing a handler',async()=>{
 const r=await fetch(base+'/api/local/fixtures',{method:'POST',headers:{'X-Remedy-Service-Key':key},body:'{"a":1,"\\u0061":2}'});
 expect(r.status).toBe(400);expect(await r.json()).toEqual({error:'invalid_request'});
});
it('rejects production downgrade and mode typos at startup', async()=>{
 const {loadSecurity}=await import('../../../conductor-panel/server/security-config.js');
 expect(()=>loadSecurity({NODE_ENV:'production'})).toThrow('reviewer_configuration_invalid');
 expect(()=>loadSecurity({REMEDY_REVIEWER_REQUIRED:'tru'})).toThrow('reviewer_configuration_invalid');
 expect(()=>loadSecurity({NODE_ENV:'production',REMEDY_REVIEWER_REQUIRED:'false'})).toThrow('reviewer_configuration_invalid');
});
it('authenticates malformed request targets without crashing the process',async()=>{
 const code=await new Promise<number>(resolve=>{const req=request(base,{method:'OPTIONS',path:'//[',timeout:300},res=>{res.resume();resolve(res.statusCode!);});req.on('timeout',()=>{req.destroy();resolve(0);});req.on('error',()=>resolve(0));req.end();});
 expect(code).toBe(401);
 expect((await fetch(base+'/healthz')).status).toBe(200);
});
it('rejects 33 empty JSON containers at the documented depth limit',async()=>{
 const r=await fetch(base+'/api/local/fixtures',{method:'POST',headers:{'X-Remedy-Service-Key':key},body:'{"x":'+'['.repeat(32)+']'.repeat(32)+'}'});
 expect(r.status).toBe(400);
});
