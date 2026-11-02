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
   first=false;const state=JSON.parse(await fs.readFile(process.env.LT225_CHURN_STATE,'utf8')),pid=state.pid;
   if(!Number.isSafeInteger(pid)||pid<=1||pid===process.pid)throw Error('Invalid fixture process');
   const stat=await fs.readFile('/proc/'+pid+'/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
   if(fields[19]!==state.start)throw Error('Fixture identity changed');
   process.kill(pid,'SIGKILL');
   for(let i=0;i<200;i++){try{await fs.readFile('/proc/'+pid+'/stat');}catch(error){if(error.code==='ENOENT'||error.code==='ESRCH'){await fs.writeFile(process.env.LT225_CHURN_STATE,JSON.stringify({...state,observed:true}));break;}throw error;}await new Promise(r=>setTimeout(r,5));}
  }
  return names;
 }
 `)};
}
