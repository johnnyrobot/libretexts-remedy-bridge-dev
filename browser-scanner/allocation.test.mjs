import test from 'node:test';
import assert from 'node:assert/strict';
import {fork,execFileSync} from 'node:child_process';
import {mkdtemp,readdir,readFile,writeFile,statfs,open,lstat,chmod,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {collectDiagnostics} from './test-diagnostics.mjs';
const enabled=process.env.RUN_BROWSER_TESTS==='1'&&process.platform==='linux';
async function until(check){for(let i=0;i<100;i++){if(await check())return;await sleep(50);}throw Error('Allocation state did not settle');}
const jobs=async root=>(await readdir(root)).filter(n=>n.startsWith('remedy-render-job-'));
const children=pid=>execFileSync('ps',['-eo','pid=,ppid=,args='],{encoding:'utf8'}).split('\n').filter(line=>+line.trim().split(/\s+/)[1]===pid);
async function start(root,mode=''){
 const child=fork(fileURLToPath(new URL('./server.mjs',import.meta.url)),[],{execArgv:[],env:{...process.env,TMPDIR:root,TMP:root,TEMP:root,RENDER_TEST_COMPLETE:'1',RENDER_SCANNER_TOKEN:'synthetic-only',RENDER_SCANNER_PORT:'0',RENDER_ALLOWED_HOSTS:'dev.libretexts.org',LT224_ALLOCATION_FAULT:mode,NODE_OPTIONS:`--loader ${fileURLToPath(new URL('./ownership-loader.mjs',import.meta.url))} --loader ${fileURLToPath(new URL('./allocation-loader.mjs',import.meta.url))}`},stdio:['ignore','ignore','pipe','ipc']});
 const diagnostic=collectDiagnostics(child.stderr),exited=new Promise(r=>child.once('exit',r));
 let port;try{port=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error(diagnostic.text())),10000);child.once('message',m=>{clearTimeout(timeout);resolve(m.port);});child.once('exit',()=>{clearTimeout(timeout);reject(Error(diagnostic.text()));});});}catch(error){child.kill('SIGTERM');await exited;if(child.connected)child.disconnect();throw error;}
 const base=`http://127.0.0.1:${port}`;
 return{child,health:()=>fetch(base+'/healthz').then(r=>r.json()),request:()=>fetch(base+'/scan',{method:'POST',headers:{Authorization:'Bearer synthetic-only'},body:JSON.stringify({url:'https://dev.libretexts.org/Sandboxes/johnnyphung/allocation-test'})}),diagnostic,close:async()=>{child.kill('SIGTERM');await exited;if(child.connected)child.disconnect();}};
}
async function reusable(server,root){await until(async()=>!(await server.health()).busy);assert.deepEqual(await jobs(root),[]);assert.deepEqual(children(server.child.pid),[]);}
async function completed(server,root){const r=await server.request();assert.equal(r.status,200);assert.equal((await r.json()).scope,'full-reader-page');await reusable(server,root);}
test('real finite tmpfs low-space refusal recovers only after fixture space is released',{skip:!enabled,timeout:30000},async t=>{
 const root=await mkdtemp('/tmp/lt224-space-'),sentinel=join(root,'caller-sentinel'),pressure=join(root,'fixture-space-pressure');await writeFile(sentinel,'preserve');
 let server,pressureCreated=false;
 t.after(async()=>{try{await server?.close();}finally{if(pressureCreated)await unlink(pressure);}});
 const initial=await statfs(root);assert.equal(initial.type,0x01021994,'requires Linux tmpfs');assert.ok(initial.blocks*initial.bsize<=512*1024*1024,'requires finite shipping tmpfs');
 const f=await open(pressure,'wx');pressureCreated=true;let blocks=0;
 try{for(;blocks<80;blocks++){const s=await statfs(root);if(s.bavail*s.bsize<256*1024*1024)break;await f.writeFile(Buffer.alloc(4*1024*1024,1));}}finally{await f.close();}
 const filled=await lstat(pressure);assert.ok(filled.blocks*512>0);const free=await statfs(root);assert.ok(free.bavail*free.bsize<256*1024*1024);
 server=await start(root);
 for(let i=0;i<2;i++){const r=await server.request();assert.equal(r.status,503);assert.deepEqual(await r.json(),{state:'error',error:'scan_failed'});console.log(JSON.stringify({phase:'low_space_refused',busy:(await server.health()).busy,jobRoots:(await jobs(root)).length,children:children(server.child.pid).length}));await reusable(server,root);}
 console.log(JSON.stringify({phase:'known_low_space',allocated:filled.blocks*512,free:free.bavail*free.bsize,busy:false,children:0,jobRoots:0}));
 await unlink(pressure);pressureCreated=false;await completed(server,root);assert.equal(await readFile(sentinel,'utf8'),'preserve');console.log(JSON.stringify({phase:'low_space_recovered',busy:false,jobRoots:0}));
});
test('real mkdir denial followed by verified exact-root cleanup permits a real scan retry',{skip:!enabled,timeout:25000},async()=>{
 const root=await mkdtemp('/tmp/lt224-mkdir-'),server=await start(root,'mkdir_removed');
 try{const r=await server.request();assert.equal(r.status,503);assert.deepEqual(await r.json(),{state:'error',error:'scan_failed'});await reusable(server,root);console.log(JSON.stringify({phase:'mkdir_removed',busy:false,jobRoots:0}));await completed(server,root);}finally{await server.close();}
});
for(const mode of ['mkdtemp_failed','identity_unreadable','partial','cleanup_denied','identity_changed'])test('unproved '+mode+' allocation retains storage and admission',{skip:!enabled,timeout:15000},async()=>{
 const root=await mkdtemp('/tmp/lt224-refused-'),server=await start(root,mode);
 try{const r=await server.request();assert.equal(r.status,503);assert.deepEqual(await r.json(),{state:'error',error:'scan_failed'});await sleep(200);assert.equal((await server.health()).busy,true);const names=await jobs(root);if(mode==='mkdtemp_failed')assert.deepEqual(names,[]);else assert.ok(names.length>0);assert.deepEqual(children(server.child.pid),[]);const retry=await server.request();assert.equal(retry.status,503);assert.deepEqual(await retry.json(),{error:'capacity_unavailable'});
  if(mode==='partial')assert.equal(await readFile(join(root,names[0],'partial-allocation'),'utf8'),'preserve');
  if(mode==='identity_changed'){assert.equal(names.length,2);const replacement=names.find(n=>!n.endsWith('-preserved'));assert.equal(await readFile(join(root,replacement,'replacement-sentinel'),'utf8'),'preserve');}
  console.log(JSON.stringify({phase:mode,busy:true,retainedRoots:names.length,children:0}));
 }finally{await server.close();if(mode==='cleanup_denied')for(const name of await jobs(root))await chmod(join(root,name),0o700);}
});
