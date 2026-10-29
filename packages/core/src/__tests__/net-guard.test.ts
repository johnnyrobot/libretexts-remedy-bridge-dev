import { describe, expect, it } from 'vitest';
import { isImageFetchAllowed, assertImageFetchAllowed, SsrfBlockedError } from '../net-guard.js';

describe('net-guard SSRF allowlist', () => {
  it('allows legitimate public image hosts', () => {
    expect(isImageFetchAllowed('https://cdn.mathpix.com/cropped/x.jpg').ok).toBe(true);
    expect(isImageFetchAllowed('https://dev.libretexts.org/available.png').ok).toBe(true);
  });

  it('allows data: URLs (inline bytes, no network request)', () => {
    expect(isImageFetchAllowed('data:image/png;base64,iVBORw0KGgo=').ok).toBe(true);
  });

  it('blocks loopback, private, link-local and metadata targets', () => {
    for (const url of [
      'http://127.0.0.1/x.png',
      'http://localhost:5175/x.png',
      'http://10.0.0.5/x.png',
      'http://192.168.1.10/x.png',
      'http://172.16.5.4/x.png',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/x.png',
      'http://[fd00::1]/x.png',
      'http://metadata.google.internal/x',
    ]) {
      expect(isImageFetchAllowed(url).ok, url).toBe(false);
    }
  });

  it('blocks non-http(s) schemes and bare hostnames', () => {
    expect(isImageFetchAllowed('file:///etc/passwd').ok).toBe(false);
    expect(isImageFetchAllowed('ftp://example.com/x').ok).toBe(false);
    expect(isImageFetchAllowed('http://intranet/x.png').ok).toBe(false);
  });

  it('enforces a positive allowlist when REMEDY_IMAGE_FETCH_ALLOWLIST is set', () => {
    const env = { REMEDY_IMAGE_FETCH_ALLOWLIST: 'libretexts.org' } as NodeJS.ProcessEnv;
    expect(isImageFetchAllowed('https://dev.libretexts.org/x.png', env).ok).toBe(true);
    expect(isImageFetchAllowed('https://cdn.mathpix.com/x.jpg', env).ok).toBe(false);
  });

  it('assert form throws SsrfBlockedError', () => {
    expect(() => assertImageFetchAllowed('http://169.254.169.254/')).toThrow(SsrfBlockedError);
    expect(() => assertImageFetchAllowed('https://dev.libretexts.org/x.png')).not.toThrow();
  });
});

it.each(['http://[::ffff:7f00:1]/x', 'http://[::ffff:a00:1]/x', 'http://[::ffff:a9fe:a9fe]/x', 'http://2130706433/x', 'http://0x7f000001/x', 'http://[ff02::1]/x'])('blocks canonical private/mapped/non-unicast destination %s', url => {
  expect(isImageFetchAllowed(url).ok).toBe(false);
});
