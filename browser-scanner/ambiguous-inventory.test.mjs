import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('vanished unidentified row can hide a genuine escaped owned descendant',{skip:process.platform!=='linux',timeout:15000},async t=>{
 const dir=await mkdtemp('/tmp/lt225-ambiguous-'),marker=join(dir,'fork'),settled=join(dir,'settled'),orphanFile=join(dir,'orphan');
 const b=`const fs=require('node:fs'),{spawn}=require('node:child_process');console.log('ready');const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(marker)}))return;clearInterval(timer);const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});const stat=fs.readFileSync('/proc/'+child.pid+'/stat','utf8'),f=stat.slice(stat.lastIndexOf(')')+2).split(' ');fs.writeFileSync(${JSON.stringify(orphanFile)},JSON.stringify({pid:child.pid,start:f[19]}));process.exit(0);},5);`;
 const a=`const{spawn}=require('node:child_process'),fs=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(b)}],{stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>console.log('ready'));child.once('close',()=>fs.writeFileSync(${JSON.stringify(settled)},'reaped'));setInterval(()=>{},1000);`;
 const rootCode=`const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(a)}],{stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>console.log('ready'));setInterval(()=>{},1000);`;
 const driver=join(dir,'driver.mjs');
 await writeFile(driver,`import{spawn}from'node:child_process';import{readFile}from'node:fs/promises';import{terminateOwnedTree}from${JSON.stringify(new URL('./process-owner.mjs',import.meta.url).href)};
 const root=spawn(process.execPath,['-e',${JSON.stringify(rootCode)}],{detached:true,stdio:['ignore','pipe','ignore']});
 const cleanup=async()=>{try{process.kill(-root.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}try{const orphan=JSON.parse(await readFile(${JSON.stringify(orphanFile)},'utf8')),s=await readFile('/proc/'+orphan.pid+'/stat','utf8'),f=s.slice(s.lastIndexOf(')')+2).split(' ');if(f[19]===orphan.start)process.kill(orphan.pid,'SIGKILL');}catch(e){if(!['ENOENT','ESRCH'].includes(e.code))throw e;}};
 process.once('SIGTERM',()=>{void cleanup().finally(()=>process.exit(1));});
 try{await new Promise((r,j)=>{const timer=setTimeout(()=>j(Error('Fixture startup timed out')),4000);root.stdout.once('data',()=>{clearTimeout(timer);r();});root.once('error',j);});let error;try{await terminateOwnedTree(root.pid);}catch(e){error={code:e.code,details:e.details};}const orphan=JSON.parse(await readFile(${JSON.stringify(orphanFile)},'utf8')),s=await readFile('/proc/'+orphan.pid+'/stat','utf8'),f=s.slice(s.lastIndexOf(')')+2).split(' ');const alive=f[0]!=='Z'&&f[19]===orphan.start;console.log(JSON.stringify({phase:'genuine_unknown',orphan,alive,error:error??null}));if(!alive||error?.code!=='ownership_uncertain')process.exitCode=1;}finally{await cleanup();}`);
 const child=spawn(process.execPath,['--loader',fileURLToPath(new URL('./ambiguous-inventory-loader.mjs',import.meta.url)),driver],{env:{...process.env,LT225_AMBIG_MARKER:marker,LT225_AMBIG_SETTLED:settled},stdio:['ignore','pipe','pipe']});
 const exited=new Promise(r=>child.once('close',r));const stop=()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),500).unref();}};t.signal.addEventListener('abort',stop,{once:true});
 let output='';child.stdout.on('data',c=>output=(output+c).slice(-8192));child.stderr.on('data',c=>output=(output+c).slice(-8192));
 try{assert.equal(await exited,0,output);console.log(output);}finally{stop();await exited;t.signal.removeEventListener('abort',stop);}
});
