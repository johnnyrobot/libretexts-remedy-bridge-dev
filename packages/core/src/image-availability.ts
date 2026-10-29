import type { Finding, PageRef } from './types.js';
import { fetchBoundedImage, ImageFetchError, type ImageFetchOptions } from './image-fetch.js';

export interface MarkUnavailableImageFixesOptions {
  env?: NodeJS.ProcessEnv;
  /** DNS/transport seams shared with the AI byte fetch. */
  imageFetch?: ImageFetchOptions;
  signal?: AbortSignal;
  timeoutMs?: number;
  concurrency?: number;
}

interface ImageAvailabilityOk {
  ok: true;
  url: string;
  status: number;
  mimeType?: string;
}

interface ImageAvailabilityUnavailable {
  ok: false;
  url: string;
  status?: number;
  mimeType?: string;
  reason: 'http-status' | 'non-image-content' | 'timeout' | 'fetch-error' | 'unsupported-url' | 'blocked-destination' | 'too-large' | 'cancelled' | 'unsupported';
  message: string;
}

type ImageAvailability = ImageAvailabilityOk | ImageAvailabilityUnavailable;

const IMAGE_FIX_RULE_IDS = new Set(['img-alt', 'chart-alt']);
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CONCURRENCY = 4;
const IMAGE_FETCH_HEADERS = {
  Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  'User-Agent': 'Mozilla/5.0 LibreTexts-Remedy/1.0',
};

export async function markUnavailableImageFixes(
  findings: Finding[],
  page: Pick<PageRef, 'hostname' | 'path'>,
  opts: MarkUnavailableImageFixesOptions = {},
): Promise<Finding[]> {
  if (opts.env?.REMEDY_IMAGE_PREFLIGHT === 'false') return findings;

  const imageFetch = { ...opts.imageFetch, env: opts.env ?? opts.imageFetch?.env, signal: opts.signal ?? opts.imageFetch?.signal };
  const timeoutMs = opts.timeoutMs ?? numberFromEnv(opts.env, 'REMEDY_IMAGE_PREFLIGHT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const concurrency = opts.concurrency ?? numberFromEnv(opts.env, 'REMEDY_IMAGE_PREFLIGHT_CONCURRENCY', DEFAULT_CONCURRENCY);
  const candidates = findings
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => isImageFixFinding(finding));
  if (candidates.length === 0) return findings;

  const nextFindings = findings.slice();
  const cache = new Map<string, Promise<ImageAvailability>>();
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, candidates.length));

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < candidates.length) {
      const current = candidates[cursor++];
      const src = String(current.finding.data?.src ?? '').trim();
      const url = absoluteImageUrl(src, page.hostname);
      const availability = await cachedProbe(cache, url, page, imageFetch, timeoutMs);
      if (!availability.ok) {
        nextFindings[current.index] = blockedFinding(current.finding, availability);
      }
    }
  }));

  return nextFindings;
}

function isImageFixFinding(finding: Finding): boolean {
  if (!finding.fixable || !IMAGE_FIX_RULE_IDS.has(finding.ruleId)) return false;
  const src = typeof finding.data?.src === 'string' ? finding.data.src.trim() : '';
  if (!src || src === '(no src)') return false;
  return true;
}

function cachedProbe(
  cache: Map<string, Promise<ImageAvailability>>,
  url: string,
  page: Pick<PageRef, 'hostname' | 'path'>,
  imageFetch: ImageFetchOptions,
  timeoutMs: number,
): Promise<ImageAvailability> {
  const existing = cache.get(url);
  if (existing) return existing;
  const probe = probeImageUrl(url, page, imageFetch, timeoutMs);
  cache.set(url, probe);
  return probe;
}

async function probeImageUrl(
  url: string,
  page: Pick<PageRef, 'hostname' | 'path'>,
  imageFetch: ImageFetchOptions,
  timeoutMs: number,
): Promise<ImageAvailability> {
  try {
    const response = await fetchBoundedImage(url, { ...imageFetch, probe: true, timeoutMs, headers: probeHeaders(page) });
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
    return classifyResponse(url, { status: response.status, ok: response.status >= 200 && response.status < 300, headers });
  } catch (error) {
    const reason = error instanceof ImageFetchError ? error.reason : 'fetch-error';
    return unavailable(url, reason === 'transport' ? 'fetch-error' : reason, `Image requires manual review: ${reason}.`);
  }
}

function classifyResponse(url: string, response: Pick<Response, 'status' | 'ok' | 'headers'>): ImageAvailability {
  const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || undefined;
  if (!response.ok) {
    return unavailable(
      url,
      'http-status',
      `Image URL returned HTTP ${response.status}.`,
      response.status,
      mimeType,
    );
  }
  if (mimeType && !mimeType.startsWith('image/') && !isOctetStreamImage(url, mimeType)) {
    return unavailable(
      url,
      'non-image-content',
      `Image URL returned ${mimeType}, not image content.`,
      response.status,
      mimeType,
    );
  }
  if (!mimeType && !hasImageExtension(url)) {
    return unavailable(
      url,
      'non-image-content',
      'Image URL did not report image content.',
      response.status,
      mimeType,
    );
  }
  return { ok: true, url, status: response.status, mimeType };
}

function probeHeaders(page: Pick<PageRef, 'hostname' | 'path'>): Record<string, string> {
  return {
    ...IMAGE_FETCH_HEADERS,
    Referer: `https://${page.hostname}${page.path || '/'}`,
  };
}

function blockedFinding(finding: Finding, availability: ImageAvailabilityUnavailable): Finding {
  const blockedMessage = `Image URL is unavailable (${availability.status ? `HTTP ${availability.status}` : availability.reason}); alt text cannot be generated until the image source is fixed.`;
  return {
    ...finding,
    fixable: false,
    message: finding.message,
    data: {
      ...(finding.data ?? {}),
      fixBlockedReason: 'broken-image-url',
      fixBlockedMessage: blockedMessage,
      imageUrl: availability.url,
      imageStatus: availability.status,
      imageMimeType: availability.mimeType,
      imageAvailabilityReason: availability.reason,
      imageAvailabilityMessage: availability.message,
    },
  };
}

function unavailable(
  url: string,
  reason: ImageAvailabilityUnavailable['reason'],
  message: string,
  status?: number,
  mimeType?: string,
): ImageAvailabilityUnavailable {
  return { ok: false, url, reason, message, status, mimeType };
}

function absoluteImageUrl(src: string, hostname: string): string {
  if (/^(https?|data|blob):/i.test(src)) return src;
  if (src.startsWith('//')) return `https:${src}`;
  if (src.startsWith('/')) return `https://${hostname}${src}`;
  return `https://${hostname}/${src}`;
}

function hasImageExtension(url: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|avif)(?:[?#]|$)/i.test(url);
}

function isOctetStreamImage(url: string, mimeType: string): boolean {
  return mimeType === 'application/octet-stream' && hasImageExtension(url);
}

function numberFromEnv(env: NodeJS.ProcessEnv | undefined, key: string, fallback: number): number {
  const raw = Number(env?.[key] ?? process.env[key]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
