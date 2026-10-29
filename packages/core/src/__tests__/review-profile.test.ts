import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
const children: ChildProcess[] = [], servers: Server[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(p => new Promise<void>(resolve => {
    if (p.exitCode !== null || p.signalCode !== null) return resolve();
    p.once('close', () => resolve()); p.kill('SIGKILL');
  })));
  await Promise.all(servers.splice(0).map(s => { s.closeAllConnections(); return new Promise<void>(r => s.close(() => r())); }));
});
async function fixture(extra: NodeJS.ProcessEnv = {}, html = '<p><strong>Review title</strong></p>') {
  const dir = await mkdtemp(join(tmpdir(), 'review-only-')), key = 'a'.repeat(64);
  await writeFile(join(dir, 'service'), key);
  let mutations = 0, reads = 0, failReads = false;
  const external = createServer((req, res) => {
    if (!['GET', 'HEAD'].includes(req.method!)) { mutations++; res.writeHead(500).end(); return; }
    reads++; res.setHeader('content-type', 'application/json');
    if (failReads) { res.writeHead(503).end('{"error":"synthetic read unavailable"}'); return; }
    res.end(JSON.stringify(req.url?.includes('/contents') ? {body:html} : {'@id':1,path:'Sandboxes/johnnyphung/Page'}));
  });
  servers.push(external); await new Promise<void>(r => external.listen(0, '127.0.0.1', r));
  const env = { PATH: process.env.PATH!, NODE_ENV: 'production', REMEDY_BRIDGE_PROFILE: 'review-only',
    NODE_OPTIONS: `--loader ${new URL('./support/no-dotenv-loader.mjs', import.meta.url).pathname} --import ${new URL('./support/owned-network.mjs', import.meta.url).pathname}`,
    REMEDY_BRIDGE_SERVICE_KEY_FILE: join(dir, 'service'), CXONE_INTEGRATION_ENABLED: 'true', SERVER_DOMAIN: 'dev.libretexts.org', SERVER_KEY: 'fake', SERVER_SECRET: 'fake', SERVER_USER: 'fake',
    REMEDY_SNAPSHOT_DIR: join(dir, 'snapshots'), REMEDY_AUDIT_LOG: join(dir, 'audit'), TEST_EXTERNAL_URL: `http://127.0.0.1:${(external.address() as any).port}`, ...extra };
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('./support/owned-bridge.ts', import.meta.url).pathname], {env, stdio:['ignore','pipe','pipe','ipc']});
  children.push(child); let diagnostics = ''; child.stderr!.on('data', c => diagnostics += c);
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('review child startup timed out')), 8000);
    child.once('message', (m: any) => {clearTimeout(timer); resolve(m.port);});
    child.once('exit', () => {clearTimeout(timer); reject(Error('review child startup failed: ' + diagnostics));});
  });
  const base = `http://127.0.0.1:${port}`;
  const request = async (path: string, body?: unknown, authenticated = true) => {
    const r = await fetch(base + path, {method:body === undefined ? 'GET' : 'POST', headers:authenticated ? {'X-Remedy-Service-Key':key} : {}, body:body === undefined ? undefined : JSON.stringify(body)});
    return {status:r.status, body:await r.json()};
  };
  return {request,dir,env,child, mutations:()=>mutations,reads:()=>reads, fail:(value:boolean)=>{failReads=value;}};
}
it('supports authenticated real HTTP scan/preview with service/read config only and rejects valid signed mutations before side effects', async () => {
  const f = await fixture();
  expect((await f.request('/readyz', undefined, false)).status).toBe(401);
  const ready = await f.request('/readyz');
  expect(ready.status).toBe(200);
  expect(ready.body).toMatchObject({ok:true,capabilities:{scan:true,preview:true,mutate:false,operation_status:false},profile:{contract:'cxone-review-v1',name:'review-only',required_capabilities:['scan','preview']}});
  const scan = await f.request('/v1/cxone/page/scan', {page_id:1}); expect(scan.status).toBe(200); expect(scan.body.findings.length).toBeGreaterThan(0);
  const preview = await f.request('/v1/cxone/page/preview-fix', {page_id:1}); expect(preview.status).toBe(200); expect(preview.body.review_binding).toMatchObject({action:'cxone.apply',target:{page_id:'1'}}); expect(preview.body.after_html).not.toBe(preview.body.before_html);
  const keys = generateKeyPairSync('ed25519'), now = Math.floor(Date.now()/1000);
  const h = Buffer.from(JSON.stringify({alg:'Ed25519',kid:'synthetic-valid',typ:'remedy-review+jwt'})).toString('base64url');
  const p = Buffer.from(JSON.stringify({v:1,iss:'urn:synthetic',aud:'urn:bridge',sub:'synthetic',iat:now,nbf:now,exp:now+60,jti:randomBytes(32).toString('base64url'),binding:preview.body.review_binding})).toString('base64url');
  const body = {page_id:1,preview_token:preview.body.preview_token,preview_hash:preview.body.preview_hash,reviewer_assertion:`${h}.${p}.${sign(null,Buffer.from(`${h}.${p}`),keys.privateKey).toString('base64url')}`};
  expect((await f.request('/v1/cxone/page/apply-fix',body,false)).status).toBe(401);
  const reads = f.reads();
  for (const path of ['/v1/cxone/page/apply-fix','/v1/cxone/page/restore','/api/apply']) {
    const denied = await f.request(path, body);
    expect(denied.status).toBe(503); expect(denied.body).toMatchObject({error:'review_only_profile',outcome:'not_attempted',evidence_effect:'preserve',operation_id:null,retryable:false});
  }
  expect(f.reads()).toBe(reads); expect(f.mutations()).toBe(0);
  // A denied mutation did not consume its preview: revision reaches edit validation.
  const revision = await f.request('/v1/cxone/page/revise-preview',{page_id:1,preview_token:preview.body.preview_token,alt_edits:[]});
  expect(revision.status).toBe(400); expect(revision.body.error).toBe('invalid_description');
  expect((await readdir(f.dir)).sort()).toEqual(['service']);
},30000);

