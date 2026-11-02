import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {startOwnedWorker} from './owned-worker.mjs';
const enabled=process.platform==='linux';
test('kernel guardian reaps a worker and its escaped adopted child before terminal proof',{skip:!enabled,timeout:15000},async()=>{
 const dir=await mkdtemp('/tmp/lt225-guardian-'),worker=join(dir,'worker.mjs');
 await writeFile(worker,`import{spawn}from'node:child_process';process.once('message',()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});process.send({escaped:child.pid},()=>process.exit(0));});`);
 const child=startOwnedWorker({...process.env},10000,pathToFileURL(worker));let escaped;
 const closed=new Promise(r=>child.once('close',r));
 try{
  const message=new Promise((r,j)=>{const timer=setTimeout(()=>j(Error('fixture startup timeout')),4000);child.once('message',m=>{clearTimeout(timer);r(m);});child.once('error',j);});child.send({url:'synthetic'});escaped=(await message).escaped;
  await closed;await child.terminate();await assert.rejects(readFile('/proc/'+escaped+'/stat'),e=>['ENOENT','ESRCH'].includes(e.code));
  console.log(JSON.stringify({phase:'kernel_adopted_reaped',escaped,verified:true}));
 }finally{await child.terminate().catch(()=>{});await closed;}
});
test('worker-supplied terminal fields cannot forge the guardian channel proof',{skip:!enabled,timeout:15000},async()=>{
 const dir=await mkdtemp('/tmp/lt225-forge-'),worker=join(dir,'worker.mjs');
 await writeFile(worker,`process.once('message',()=>{process.send({kind:'terminal',verified:true,reaped:999});setInterval(()=>{},1000);});`);
 const child=startOwnedWorker({...process.env},10000,pathToFileURL(worker));let closed=false;const finished=new Promise(r=>child.once('close',()=>{closed=true;r();}));
 try{const received=new Promise(r=>child.once('message',r));child.send({url:'synthetic'});assert.equal((await received).verified,true);await new Promise(r=>setTimeout(r,100));assert.equal(closed,false);await child.terminate();await finished;}finally{await child.terminate().catch(()=>{});await finished;}
});
test('negative guardian proof retains its bounded failure reason',{skip:!enabled,timeout:15000},async()=>{
 const dir=await mkdtemp('/tmp/lt225-negative-'),worker=join(dir,'worker.mjs');await writeFile(worker,"process.once('message',()=>setInterval(()=>{},1000));");
 const child=startOwnedWorker({...process.env},10000,pathToFileURL(worker)),closed=new Promise(r=>child.once('close',r));
 try{child.send('invalid-private-frame');await closed;await assert.rejects(child.terminate(),error=>error.code==='guardian_unproved'&&error.details.reasons[0]==='message_failed');}finally{await child.terminate().catch(()=>{});await closed;}
});
