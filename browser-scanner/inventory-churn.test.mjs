import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
test('unrelated exiting sibling cannot quarantine a positively owned frozen tree',{skip:process.platform!=='linux',timeout:15000},async()=>{
 const root=await mkdtemp('/tmp/lt225-churn-'),driver=join(root,'driver.mjs');
 await writeFile(driver,`import {spawn} from 'node:child_process';import {readFile} from 'node:fs/promises';import {terminateOwnedTree} from ${JSON.stringify(new URL('./process-owner.mjs',import.meta.url).href)};
 const create=()=>spawn(process.execPath,['-e',"console.log('ready');setInterval(()=>{},1000)"],{detached:true,stdio:['ignore','pipe','ignore']});
 const owned=create(),unrelated=create();
 const ready=p=>new Promise(r=>p.stdout.once('data',r));await Promise.all([ready(owned),ready(unrelated)]);
 const identity=async pid=>{const value=await readFile('/proc/'+pid+'/stat','utf8'),f=value.slice(value.lastIndexOf(')')+2).split(' ');return{pid,ppid:+f[1],group:+f[2],start:f[19]};};
 const before={owned:await identity(owned.pid),unrelated:await identity(unrelated.pid)};
 process.env.LT225_UNRELATED_PID=String(unrelated.pid);let error;
 try{await terminateOwnedTree(owned.pid);}catch(e){error={code:e.code??'unclassified',details:e.details??{}};}
 console.log(JSON.stringify({before,churnObserved:process.env.LT225_CHURN_OBSERVED==='1',error:error??null}));
 owned.kill('SIGKILL');unrelated.kill('SIGKILL');
 if(before.owned.ppid!==process.pid||before.unrelated.ppid!==process.pid||process.env.LT225_CHURN_OBSERVED!=='1'||error)process.exitCode=1;`);
 const child=spawn(process.execPath,['--loader',fileURLToPath(new URL('./inventory-churn-loader.mjs',import.meta.url)),driver],{stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
 const code=await new Promise(r=>child.once('close',r));console.log(output);assert.equal(code,0,output);
});
