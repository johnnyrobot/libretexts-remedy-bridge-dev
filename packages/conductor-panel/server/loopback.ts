import { isIP } from 'node:net';

/** Enforce the local staff tool boundary before opening a listening socket. */
export function requireLoopbackHost(host: string): string {
  // Resolve this permitted name ourselves so DNS cannot turn it into an off-host bind.
  if (host.toLowerCase() === 'localhost') return '127.0.0.1';
  if (host === '::1' || (isIP(host) === 4 && host.startsWith('127.'))) return host;
  throw new Error('CONDUCTOR_API_HOST: non-loopback bind needs signed reviewer assertions (option B) first');
}
