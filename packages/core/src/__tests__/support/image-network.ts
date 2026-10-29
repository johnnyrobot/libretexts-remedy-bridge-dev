import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ImageFetchOptions } from '../../image-fetch.js';

export interface FakeImageReply { status?: number; headers?: Record<string, string>; chunks?: Buffer[]; stallHeaders?: boolean; stallBody?: boolean; }
/** Only external DNS/HTTP transport are fake; callers use the real image policy. */
export function imageNetwork(reply: (url: URL, method: string) => FakeImageReply, destinations = ['93.184.216.34']) {
  const calls: { url: string; method: string; address: string; servername?: string }[] = [];
  const lookups: string[] = [];
  let destroyed = 0;
  const options: ImageFetchOptions = {
    lookup: async host => { lookups.push(host); return destinations.map(address => ({ address, family: address.includes(':') ? 6 : 4 })); },
    request: (url, config, callback) => {
      const req = new EventEmitter() as any;
      let response: PassThrough | undefined;
      req.destroy = (error?: Error) => { destroyed++; response?.destroy(); if (error) req.emit('error', error); return req; };
      const abort = () => req.destroy(new Error('external transport aborted'));
      config.signal?.addEventListener('abort', abort, { once: true });
      req.end = () => queueMicrotask(() => {
        const connected = (_error: unknown, addresses: any) => {
          const address = typeof addresses === 'string' ? addresses : addresses[0].address;
          calls.push({ url: url.href, method: String(config.method), address, servername: (config as any).servername });
          const result = reply(url, String(config.method));
          if (result.stallHeaders) return;
          response = new PassThrough();
          Object.assign(response, { statusCode: result.status ?? 200, headers: result.headers ?? { 'content-type': 'image/png' } });
          response.on('close', () => config.signal?.removeEventListener('abort', abort));
          callback(response as any);
          if (!result.stallBody && !response.destroyed) {
            for (const chunk of result.chunks ?? []) response.write(chunk);
            response.end();
          }
        };
        if (config.lookup) (config.lookup as any)(url.hostname, { all: true }, connected);
        else connected(null, [{ address: 'UNVALIDATED' }]);
      });
      return req;
    },
  };
  return { options, calls, lookups, get destroyed() { return destroyed; } };
}
