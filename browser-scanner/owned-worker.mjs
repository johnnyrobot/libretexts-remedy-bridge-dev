import {fork} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {terminateOwnedTree,OwnershipFailure} from './process-owner.mjs';

/** Private guardian channel is never inherited by the worker or browser. */
export function startOwnedWorker(env,remainingMs=120000,workerURL=new URL('./scan-worker.mjs',import.meta.url)){
 const worker=fileURLToPath(workerURL);
 if(process.platform!=='linux'){
  const child=fork(worker,[],{env,detached:true,stdio:['ignore','ignore','ignore','ipc'],execArgv:['--max-old-space-size=384']});
  child.terminate=roots=>terminateOwnedTree(child.pid,roots);return child;
 }
 const processOwner=fork('guardian-private-channel',[],{execPath:'python3',execArgv:['-u',fileURLToPath(new URL('./process-guardian.py',import.meta.url)),process.execPath,worker,String(Math.max(0,Math.min(120000,remainingMs)))],env,detached:true,stdio:['ignore','ignore','ignore','ipc'],serialization:'json'});
 const child=new EventEmitter();child.pid=processOwner.pid;
 let proof,stop=false,resolve,reject;
 const terminal=new Promise((yes,no)=>{resolve=yes;reject=no;});terminal.catch(()=>{});
 child.send=(value,callback)=>processOwner.send({op:'forward',value},callback);
 child.terminate=()=>{if(!stop){stop=true;if(processOwner.connected)processOwner.send({op:'cancel'},()=>{});}return terminal;};
 processOwner.on('message',message=>{
  if(message?.kind==='worker')child.emit('message',message.value);
  else if(message?.kind==='terminal')proof=message;
 });
 processOwner.on('error',error=>child.emit('error',error));
 processOwner.once('close',(code,signal)=>{
  if(code===0&&!signal&&proof?.verified===true&&Number.isSafeInteger(proof.reaped)&&proof.reaped>=1)resolve();
  else reject(new OwnershipFailure('guardian_unproved',{reasons:['guardian_missing_terminal_proof']}));
  child.emit('close',code,signal);
 });
 return child;
}
