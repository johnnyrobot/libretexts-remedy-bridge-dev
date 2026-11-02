// Deterministic OS race fixture: a descendant forks after the /proc snapshot.
export async function resolve(specifier,context,nextResolve){
 if(specifier!=='node:fs/promises'||!context.parentURL?.endsWith('/process-owner.mjs'))return nextResolve(specifier,context);
 return{shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(`
 import * as fs from 'node:fs/promises';
 export const readFile=fs.readFile;
 let first=true;
 export async function readdir(path){
  const names=await fs.readdir(path);
  if(path==='/proc'&&first){first=false;await fs.writeFile(process.env.LT162_LATE_MARKER,'spawn');await new Promise(r=>setTimeout(r,300));}
  return names;
 }`)};
}
