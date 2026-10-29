import { afterEach, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { DurableLedger } from '../../../conductor-panel/server/durable-ledger.js';
const children:ChildProcess[]=[],servers:Server[]=[];
async function stop(p:ChildProcess){if(p.exitCode!==null||p.signalCode!==null)return;await new Promise<void>(r=>{p.once('close',()=>r());p.kill('SIGKILL');});}
afterEach(async()=>{await Promise.all(children.splice(0).map(stop));await Promise.all(servers.splice(0).map(s=>{s.closeAllConnections();return new Promise<void>(r=>s.close(()=>r()));}));});
async function start(env:NodeJS.ProcessEnv){
 const child=spawn(process.execPath,['--import','tsx','--loader',new URL('./support/no-dotenv-loader.mjs',import.meta.url).pathname,new URL('./support/signed-bridge-child.ts',import.meta.url).pathname],{env,stdio:['ignore','pipe','pipe','ipc']});children.push(child);
 child.stdout!.resume();child.stderr!.resume();
 const port=await new Promise<number>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('synthetic child startup timeout')),8000);child.once('message',(m:any)=>{clearTimeout(timer);resolve(m.port);});child.once('exit',()=>{clearTimeout(timer);reject(Error('synthetic child startup failed'));});});
 const url=`http://127.0.0.1:${port}`;
 const request=async(path:string,body:unknown,auth=true)=>{const r=await fetch(url+path,{method:'POST',headers:auth?{'X-Remedy-Service-Key':env.REMEDY_TEST_SERVICE!}:{},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 return {child,url,request};
}
it('recovers an actual lost HTTP reply after durable success, survives process death and serves unchanged review-only history',async()=>{
 const root=await mkdtemp(join(tmpdir(),'terminal-http-'));await mkdir(join(root,'ledger'));
 const options={directory:join(root,'ledger'),fencePath:join(root,'fence.json'),trustEpoch:'terminal-http'};await(await DurableLedger.open({...options,initialize:true})).close();
 const keys=generateKeyPairSync('ed25519'),issuer='urn:conductor:terminal',audience='urn:bridge:terminal',service='d'.repeat(64);
 await writeFile(join(root,'service'),service);await writeFile(join(root,'keys'),JSON.stringify({issuer,audience,environment:'test',trust_epoch:options.trustEpoch,keys:[{kid:'terminal-test',issuer,audience,environment:'test',trust_epoch:options.trustEpoch,kty:'OKP',crv:'Ed25519',x:keys.publicKey.export({format:'jwk'}).x,not_before:0,not_after:4102444800,enabled:true,revoked_at:null}]}));
 let html='<p><strong>Terminal chapter</strong></p>',writes=0,reads=0,release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>release=r),writing=new Promise<void>(r=>entered=r);
 const external=createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.method==='POST'){const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));html=Buffer.concat(chunks).toString();writes++;entered();await gate;res.end('{"page":{"@revision":"1"}}');}else{reads++;res.end(JSON.stringify(req.url?.includes('/contents')?{body:html}:{'@id':1,path:'Sandboxes/johnnyphung/Page'}));}});servers.push(external);await new Promise<void>(r=>external.listen(0,'127.0.0.1',r));
 const env={PATH:process.env.PATH!,NODE_ENV:'test',CXONE_INTEGRATION_ENABLED:'true',SERVER_DOMAIN:'dev.libretexts.org',SERVER_KEY:'fake',SERVER_SECRET:'fake',SERVER_USER:'fake',REMEDY_LLM_PROVIDER:'ollama-local',REMEDY_REVIEWER_REQUIRED:'true',REMEDY_REVIEWER_TRUST_EPOCH:options.trustEpoch,REMEDY_REVIEWER_KEYRING_FILE:join(root,'keys'),REMEDY_BRIDGE_SERVICE_KEY_FILE:join(root,'service'),REMEDY_CLAIM_DB:join(options.directory,'claims.sqlite3'),REMEDY_CLAIM_FENCE_DIR:root,REMEDY_SNAPSHOT_DIR:join(root,'snapshots'),REMEDY_AUDIT_LOG:root,REMEDY_TEST_SERVICE:service,TEST_CXONE_URL:`http://127.0.0.1:${(external.address()as any).port}`};
 const f=await start(env),p=(await f.request('/v1/cxone/page/preview-fix',{page_id:1})).body;
 const jti=randomBytes(32).toString('base64url'),now=Math.floor(Date.now()/1000),query={issuer,jti};
 const h=Buffer.from(JSON.stringify({alg:'Ed25519',kid:'terminal-test',typ:'remedy-review+jwt'})).toString('base64url'),payload=Buffer.from(JSON.stringify({v:1,iss:issuer,aud:audience,sub:'synthetic-reviewer',iat:now,nbf:now,exp:now+60,jti,binding:p.review_binding})).toString('base64url');
 const body={page_id:1,preview_token:p.preview_token,preview_hash:p.preview_hash,reviewer_assertion:`${h}.${payload}.${sign(null,Buffer.from(`${h}.${payload}`),keys.privateKey).toString('base64url')}`};
 const controller=new AbortController();const lost=fetch(f.url+'/v1/cxone/page/apply-fix',{method:'POST',headers:{'X-Remedy-Service-Key':service},body:JSON.stringify(body),signal:controller.signal});
 await writing;controller.abort();await expect(lost).rejects.toThrow();
 try{expect((await f.request('/v1/cxone/page/operation-status',query)).body).toMatchObject({outcome:'pending',terminal_proof:null});}finally{release();}
 let terminal:any;await vi.waitFor(async()=>{terminal=await f.request('/v1/cxone/page/operation-status',query);expect(terminal.body).toMatchObject({outcome:'known_success',audit_recorded:false,terminal_proof:{contract:'cxone-terminal-v1',...query,target:{hostname:'dev.libretexts.org',page_id:'1'},outcome:'known_success',audit_recorded:false}});});
 expect(writes).toBe(1);await stop(f.child);
 // Restart in production review-only without a signing keyring: no recovery or writer open.
 const review=await start({...env,NODE_ENV:'production',REMEDY_BRIDGE_PROFILE:'review-only',REMEDY_REVIEWER_KEYRING_FILE:'',REMEDY_OPERATION_STATUS_ISSUER:issuer});
 const files=(await readdir(options.directory)).filter(n=>n!=='claims.sqlite3-shm').map(n=>join(options.directory,n)).concat(options.fencePath);
 const bytes=await Promise.all(files.map(n=>readFile(n))),readCount=reads;
 expect((await review.request('/v1/cxone/page/operation-status',query)).body).toEqual(terminal.body);
 expect((await review.request('/v1/cxone/page/operation-status',query,false)).status).toBe(401);
 expect((await review.request('/v1/cxone/page/operation-status',{...query,issuer:'wrong'})).status).toBe(400);
 expect((await review.request('/v1/cxone/page/operation-status',{...query,target:{page_id:'2'}})).status).toBe(400);
 expect((await review.request('/v1/cxone/page/operation-status',{issuer,jti:randomBytes(32).toString('base64url')})).status).toBe(404);
 expect((await review.request('/v1/cxone/page/apply-fix',body)).status).toBe(503);
 expect(await Promise.all(files.map(n=>readFile(n)))).toEqual(bytes);expect(reads).toBe(readCount);expect(writes).toBe(1);
 await writeFile(options.fencePath,JSON.stringify({trust_epoch:'other-epoch',durability_seq:terminal.body.terminal_proof.durability_seq}));
 expect(await review.request('/v1/cxone/page/operation-status',query)).toEqual({status:503,body:{error:'claim_store_unavailable'}});expect(writes).toBe(1);
},30000);
