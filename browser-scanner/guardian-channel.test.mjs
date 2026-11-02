import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('uncertain partial guardian send cannot append a malformed terminal frame or crash its parent',{timeout:10000},async t=>{
 const dir=await mkdtemp('/tmp/lt225-channel-'),sender=join(dir,'sender.py'),driver=join(dir,'driver.mjs'),marker=join(dir,'timeout');
 await writeFile(sender,`import os,socket,sys\nsys.path.insert(0,${JSON.stringify(fileURLToPath(new URL('.',import.meta.url)))})\nfrom guardian_channel import Channel\nc=Channel(socket.socket(fileno=int(os.environ['NODE_CHANNEL_FD'])))\ntry:\n c.send({'ready':True})\n c.send({'large':'x'*(8*1024*1024)})\nexcept BaseException as error:\n open(${JSON.stringify(marker)},'w').write('timeout' if isinstance(error,TimeoutError) else 'other')\n try:c.send({'terminal':False})\n except BaseException:pass\nfinally:c.close()\n`);
 await writeFile(driver,`import{fork}from'node:child_process';import{readFile}from'node:fs/promises';const child=fork('private-channel',[],{execPath:'python3',execArgv:['-B','-u',${JSON.stringify(sender)}],stdio:['ignore','ignore','ignore','ipc'],serialization:'json'});let ready=false,terminal=false;child.on('message',m=>{if(m.ready){ready=true;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1600);}if('terminal'in m)terminal=true;});await new Promise((r,j)=>{child.once('close',r);child.once('error',j);});const timeout=(await readFile(${JSON.stringify(marker)},'utf8'))==='timeout';console.log(JSON.stringify({alive:true,ready,terminal,timeout}));if(!ready||terminal||!timeout)process.exitCode=1;`);
 const child=spawn(process.execPath,[driver],{stdio:['ignore','pipe','pipe']});const exited=new Promise(r=>child.once('close',r));const stop=()=>child.kill('SIGKILL');t.signal.addEventListener('abort',stop,{once:true});let output='';child.stdout.on('data',c=>output=(output+c).slice(-8192));child.stderr.on('data',c=>output=(output+c).slice(-8192));
 try{assert.equal(await exited,0,output);assert.match(output,/"alive":true/);console.log(output);}finally{stop();await exited;t.signal.removeEventListener('abort',stop);}
});
