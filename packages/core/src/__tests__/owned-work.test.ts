import {afterEach,expect,it} from 'vitest';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer,type Server,request} from 'node:http';
const children:ChildProcess[]=[],servers:Server[]=[];
afterEach(async()=>{for(const p of children){p.kill('SIGKILL');}children.length=0;await Promise.all(servers.splice(0).map(s=>{s.closeAllConnections();return new Promise<void>(r=>s.close(()=>r()));}));});
async function setup(timeout=2500,html='<p><strong>Title</strong></p>',slow=false){
 let reads=0,closed=0;
 const external=createServer((req,res)=>{reads++;res.once('close',()=>closed++);if(slow)return;res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url?.includes('/contents')?{body:html}:{'@id':1,path:'Sandboxes/johnnyphung/Page'}));});servers.push(external);await new Promise<void>(r=>external.listen(0,'127.0.0.1',r));
 const child=spawn(process.execPath,['--import','tsx',new URL('./support/owned-bridge.ts',import.meta.url).pathname],{env:{PATH:process.env.PATH!,NODE_ENV:'test',NODE_OPTIONS:`--loader ${new URL('./support/no-dotenv-loader.mjs',import.meta.url).pathname} --import ${new URL('./support/owned-network.mjs',import.meta.url).pathname}`,REMEDY_REVIEWER_REQUIRED:'false',CXONE_INTEGRATION_ENABLED:'true',SERVER_DOMAIN:'dev.libretexts.org',SERVER_KEY:'fake',SERVER_SECRET:'fake',SERVER_USER:'fake',REMEDY_WORK_TIMEOUT_MS:String(timeout),TEST_EXTERNAL_URL:`http://127.0.0.1:${(external.address() as any).port}`},stdio:['ignore','pipe','pipe','ipc']});children.push(child);
 let diagnostic='';child.stderr!.on('data',c=>diagnostic+=c);
 const port=await new Promise<number>((resolve,reject)=>{const t=setTimeout(()=>reject(Error(diagnostic)),8000);child.once('message',(m:any)=>{clearTimeout(t);resolve(m.port);});child.once('exit',()=>{clearTimeout(t);reject(Error(diagnostic));});});
 const base=`http://127.0.0.1:${port}`;
 const post=(path='/v1/cxone/page/preview-fix',signal?:AbortSignal)=>fetch(base+path,{method:'POST',body:JSON.stringify({page_id:1}),signal});
 return {base,post,child,reads:()=>reads,closed:()=>closed};
}
async function until(predicate:()=>boolean){for(let i=0;i<300&&!predicate();i++)await new Promise(r=>setTimeout(r,20));expect(predicate()).toBe(true);}
it('runs actual SDK/scan/preview in owned children and imports a usable exact token',async()=>{
 const f=await setup(10000);const response=await f.post();expect(response.status).toBe(200);const value=await response.json();expect(value.preview_token).toBeTypeOf('string');expect(value.after_html).not.toBe(value.before_html);expect(f.reads()).toBeGreaterThan(0);
},30000);
it('bounds2 active+8 queued, rejects mutations immediately and keeps health responsive, then reaps timed out sockets',async()=>{
 const f=await setup(6000,undefined,true);
 const jobs=Array.from({length:10},()=>f.post());await until(()=>f.reads()===2);
 const over=await f.post();expect(over.status).toBe(503);expect(over.headers.get('retry-after')).toBe('5');
 expect((await f.post('/v1/cxone/page/apply-fix')).status).toBe(503);
 const begin=performance.now();expect((await fetch(f.base+'/healthz')).status).toBe(200);expect(performance.now()-begin).toBeLessThan(500);
 const results=await Promise.all(jobs);expect(results.every(r=>r.status===503)).toBe(true);await until(()=>f.closed()===2);
 expect((await fetch(f.base+'/healthz')).status).toBe(200);
},30000);
it('disconnect kills actual SDK work, prevents late preview admission and reuses the slot',async()=>{
 const f=await setup(10000,undefined,true);const c=new AbortController();const job=f.post(undefined,c.signal).catch(()=>null);await until(()=>f.reads()===1);c.abort();await job;await until(()=>f.closed()===1);
 const c2=new AbortController();const next=f.post(undefined,c2.signal).catch(()=>null);await until(()=>f.reads()===2);c2.abort();await next;await until(()=>f.closed()===2);
},30000);
it('kills CPU-heavy real scans without blocking parent health',async()=>{
 const f=await setup(5000,'<p>text</p>'.repeat(150000));const job=f.post();await until(()=>f.reads()>=2);const start=performance.now();expect((await fetch(f.base+'/healthz')).status).toBe(200);expect(performance.now()-start).toBeLessThan(500);const r=await job;expect(r.status).toBe(503);expect((await r.json()).preview_token).toBeUndefined();
},30000);
it('ends a slow request body within the total budget and releases capacity',async()=>{
 const f=await setup(500);const result=await new Promise<number>((resolve,reject)=>{const req=request(f.base+'/api/local/run',{method:'POST',headers:{'content-type':'application/json','content-length':'1000'}},res=>{res.resume();resolve(res.statusCode!);});req.on('error',reject);req.write('{');});expect(result).toBe(503);expect((await fetch(f.base+'/healthz')).status).toBe(200);
},30000);
it('shutdown aborts actual pending reads and reaps their connections before process exit',async()=>{
 const f=await setup(10000,undefined,true);const pending=f.post().catch(()=>null);await until(()=>f.reads()===1);
 const exited=new Promise<void>(resolve=>f.child.once('exit',()=>resolve()));f.child.send('stop');await exited;await pending;await until(()=>f.closed()===1);
},30000);
