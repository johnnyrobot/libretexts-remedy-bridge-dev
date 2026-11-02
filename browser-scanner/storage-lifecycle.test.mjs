import test from 'node:test';
import assert from 'node:assert/strict';
import {fork,execFileSync} from 'node:child_process';
import {mkdtemp,readdir,lstat,chmod,writeFile,readFile,open} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,attempts=200){for(let i=0;i<attempts;i++){if(await check())return;await sleep(50);}throw Error('Lifecycle did not reach expected state');}
const rows=()=>execFileSync('ps',['-eo','pid=,ppid=,pgid=,stat=,args='],{encoding:'utf8',maxBuffer:8*1024*1024}).trim().split('\n').map(line=>line.trim().split(/\s+/));
async function usage(path){let bytes=0,allocated=0,entries=0;for(const name of await readdir(path)){const p=join(path,name),s=await lstat(p);entries++;bytes+=s.size;allocated+=s.blocks*512;if(s.isDirectory()){const c=await usage(p);bytes+=c.bytes;allocated+=c.allocated;entries+=c.entries;}}return{bytes,allocated,entries};}
async function start(root,fixtureEnv={}){
 const child=fork(fileURLToPath(new URL('./server.mjs',import.meta.url)),[],{execArgv:[],env:{...process.env,...fixtureEnv,TMPDIR:root,TMP:root,TEMP:root,RENDER_TEST_CPU_HANG:'1',RENDER_SCANNER_TOKEN:'synthetic-only',RENDER_SCANNER_PORT:'0',RENDER_ALLOWED_HOSTS:'dev.libretexts.org',NODE_OPTIONS:`--loader ${fileURLToPath(new URL('./ownership-loader.mjs',import.meta.url))}`},stdio:['ignore','ignore','pipe','ipc']});
 let diagnostics='';child.stderr.on('data',c=>diagnostics+=c);
 const exited=new Promise(resolve=>child.once('exit',resolve));
 const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Scanner startup: '+diagnostics)),10000);child.once('message',m=>{clearTimeout(timer);resolve(m.port);});child.once('exit',()=>{clearTimeout(timer);reject(Error(diagnostics));});});
 const base=`http://127.0.0.1:${port}`;
 return{child,exited,health:()=>fetch(base+'/healthz').then(r=>r.json()),request:signal=>fetch(base+'/scan',{method:'POST',headers:{Authorization:'Bearer synthetic-only'},body:JSON.stringify({url:'https://dev.libretexts.org/Sandboxes/johnnyphung/owned-test'}),signal}).catch(()=>null),close:async()=>{child.kill('SIGTERM');await exited;if(child.connected)child.disconnect();}};
}
function descendants(all,pid){const owned=new Set([String(pid)]);for(let changed=true;changed;){changed=false;for(const row of all)if(owned.has(row[1])&&!owned.has(row[0])){owned.add(row[0]);changed=true;}}return owned;}
async function active(server){
 let owned,workerPid;
 await until(()=>{const all=rows();owned=descendants(all,server.child.pid);workerPid=all.find(r=>+r[1]===server.child.pid&&r.slice(4).join(' ').includes('scan-worker.mjs'))?.[0];return all.some(r=>owned.has(r[0])&&/--type=renderer/.test(r.slice(4).join(' '))&&!r[3].startsWith('Z'));});
 return{owned,workerPid};
}
async function reaped(server,owned){await until(()=>!rows().some(r=>r[0]!==String(server.child.pid)&&owned.has(r[0])&&(process.platform==='linux'||!r[3].startsWith('Z'))));}
const enabled=process.env.RUN_BROWSER_TESTS==='1';
test('completed real scan cleans its owned storage before admission reopens',{skip:!enabled,timeout:20000},async()=>{
 const root=await mkdtemp('/tmp/lt162-'),server=await start(root,{RENDER_TEST_COMPLETE:'1'});
 try{const response=await server.request();assert.equal(response.status,200);assert.equal((await response.json()).scope,'full-reader-page');await until(async()=>!(await server.health()).busy);assert.deepEqual(await usage(root),{bytes:0,allocated:0,entries:0});}finally{await server.close();}
});
test('repeated real sandboxed Chromium cancellation, deadline, SIGKILL and shutdown retain zero job storage',{skip:!enabled,timeout:230000},async()=>{
 const root=await mkdtemp('/tmp/lt162-');let server=await start(root);
 try{
  const modes=['disconnect','disconnect','worker_exit','disconnect','worker_exit',...(process.platform==='linux'?['deadline']:[]),'shutdown','shutdown'];
  for(const [iteration,mode] of modes.entries()){
   if(mode==='deadline'){await server.close();server=await start(root,{RENDER_TEST_BEFORE_CONTEXT:'1'});}
   const requestedAt=performance.now(),controller=new AbortController(),request=server.request(controller.signal),{owned,workerPid}=await active(server);
   const startTime=performance.now();assert.equal((await server.health()).busy,true);assert.ok(performance.now()-startTime<1000);
   const rejected=await server.request();assert.equal(rejected.status,503);assert.equal((await rejected.json()).error,'capacity_unavailable');
   const measured=await usage(root);assert.ok(measured.bytes>0);assert.ok(measured.bytes<128*1024*1024);assert.ok(measured.entries<8192);
   console.log(JSON.stringify({phase:'active',iteration,mode,...measured,directories:await readdir(root)}));
   if(mode==='shutdown')server.child.kill('SIGTERM');else if(mode==='worker_exit')process.kill(+workerPid,'SIGKILL');else if(mode==='disconnect')controller.abort();
   const response=await request;
   if(mode==='deadline')assert.ok(performance.now()-requestedAt>=119000,'must exercise the real 120 second deadline');
   if(mode==='worker_exit'||mode==='deadline'){assert.equal(response.status,503);assert.equal((await response.json()).error,'scan_failed');}
   await reaped(server,owned);
   if(mode==='shutdown'){await server.exited;if(server.child.connected)server.child.disconnect();}else await until(async()=>!(await server.health()).busy);
   const retained=await usage(root);console.log(JSON.stringify({phase:'reaped',iteration,mode,...retained,directories:await readdir(root)}));
   assert.deepEqual(retained,{bytes:0,allocated:0,entries:0});
   if(mode==='shutdown')server=await start(root);
  }
 }finally{await server.close();}
});
test('startup cancellation before browser ownership acknowledgement stays closed with retained storage',{skip:!enabled,timeout:20000},async()=>{
 const root=await mkdtemp('/tmp/lt162-'),server=await start(root,{RENDER_TEST_LATE_OWNERSHIP:'1'});
 try{
  const controller=new AbortController(),request=server.request(controller.signal);let owned;
  await until(()=>{const all=rows();owned=descendants(all,server.child.pid);return all.some(r=>owned.has(r[0])&&/--remote-debugging-pipe/.test(r.slice(4).join(' ')));});
  controller.abort();await request;await reaped(server,owned);await sleep(500);
  assert.equal((await server.health()).busy,true);assert.equal((await server.request()).status,503);assert.ok((await readdir(root)).length>0);
  console.log(JSON.stringify({phase:'uncertain_startup',retained:await usage(root),busy:true}));
 }finally{await server.close();}
});
test('separate concurrent scanners clean only their own job; denied cleanup keeps admission closed',{skip:!enabled,timeout:40000},async()=>{
 const root=await mkdtemp('/tmp/lt162-'),a=await start(root),b=await start(root);
 const sentinel=join(root,'other-user-data');await writeFile(sentinel,'preserve');
 try{
  const ac=new AbortController(),bc=new AbortController(),ar=a.request(ac.signal),br=b.request(bc.signal);
  const aa=await active(a),bb=await active(b);
  assert.equal((await readdir(root)).filter(n=>n.startsWith('remedy-render-job-')).length,2);
  ac.abort();await ar;await reaped(a,aa.owned);await until(async()=>!(await a.health()).busy);
  assert.equal((await b.health()).busy,true);
  assert.equal((await readdir(root)).filter(n=>n.startsWith('remedy-render-job-')).length,1);
  assert.equal(await readFile(sentinel,'utf8'),'preserve');
  // Actual OS permission denial, without replacing rm or process termination.
  await chmod(root,0o500);bc.abort();await br;await reaped(b,bb.owned);
  await sleep(750);assert.equal((await b.health()).busy,true);
  assert.equal((await b.request()).status,503);
  assert.equal((await readdir(root)).filter(n=>n.startsWith('remedy-render-job-')).length,1);
  assert.equal(await readFile(sentinel,'utf8'),'preserve');
  console.log(JSON.stringify({phase:'cleanup_denied',retained:await usage(root),busy:(await b.health()).busy}));
 }finally{await chmod(root,0o700);await a.close();await b.close();}
});
test('a real job crossing the storage threshold is reaped and cannot claim reusable capacity',{skip:!enabled,timeout:30000},async()=>{
 const root=await mkdtemp('/tmp/lt162-'),server=await start(root);
 try{
  const request=server.request(),{owned}=await active(server),[name]=await readdir(root);
  const file=await open(join(root,name,'oversized-synthetic-fixture'),'w');await file.truncate(128*1024*1024+1);await file.close();
  const response=await request;assert.equal(response.status,503);await reaped(server,owned);
  await sleep(750);assert.equal((await server.health()).busy,true);assert.equal((await server.request()).status,503);
  console.log(JSON.stringify({phase:'budget_refused',retained:await usage(root),busy:(await server.health()).busy}));
 }finally{await server.close();}
});
