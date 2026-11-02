// Synthetic EXTERNAL DNS and reader content for owned-process tests only.
export async function resolve(specifier,context,nextResolve){
 if(specifier==='node:dns/promises')return{url:'data:text/javascript,export async function lookup(){return [{address:"8.8.8.8",family:4}]}',shortCircuit:true};
 if(specifier!=='playwright')return nextResolve(specifier,context);
 const real=await nextResolve(specifier,context);
 const body='<section class="mt-content-container">Synthetic reader page with enough content.</section><script>'+ (process.env.RENDER_TEST_COMPLETE==='1'?'':process.env.RENDER_TEST_CPU_HANG==='1'?'while(true){}':'window.MathJax={startup:{promise:new Promise(()=>{})}}')+'</script>';
 const script=`import {chromium} from ${JSON.stringify(real.url)};
 if(process.env.RENDER_TEST_LATE_OWNERSHIP==='1'){const launch=chromium.launchServer.bind(chromium);chromium.launchServer=async(...args)=>{const server=await launch(...args);await new Promise(r=>setTimeout(r,2000));return server;};}
 const connect=chromium.connect.bind(chromium);
 chromium.connect=async(...args)=>{const browser=await connect(...args);const create=browser.newContext.bind(browser);
 browser.newContext=async(...values)=>{const context=await create(...values);const register=context.route.bind(context);
 if(process.env.RENDER_TEST_BEFORE_CONTEXT==='1'){const newPage=context.newPage.bind(context);context.newPage=async(...args)=>{const page=await newPage(...args);await page.setContent('<section class="mt-content-container">Synthetic owned deadline renderer.</section>');await new Promise(()=>{});return page;};}
 context.route=(pattern,handler)=>register(pattern,route=>route.request().resourceType()==='document'?route.fulfill({contentType:'text/html',body:${JSON.stringify(body)}}):route.abort());return context;};return browser;};export {chromium};`;
 return{url:'data:text/javascript,'+encodeURIComponent(script),shortCircuit:true};
}
