import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { Server } from 'node:http';
import { DurableLedger } from '../../../conductor-panel/server/durable-ledger.js';
const cxone=vi.hoisted(()=>({html:'<p><strong>Chapter</strong></p>',path:'Sandboxes/johnnyphung/Page',writes:[] as string[],lose:false,gate:undefined as Promise<void>|undefined,onWrite:undefined as (()=>void)|undefined}));
vi.mock('dotenv/config',()=>({})); vi.mock('dotenv',()=>({config:()=>({})}));
vi.mock('@libretexts/cxone-expert-node',()=>({default:class {pages={getPageInfo:async()=>({'@id':1,path:cxone.path}),getPageContents:async()=>({body:cxone.html}),postPageContents:async(_id:number,html:string)=>{cxone.writes.push(html);cxone.html=html;cxone.onWrite?.();await cxone.gate;if(cxone.lose)throw new Error('private upstream error');return {page:{'@revision':'9'}};}}}}));
let signerKid='synthetic1';
const keys=generateKeyPairSync('ed25519'), service='b'.repeat(64), issuer='urn:libretexts:conductor:test';
let server:Server,base:string,dir:string,store:{directory:string,fencePath:string,trustEpoch:string};
beforeAll(async()=>{
 dir=await mkdtemp(join(tmpdir(),'signed-writer-'));await mkdir(join(dir,'ledger'));
 store={directory:join(dir,'ledger'),fencePath:join(dir,'fence.json'),trustEpoch:'test-epoch'};
 await (await DurableLedger.open({...store,initialize:true})).close();
 await writeFile(join(dir,'service'),service);await writeFile(join(dir,'keys.json'),JSON.stringify({issuer,audience:'urn:libretexts:remedy-bridge:test',environment:'test',trust_epoch:'test-epoch',keys:[{kid:'synthetic1',kty:'OKP',crv:'Ed25519',x:keys.publicKey.export({format:'jwk'}).x,issuer,audience:'urn:libretexts:remedy-bridge:test',environment:'test',trust_epoch:'test-epoch',not_before:0,not_after:4102444800,enabled:true,revoked_at:null}]}));
 for(const [k,v]of Object.entries({NODE_ENV:'test',REMEDY_REVIEWER_REQUIRED:'true',REMEDY_REVIEWER_TRUST_EPOCH:'test-epoch',REMEDY_REVIEWER_KEYRING_FILE:join(dir,'keys.json'),REMEDY_BRIDGE_SERVICE_KEY_FILE:join(dir,'service'),REMEDY_CLAIM_DB:join(dir,'ledger','claims.sqlite3'),REMEDY_CLAIM_FENCE_DIR:dir,CXONE_INTEGRATION_ENABLED:'true',SERVER_DOMAIN:'dev.libretexts.org',SERVER_KEY:'fake',SERVER_SECRET:'fake',SERVER_USER:'fake',REMEDY_SNAPSHOT_DIR:join(dir,'snapshots'),REMEDY_AUDIT_LOG:join(dir,'audit.log')}))vi.stubEnv(k,v);
 server=(await import('../../../conductor-panel/server/server.js')).server;await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${(server.address()as{port:number}).port}`;
});
afterAll(async()=>{if(server)await new Promise<void>(r=>server.close(()=>r()));vi.unstubAllEnvs();});
beforeEach(()=>{cxone.html='<p><strong>Chapter</strong></p>';cxone.path='Sandboxes/johnnyphung/Page';cxone.writes=[];cxone.lose=false;cxone.gate=undefined;cxone.onWrite=undefined;});
async function post(path:string,body:unknown){const r=await fetch(base+path,{method:'POST',headers:{'X-Remedy-Service-Key':service},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
const preview=()=>post('/v1/cxone/page/preview-fix',{page_id:1});
function assertion(p:any,jti=randomBytes(32).toString('base64url')){const now=Math.floor(Date.now()/1000);const h=Buffer.from(JSON.stringify({alg:'Ed25519',kid:signerKid,typ:'remedy-review+jwt'})).toString('base64url');const b=Buffer.from(JSON.stringify({v:1,iss:issuer,aud:'urn:libretexts:remedy-bridge:test',sub:'verified-user',iat:now,nbf:now,exp:Math.min(now+60,p.review_expires_at),jti,binding:p.review_binding})).toString('base64url');return {jti,compact:`${h}.${b}.${sign(null,Buffer.from(`${h}.${b}`),keys.privateKey).toString('base64url')}`};}
function apply(p:any,a=assertion(p)){return post('/v1/cxone/page/apply-fix',{page_id:1,preview_token:p.preview_token,preview_hash:p.preview_hash,reviewer_assertion:a.compact,requested_by:'forged'});}
it('exposes authoritative exact binding/expiry and writes once with verified attribution and durable status',async()=>{
 const p=await preview();expect(p.status).toBe(200);expect(p.body.review_expires_at).toBeGreaterThan(Math.floor(Date.now()/1000));expect(p.body.review_binding).toMatchObject({action:'cxone.apply',target:{hostname:'dev.libretexts.org',page_id:'1',page_path:cxone.path},fix_mode:'deterministic',tier:null,snapshot:null});
 const a=assertion(p.body),r=await apply(p.body,a);expect(r.status).toBe(200);expect(r.body).toMatchObject({outcome:'known_success',applied:true,evidence_effect:'invalidate'});expect(cxone.writes).toEqual([p.body.after_html]);
 expect((await post('/v1/cxone/page/operation-status',{issuer,jti:a.jti})).body).toEqual(r.body);
 expect((await apply(p.body,a)).status).toBe(409);expect(cxone.writes).toHaveLength(1);
 const audit=await readFile(join(dir,'audit.log'),'utf8');expect(audit).toContain('verified-user');expect(audit).not.toContain('forged');expect(audit).toContain(issuer);expect(audit).not.toContain(a.compact);
});
it('authenticates readiness, denies aliases and rejects unsigned or wrong binding requests without mutation',async()=>{
 const ready=await fetch(base+'/readyz',{headers:{'X-Remedy-Service-Key':service}});expect(ready.status).toBe(200);expect(await ready.json()).toEqual({ok:true,state:'ready',capabilities:{scan:true,preview:true,mutate:true,operation_status:true}});
 const p=(await preview()).body;
 expect((await post('/v1/cxone/page/apply-fix',{page_id:1,preview_token:p.preview_token,preview_hash:p.preview_hash})).status).toBe(401);
 expect((await post('/api/apply',{page:'1',tier:1})).status).toBe(403);
 const wrong=structuredClone(p);wrong.review_binding.after_sha256='c'.repeat(64);
 expect((await apply(p,assertion(wrong))).status).toBe(403);expect(cxone.writes).toEqual([]);
 expect((await post('/v1/cxone/page/operation-status',{issuer,jti:randomBytes(32).toString('base64url')})).status).toBe(404);
 expect((await post('/v1/cxone/page/operation-status',{issuer,jti:'bad',extra:true})).status).toBe(400);
});
it('preserves matched no-change evidence and invalidates proven stale source and renamed target',async()=>{
 cxone.html='<p>No change</p>';let p=(await preview()).body;let r=await apply(p);expect(r.status).toBe(200);expect(r.body).toMatchObject({outcome:'not_attempted',reason:'no_change',applied:false,evidence_effect:'preserve'});
 cxone.html='<p><strong>Chapter</strong></p>';p=(await preview()).body;cxone.html='<p>External change</p>';r=await apply(p);expect(r.status).toBe(409);expect(r.body).toMatchObject({reason:'stale_preview',evidence_effect:'invalidate'});
 cxone.html='<p><strong>Chapter</strong></p>';p=(await preview()).body;cxone.path='Sandboxes/johnnyphung/Renamed';r=await apply(p);expect(r.status).toBe(409);expect(r.body).toMatchObject({reason:'target_mismatch',evidence_effect:'invalidate'});expect(cxone.writes).toEqual([]);
});
it('exposes pending by nonce before the caller receives any operation ID and denies concurrent target claims',async()=>{
 const p=(await preview()).body,q=(await preview()).body,a=assertion(p);let release!:()=>void;cxone.gate=new Promise<void>(r=>release=r);
 let entered!:()=>void;const writing=new Promise<void>(r=>entered=r);cxone.onWrite=entered;
 const pending=apply(p,a);await writing;
 try {
  const status=await post('/v1/cxone/page/operation-status',{issuer,jti:a.jti});expect(status.body).toMatchObject({outcome:'pending',applied:null,evidence_effect:'hold'});
  expect((await apply(q)).status).toBe(409);expect((await apply(p,a)).status).toBe(409);
 }finally{release();}
 expect((await pending).body).toMatchObject({outcome:'known_success',applied:true});expect(cxone.writes).toHaveLength(1);
});
it('retains known success after audit append failure',async()=>{
 const previous=process.env.REMEDY_AUDIT_LOG;vi.stubEnv('REMEDY_AUDIT_LOG',dir);
 try{const p=(await preview()).body;const r=await apply(p);expect(r.status).toBe(200);expect(r.body).toMatchObject({outcome:'known_success',applied:true,audit_recorded:false,evidence_effect:'invalidate'});expect(cxone.writes).toHaveLength(1);}
 finally{vi.stubEnv('REMEDY_AUDIT_LOG',previous!);}
});
it('recovers a lost caller response before any operation ID by read-only nonce lookup',async()=>{
 const p=(await preview()).body,a=assertion(p.body??p),controller=new AbortController();let release!:()=>void;cxone.gate=new Promise<void>(r=>release=r);let entered!:()=>void;const writing=new Promise<void>(r=>entered=r);cxone.onWrite=entered;
 const request=fetch(base+'/v1/cxone/page/apply-fix',{method:'POST',headers:{'X-Remedy-Service-Key':service},signal:controller.signal,body:JSON.stringify({page_id:1,preview_token:p.preview_token,preview_hash:p.preview_hash,reviewer_assertion:a.compact})});
 await writing;controller.abort();await expect(request).rejects.toThrow();
 try{expect((await post('/v1/cxone/page/operation-status',{issuer,jti:a.jti})).body.outcome).toBe('pending');}finally{release();}
 await vi.waitFor(async()=>expect((await post('/v1/cxone/page/operation-status',{issuer,jti:a.jti})).body).toMatchObject({outcome:'known_success',applied:true}));expect(cxone.writes).toHaveLength(1);
});
it('restores only the signed, exact reviewed snapshot output',async()=>{
 const {saveSnapshot}=await import('../guardrails.js');const saved=await saveSnapshot('<p>Restore exact</p>',{pageId:1,pagePath:cxone.path,hostname:'dev.libretexts.org',operator:'synthetic',rules:[],source:'fix'},process.env);
 const p=await post('/v1/cxone/page/restore-preview',{page_id:1,snapshot_timestamp:saved.meta.ts});expect(p.status).toBe(200);expect(p.body.review_binding).toMatchObject({action:'cxone.restore',fix_mode:'restore',tier:null,snapshot:{timestamp:saved.meta.ts,sha256:p.body.review_binding.after_sha256}});
 const a=assertion(p.body),r=await post('/v1/cxone/page/restore',{page_id:1,preview_token:p.body.preview_token,preview_hash:p.body.preview_hash,reviewer_assertion:a.compact});expect(r.status).toBe(200);expect(r.body).toMatchObject({outcome:'known_success',restored:true,applied:false});expect(cxone.writes).toEqual(['<p>Restore exact</p>']);
});
it('acknowledges key revocation durably, rejects reenabling an old ID and supports explicit rotation',async()=>{
 const {reloadReviewerKeys}=await import('../../../conductor-panel/server/server.js');const config=JSON.parse(await readFile(join(dir,'keys.json'),'utf8'));const p=(await preview()).body,a=assertion(p);config.keys[0].revoked_at=Math.floor(Date.now()/1000);await writeFile(join(dir,'keys.json'),JSON.stringify(config));await reloadReviewerKeys();
 expect((await apply(p,a)).status).toBe(401);expect(cxone.writes).toEqual([]);
 config.keys[0].revoked_at=null;await writeFile(join(dir,'keys.json'),JSON.stringify(config));await reloadReviewerKeys();expect((await apply(p,a)).status).toBe(401);
 config.keys[0].kid='synthetic2';signerKid='synthetic2';await writeFile(join(dir,'keys.json'),JSON.stringify(config));await reloadReviewerKeys();expect((await apply(p)).status).toBe(200);expect(cxone.writes).toHaveLength(1);
});
it('keeps reads/status available while an invalid explicit key reload disables all dispatch',async()=>{
 const module=await import('../../../conductor-panel/server/server.js');const previous=await readFile(join(dir,'keys.json'),'utf8');await writeFile(join(dir,'keys.json'),'{}');
 try{
  await expect(module.reloadReviewerKeys()).rejects.toThrow('reviewer_configuration_invalid');
  const r=await fetch(base+'/readyz',{headers:{'X-Remedy-Service-Key':service}});expect(r.status).toBe(503);expect(await r.json()).toMatchObject({capabilities:{mutate:false,operation_status:true}});
  expect((await apply((await preview()).body)).status).toBe(503);
  expect((await post('/v1/cxone/page/operation-status',{issuer,jti:randomBytes(32).toString('base64url')})).status).toBe(404);expect(cxone.writes).toEqual([]);
 }finally{await writeFile(join(dir,'keys.json'),previous);await module.reloadReviewerKeys();}
});
it('rejects duplicate body fields before consuming the signed operation and never leaks parser details',async()=>{
 const p=(await preview()).body,a=assertion(p);const body=JSON.stringify({page_id:1,preview_token:p.preview_token,preview_hash:p.preview_hash,reviewer_assertion:a.compact});
 const r=await fetch(base+'/v1/cxone/page/apply-fix',{method:'POST',headers:{'X-Remedy-Service-Key':service},body:body.slice(0,-1)+',"reviewer_assertion":"forged"}'});expect(r.status).toBe(400);expect(await r.json()).toEqual({error:'invalid_request'});expect(cxone.writes).toEqual([]);
 expect((await post('/v1/cxone/page/operation-status',{issuer:'wrong-issuer',jti:a.jti})).status).toBe(400);
});
it('blocks dispatch when pre-write snapshot storage fails',async()=>{
 const previous=process.env.REMEDY_SNAPSHOT_DIR;vi.stubEnv('REMEDY_SNAPSHOT_DIR',join(dir,'service'));
 try{const p=(await preview()).body;const r=await apply(p);expect(r.status).toBe(409);expect(r.body).toMatchObject({outcome:'not_attempted',reason:'pre_dispatch_failure',applied:false,evidence_effect:'preserve'});expect(cxone.writes).toEqual([]);}finally{vi.stubEnv('REMEDY_SNAPSHOT_DIR',previous!);}
});
it('returns fixed unknown metadata and retains quarantine after transport loss and restart',async()=>{
 const p=(await preview()).body,a=assertion(p);cxone.lose=true;const r=await apply(p,a);expect(r.status).toBe(502);expect(r.body).toMatchObject({outcome:'unknown_write',applied:null,restored:false,evidence_effect:'invalidate',requires_reconciliation:true,reconciliation:'required',error:'write_outcome_unknown'});expect(JSON.stringify(r.body)).not.toMatch(/private upstream|\.json|snapshot|reviewer_assertion/);
 expect((await post('/v1/cxone/page/operation-status',{issuer,jti:a.jti})).body).toMatchObject({operation_id:r.body.operation_id,outcome:'unknown_write'});
 cxone.html='<p><strong>New source</strong></p>';expect((await apply((await preview()).body)).status).toBe(409);expect(cxone.writes).toHaveLength(1);
 await new Promise<void>(r=>server.close(()=>r()));await (await import('../../../conductor-panel/server/server.js')).closeSignedWriter();vi.resetModules();
 server=(await import('../../../conductor-panel/server/server.js')).server;await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${(server.address()as{port:number}).port}`;
 expect((await post('/v1/cxone/page/operation-status',{issuer,jti:a.jti})).body).toMatchObject({operation_id:r.body.operation_id,outcome:'unknown_write'});expect((await apply((await preview()).body)).status).toBe(409);expect(cxone.writes).toHaveLength(1);
});

it('fails readiness and status closed when the independent fence becomes unreadable',async()=>{
 const original=await readFile(store.fencePath,'utf8');await writeFile(store.fencePath,'corrupt');
 try{const r=await post('/v1/cxone/page/operation-status',{issuer,jti:randomBytes(32).toString('base64url')});expect(r.status).toBe(503);expect(r.body.error).toBe('claim_store_unavailable');const ready=await fetch(base+'/readyz',{headers:{'X-Remedy-Service-Key':service}});expect(ready.status).toBe(503);expect(await ready.json()).toMatchObject({capabilities:{mutate:false,operation_status:false}});expect(cxone.writes).toEqual([]);}finally{await writeFile(store.fencePath,original);}
});
