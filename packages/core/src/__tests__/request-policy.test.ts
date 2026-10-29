import {expect,it} from 'vitest';
import {createServer} from 'node:http';
import Expert from '@libretexts/cxone-expert-node';
import {LLMClient} from '../ai/llm-client.js';
import {requestBudget,boundedFetch} from '../../../../tools/request-policy.cjs';
async function external(handler:Parameters<typeof createServer>[0]){const server=createServer(handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return{url:`http://127.0.0.1:${(server.address() as any).port}`,async close(){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}};}
it('rejects an oversized chunked SDK response before parsing or source scanning',async()=>{
 const f=await external((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({body:'a'.repeat(8*1024*1024)}));});
 try{const client=new Expert({tld:f.url,auth:{type:'server',params:{key:'fake',secret:'fake',user:'fake'}}});await expect(client.pages.getPageContents(1)).rejects.toThrow();}finally{await f.close();}
});
it('total budget cancels actual provider response/backoff, prevents retries and late usage',async()=>{
 let calls=0;const f=await external((_req,res)=>{calls++;res.writeHead(429,{'retry-after':'10'});res.end('{}');});
 try{const client=new LLMClient({provider:'custom',baseUrl:f.url,apiKey:'fake',textModel:'synthetic',maxRetries:4});const start=performance.now();await expect(requestBudget.run({signal:AbortSignal.timeout(80),mutation:false},()=>client.chat({messages:[{role:'user',content:'synthetic'}]}))).rejects.toBeDefined();expect(performance.now()-start).toBeLessThan(1000);expect(calls).toBe(1);expect(client.usage).toHaveLength(0);}finally{await f.close();}
});
it('after dispatch, client cancellation cannot abandon the single bounded mutation',async()=>{
 let calls=0;const f=await external((req,res)=>{req.resume();calls++;setTimeout(()=>res.end('{}'),80);});
 try{const controller=new AbortController();const result=requestBudget.run({signal:controller.signal,mutation:true,dispatched:true},()=>boundedFetch(f.url,{method:'POST',body:'synthetic'}));controller.abort();expect((await result).status).toBe(200);expect(calls).toBe(1);}finally{await f.close();}
});
