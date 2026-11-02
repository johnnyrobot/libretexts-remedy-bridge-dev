import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
test('raw inventory refuses ambiguous disappearance without kernel ownership proof',{skip:process.platform!=='linux',timeout:15000},async t=>{
 const root=await mkdtemp('/tmp/lt225-churn-'),driver=join(root,'driver.mjs');
 await writeFile(driver,`import {spawn} from 'node:child_process';import {readFile,writeFile} from 'node:fs/promises';import {terminateOwnedTree} from ${JSON.stringify(new URL('./process-owner.mjs',import.meta.url).href)};
 const children=[];
 const cleanup=()=>Promise.all(children.map(p=>new Promise(r=>{if(p.exitCode!==null||p.signalCode!==null)return r();p.once('close',r);p.kill('SIGKILL');})));
 process.once('SIGTERM',()=>{void cleanup().finally(()=>process.exit(1));});
 const create=()=>{const p=spawn(process.execPath,['-e',"console.log('ready');setInterval(()=>{},1000)"],{detached:true,stdio:['ignore','pipe','ignore']});children.push(p);return p;};
 try{
 const owned=create(),unrelated=create();
 const ready=p=>new Promise((r,j)=>{const timer=setTimeout(()=>j(Error('fixture startup timeout')),4000);p.stdout.once('data',()=>{clearTimeout(timer);r();});p.once('error',e=>{clearTimeout(timer);j(e);});p.once('exit',()=>{clearTimeout(timer);j(Error('fixture exited before ready'));});});await Promise.all([ready(owned),ready(unrelated)]);
 const identity=async pid=>{const value=await readFile('/proc/'+pid+'/stat','utf8'),f=value.slice(value.lastIndexOf(')')+2).split(' ');return{pid,ppid:+f[1],group:+f[2],start:f[19]};};
 const before={owned:await identity(owned.pid),unrelated:await identity(unrelated.pid)};
 await writeFile(process.env.LT225_CHURN_STATE,JSON.stringify({...before.unrelated,observed:false}));let error;
 try{await terminateOwnedTree(owned.pid);}catch(e){error={code:e.code??'unclassified',details:e.details??{}};}
 const {observed}=JSON.parse(await readFile(process.env.LT225_CHURN_STATE,'utf8'));
 console.log(JSON.stringify({before,churnObserved:observed,error:error??null}));

 if(before.owned.ppid!==process.pid||before.unrelated.ppid!==process.pid||observed!==true||error?.code!=='ownership_uncertain')process.exitCode=1;
 }finally{await cleanup();}`);
 const child=spawn(process.execPath,['--loader',fileURLToPath(new URL('./inventory-churn-loader.mjs',import.meta.url)),driver],{env:{...process.env,LT225_CHURN_STATE:join(root,'churn.json')},stdio:['ignore','pipe','pipe']});
 const exited=new Promise(r=>child.once('close',r));
 const stop=()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),500);timer.unref();}};
 t.signal.addEventListener('abort',stop,{once:true});
 let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
 try{const code=await exited;console.log(output);assert.equal(code,0,output);}finally{stop();await exited;t.signal.removeEventListener('abort',stop);}
});
