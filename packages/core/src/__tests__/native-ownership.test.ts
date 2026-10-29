import {expect,it} from 'vitest';
import {createServer} from 'node:http';
import {ownedRead} from '../../../conductor-panel/server/work-owner.js';
it('reaps actual native decoder work on cancellation before slot release or late effects',async()=>{
 let pid=0,late=0,entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
 const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));if(req.url==='/late')late++;else{pid=JSON.parse(Buffer.concat(chunks).toString()).pid;entered();}res.end('{}');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const controller=new AbortController();
 const work=ownedRead({url:`http://127.0.0.1:${(server.address() as any).port}`},controller.signal,new URL('./support/native-work.ts',import.meta.url)).then(value=>({value,error:undefined}),error=>({error}));
 const timer=setTimeout(()=>controller.abort(),10000);
 try{await Promise.race([started,work.then(()=>{throw Error('Decoder exited before observation');})]);controller.abort();expect((await work).error).toBeDefined();expect(()=>process.kill(pid,0)).toThrow();expect(late).toBe(0);}finally{clearTimeout(timer);controller.abort();await work;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},20000);
