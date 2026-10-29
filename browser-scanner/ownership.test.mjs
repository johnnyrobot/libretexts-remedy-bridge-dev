import test from 'node:test';
import assert from 'node:assert/strict';
import {fork,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<150;i++){if(await check())return;await sleep(50);}throw Error('Owned process did not reach expected state');}
const processRows=()=>execFileSync('ps',['-eo','pid=,ppid=,pgid=,stat=,args='],{encoding:'utf8'}).split('\n').map(line=>line.trim().split(/\s+/));
test('disconnect and shutdown reap actual sandboxed Chromium groups while health stays responsive',{skip:process.env.RUN_BROWSER_TESTS!=='1',timeout:25000},async()=>{
 const child=fork(fileURLToPath(new URL('./server.mjs',import.meta.url)),[],{env:{...process.env,RENDER_SCANNER_TOKEN:'synthetic-only',RENDER_SCANNER_PORT:'0',RENDER_ALLOWED_HOSTS:'dev.libretexts.org',NODE_OPTIONS:`--loader ${fileURLToPath(new URL('./ownership-loader.mjs',import.meta.url))}`},stdio:['ignore','ignore','pipe','ipc']});
 let diagnostics='';child.stderr.on('data',c=>diagnostics+=c);
 try{
  const port=await new Promise((resolve,reject)=>{child.once('message',m=>resolve(m.port));child.once('exit',()=>reject(Error(diagnostics)));});
  const base=`http://127.0.0.1:${port}`;
  const health=async()=>fetch(base+'/healthz').then(r=>r.json());
  for(const shutdown of [false,true]){
   const controller=new AbortController();const request=fetch(base+'/scan',{method:'POST',headers:{Authorization:'Bearer synthetic-only'},body:JSON.stringify({url:'https://dev.libretexts.org/Sandboxes/johnnyphung/owned-test'}),signal:controller.signal}).catch(()=>null);
   let owned;
   await until(()=>{const rows=processRows(),worker=rows.find(r=>Number(r[1])===child.pid&&r.slice(4).join(' ').includes('scan-worker.mjs'));if(!worker)return false;owned=new Set([worker[0]]);for(let changed=true;changed;){changed=false;for(const row of rows)if(owned.has(row[1])&&!owned.has(row[0])){owned.add(row[0]);changed=true;}}return rows.some(r=>owned.has(r[0])&&/chrome|chromium/.test(r.slice(4).join(' '))&&!r[3].startsWith('Z'));});
   const start=performance.now();assert.equal((await health()).busy,true);assert.ok(performance.now()-start<1000);
   if(shutdown)child.kill('SIGTERM');else controller.abort();
   await request;
   await until(()=>!processRows().some(r=>owned.has(r[0])&&!r[3].startsWith('Z')));
   if(!shutdown)await until(async()=>!(await health()).busy);
  }
 }finally{child.kill('SIGKILL');}
});
