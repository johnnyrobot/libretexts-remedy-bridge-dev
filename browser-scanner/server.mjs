import {loadPublicCA,stagePublicCA} from './public-ca.mjs';
import {OwnershipFailure} from './process-owner.mjs';
import {startOwnedWorker} from './owned-worker.mjs';
import {createJobStorage,allocationStorageState,STORAGE_LIMITS} from './job-storage.mjs';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
const token = process.env.RENDER_SCANNER_TOKEN;
if (!token) throw Error('RENDER_SCANNER_TOKEN required');
const publicCA=await loadPublicCA(process.env.RENDER_PUBLIC_CA_FILE);
if(publicCA&&process.platform!=='linux')throw Error('Public CA provisioning requires the shipping Linux runtime');
const hold=(phase,error)=>console.error(JSON.stringify({event:'renderer_admission_hold',phase,reason:error instanceof OwnershipFailure?error.code:'unproved',...(error instanceof OwnershipFailure?{details:error.details}:{})}));
let busy = false;
let current;
const server = createServer(async (req,res) => {
  res.setHeader('Content-Type','application/json');
  if (req.url === '/healthz' && req.method === 'GET') return res.end(JSON.stringify({ok:true,busy}));
  const received=Buffer.from(req.headers.authorization||''), expected=Buffer.from(`Bearer ${token}`);
  if(received.length!==expected.length||!timingSafeEqual(received,expected)){res.statusCode=401;return res.end('{}');}
  if(req.url!=='/scan'||req.method!=='POST'){res.statusCode=404;return res.end('{}');}
  if(busy){res.statusCode=503;res.setHeader('Retry-After','5');return res.end('{"error":"capacity_unavailable"}');}
  busy=true;
  const reported=new Set();
  const report=(phase,error)=>{if(!reported.has(phase)){reported.add(phase);hold(phase,error);}};
  let child, browserPid, storage, monitor, inspection, storageFailed=false, cancelled=false, teardown, teardownFailed=false;
  const stop=()=>{cancelled=true;if(child&&!teardown)teardown=child.terminate(browserPid?[browserPid]:[]).catch(error=>{teardownFailed=true;report('termination',error);});};
  current=stop;
  const deadline=performance.now()+120000;
  const timeout=setTimeout(stop,120000);
  res.once('close',stop);
  try {
    const body = await new Promise((resolve,reject)=>{
      const chunks=[];let size=0;
      const bodyTimeout=setTimeout(()=>finish(Error()),5000);
      const finish=(error)=>{clearTimeout(bodyTimeout);req.off('data',data);req.off('end',end);req.off('aborted',abort);req.off('error',finish);error?reject(error):resolve(Buffer.concat(chunks).toString());};
      const data=chunk=>{size+=chunk.length;if(size>4096){req.pause();finish(Error());}else chunks.push(chunk);};
      const end=()=>finish(),abort=()=>finish(Error());
      req.on('data',data);req.once('end',end);req.once('aborted',abort);req.once('error',finish);
    });
    if(cancelled)throw Error();
    const url=JSON.parse(body).url;
    // Allocation itself may have partially created storage before an I/O error.
    teardownFailed=true;
    try{storage=await createJobStorage();}catch(error){const state=allocationStorageState(error);if(state==='no_root'||state==='removed')teardownFailed=false;else report('allocation',error);throw error;}
    teardownFailed=false;
    await stagePublicCA(publicCA,storage.env.RENDER_JOB_HOME);
    if(cancelled)throw Error();
    const result=await new Promise((resolve,reject)=>{
      child=startOwnedWorker({...process.env,...storage.env},deadline-performance.now());
      monitor=setInterval(()=>{if(!inspection)inspection=storage.inspect().catch(()=>{storageFailed=true;report('storage_inspection');stop();}).finally(()=>{inspection=undefined;});},STORAGE_LIMITS.intervalMs);
      let reply;
      child.on('message',message=>{if(Number.isSafeInteger(message?.browser_owned)&&message.browser_owned>1){browserPid=message.browser_owned;if(cancelled){const previous=teardown;teardown=(async()=>{await previous;await child.terminate([browserPid]);})().catch(error=>{teardownFailed=true;report('termination',error);});}else child.send({ownership_ack:browserPid},error=>{if(error)stop();});return;}if(!cancelled)reply=Buffer.byteLength(JSON.stringify(message))<=16*1024*1024?message:undefined;stop();});
      child.on('error',()=>stop());
      child.once('close',async()=>{clearInterval(monitor);if(!reply){if(!browserPid){teardownFailed=true;report('ownership_ack');}stop();}await teardown;await inspection;if(teardownFailed||storageFailed)reject(Error());else reply?.result?resolve({...reply.result,publicCATrust:publicCA?{sha256:publicCA.sha256,fingerprints:publicCA.fingerprints}:null}):reject(Error());});
      child.send({url,publicCASha256:publicCA?.sha256});
      if(cancelled)stop();
    });
    if(!res.destroyed)res.end(JSON.stringify(result));
  } catch {if(!res.destroyed){res.statusCode=503;res.end('{"state":"error","error":"scan_failed"}');}}
  finally {
    clearTimeout(timeout);clearInterval(monitor);res.off('close',stop);
    await teardown;await inspection;
    if(storage&&!teardownFailed){try{await storage.cleanup();}catch{teardownFailed=true;report('storage_cleanup');}}
    current=undefined;busy=teardownFailed;
  }
});
const port=Number(process.env.RENDER_SCANNER_PORT??5180);
if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid scanner port');
server.listen(port,'0.0.0.0',()=>process.send?.({port:server.address().port}));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{current?.();server.close();});
