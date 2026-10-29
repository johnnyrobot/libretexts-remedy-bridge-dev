import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

/** URL policy is only the first step; image-fetch pins validated DNS at connect. */
export class SsrfBlockedError extends Error {
  constructor(url: string, reason: string) {
    super(`Blocked outbound fetch to ${url}: ${reason}`);
    this.name = 'SsrfBlockedError';
  }
}

export type FetchGuardResult = { ok: true } | { ok: false; reason: string };

/** Pure predicate form — returns a reason string when the URL is disallowed. */
export function isImageFetchAllowed(
  rawUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): FetchGuardResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }

  // `data:` URLs are inline bytes — decoding them issues no network request, so
  // they carry no SSRF risk and are always allowed.
  if (url.protocol === 'data:') return { ok: true };

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `scheme ${url.protocol} not allowed` };
  }

  if (url.username || url.password) return { ok: false, reason: 'URL credentials forbidden' };
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) return { ok: false, reason: 'empty host' };

  const ipReason = blockedIpReason(host);
  if (ipReason) return { ok: false, reason: ipReason };

  if (!isIpLiteral(host)) {
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host === 'metadata.google.internal'
    ) {
      return { ok: false, reason: 'internal hostname' };
    }
    if (!host.includes('.')) {
      return { ok: false, reason: 'bare hostname (no public domain)' };
    }
  }

  const allowlist = (env.REMEDY_IMAGE_FETCH_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length > 0) {
    const matches = allowlist.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
    if (!matches) return { ok: false, reason: 'host not in REMEDY_IMAGE_FETCH_ALLOWLIST' };
  }

  return { ok: true };
}

/** Throwing form for call sites that should abort on a blocked URL. */
export function assertImageFetchAllowed(rawUrl: string, env: NodeJS.ProcessEnv = process.env): void {
  const result = isImageFetchAllowed(rawUrl, env);
  if (!result.ok) throw new SsrfBlockedError(rawUrl, result.reason);
}

function isIpLiteral(host: string): boolean { return isIP(host) !== 0; }

export function blockedIpReason(host: string): string | null {
  try {
    // URL normalizes alternate IPv4 notation first; process() normalizes mapped IPv6.
    const address = ipaddr.process(host);
    return address.range() === 'unicast' ? null : 'non-public IP destination';
  } catch { return isIpLiteral(host) || host.includes(':') ? 'invalid IP destination' : null; }
}