it('serves historical pending operation status without opening a writer or changing recovery state', async () => {
  const { DurableLedger } = await import('../../../conductor-panel/server/durable-ledger.js');
  const { mkdir, readFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(),'review-history-')); await mkdir(join(dir,'ledger'));
  const options = {directory:join(dir,'ledger'),fencePath:join(dir,'fence.json'),trustEpoch:'history-test'};
  const ledger = await DurableLedger.open({...options,initialize:true});
  const issuer='urn:conductor:history', jti=randomBytes(32).toString('base64url');
  const claim = await ledger.claim({issuer,jti,preview_token:'old-preview',target:{hostname:'dev.libretexts.org',page_id:'1'},binding:{action:'cxone.apply'},subject:'synthetic-old-reviewer',expires_at:4102444800});
  await writeFile(join(dir,'recovery.json'),'{}');
  await ledger.start(claim.operation_id,{snapshot_path:join(dir,'recovery.json')}); await ledger.close();
  const dbBefore=await readFile(join(options.directory,'claims.sqlite3')), fenceBefore=await readFile(options.fencePath);
  const f=await fixture({REMEDY_CLAIM_DB:join(options.directory,'claims.sqlite3'),REMEDY_CLAIM_FENCE_DIR:dir,REMEDY_REVIEWER_TRUST_EPOCH:options.trustEpoch,REMEDY_OPERATION_STATUS_ISSUER:issuer});
  expect((await f.request('/readyz')).body.capabilities.operation_status).toBe(true);
  const status=await f.request('/v1/cxone/page/operation-status',{issuer,jti});
  expect(status.status).toBe(200); expect(status.body).toMatchObject({operation_id:claim.operation_id,outcome:'pending',evidence_effect:'hold',applied:null});
  expect(status.body).not.toHaveProperty('subject'); expect(status.body).not.toHaveProperty('snapshot_path');
  expect((await f.request('/v1/cxone/page/operation-status',{issuer,jti:randomBytes(32).toString('base64url')})).status).toBe(404);
  expect(await readFile(join(options.directory,'claims.sqlite3'))).toEqual(dbBefore); expect(await readFile(options.fencePath)).toEqual(fenceBefore);
  expect(f.reads()).toBe(0); expect(f.mutations()).toBe(0);
  await writeFile(options.fencePath,JSON.stringify({trust_epoch:options.trustEpoch,durability_seq:-1}));
  const degraded=await f.request('/readyz');expect(degraded.status).toBe(200);expect(degraded.body.capabilities.operation_status).toBe(false);
  const unavailable=await f.request('/v1/cxone/page/operation-status',{issuer,jti});expect(unavailable.status).toBe(503);expect(unavailable.body).toEqual({error:'claim_store_unavailable'});
  // The fully configured but unhealthy store stays distinguishable after restart.
  const restarted=await fixture({REMEDY_CLAIM_DB:join(options.directory,'claims.sqlite3'),REMEDY_CLAIM_FENCE_DIR:dir,REMEDY_REVIEWER_TRUST_EPOCH:options.trustEpoch,REMEDY_OPERATION_STATUS_ISSUER:issuer});
  expect((await restarted.request('/readyz')).status).toBe(200);
  expect((await restarted.request('/v1/cxone/page/operation-status',{issuer,jti})).body).toEqual({error:'claim_store_unavailable'});
},30000);

