import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import Expert from '@libretexts/cxone-expert-node';

const CommonJSExpert = createRequire(import.meta.url)('@libretexts/cxone-expert-node').default;
it.each([['ESM', Expert], ['CommonJS', CommonJSExpert]])('%s SDK declares UTF-8 for page writes and preserves scientific text', async (_format, SDK) => {
  let contentType = '', received = '';
  const server = createServer(async (req, res) => {
    contentType = req.headers['content-type'] || '';
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received = Buffer.concat(chunks).toString('utf8');
    res.setHeader('Content-Type', 'application/json');
    res.end('{"page":{"@revision":"1"}}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const client = new SDK({ tld: `http://127.0.0.1:${address.port}`,
      auth: { type: 'server', params: { key: 'test', secret: 'test', user: 'test' } } });
    const html = '<p>“α-helix” — π ≈ 3.14; café; 水</p>';
    await client.pages.postPageContents(1, html, { edittime: 'now' });
    expect(contentType.toLowerCase()).toBe('text/plain; charset=utf-8');
    expect(received).toBe(html);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
it.each([['ESM', Expert], ['CommonJS', CommonJSExpert]])('%s SDK never follows or retries a mutation redirect', async (_format, SDK) => {
  const requests: string[] = [];
  const server = createServer((req,res) => { requests.push(req.url!);req.resume();if(requests.length===1){res.writeHead(307,{location:'/duplicate-mutation'});res.end();}else{res.setHeader('content-type','application/json');res.end('{}');} });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    const client=new SDK({tld:`http://127.0.0.1:${(server.address()as{port:number}).port}`,auth:{type:'server',params:{key:'fake',secret:'fake',user:'fake'}}});
    await expect(client.pages.postPageContents(1,'<p>Reviewed</p>',{edittime:'now'})).rejects.toThrow();
    expect(requests).toHaveLength(1);
  } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

it.each([['ESM', Expert], ['CommonJS', CommonJSExpert]])('%s SDK routes request instances through pinned supported Axios', async (_format, SDK) => {
  const axios = createRequire(import.meta.url)('axios');
  expect(axios.VERSION).toBe('1.21.0');
  const create = vi.spyOn(axios, 'create');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } }));
  try {
    const client = new SDK({ tld: 'https://synthetic.example.test', auth: { type: 'server', params: { key: 'fake', secret: 'fake', user: 'fake' } } });
    await client.pages.getPageInfo(1);
    expect(create.mock.calls.length).toBeGreaterThan(1);
    expect(create.mock.results.every(result => result.value.defaults.adapter === 'fetch')).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  } finally { create.mockRestore(); fetcher.mockRestore(); }
});
