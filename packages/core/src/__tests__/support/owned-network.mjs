// Every child inherits this preload. No real external requests can escape.
const nativeFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const request=new Request(input,init),url=new URL(request.url);
 if(url.hostname!=='dev.libretexts.org' && url.hostname!=='fake-provider.test')throw Error('External network forbidden');
 const target=new URL(process.env.TEST_EXTERNAL_URL);target.pathname=url.pathname;target.search=url.search;
 return nativeFetch(target,{method:request.method,headers:request.headers,body:['GET','HEAD'].includes(request.method)?undefined:await request.text(),signal:request.signal,redirect:'error'});
};
