import { expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { imageSourceFromUrl } from '../ai/llm-client.js';
import { fetchBoundedImage, MAX_IMAGE_BYTES } from '../image-fetch.js';
import { markUnavailableImageFixes } from '../image-availability.js';
import { scanHtml } from '../scan.js';
import { imageNetwork } from './support/image-network.js';

const png = () => sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } }).png().toBuffer();
it('uses the validated address at connect while retaining hostname TLS/SNI through actual AI byte loading', async () => {
  const bytes = await png();
  const net = imageNetwork(() => ({ chunks: [bytes] }));
  const image = await imageSourceFromUrl('https://images.example.test/a.png', net.options);
  expect(image.kind).toBe('bytes');
  expect(net.calls).toEqual([{ url: 'https://images.example.test/a.png', method: 'GET', address: '93.184.216.34', servername: 'images.example.test' }]);
  expect(net.lookups).toEqual(['images.example.test']);
});
it.each([['10.0.0.1'], ['93.184.216.34', '::ffff:7f00:1'], ['169.254.169.254'], ['::ffff:a00:1']])('denies all mixed/private DNS destinations %s before connect', async (...destinations) => {
  const net = imageNetwork(() => ({}), destinations);
  await expect(imageSourceFromUrl('https://images.example.test/a.png', net.options)).rejects.toMatchObject({ reason: 'blocked-destination' });
  expect(net.calls).toEqual([]);
});
it('never resolves again during connect, defeating a public-to-private rebinding answer', async () => {
  const net = imageNetwork(() => ({}));
  const lookup = vi.fn().mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
  await fetchBoundedImage('https://images.example.test/a.png', { ...net.options, lookup });
  expect(lookup).toHaveBeenCalledTimes(1); expect(net.calls[0].address).toBe('93.184.216.34');
});
it('guards every redirect, including DNS destination and allowlist, and allows at most three hops', async () => {
  const literal = imageNetwork(() => ({ status: 302, headers: { location: 'http://[::ffff:7f00:1]/private.png' } }));
  await expect(fetchBoundedImage('https://images.example.test/a.png', literal.options)).rejects.toMatchObject({ reason: 'blocked-destination' });
  expect(literal.calls).toHaveLength(1);
  const dns = imageNetwork(() => ({ status: 302, headers: { location: 'https://other.example.test/private.png' } }));
  const lookup = vi.fn().mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
  await expect(fetchBoundedImage('https://images.example.test/a.png', { ...dns.options, lookup })).rejects.toMatchObject({ reason: 'blocked-destination' });
  expect(dns.calls).toHaveLength(1);
  const hops = imageNetwork(url => ({ status: 302, headers: { location: url.href + '?next' } }));
  await expect(fetchBoundedImage('https://images.example.test/a.png', hops.options)).rejects.toMatchObject({ reason: 'unsupported' });
  expect(hops.calls).toHaveLength(4);
  const allow = imageNetwork(() => ({ status: 302, headers: { location: 'https://unlisted.example.net/a.png' } }));
  await expect(fetchBoundedImage('https://images.example.test/a.png', { ...allow.options, env: { REMEDY_IMAGE_FETCH_ALLOWLIST: 'example.test' } })).rejects.toMatchObject({ reason: 'blocked-destination' });
  expect(allow.calls).toHaveLength(1);
});
it.each(['dns', 'headers', 'body'])('enforces the shared deadline across stalled %s and stops transport', async phase => {
  const net = imageNetwork(() => ({ stallHeaders: phase === 'headers', stallBody: phase === 'body' }));
  const options = phase === 'dns' ? { ...net.options, lookup: () => new Promise<any>(() => {}) } : net.options;
  await expect(fetchBoundedImage('https://images.example.test/a.png', { ...options, timeoutMs: 20 })).rejects.toMatchObject({ reason: 'timeout' });
  if (phase !== 'dns') expect(net.destroyed).toBeGreaterThan(0);
});
it('aborts actual body transport on caller cancellation', async () => {
  const controller = new AbortController();
  const net = imageNetwork(() => ({ stallBody: true }));
  const pending = fetchBoundedImage('https://images.example.test/a.png', { ...net.options, signal: controller.signal });
  await vi.waitFor(() => expect(net.calls).toHaveLength(1)); controller.abort();
  await expect(pending).rejects.toMatchObject({ reason: 'cancelled' }); expect(net.destroyed).toBeGreaterThan(0);
});
it('rejects encoded-size overflow before decoding or concatenating, including data images', async () => {
  const headers = imageNetwork(() => ({ headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) } }));
  await expect(imageSourceFromUrl('https://images.example.test/a.png', headers.options)).rejects.toMatchObject({ reason: 'too-large' });
  const body = imageNetwork(() => ({ chunks: [Buffer.alloc(MAX_IMAGE_BYTES), Buffer.from('x')] }));
  await expect(imageSourceFromUrl('https://images.example.test/a.png', body.options)).rejects.toMatchObject({ reason: 'too-large' });
  await expect(imageSourceFromUrl('data:image/png;base64,' + 'A'.repeat(4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 4))).rejects.toMatchObject({ reason: 'too-large' });
});
it('retains the 40M decoded-pixel cap and explicit invalid/animated input failures', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="10000"></svg>');
  await expect(imageSourceFromUrl('data:image/svg+xml;base64,' + svg.toString('base64'))).rejects.toThrow(/pixel limit/i);
  await expect(imageSourceFromUrl('data:image/png;base64,YmFk')).rejects.toThrow();
});
it('preserves blocked images as unusable/manual review evidence in actual availability caller', async () => {
  const findings = scanHtml('<img src="https://images.example.test/a.png">');
  const net = imageNetwork(() => ({}), ['::ffff:7f00:1']);
  const result = await markUnavailableImageFixes(findings, { hostname: 'dev.libretexts.org', path: '/test' }, { imageFetch: net.options });
  expect(result[0]).toMatchObject({ ruleId: 'img-alt', fixable: false, data: { imageAvailabilityReason: 'blocked-destination' } });
  expect(net.calls).toEqual([]);
});

