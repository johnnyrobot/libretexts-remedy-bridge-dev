import {terminateOwnedTree} from './process-owner.mjs';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const token = process.env.RENDER_SCANNER_TOKEN;
if (!token) throw Error('RENDER_SCANNER_TOKEN required');
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
  let child, browserPid, cancelled=false, teardown, teardownFailed=false;
  const stop=()=>{cancelled=true;if(child&&!teardown)teardown=terminateOwnedTree(child.pid,browserPid?[browserPid]:[]).catch(()=>{teardownFailed=true;});};
  current=stop;
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
    const result=await new Promise((resolve,reject)=>{
      child=fork(fileURLToPath(new URL('./scan-worker.mjs',import.meta.url)),[],{detached:true,stdio:['ignore','ignore','ignore','ipc'],execArgv:['--max-old-space-size=384']});
      let reply;
      child.on('message',message=>{if(Number.isSafeInteger(message?.browser_owned)&&message.browser_owned>1){browserPid=message.browser_owned;child.send({ownership_ack:browserPid});return;}reply=Buffer.byteLength(JSON.stringify(message))<=16*1024*1024?message:undefined;stop();});
      child.on('error',()=>stop());
      child.once('close',async()=>{if(!reply){if(!browserPid)teardownFailed=true;stop();}await teardown;if(teardownFailed)reject(Error());else reply?.result?resolve(reply.result):reject(Error());});
      child.send({url});
      if(cancelled)stop();
    });
    if(!res.destroyed)res.end(JSON.stringify(result));
  } catch {if(!res.destroyed){res.statusCode=503;res.end('{"state":"error","error":"scan_failed"}');}}
  finally {clearTimeout(timeout);res.off('close',stop);current=undefined;busy=teardownFailed;}
});
const port=Number(process.env.RENDER_SCANNER_PORT??5180);
if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid scanner port');
server.listen(port,'0.0.0.0',()=>process.send?.({port:server.address().port}));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{current?.();server.close();});
