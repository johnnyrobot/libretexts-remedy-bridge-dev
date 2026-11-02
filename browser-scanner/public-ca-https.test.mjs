import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {fork,execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,chmod,readdir,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {certificates} from './public-ca-fixture.mjs';
import {collectDiagnostics} from './test-diagnostics.mjs';
import {findOwnedWorker} from './test-worker-identity.mjs';
const enabled=process.env.RUN_BROWSER_TESTS==='1'&&process.platform==='linux';
const page='<html lang="en"><head><title>TLS fixture</title></head><body><section class="mt-content-container">Synthetic controlled HTTPS reader with enough content.</section></body></html>';
const sha=value=>createHash('sha256').update(value).digest('hex');
async function until(check){for(let i=0;i<200;i++){if(await check())return;await sleep(50);}throw Error('HTTPS job did not settle');}
async function fixture(certs,respond=(req,res)=>res.end(page)){
 const server=createServer(certs,(req,res)=>{if(req.url!=='/Sandboxes/johnnyphung/tls-test')return res.end('');res.setHeader('Content-Type','text/html');respond(req,res);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return{port:server.address().port,close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
async function scanner(root,port,ca,extra={}){
 const child=fork(fileURLToPath(new URL('./server.mjs',import.meta.url)),[],{execArgv:[],env:{...process.env,TMPDIR:root,TMP:root,TEMP:root,RENDER_SCANNER_TOKEN:'synthetic-only',RENDER_SCANNER_PORT:'0',RENDER_ALLOWED_HOSTS:'dev.libretexts.org',RENDER_PUBLIC_CA_FILE:ca??'',LT239_HTTPS_PORT:String(port),...extra,NODE_OPTIONS:`--loader ${fileURLToPath(new URL('./public-ca-https-loader.mjs',import.meta.url))}`},stdio:['ignore','ignore','pipe','ipc']});
 const diagnostics=collectDiagnostics(child.stderr),exited=new Promise(r=>child.once('exit',r));
 let scannerPort;
 try{scannerPort=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(diagnostics.text())),10000);child.once('message',m=>{clearTimeout(timer);resolve(m.port);});child.once('exit',()=>{clearTimeout(timer);reject(Error(diagnostics.text()));});});}
 catch(error){child.kill('SIGTERM');await exited;if(child.connected)child.disconnect();throw error;}
 const base=`http://127.0.0.1:${scannerPort}`;
 return{child,request:({signal,body={}}={})=>fetch(base+'/scan',{method:'POST',headers:{Authorization:'Bearer synthetic-only'},body:JSON.stringify({url:'https://dev.libretexts.org/Sandboxes/johnnyphung/tls-test',...body}),signal}),health:()=>fetch(base+'/healthz').then(r=>r.json()),close:async()=>{child.kill('SIGTERM');await exited;if(child.connected)child.disconnect();}};
}
async function idle(server,root){await until(async()=>!(await server.health()).busy);assert.deepEqual(await readdir(root),[]);}
async function completed(server,root){const response=await server.request();assert.equal(response.status,200);const result=await response.json();assert.equal(result.state,'complete',JSON.stringify(result));await idle(server,root);return result;}
const processRows=()=>execFileSync('ps',['-eo','pid=,ppid=,pgid=,stat=,args='],{encoding:'utf8'}).trim().split('\n').map(line=>line.trim().split(/\s+/));

test('operator public CA reaches actual HTTPS through HTTP and the owned sandboxed worker',{skip:!enabled,timeout:30000},async()=>{
 const certs=await certificates(),root=await mkdtemp('/tmp/lt239-jobs-');let reads=0;
 const https=await fixture(certs,(req,res)=>{reads++;res.end(page);}),server=await scanner(root,https.port,certs.ca);
 try{
  const result=await completed(server,root);assert.ok(reads>0);assert.equal(result.publicCATrust.sha256,sha(await readFile(certs.ca)));
  console.log(JSON.stringify({phase:'public_ca_https_success',node:process.version,browser:result.browser,trust:result.publicCATrust,nss:execFileSync('dpkg-query',['-W','libnss3','libnss3-tools'],{encoding:'utf8'}).trim(),certutilSha256:sha(await readFile('/usr/bin/certutil'))}));
 }finally{await server.close();await https.close();}
});

test('absent and wrong CA and wrong hostname refuse real TLS; request fields cannot choose trust',{skip:!enabled,timeout:45000},async()=>{
 const certs=await certificates(),wrong=await certificates(),mismatch=await certificates('wrong.invalid');
 for(const mode of ['absent','wrong-ca','wrong-hostname']){
  const root=await mkdtemp('/tmp/lt239-denied-');let reads=0;
  const https=await fixture(mode==='wrong-hostname'?mismatch:certs,(req,res)=>{reads++;res.end(page);});
  const server=await scanner(root,https.port,mode==='absent'?undefined:mode==='wrong-ca'?wrong.ca:mismatch.ca);
  try{
   const response=await server.request({body:{publicCA:await readFile(certs.ca,'utf8'),RENDER_PUBLIC_CA_FILE:certs.ca}});assert.equal(response.status,200);
   const result=await response.json();assert.equal(result.state,'error');assert.match(result.error,mode==='wrong-hostname'?/ERR_CERT_COMMON_NAME_INVALID/:/ERR_CERT_AUTHORITY_INVALID/);assert.equal(reads,0);await idle(server,root);
   console.log(JSON.stringify({phase:mode,error:result.error,externalReads:reads}));
  }finally{await server.close();await https.close();}
 }
});

test('invalid configured public CA refuses service startup without jobs or HTTPS reads',{skip:!enabled,timeout:30000},async()=>{
 const certs=await certificates(),dir=await mkdtemp('/tmp/lt239-invalid-');let reads=0;
 const https=await fixture(certs,(req,res)=>{reads++;res.end(page);});
 try{
  const cases=[['missing',null],['malformed','invalid'],['empty',''],['key',await readFile(join(certs.dir,'ca.key'))],['leaf',certs.cert],['oversized','x'.repeat(65537)],['count',(await readFile(certs.ca,'utf8')).repeat(9)],['unreadable',await readFile(certs.ca)],['writable',await readFile(certs.ca)]];
  for(const [mode,value] of cases){const file=join(dir,mode);if(value!==null)await writeFile(file,value,{mode:mode==='unreadable'?0o000:mode==='writable'?0o644:0o444});const root=await mkdtemp('/tmp/lt239-unadmitted-');await assert.rejects(scanner(root,https.port,file),/Public CA configuration invalid or unavailable/);assert.deepEqual(await readdir(root),[]);}
  assert.equal(reads,0);
 }finally{await https.close();}
});

test('sequential jobs use the captured operator hash and never share HTTPS cookies',{skip:!enabled,timeout:30000},async()=>{
 const certs=await certificates(),root=await mkdtemp('/tmp/lt239-sequential-'),cookies=[];
 const https=await fixture(certs,(req,res)=>{cookies.push(req.headers.cookie??'');res.setHeader('Set-Cookie','lt239=synthetic; Secure; HttpOnly');res.end(page);}),server=await scanner(root,https.port,certs.ca);
 try{
  const expected=sha(await readFile(certs.ca));const a=await completed(server,root);
  await chmod(certs.ca,0o644);await writeFile(certs.ca,'operator replacement applies only after restart');
  const b=await completed(server,root);assert.equal(a.publicCATrust.sha256,expected);assert.equal(b.publicCATrust.sha256,expected);assert.ok(cookies.length>=2);assert.ok(cookies.every(c=>c===''));
 }finally{await server.close();await https.close();}
});

test('concurrent jobs isolate NSS trust mutations, empty private-key stores and cookies',{skip:!enabled,timeout:35000},async()=>{
 const certs=await certificates(),root=await mkdtemp('/tmp/lt239-concurrent-'),cookies=[],responses=[];
 const https=await fixture(certs,(req,res)=>{cookies.push(req.headers.cookie??'');responses.push(res);});
 const a=await scanner(root,https.port,certs.ca),b=await scanner(root,https.port,certs.ca);
 try{
  const ar=a.request();await until(()=>responses.length===1);const [aname]=await readdir(root);
  const br=b.request();await until(()=>responses.length===2);const bname=(await readdir(root)).find(n=>n!==aname);assert.ok(bname);
  const db=name=>join(root,name,'home','.pki','nssdb');
  const list=name=>execFileSync('/usr/bin/certutil',['-L','-d','sql:'+db(name)],{encoding:'utf8'});
  assert.match(list(aname),/operator-ca-0/);assert.match(list(bname),/operator-ca-0/);
  for(const name of [aname,bname]){
   const privateKeys=execFileSync('python3',['-c','import sqlite3,sys; print(sqlite3.connect("file:"+sys.argv[1]+"?mode=ro", uri=True).execute("select count(*) from nssPrivate").fetchone()[0])',join(db(name),'key4.db')],{encoding:'utf8'});assert.equal(privateKeys.trim(),'0');
   assert.equal((await lstat(join(root,name,'home'))).mode&0o077,0);
  }
  execFileSync('/usr/bin/certutil',['-D','-d','sql:'+db(aname),'-n','operator-ca-0']);assert.doesNotMatch(list(aname),/operator-ca-0/);assert.match(list(bname),/operator-ca-0/);
  for(const res of responses){res.setHeader('Set-Cookie','lt239=concurrent; Secure');res.end(page);}
  for(const response of await Promise.all([ar,br])){assert.equal(response.status,200);assert.equal((await response.json()).state,'complete');}
  await until(async()=>!(await a.health()).busy&&!(await b.health()).busy);assert.deepEqual(await readdir(root),[]);assert.deepEqual(cookies,['','']);
 }finally{for(const res of responses)res.end();await a.close();await b.close();await https.close();}
});

for(const mode of ['error','cancel'])test('public CA setup '+mode+' stays under guardian ownership and conservative cleanup',{skip:!enabled,timeout:25000},async()=>{
 const certs=await certificates(),root=await mkdtemp('/tmp/lt239-setup-'),server=await scanner(root,1,certs.ca,{LT239_SETUP_MODE:mode});
 try{
  const controller=new AbortController(),request=server.request({signal:controller.signal}).catch(()=>null);
  if(mode==='error'){const response=await request;assert.equal(response.status,503);await idle(server,root);assert.ok(!processRows().some(r=>+r[1]===server.child.pid));}
  else{
   let owned;
   await until(()=>{const found=findOwnedWorker(processRows(),server.child.pid);owned=found?.owned;return !!owned&&processRows().some(r=>owned.has(r[0])&&r.slice(4).join(' ').includes('lt239-setup-child'));});
   controller.abort();await request;await until(()=>!processRows().some(r=>owned.has(r[0])&&+r[0]!==server.child.pid));await sleep(300);
   assert.equal((await server.health()).busy,true);assert.equal((await server.request()).status,503);assert.equal((await readdir(root)).length,1);
  }
 }finally{await server.close();}
});
