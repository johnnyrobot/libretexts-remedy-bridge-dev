// Test-only OS fault adapter, scoped to the allocator's fs import.
export async function resolve(specifier,context,nextResolve){
 if(specifier!=='node:fs/promises'||!context.parentURL?.endsWith('/job-storage.mjs'))return nextResolve(specifier,context);
 const source=`import * as fs from 'node:fs/promises';import {dirname,join} from 'node:path';export * from 'node:fs/promises';
 let armed=true;const mode=process.env.LT224_ALLOCATION_FAULT;
 export async function mkdtemp(...args){
  if(armed&&mode==='mkdtemp_failed'){armed=false;try{return await fs.mkdtemp('/dev/null/lt224-');}catch(error){Object.assign(error,{allocationStorageState:'no_root',storageReleased:true,name:'AllocationFailure'});throw error;}}
  const path=await fs.mkdtemp(...args);
  if(armed&&mode==='partial'){armed=false;await fs.writeFile(join(path,'partial-allocation'),'preserve');await fs.mkdir(path);}
  return path;
 }
 export async function lstat(path,...args){if(armed&&mode==='identity_unreadable'&&String(path).includes('/remedy-render-job-')){armed=false;return fs.lstat(join(path,'missing-identity'));}return fs.lstat(path,...args);}
 export async function mkdir(path,...args){
  if(!armed||!String(path).endsWith('/home'))return fs.mkdir(path,...args);
  armed=false;const root=dirname(path);
  if(mode==='mkdir_removed'||mode==='cleanup_denied'){
   await fs.chmod(root,0o500);
   try{return await fs.mkdir(path,...args);}finally{await fs.chmod(root,mode==='cleanup_denied'?0o000:0o700);}
  }
  if(mode==='identity_changed'){
   await fs.rename(root,root+'-preserved');await fs.mkdir(root,{mode:0o700});await fs.writeFile(join(root,'replacement-sentinel'),'preserve');return fs.mkdir(root);
  }
  return fs.mkdir(path,...args);
 }`;
 return{url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true};
}
