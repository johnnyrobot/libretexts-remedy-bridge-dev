const { AsyncLocalStorage } = require('node:async_hooks');
const requestBudget = exports.requestBudget = new AsyncLocalStorage();
const MAX_RESPONSE_BYTES = exports.MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Shared by SDK and provider fetches. Bounded decoded bytes, including chunked bodies. */
exports.boundedFetch = async function boundedFetch(input, init) {
  const context = requestBudget.getStore();
  const request = input instanceof Request ? input : new Request(input, init);
  const mutation = !['GET','HEAD'].includes(request.method) && context?.mutation === true;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(mutation ? 30000 : 300000), ...(!mutation && context ? [context.signal] : [])]);
  if(!context?.dispatched) context?.signal.throwIfAborted();
  const response = await globalThis.fetch(input, {...init,signal});
  const reader = response.body?.getReader();
  if (!reader) return response;
  const chunks=[]; let bytes=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_RESPONSE_BYTES)throw new Error('response_too_large');chunks.push(value);}
  } catch(error) { await reader.cancel().catch(()=>{}); throw error; }
  const headers = new Headers(response.headers); headers.delete('content-encoding'); headers.delete('content-length');
  return new Response(Buffer.concat(chunks),{status:response.status,statusText:response.statusText,headers});
}
