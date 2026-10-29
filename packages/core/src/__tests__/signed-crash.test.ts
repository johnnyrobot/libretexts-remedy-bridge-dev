import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { DurableLedger } from '../../../conductor-panel/server/durable-ledger.js';
const processes:ChildProcess[]=[],servers:Server[]=[];
afterEach(async()=>{for(const p of processes.splice(0)){if(p.exitCode===null&&p.signalCode===null)p.kill('SIGKILL');}await Promise.all(servers.splice(0).map(s=>{s.closeAllConnections();return new Promise<void>(r=>s.close(()=>r()));}));});
it.each(['before_send','during_send','after_response'])('actual Node crash at %s keeps target quarantined on restart',async stage=>{
 const dir=await mkdtemp(join(tmpdir(),'bridge-crash-'));await mkdir(join(dir,'ledger'));
 const store={directory:join(dir,'ledger'),fencePath:join(dir,'fence.json'),trustEpoch:'crash-test'};await(await DurableLedger.open({...store,initialize:true})).close();
 const keys=generateKeyPairSync('ed25519'),issuer='urn:conductor:crash',audience='urn:bridge:crash',key='c'.repeat(64);
 await writeFile(join(dir,'service'),key);await writeFile(join(dir,'keys'),JSON.stringify({issuer,audience,environment:'test',trust_epoch:store.trustEpoch,keys:[{kid:'crash-key',issuer,audience,environment:'test',trust_epoch:store.trustEpoch,kty:'OKP',crv:'Ed25519',x:keys.publicKey.export({format:'jwk'}).x,not_before:0,not_after:4102444800,enabled:true,revoked_at:null}]}));
 let html='<p><strong>Crash chapter</strong></p>',writes=0;let sent!:()=>void;const mutation=new Promise<void>(r=>sent=r);
 const external=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));res.setHeader('content-type','application/json');if(req.method==='POST'){writes++;html=Buffer.concat(chunks).toString();sent();if(stage==='during_send')return;res.end('{"page":{"@revision":"1"}}');}else if(req.url!.includes('/contents'))res.end(JSON.stringify({body:html}));else res.end(JSON.stringify({'@id':1,path:'Sandboxes/johnnyphung/Page'}));});servers.push(external);await new Promise<void>(r=>external.listen(0,'127.0.0.1',r));
 const env={PATH:process.env.PATH!,NODE_ENV:'test',CXONE_INTEGRATION_ENABLED:'true',SERVER_DOMAIN:'dev.libretexts.org',SERVER_KEY:'fake',SERVER_SECRET:'fake',SERVER_USER:'fake',REMEDY_LLM_PROVIDER:'ollama-local',REMEDY_REVIEWER_REQUIRED:'true',REMEDY_REVIEWER_TRUST_EPOCH:store.trustEpoch,REMEDY_REVIEWER_KEYRING_FILE:join(dir,'keys'),REMEDY_BRIDGE_SERVICE_KEY_FILE:join(dir,'service'),REMEDY_CLAIM_DB:join(dir,'ledger','claims.sqlite3'),REMEDY_CLAIM_FENCE_DIR:dir,REMEDY_SNAPSHOT_DIR:join(dir,'snapshots'),REMEDY_AUDIT_LOG:join(dir,'audit'),TEST_CXONE_URL:`http://127.0.0.1:${(external.address()as{port:number}).port}`,TEST_CRASH_STAGE:stage};
 const child=spawn(process.execPath,['--import','tsx','--loader',new URL('./support/no-dotenv-loader.mjs',import.meta.url).pathname,new URL('./support/signed-bridge-child.ts',import.meta.url).pathname],{env,stdio:['ignore','pipe','pipe','ipc']});processes.push(child);
 let diagnostics='';child.stderr!.on('data',c=>diagnostics+=c);
 const port=await new Promise<number>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('child startup timed out '+diagnostics)),8000);child.once('message',(m:any)=>{clearTimeout(timer);resolve(m.port);});child.once('exit',()=>{clearTimeout(timer);reject(new Error('child startup failed '+diagnostics));});});
 const base=`http://127.0.0.1:${port}`;const post=async(path:string,body:unknown)=>{const r=await fetch(base+path,{method:'POST',headers:{'X-Remedy-Service-Key':key},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const p=(await post('/v1/cxone/page/preview-fix',{page_id:1})).body;expect(p.review_binding).toBeDefined();const now=Math.floor(Date.now()/1000),jti=randomBytes(32).toString('base64url'),h=Buffer.from(JSON.stringify({alg:'Ed25519',kid:'crash-key',typ:'remedy-review+jwt'})).toString('base64url'),payload=Buffer.from(JSON.stringify({v:1,iss:issuer,aud:audience,sub:'synthetic-user',iat:now,nbf:now,exp:now+60,jti,binding:p.review_binding})).toString('base64url');
 const exited=new Promise<void>(r=>child.once('exit',()=>r()));
 const request=post('/v1/cxone/page/apply-fix',{page_id:1,preview_token:p.preview_token,preview_hash:p.preview_hash,reviewer_assertion:`${h}.${payload}.${sign(null,Buffer.from(`${h}.${payload}`),keys.privateKey).toString('base64url')}`}).catch(()=>null);
 if(stage==='during_send'){await mutation;child.kill('SIGKILL');}await exited;await request;
 // The pipe helper exits on parent EOF; startup never breaks a held lock.
 await new Promise(r=>setTimeout(r,80));const ledger=await DurableLedger.open(store);
 try{expect(await ledger.status({issuer,jti})).toMatchObject({outcome:'unknown_write',applied:null,evidence_effect:'invalidate',requires_reconciliation:true});await expect(ledger.claim({issuer,jti:randomBytes(32).toString('base64url'),preview_token:'fresh',target:{hostname:'dev.libretexts.org',page_id:'1'},binding:p.review_binding,subject:'synthetic-user',expires_at:now+60})).rejects.toMatchObject({code:'claim_conflict'});expect(writes).toBe(stage==='before_send'?0:1);}finally{await ledger.close();}
},15000);