it('keeps missing read credentials unavailable without requiring writer configuration', async () => {
  const f=await fixture({SERVER_KEY:''});
  const r=await f.request('/readyz'); expect(r.status).toBe(503);
  expect(r.body).toMatchObject({ok:false,capabilities:{scan:false,preview:false,mutate:false,operation_status:false},profile:{unavailable_reasons:['cxone_configuration_invalid']}});
  expect((await f.request('/v1/cxone/page/scan',{page_id:1})).status).toBe(503);
  expect(f.reads()).toBe(0); expect(f.mutations()).toBe(0);
},30000);
it('marks a failed required preview dependency unavailable and recovers only after successful real work', async () => {
  const f=await fixture(); f.fail(true);
  expect((await f.request('/v1/cxone/page/preview-fix',{page_id:1})).status).toBe(503);
  const failed=await f.request('/readyz'); expect(failed.status).toBe(503); expect(failed.body.capabilities.preview).toBe(false);
  f.fail(false);
  expect((await f.request('/v1/cxone/page/preview-fix',{page_id:1})).status).toBe(200);
  expect((await f.request('/readyz')).status).toBe(200); expect(f.mutations()).toBe(0);
},30000);
it('rejects actual CLI mutation commands before reads, exports or local snapshots even in development', async () => {
  const f=await fixture({NODE_ENV:'development'});
  for (const args of [['fix','1','--apply','--out-dir',join(f.dir,'out')],['pipeline','1','--apply','--out-dir',join(f.dir,'out')],['revert','1'],['tags-restore','--manifest',join(f.dir,'missing')],['tags-revert','--snapshot-path',join(f.dir,'missing')]]) {
    const p=spawn(process.execPath,['--import','tsx',new URL('../../../cli/src/index.ts',import.meta.url).pathname,...args],{env:f.env,stdio:['ignore','pipe','pipe']}); children.push(p);
    let text='';p.stdout!.on('data',c=>text+=c);p.stderr!.on('data',c=>text+=c);
    const code=await new Promise<number|null>(r=>p.once('close',r));expect(code).not.toBe(0);expect(text).toContain('review-only');
  }
  expect(f.reads()).toBe(0);expect(f.mutations()).toBe(0);expect((await readdir(f.dir)).sort()).toEqual(['service']);
},30000);
it.each([{REMEDY_BRIDGE_PROFILE:'unknown'},{REMEDY_REVIEWER_REQUIRED:'false'}])('fails startup for unsafe review profile configuration %j', async extra => {
  await expect(fixture(extra)).rejects.toThrow('startup failed');
},30000);

it('captures the non-writing process policy even when core callers later change profile and NODE_ENV', async () => {
  const f=await fixture();
  const p=spawn(process.execPath,['--import','tsx',new URL('./support/review-mutation-probe.ts',import.meta.url).pathname],{env:f.env,stdio:['ignore','pipe','pipe']});children.push(p);
  let output='';p.stdout!.on('data',c=>output+=c);
  expect(await new Promise<number|null>(r=>p.once('close',r))).toBe(0);
  expect(JSON.parse(output)).toEqual({errors:Array(8).fill('ReviewOnlyProfileError'),reads:0});
  expect(f.mutations()).toBe(0);expect((await readdir(f.dir)).sort()).toEqual(['service']);
},30000);
it('reports exhausted preview capacity without disabling source scans', async () => {
  const f=await fixture({REMEDY_PREVIEW_ENTRIES:'1'});
  expect((await f.request('/v1/cxone/page/preview-fix',{page_id:1})).status).toBe(200);
  const r=await f.request('/readyz');expect(r.status).toBe(503);expect(r.body.capabilities).toMatchObject({scan:true,preview:false,mutate:false});
  expect(f.mutations()).toBe(0);
},30000);

it('keeps caller validation and optional image-description failures out of required readiness', async () => {
  const f=await fixture({},'<p><strong>Title</strong></p><img src="/diagram.png" alt="Diagram">');
  expect((await f.request('/v1/cxone/page/scan',{})).status).toBe(400);
  expect((await f.request('/readyz')).status).toBe(200);
  const p=await f.request('/v1/cxone/page/preview-fix',{page_id:1,review_images:true});expect(p.status).toBe(200);
  const optional=await f.request('/v1/cxone/page/preview-fix',{page_id:1,preview_token:p.body.preview_token,describe_image:p.body.review_images[0].data.src});
  expect(optional.status).toBe(503);expect((await f.request('/readyz')).status).toBe(200);expect(f.mutations()).toBe(0);
},30000);
