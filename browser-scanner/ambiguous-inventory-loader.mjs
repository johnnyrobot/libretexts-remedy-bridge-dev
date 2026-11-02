// Fixture only: make an owned child fork-and-exit after enumeration, then wait
// for its living parent to reap it before the product can read the vanished row.
export async function resolve(specifier,context,next){
 if(specifier!=='node:fs/promises'||!context.parentURL?.endsWith('/process-owner.mjs'))return next(specifier,context);
 return{shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(`import * as fs from 'node:fs/promises';export const readFile=fs.readFile;let first=true;
 export async function readdir(path,...args){const names=await fs.readdir(path,...args);if(path==='/proc'&&first){first=false;await fs.writeFile(process.env.LT225_AMBIG_MARKER,'fork');let settled=false;for(let i=0;i<400;i++){try{await fs.readFile(process.env.LT225_AMBIG_SETTLED);settled=true;break;}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,5));}if(!settled)throw Error('Fixture did not settle');}return names;}`)};
}
