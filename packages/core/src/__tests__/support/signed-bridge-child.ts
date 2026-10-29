// Fake EXTERNAL CXone transport only. The bridge, SDK, core and ledger are real.
const nativeFetch = globalThis.fetch;
const external = process.env.TEST_CXONE_URL!;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname !== 'dev.libretexts.org') throw new Error('External network forbidden');
  if (request.method === 'POST' && process.env.TEST_CRASH_STAGE === 'before_send') process.kill(process.pid, 'SIGKILL');
  const target = new URL(external); target.pathname = url.pathname; target.search = url.search;
  const response = await nativeFetch(target, {method:request.method,headers:request.headers,body:request.method === 'GET' ? undefined : await request.text(),redirect:'error'});
  if (request.method === 'POST' && process.env.TEST_CRASH_STAGE === 'after_response') process.kill(process.pid, 'SIGKILL');
  return response;
};
const { createBridgeServer,executeReadInline } = await import('../../../../conductor-panel/server/server.js');
const server = createBridgeServer(executeReadInline);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
process.send?.({port:(server.address() as {port:number}).port});
process.on('message', message => { if (message === 'stop') server.close(); });
