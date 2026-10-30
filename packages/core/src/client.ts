import 'dotenv/config';
import Expert from '@libretexts/cxone-expert-node';
import type { PageRef } from './types.js';
import { cxoneRead } from './cxone-read.js';
import {
  CXONE_ALLOWED_HOST,
  isCxoneIntegrationEnabled,
  maskToken,
  validateCxoneConfiguration,
} from './guardrails.js';

export interface ClientEnv {
  SERVER_DOMAIN?: string;
  SERVER_KEY?: string;
  SERVER_SECRET?: string;
  SERVER_USER?: string;
}

export class MissingEnvError extends Error {
  constructor(keys: string[]) {
    super(`Missing required environment variables: ${keys.join(', ')}. See .env.example.`);
    this.name = 'MissingEnvError';
  }
}

export class CxoneIntegrationDisabledError extends Error {
  constructor() {
    super('CXone integration is disabled.');
    this.name = 'CxoneIntegrationDisabledError';
  }
}

export class InvalidCxoneConfigurationError extends Error {
  constructor() {
    super('CXone integration configuration is invalid.');
    this.name = 'InvalidCxoneConfigurationError';
  }
}

/** A rejected caller locator, distinct from invalid service configuration. */
export class InvalidPageLocatorError extends InvalidCxoneConfigurationError {
  readonly status = 400;
  readonly body = { error: 'invalid_request' };
}

export function createExpertClient(env: NodeJS.ProcessEnv = process.env): Expert {
  if (!isCxoneIntegrationEnabled(env)) throw new CxoneIntegrationDisabledError();
  const required: Array<keyof ClientEnv> = ['SERVER_DOMAIN', 'SERVER_KEY', 'SERVER_SECRET', 'SERVER_USER'];
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) throw new MissingEnvError(missing);
  if (!validateCxoneConfiguration(env).valid) throw new InvalidCxoneConfigurationError();

  return new Expert({
    tld: env.SERVER_DOMAIN!.trim().toLowerCase(),
    auth: {
      type: 'server',
      params: {
        key: env.SERVER_KEY!,
        secret: env.SERVER_SECRET!,
        user: env.SERVER_USER!,
      },
    },
    // Gate the third-party SDK's debug logging behind a dedicated flag. The
    // generic DEBUG switch must not enable SDK request logging, which can print
    // the signed X-Deki-Token credential to the console.
    debug: env.REMEDY_SDK_DEBUG === '1' || env.REMEDY_SDK_DEBUG === 'true',
  });
}

export function describeClient(env: NodeJS.ProcessEnv = process.env): string {
  return [
    `host: ${env.SERVER_DOMAIN ?? '<unset>'}`,
    `user: ${env.SERVER_USER ?? '<unset>'}`,
    `key:  ${maskToken(env.SERVER_KEY)}`,
  ].join('\n');
}

/**
 * Accept either a numeric id, a path like "Sandboxes/johnnyphung/chem51/...",
 * or a full URL and return the normalized identifier the SDK accepts.
 *
 * The SDK's parsePageId handles number-or-path and takes care of double-URL-encoding.
 */
export function normalizePageInput(
  input: string | number,
  env: NodeJS.ProcessEnv = process.env,
): string | number {
  if (typeof input === 'number') return input;
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const httpUrl = /^https?:\/\//i.test(trimmed);
  if (!httpUrl && (/^[a-z][a-z0-9+.-]*:\//i.test(trimmed) || /^https?:/i.test(trimmed))) {
    throw new InvalidPageLocatorError();
  }
  if (httpUrl) {
    let url: URL;
    try { url = new URL(trimmed); } catch { throw new InvalidPageLocatorError(); }
    if (
      url.protocol !== 'https:' ||
      /^https:\/\/[^/]*:\d+(?:\/|$)/i.test(trimmed) ||
      url.hostname.toLowerCase().replace(/\.$/, '') !== CXONE_ALLOWED_HOST ||
      url.port ||
      url.username ||
      url.password
    ) {
      throw new InvalidPageLocatorError();
    }
    if ((env.SERVER_DOMAIN ?? '').trim().toLowerCase() !== CXONE_ALLOWED_HOST) throw new InvalidCxoneConfigurationError();
    // Strip leading slash; SDK wants the raw path.
    try { return decodeURIComponent(url.pathname.replace(/^\/+/, '')); }
    catch { throw new InvalidPageLocatorError(); }
  }
  return trimmed.replace(/^\/+/, '');
}

export async function resolvePageRef(
  expert: Expert,
  input: string | number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PageRef> {
  const id = normalizePageInput(input, env);
  const info = await cxoneRead(() => expert.pages.getPageInfo(id as number));
  // The SDK returns slightly different shapes depending on accept-format; defensively pull id/path.
  // biome-ignore lint: SDK response shape is loosely typed.
  const anyInfo = info as any;
  const pageId = Number(anyInfo?.['@id'] ?? anyInfo?.id ?? (typeof id === 'number' ? id : NaN));
  const path = String(anyInfo?.path?.['#text'] ?? anyInfo?.path ?? (typeof id === 'string' ? id : ''));
  const title = anyInfo?.['title']?.['#text'] ?? anyInfo?.title;
  return {
    id: pageId,
    path,
    title,
    hostname: (env.SERVER_DOMAIN ?? 'unknown').trim().toLowerCase(),
  };
}
