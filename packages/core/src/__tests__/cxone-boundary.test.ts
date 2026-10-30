import { describe, expect, it } from 'vitest';
import {
  assertWriteAllowed,
  isCxoneIntegrationEnabled,
  validateCxoneConfiguration,
} from '../guardrails.js';
import { InvalidCxoneConfigurationError, normalizePageInput } from '../client.js';

const validEnv = {
  CXONE_INTEGRATION_ENABLED: 'true',
  SERVER_DOMAIN: 'dev.libretexts.org',
  SERVER_KEY: 'key',
  SERVER_SECRET: 'secret',
  SERVER_USER: 'user',
  REMEDY_WRITE_ALLOWLIST: '^Sandboxes/johnnyphung(?:/|$)',
};

describe('CXone boundary', () => {
  it('is disabled by default and accepts only explicit true values', () => {
    expect(isCxoneIntegrationEnabled({})).toBe(false);
    expect(isCxoneIntegrationEnabled({ CXONE_INTEGRATION_ENABLED: 'false' })).toBe(false);
    expect(isCxoneIntegrationEnabled({ CXONE_INTEGRATION_ENABLED: 'true' })).toBe(true);
  });

  it('accepts only the exact owner root and descendants', () => {
    expect(() => assertWriteAllowed({
      hostname: 'dev.libretexts.org',
      path: 'Sandboxes/johnnyphung',
    }, validEnv)).not.toThrow();
    expect(() => assertWriteAllowed({
      hostname: 'dev.libretexts.org',
      path: '/Sandboxes/johnnyphung/Book/Page',
    }, validEnv)).not.toThrow();
  });

  it('reports stable configuration error codes without secret values', () => {
    const state = validateCxoneConfiguration({
      ...validEnv,
      SERVER_DOMAIN: 'evil.example',
      SERVER_SECRET: '',
    });
    expect(state.valid).toBe(false);
    expect(state.errors).toEqual(expect.arrayContaining([
      'invalid_allowed_host',
      'invalid_server_domain',
      'missing_server_secret',
    ]));
    expect(JSON.stringify(state)).not.toContain('TOP-SECRET-VALUE');
  });

  it('reports an invalid encoded root without throwing from health validation', () => {
    const state = validateCxoneConfiguration({
      ...validEnv,
      CXONE_ALLOWED_ROOT: 'Sandboxes/johnnyphung/%ZZ',
    });
    expect(state.valid).toBe(false);
    expect(state.errors).toContain('invalid_allowed_root');
  });

  it.each([
    'http://dev.libretexts.org/Sandboxes/johnnyphung/Page',
    'https://dev.libretexts.org:443/Sandboxes/johnnyphung/Page',
    'https://user@dev.libretexts.org/Sandboxes/johnnyphung/Page',
    'https://chem.libretexts.org/Sandboxes/johnnyphung/Page',
    'https://dev.libretexts.org.evil.test/Sandboxes/johnnyphung/Page',
  ])('rejects a non-canonical full URL: %s', (url) => {
    expect(() => normalizePageInput(url, validEnv)).toThrow(InvalidCxoneConfigurationError);
  });

  it('normalizes a canonical full URL to a path', () => {
    expect(normalizePageInput(
      'https://dev.libretexts.org/Sandboxes/johnnyphung/Book%2FPage',
      validEnv,
    )).toBe('Sandboxes/johnnyphung/Book/Page');
  });

  it('preserves ordinary colon-bearing page paths and canonical URL paths', () => {
    expect(normalizePageInput('Chapter:Introduction', validEnv)).toBe('Chapter:Introduction');
    expect(normalizePageInput('Sandboxes/johnnyphung/Chapter:Introduction', validEnv)).toBe('Sandboxes/johnnyphung/Chapter:Introduction');
    expect(normalizePageInput('https://dev.libretexts.org/Sandboxes/johnnyphung/Chapter:Introduction', validEnv)).toBe('Sandboxes/johnnyphung/Chapter:Introduction');
  });
});
