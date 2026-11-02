import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

for(const exits of [false,true])test(`late detached descendant during termination ${exits?'with fork-and-exit retains uncertainty':'is verified dead'}`,{skip:process.platform!=='linux',timeout:15000},async()=>{
 const directory=await mkdtemp('/tmp/lt162-late-'),marker=join(directory,'spawn'),pidFile=join(directory,'late-pid');
 const descendant=`const fs=require('node:fs'),{spawn}=require('node:child_process');
 console.log('ready');const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(marker)}))return;clearInterval(timer);
 const late=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
 fs.writeFileSync(${JSON.stringify(pidFile)},String(late.pid));${exits?'process.exit(0)':'setInterval(()=>{},1000)'};},5);`;
 const root=`const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>console.log('ready'));setInterval(()=>{},1000);`;
 const driver=join(directory,'driver.mjs');
 await writeFile(driver,`import {spawn} from 'node:child_process';import {readFile} from 'node:fs/promises';import {terminateOwnedTree} from ${JSON.stringify(new URL('./process-owner.mjs',import.meta.url).href)};
 const root=spawn(process.execPath,['-e',${JSON.stringify(root)}],{detached:true,stdio:['ignore','pipe','ignore']});
 await new Promise(resolve=>root.stdout.once('data',resolve));let refused=false;try{await terminateOwnedTree(root.pid);}catch{refused=true;}
 const pid=Number(await readFile(${JSON.stringify(pidFile)},'utf8'));
 let alive=false;try{alive=!(await readFile('/proc/'+pid+'/stat','utf8')).includes(') Z ');}catch(error){if(error.code!=='ENOENT')throw error;}
 console.log(JSON.stringify({latePid:pid,alive,refused}));if(alive)process.kill(pid,'SIGKILL');if(${exits?'!refused':'alive||refused'})process.exitCode=1;`);
 const child=spawn(process.execPath,['--loader',fileURLToPath(new URL('./late-child-loader.mjs',import.meta.url)),driver],{env:{...process.env,LT162_LATE_MARKER:marker},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
 const code=await new Promise(resolve=>child.once('exit',resolve));
 console.log(output);assert.equal(code,0,output);assert.match(output,exits?/"refused":true/:/"alive":false/);
});
