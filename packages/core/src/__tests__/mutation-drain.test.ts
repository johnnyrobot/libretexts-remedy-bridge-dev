import {expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {DurableLedger} from '../../../conductor-panel/server/durable-ledger.js';
const remote=vi.hoisted(()=>({gate:undefined as Promise<void>|undefined,entered:()=>{},html:'<p><strong>Title</strong></p>'}));
vi.mock('dotenv',()=>({config:()=>({})}));vi.mock('dotenv/config',()=>({}));
vi.mock('@libretexts/cxone-expert-node',()=>({default:class{pages={getPageInfo:async()=>({'@id':1,path:'Sandboxes/johnnyphung/Page'}),getPageContents:async()=>({body:remote.html}),postPageContents:async()=>{remote.entered();await remote.gate;return{page:{'@revision':'9'}};}}}}));
it('retains actual ledger ownership after dispatch plus disconnect plus shutdown until durable finalization',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mutation-drain-'));await mkdir(join(root,'ledger'));const store={directory:join(root,'ledger'),fencePath:join(root,'fence.json'),trustEpoch:'synthetic'};await(await DurableLedger.open({...store,initialize:true})).close();
 const keys=generateKeyPairSync('ed25519'),issuer='urn:conductor:test',audience='urn:bridge:test',service='d'.repeat(64);
 await writeFile(join(root,'service'),service);await writeFile(join(root,'keys'),JSON.stringify({issuer,audience,environment:'test',trust_epoch:'synthetic',keys:[{kid:'test',kty:'OKP',crv:'Ed25519',x:keys.publicKey.export({format:'jwk'}).x,issuer,audience,environment:'test',trust_epoch:'synthetic',not_before:0,not_after:4102444800,enabled:true,revoked_at:null}]}));
 for(const[k,v]of Object.entries({NODE_ENV:'test',REMEDY_PREVIEW_ENTRIES:'1',REMEDY_REVIEWER_REQUIRED:'true',REMEDY_REVIEWER_TRUST_EPOCH:'synthetic',REMEDY_REVIEWER_KEYRING_FILE:join(root,'keys'),REMEDY_BRIDGE_SERVICE_KEY_FILE:join(root,'service'),REMEDY_CLAIM_DB:join(root,'ledger/claims.sqlite3'),REMEDY_CLAIM_FENCE_DIR:root,CXONE_INTEGRATION_ENABLED:'true',SERVER_DOMAIN:'dev.libretexts.org',SERVER_KEY:'fake',SERVER_SECRET:'fake',SERVER_USER:'fake',REMEDY_SNAPSHOT_DIR:join(root,'snapshots'),REMEDY_AUDIT_LOG:join(root,'audit')}))vi.stubEnv(k,v);
 const bridge=await import('../../../conductor-panel/server/server.js');const server=bridge.createBridgeServer(bridge.executeReadInline);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address()as any).port}`;
 const post=(path:string,body:unknown,signal?:AbortSignal)=>fetch(base+path,{method:'POST',headers:{'X-Remedy-Service-Key':service},body:JSON.stringify(body),signal});
 let release=()=>{};
 try{
  const p=await(await post('/v1/cxone/page/preview-fix',{page_id:1})).json();const now=Math.floor(Date.now()/1000),jti=randomBytes(32).toString('base64url');const h=Buffer.from(JSON.stringify({alg:'Ed25519',kid:'test',typ:'remedy-review+jwt'})).toString('base64url'),b=Buffer.from(JSON.stringify({v:1,iss:issuer,aud:audience,sub:'operator',iat:now,nbf:now,exp:now+60,jti,binding:p.review_binding})).toString('base64url');
  remote.gate=new Promise(r=>release=r);let entered!:()=>void;const dispatched=new Promise<void>(r=>entered=r);remote.entered=entered;
  const controller=new AbortController();const pending=post('/v1/cxone/page/apply-fix',{page_id:1,preview_token:p.preview_token,preview_hash:p.preview_hash,reviewer_assertion:`${h}.${b}.${sign(null,Buffer.from(`${h}.${b}`),keys.privateKey).toString('base64url')}`},controller.signal).catch(()=>null);
  await dispatched;
  // With one preview slot, consuming a signed token must release all cache owners.
  expect((await post('/v1/cxone/page/preview-fix',{page_id:1})).status).toBe(200);
  controller.abort();await pending;server.close();const drained=bridge.closeSignedWriter();
  await expect(DurableLedger.open(store)).rejects.toMatchObject({code:'claim_store_unavailable'});
  release();await drained;
  const ledger=await DurableLedger.open(store);try{expect(await ledger.status({issuer,jti})).toMatchObject({outcome:'known_success',applied:true});}finally{await ledger.close();}
 }finally{release();server.close();await bridge.closeSignedWriter();vi.unstubAllEnvs();}
},15000);