it('shares one deadline across DNS/redirect work and HEAD-to-GET availability fallback', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    const net = imageNetwork((_url, method) => method === 'HEAD' ? { status: 405 } : { stallBody: true });
    const lookup = async () => { await new Promise(r => setTimeout(r, 12)); return [{ address: '93.184.216.34', family: 4 }]; };
    const checked = expect(fetchBoundedImage('https://images.example.test/a.png', { ...net.options, lookup, probe: true, timeoutMs: 20 })).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(12);
    expect(net.calls.map(c => c.method)).toEqual(['HEAD']);
    await vi.advanceTimersByTimeAsync(8); await checked;
    expect(net.calls.map(c => c.method)).toEqual(['HEAD']);
  } finally { vi.useRealTimers(); }
});
it('does not connect if a timed-out DNS operation resolves later', async () => {
  const net = imageNetwork(() => ({}));
  let resolve!: (addresses: { address: string; family: number }[]) => void;
  const pending = fetchBoundedImage('https://images.example.test/a.png', { ...net.options, timeoutMs: 10, lookup: () => new Promise(r => { resolve = r; }) });
  await expect(pending).rejects.toMatchObject({ reason: 'timeout' });
  resolve([{ address: '93.184.216.34', family: 4 }]);
  await new Promise(r => setTimeout(r, 1)); expect(net.calls).toEqual([]);
});
it('keeps a blocked-image fix unresolved and never calls inference or infers decoration', async () => {
  const { fixPage } = await import('../fix.js');
  const html = '<img src="http://[::ffff:7f00:1]/private.png">';
  const vision = vi.fn();
  const result = await fixPage(903, { expert: { pages: { getPageInfo: async () => ({ '@id': 903, path: 'Sandboxes/johnnyphung/Test' }), getPageContents: async () => ({ body: html }) } } as any,
    env: { SERVER_DOMAIN: 'dev.libretexts.org' }, llm: { vision } as any });
  expect(result.after).toBe(html); expect(result.applied).toEqual([]);
  expect(result.findings.some(f => f.ruleId === 'img-alt' && !f.fixable)).toBe(true);
  expect(vision).not.toHaveBeenCalled(); expect(result.after).not.toContain('presentation');
});

it('pins all validated addresses for native dual-stack fallback without another DNS lookup', async () => {
  const net = imageNetwork(() => ({}), ['2606:4700:4700::1111', '93.184.216.34']);
  await fetchBoundedImage('https://images.example.test/a.png', net.options);
  expect(net.lookups).toEqual(['images.example.test']);
  expect(net.pins).toEqual([['2606:4700:4700::1111', '93.184.216.34']]);
});

async function inlineRegressionSource(kind: string): Promise<string> {
  if (kind === 'parameters') return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>');
  const bytes = await png();
  return 'data:image/png,' + [...bytes].map(b => '%' + b.toString(16).padStart(2, '0')).join('');
}
it.each(['parameters', 'binary-percent'])('loads a valid inline %s image through the AI byte caller', async kind => {
  const source = await inlineRegressionSource(kind);
  const image = await imageSourceFromUrl(source);
  expect(image.kind).toBe('bytes');
  if (image.kind !== 'bytes') throw new Error('Expected bytes');
  expect((await sharp(image.bytes).metadata()).width).toBe(2);
});
it.each(['parameters', 'binary-percent'])('keeps valid inline %s images available for fixes', async kind => {
  const source = await inlineRegressionSource(kind);
  const findings = scanHtml(`<img src="${source}">`);
  const result = await markUnavailableImageFixes(findings, { hostname: 'dev.libretexts.org', path: '/test' });
  expect(result[0].fixable).toBe(true);
  expect(result[0].data?.imageAvailabilityReason).toBeUndefined();
});

it('decodes media parameters and percent-escaped base64 while preserving size checks', async () => {
  const bytes = await png();
  const source = 'data:image/png;name=diagram.png;charset=UTF-8;base64,' + encodeURIComponent(bytes.toString('base64'));
  expect(await imageSourceFromUrl(source)).toMatchObject({ kind: 'bytes', mimeType: 'image/png' });
  await expect(fetchBoundedImage('data:image/png;base64,' + 'A'.repeat(4 * Math.ceil(MAX_IMAGE_BYTES / 3)))).rejects.toMatchObject({ reason: 'too-large' });
  await expect(fetchBoundedImage('data:image/png,%xx')).rejects.toMatchObject({ reason: 'unsupported' });
});
