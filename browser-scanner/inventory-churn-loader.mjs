// OS fixture only: an unrelated, positively identified sibling exits while
// process-owner reads its inventory. No product error/termination method is mocked.
export async function resolve(specifier,context,nextResolve){
 if(specifier!=='node:fs/promises'||!context.parentURL?.endsWith('/process-owner.mjs'))return nextResolve(specifier,context);
 return{shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(`
 import * as fs from 'node:fs/promises';
 export const readFile=fs.readFile;
 let first=true;
 export async function readdir(path,...args){
  const names=await fs.readdir(path,...args);
  if(first&&(path==='/proc'||/^\\/proc\\/\\d+\\/task/.test(String(path)))){
   first=false;const pid=Number(process.env.LT225_UNRELATED_PID);
   process.kill(pid,'SIGKILL');
   for(let i=0;i<200;i++){try{await fs.readFile('/proc/'+pid+'/stat');}catch(error){if(error.code==='ENOENT'){process.env.LT225_CHURN_OBSERVED='1';break;}throw error;}await new Promise(r=>setTimeout(r,5));}
  }
  return names;
 }
 `)};
}
