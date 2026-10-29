// Synthetic EXTERNAL DNS and reader content for owned-process tests only.
export async function resolve(specifier,context,nextResolve){
 if(specifier==='node:dns/promises')return{url:'data:text/javascript,export async function lookup(){return [{address:"8.8.8.8",family:4}]}',shortCircuit:true};
 if(specifier!=='playwright')return nextResolve(specifier,context);
 const real=await nextResolve(specifier,context);
 const script=`import {chromium} from ${JSON.stringify(real.url)};
 const connect=chromium.connect.bind(chromium);
 chromium.connect=async(...args)=>{const browser=await connect(...args);const create=browser.newContext.bind(browser);
 browser.newContext=async(...values)=>{const context=await create(...values);const register=context.route.bind(context);
 context.route=(pattern,handler)=>register(pattern,route=>route.request().resourceType()==='document'?route.fulfill({contentType:'text/html',body:'<section class="mt-content-container">Synthetic reader page with enough content.</section><script>window.MathJax={startup:{promise:new Promise(()=>{})}}</script>'}):route.abort());return context;};return browser;};export {chromium};`;
 return{url:'data:text/javascript,'+encodeURIComponent(script),shortCircuit:true};
}
