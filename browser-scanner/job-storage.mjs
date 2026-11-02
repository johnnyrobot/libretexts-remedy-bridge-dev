import {mkdtemp,mkdir,lstat,readdir,realpath,rm,statfs} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Only this allocator can attest that a failed allocation left no owned root.
const allocationStates=new WeakMap();
const allocationFailure=(cause,state)=>{const error=new Error(cause.message,{cause});allocationStates.set(error,state);return error;};
/** @returns {'no_root'|'removed'|undefined} Allocator-owned proof; caller fields are ignored. */
export const allocationStorageState=error=>allocationStates.get(error);

// Polling thresholds; the deployment's 512 MiB tmpfs is the hard allocation cap.
export const STORAGE_LIMITS=Object.freeze({bytes:128*1024*1024,entries:8192,intervalMs:250,freeBytes:256*1024*1024});
export async function createJobStorage(){
 const parent=await realpath(tmpdir());
 const space=await statfs(parent);
 if(space.bavail*space.bsize<STORAGE_LIMITS.freeBytes)throw allocationFailure(Error('Temporary storage unavailable'),'no_root');
 const path=await mkdtemp(join(parent,'remedy-render-job-'));
 const identity=await lstat(path);
 const verify=async()=>{
  const current=await lstat(path);
  if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==identity.dev||current.ino!==identity.ino||current.uid!==process.getuid())throw Error('Job storage ownership changed');
 };
 const inspect=async()=>{
  await verify();
  let bytes=0,entries=0;
  const pending=[path];
  while(pending.length){
   const directory=pending.pop();
   let names;
   try{names=await readdir(directory);}catch(error){if(error.code==='ENOENT'&&directory!==path)continue;throw error;}
   for(const name of names){
    let stat;const target=join(directory,name);
    try{stat=await lstat(target);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    if(stat.dev!==identity.dev||stat.uid!==identity.uid)throw Error('Foreign job storage');
    bytes+=Math.max(stat.size,stat.blocks*512);entries++;
    if(bytes>STORAGE_LIMITS.bytes||entries>STORAGE_LIMITS.entries)throw Error('Job storage budget exceeded');
    if(stat.isDirectory())pending.push(target);
   }
  }
  return{bytes,entries};
 };
 // No discovery/sweep: this closure can remove only the directory it created.
 const cleanup=async()=>{await inspect();await verify();await rm(path,{recursive:true});try{await lstat(path);throw Error('Job storage retained');}catch(error){if(error.code!=='ENOENT')throw error;}};
 try{await mkdir(join(path,'home'),{mode:0o700});}catch(error){await cleanup();throw allocationFailure(error,'removed');}
 return{path,inspect,cleanup,env:{TMPDIR:path,TMP:path,TEMP:path,RENDER_JOB_HOME:join(path,'home')}};
}
