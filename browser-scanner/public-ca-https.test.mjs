import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {fork,execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,chmod,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {collectDiagnostics} from './test-diagnostics.mjs';
const enabled=process.env.RUN_BROWSER_TESTS==='1'&&process.platform==='linux';
async function until(check){for(let i=0;i<200;i++){if(await check())return;await sleep(50);}throw Error('HTTPS job did not settle');}
async function certificates(){
 const dir=await mkdtemp('/tmp/lt239-certs-');
 const openssl=args=>execFileSync('openssl',args,{cwd:dir,stdio:'ignore'});
 openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','2','-subj','/CN=LT239 Synthetic CA','-addext','basicConstraints=critical,CA:TRUE']);
 openssl(['req','-newkey','rsa:2048','-nodes','-keyout','leaf.key','-out','leaf.csr','-subj','/CN=dev.libretexts.org']);
 await writeFile(join(dir,'leaf.ext'),'subjectAltName=DNS:dev.libretexts.org\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
 openssl(['x509','-req','-in','leaf.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out','leaf.pem','-days','2','-extfile','leaf.ext']);
 await chmod(join(dir,'ca.pem'),0o444);
 return{dir,ca:join(dir,'ca.pem'),key:await readFile(join(dir,'leaf.key')),cert:await readFile(join(dir,'leaf.pem'))};
}
async function scanner(root,port,ca){
 const child=fork(fileURLToPath(new URL('./server.mjs',import.meta.url)),[],{execArgv:[],env:{...process.env,TMPDIR:root,TMP:root,TEMP:root,RENDER_SCANNER_TOKEN:'synthetic-only',RENDER_SCANNER_PORT:'0',RENDER_ALLOWED_HOSTS:'dev.libretexts.org',RENDER_PUBLIC_CA_FILE:ca??'',LT239_HTTPS_PORT:String(port),NODE_OPTIONS:`--loader ${fileURLToPath(new URL('./public-ca-https-loader.mjs',import.meta.url))}`},stdio:['ignore','ignore','pipe','ipc']});
 const diagnostics=collectDiagnostics(child.stderr),exited=new Promise(r=>child.once('exit',r));
 const scannerPort=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(diagnostics.text())),10000);child.once('message',m=>{clearTimeout(timer);resolve(m.port);});child.once('exit',()=>{clearTimeout(timer);reject(Error(diagnostics.text()));});});
 const base=`http://127.0.0.1:${scannerPort}`;
 return{child,request:()=>fetch(base+'/scan',{method:'POST',headers:{Authorization:'Bearer synthetic-only'},body:JSON.stringify({url:'https://dev.libretexts.org/Sandboxes/johnnyphung/tls-test'})}),health:()=>fetch(base+'/healthz').then(r=>r.json()),close:async()=>{child.kill('SIGTERM');await exited;if(child.connected)child.disconnect();}};
}
test('operator public CA reaches actual HTTPS through HTTP and the owned sandboxed worker',{skip:!enabled,timeout:30000},async()=>{
 const certs=await certificates(),root=await mkdtemp('/tmp/lt239-jobs-');let reads=0;
 const https=createServer(certs,(req,res)=>{reads++;res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><head><title>TLS fixture</title></head><body><section class="mt-content-container">Synthetic controlled HTTPS reader with enough content.</section></body></html>');});
 await new Promise(r=>https.listen(0,'127.0.0.1',r));
 const server=await scanner(root,https.address().port,certs.ca);
 try{const response=await server.request();assert.equal(response.status,200);const result=await response.json();assert.equal(result.state,'complete',JSON.stringify(result));assert.ok(reads>0);await until(async()=>!(await server.health()).busy);assert.deepEqual(await readdir(root),[]);}finally{await server.close();await new Promise(r=>https.close(r));}
});
