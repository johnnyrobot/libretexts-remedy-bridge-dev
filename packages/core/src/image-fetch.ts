import { lookup as nativeLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request as httpRequest, type RequestOptions, type IncomingMessage, type ClientRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { blockedIpReason, isImageFetchAllowed } from './net-guard.js';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_DEADLINE_MS = 15_000;
export class ImageFetchError extends Error {
  constructor(readonly reason: 'blocked-destination' | 'timeout' | 'cancelled' | 'too-large' | 'unsupported' | 'transport') {
    super(`Image requires manual review: ${reason}`); this.name = 'ImageFetchError';
  }
}
export interface ImageFetchOptions {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** May shorten the fixed 15s budget, never lengthen it. */
  timeoutMs?: number;
  probe?: boolean;
  headers?: Record<string, string>;
  /** External DNS/transport seams; native implementations are the default. */
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
  request?: (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
}
export interface ImageFetchResult { bytes: Buffer; status: number; headers: IncomingHttpHeaders; url: string; }

function aborted(signal: AbortSignal): never {
  throw signal.reason instanceof ImageFetchError ? signal.reason : new ImageFetchError('cancelled');
}
function checkAbort(signal: AbortSignal) { if (signal.aborted) aborted(signal); }
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => { try { aborted(signal); } catch (error) { reject(error); } };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); }, error => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}
function inlineImage(url: string): ImageFetchResult {
  const match = /^data:(image\/[a-z0-9.+-]+)(;base64)?,([\s\S]*)$/i.exec(url);
  if (!match) throw new ImageFetchError('unsupported');
  const payload = match[3];
  if (payload.length > (match[2] ? 4 * Math.ceil(MAX_IMAGE_BYTES / 3) : MAX_IMAGE_BYTES)) throw new ImageFetchError('too-large');
  let bytes: Buffer;
  try {
    if (match[2]) {
      if (payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) throw new Error();
      bytes = Buffer.from(payload, 'base64');
      if (bytes.toString('base64') !== payload) throw new Error();
    } else bytes = Buffer.from(decodeURIComponent(payload), 'utf8');
  } catch { throw new ImageFetchError('unsupported'); }
  if (bytes.length > MAX_IMAGE_BYTES) throw new ImageFetchError('too-large');
  return { bytes, status: 200, headers: { 'content-type': match[1].toLowerCase() }, url };
}

/** Complete image transport policy, including DNS, connect, redirects and bytes. */
export async function fetchBoundedImage(raw: string, opts: ImageFetchOptions = {}): Promise<ImageFetchResult> {
  const requested = opts.timeoutMs ?? IMAGE_DEADLINE_MS;
  if (!Number.isFinite(requested) || requested <= 0) throw new ImageFetchError('unsupported');
  const controller = new AbortController();
  const cancel = () => controller.abort(new ImageFetchError('cancelled'));
  opts.signal?.addEventListener('abort', cancel, { once: true });
  if (opts.signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new ImageFetchError('timeout')), Math.min(requested, IMAGE_DEADLINE_MS));
  const signal = controller.signal;
  try {
    checkAbort(signal);
    if (raw.startsWith('data:')) return inlineImage(raw);
    let url = new URL(raw), method = opts.probe ? 'HEAD' : 'GET', redirects = 0, retried = false;
    while (true) {
      checkAbort(signal);
      if (!['http:', 'https:'].includes(url.protocol)) throw new ImageFetchError('unsupported');
      if (!isImageFetchAllowed(url.href, opts.env).ok) throw new ImageFetchError('blocked-destination');
      const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
      const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] :
        await abortable((opts.lookup ?? (name => nativeLookup(name, { all: true, verbatim: true })))(host), signal);
      checkAbort(signal);
      if (!addresses.length || addresses.some(a => ![4, 6].includes(a.family) || isIP(a.address) !== a.family || blockedIpReason(a.address))) throw new ImageFetchError('blocked-destination');
      const address = addresses[0];
      const pinnedLookup: RequestOptions['lookup'] = (_hostname, options, callback) => {
        // Node must not resolve again at connect (including autoSelectFamily).
        if (options?.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      };
      const response = await oneRequest(url, method, { ...opts, signal }, pinnedLookup);
      checkAbort(signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (++redirects > 3 || typeof response.headers.location !== 'string') throw new ImageFetchError('unsupported');
        url = new URL(response.headers.location, url);
        continue;
      }
      if (opts.probe && method === 'HEAD' && !retried && [403, 405, 501].includes(response.status)) {
        retried = true; method = 'GET'; continue;
      }
      return response;
    }
  } catch (error) {
    if (signal.aborted) aborted(signal);
    if (error instanceof ImageFetchError) throw error;
    throw new ImageFetchError('transport');
  } finally { clearTimeout(timer); opts.signal?.removeEventListener('abort', cancel); }
}

function oneRequest(url: URL, method: string, opts: ImageFetchOptions & { signal: AbortSignal }, lookup: RequestOptions['lookup']): Promise<ImageFetchResult> {
  return new Promise((resolve, reject) => {
    const request = opts.request ?? (url.protocol === 'https:' ? httpsRequest : httpRequest);
    const req = request(url, { method, lookup, agent: false, signal: opts.signal, maxHeaderSize: 16 * 1024,
      ...(url.protocol === 'https:' && !isIP(url.hostname.replace(/^\[|\]$/g, '')) ? { servername: url.hostname.replace(/\.$/, '') } : {}),
      headers: { ...opts.headers, Accept: 'image/*', 'Accept-Encoding': 'identity' } }, response => {
      const status = response.statusCode ?? 0;
      const result = { status, headers: response.headers, url: url.href };
      const fail = (error: Error) => { response.destroy(); req.destroy(); reject(error); };
      const length = response.headers['content-length'];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_IMAGE_BYTES)) { fail(new ImageFetchError('too-large')); return; }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { fail(new ImageFetchError('unsupported')); return; }
      if (method === 'HEAD' || status < 200 || status >= 300) { response.destroy(); resolve({ ...result, bytes: Buffer.alloc(0) }); return; }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) { fail(new ImageFetchError('too-large')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('aborted', () => reject(new ImageFetchError('transport')));
      response.on('end', () => resolve({ ...result, bytes: Buffer.concat(chunks, size) }));
    });
    req.on('error', reject);
    req.end();
  });
}
