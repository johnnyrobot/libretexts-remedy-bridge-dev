import { fork, type Serializable } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CapacityError, finiteLimit } from './preview-cache.js';
export class WorkCancelled extends Error {}
export class WorkOwner {
  private active = 0;
  private queue: Array<()=>void> = [];
  private controllers = new Set<AbortController>();
  private stopped = false;
  private drained:Array<()=>void>=[];
  readonly limit = finiteLimit(process.env.REMEDY_WORK_ACTIVE,2,2);
  readonly queued = finiteLimit(process.env.REMEDY_WORK_QUEUED,8,8,0);
  readonly timeoutMs = finiteLimit(process.env.REMEDY_WORK_TIMEOUT_MS,300000,300000);
  get accepting(): boolean { return !this.stopped && (this.active < this.limit || this.queue.length < this.queued); }
  async run<T>(signal: AbortSignal, mutation: boolean, work: ()=>Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.stopped || this.active >= this.limit && (mutation || this.queue.length >= this.queued)) throw new CapacityError();
    if (this.active >= this.limit) {
      await new Promise<void>((resolve,reject)=>{
        const enter = () => { signal.removeEventListener('abort',abort); resolve(); };
        const abort = () => { this.queue=this.queue.filter(item=>item!==enter); reject(new WorkCancelled()); };
        this.queue.push(enter); signal.addEventListener('abort',abort,{once:true});
      });
    } else this.active++;
    try { signal.throwIfAborted(); return await work(); }
    finally { const next = this.queue.shift(); if(next) next(); else this.active--;
      if(this.active===0)for(const resolve of this.drained.splice(0))resolve(); }
  }
  controller() {
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(()=>controller.abort(new WorkCancelled()),this.timeoutMs);
    return {controller,done:()=>{clearTimeout(timer);this.controllers.delete(controller);}};
  }
  drain():Promise<void> {return this.active===0?Promise.resolve():new Promise(resolve=>this.drained.push(resolve));}
  shutdown() { this.stopped=true; for(const controller of this.controllers) controller.abort(new WorkCancelled()); }
}
/** Reap actual native/CPU/socket work before settling; no abandoned promise releases a slot. */
export async function ownedRead(payload: Serializable, signal: AbortSignal, worker = new URL('./read-worker.ts',import.meta.url)): Promise<any> {
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child = fork(fileURLToPath(worker), [], { execArgv: ['--max-old-space-size=384','--import','tsx'],
      stdio: ['ignore','ignore','ignore','ipc'], serialization:'advanced' });
    let reply: any, failure: unknown;
    const stop = () => { failure = new WorkCancelled(); child.kill('SIGKILL'); };
    signal.addEventListener('abort',stop,{once:true});
    child.on('message',message=>{ reply=message; child.kill('SIGKILL'); });
    child.on('error',()=>{ failure=new Error('worker_unavailable'); child.kill('SIGKILL'); });
    child.once('close',()=>{
      signal.removeEventListener('abort',stop);
      if(signal.aborted || failure) reject(failure??new WorkCancelled());
      else if(reply?.ok === true) resolve(reply.value);
      else { const error = new Error('worker_failed') as Error & {status:number;body:unknown}; error.status=reply?.status??503; error.body=reply?.body??{error:'work_failed',evidence_usable:false}; reject(error); }
    });
    child.send(payload,error=>{if(error){failure=error;child.kill('SIGKILL');}});
    if(signal.aborted) stop();
  });
}
