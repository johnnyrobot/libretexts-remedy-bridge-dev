// Controlled HTTPS transport only. Keep production policy, sandbox and TLS checks.
export async function resolve(specifier,context,nextResolve){
 if(specifier==='node:dns/promises')return{shortCircuit:true,url:'data:text/javascript,export async function lookup(){return [{address:"8.8.8.8",family:4}]}'};
 if(specifier!=='playwright')return nextResolve(specifier,context);
 const real=await nextResolve(specifier,context);
 return{shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(`
 import {chromium} from ${JSON.stringify(real.url)};
 const launch=chromium.launchServer.bind(chromium);
 chromium.launchServer=options=>launch({...options,args:options.args.map(arg=>arg.startsWith('--host-resolver-rules=')?'--host-resolver-rules=MAP dev.libretexts.org 127.0.0.1:'+process.env.LT239_HTTPS_PORT+',MAP * ~NOTFOUND':arg)});
 export {chromium};`)};
}
