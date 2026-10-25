import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const CXONE_ALLOWED_HOST = 'dev.libretexts.org';
export const CXONE_ALLOWED_ROOT = 'Sandboxes/johnnyphung';
export const CXONE_CANONICAL_ALLOWLIST = '^Sandboxes/johnnyphung(?:/|$)';

export class WriteNotAllowedError extends Error {
  constructor(_hostname: string, _path: string) {
    super(`Write refused: target is outside the configured CXone owner sandbox.`);
    this.name = 'WriteNotAllowedError';
  }
}

export interface CxoneConfigurationState {
  valid: boolean;
  errors: string[];
  host: string;
  root: string;
}

export function isCxoneIntegrationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env.CXONE_INTEGRATION_ENABLED ?? '').trim());
}

export function validateCxoneConfiguration(env: NodeJS.ProcessEnv = process.env): CxoneConfigurationState {
  const host = (env.CXONE_ALLOWED_HOST ?? env.SERVER_DOMAIN ?? CXONE_ALLOWED_HOST).trim().toLowerCase();
  const errors: string[] = [];
  let root = '';
  try {
    root = normalizeSandboxPath(env.CXONE_ALLOWED_ROOT ?? CXONE_ALLOWED_ROOT);
  } catch {
    errors.push('invalid_allowed_root');
  }
  if (host !== CXONE_ALLOWED_HOST) errors.push('invalid_allowed_host');
  if (root && root !== CXONE_ALLOWED_ROOT) errors.push('invalid_allowed_root');
  if ((env.SERVER_DOMAIN ?? '').trim().toLowerCase() !== CXONE_ALLOWED_HOST) {
    errors.push('invalid_server_domain');
  }
  const legacyAllowlist = env.REMEDY_WRITE_ALLOWLIST?.trim();
  if (legacyAllowlist && legacyAllowlist !== CXONE_CANONICAL_ALLOWLIST) {
    errors.push('invalid_legacy_allowlist');
  }
  for (const key of ['SERVER_KEY', 'SERVER_SECRET', 'SERVER_USER'] as const) {
    if (!(env[key] ?? '').trim()) errors.push(`missing_${key.toLowerCase()}`);
  }
  return { valid: errors.length === 0, errors, host, root };
}

export function normalizeSandboxPath(path: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path.trim());
  } catch {
    throw new WriteNotAllowedError('', '');
  }
  const normalized = decoded.replace(/^\/+/, '').replace(/\/+$/, '');
  if (
    !normalized ||
    normalized.includes('\\') ||
    normalized.includes('\0') ||
    normalized.split('/').some((part) => part === '.' || part === '..' || part === '')
  ) {
    throw new WriteNotAllowedError('', normalized);
  }
  return normalized;
}

export function assertWriteAllowed(
  page: { hostname: string; path: string },
  env: NodeJS.ProcessEnv = process.env,
): void {
  const config = validateCxoneConfiguration(env);
  const hostname = page.hostname.trim().toLowerCase().replace(/\.$/, '');
  const normalized = normalizeSandboxPath(page.path);
  if (
    !config.valid ||
    hostname !== CXONE_ALLOWED_HOST ||
    (normalized !== CXONE_ALLOWED_ROOT && !normalized.startsWith(`${CXONE_ALLOWED_ROOT}/`))
  ) {
    throw new WriteNotAllowedError(hostname, normalized);
  }
}

export function maskToken(token: string | undefined): string {
  if (!token) return '<unset>';
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

export function hashContent(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

export interface AuditEntry {
  ts: string;
  page: { id: number; path: string; hostname: string };
  rules: string[];
  mode: 'preview' | 'apply' | 'revert';
  beforeHash: string;
  afterHash: string;
  operator: string;
  /** Application reviewer: caller-asserted, unverified, never used for authorization; separate from operator. */
  requestedBy?: string;
  revisionSummary?: string;
  /** Path on disk to the HTML snapshot of the before-state (if saved). */
  snapshotPath?: string;
  /** CXone revision ID returned by postPageContents, when available. */
  cxoneRevisionId?: string | number;
  /** If this entry is a revert, points back to the audit entry it's undoing. */
  revertedFrom?: string;
  /** True when the Patch API wrote only changed bytes; false = full-rewrite fallback. */
  bytePreserved?: boolean;
  /** Present when bytePreserved=false. */
  fallbackReason?: 'unsupported-mutation' | 'no-source-location' | 'verification-mismatch' | 'parse-error';
  /** Count of splices applied in a successful byte-preserve. */
  splicesApplied?: number;
}

export async function appendAudit(
  entry: AuditEntry,
  logPath: string = process.env.REMEDY_AUDIT_LOG ?? '.remedy/audit.log',
): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, JSON.stringify(entry) + '\n', 'utf8');
}

export function operatorFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.USER ?? env.LOGNAME ?? env.USERNAME ?? 'unknown';
}

/* -------------------------------------------------------------------------- *
 * Snapshots — pre-write on-disk copies of the page HTML so we can always
 * revert, even if CXone revision retention is limited.
 * -------------------------------------------------------------------------- */

export interface SnapshotMeta {
  /** ISO 8601 write timestamp. */
  ts: string;
  /** CXone page id. */
  pageId: number;
  /** Full page path (e.g. "Sandboxes/johnnyphung/…"). */
  pagePath: string;
  /** Hostname the page was fetched from (e.g. "dev.libretexts.org"). */
  hostname: string;
  /** Operator who initiated the write. */
  operator: string;
  /** Application reviewer: caller-asserted, unverified, never used for authorization; separate from operator. */
  requestedBy?: string;
  /** SHA-256 hash (first 16 hex chars) of the HTML. */
  hash: string;
  /** Rule ids that will be applied after this snapshot. */
  rules: string[];
  /** The CLI revision summary about to be written. */
  revisionSummary?: string;
  /** The tier or mode that produced the snapshot. */
  source?: 'fix' | 'pipeline' | 'revert';
  /** Size of the HTML in bytes. */
  bytes: number;
}

export interface SnapshotEntry {
  htmlPath: string;
  metaPath: string;
  meta: SnapshotMeta;
}

function snapshotRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.REMEDY_SNAPSHOT_DIR ?? '.remedy/snapshots';
}

export function snapshotDir(pageId: number, env: NodeJS.ProcessEnv = process.env): string {
  return join(snapshotRoot(env), String(pageId));
}

/**
 * Write a pre-apply snapshot to disk. Always returns the absolute path so
 * callers can record it in the audit log.
 *
 * Files written:
 *   {REMEDY_SNAPSHOT_DIR}/{pageId}/{YYYYMMDDTHHMMSSZ}_{hash}.html
 *   {REMEDY_SNAPSHOT_DIR}/{pageId}/{YYYYMMDDTHHMMSSZ}_{hash}.json
 *
 * The .html is the raw page body *before* the planned write. The .json has
 * the metadata needed for the `revert` command to identify and restore it.
 */
export async function saveSnapshot(
  html: string,
  meta: Omit<SnapshotMeta, 'ts' | 'hash' | 'bytes'>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SnapshotEntry> {
  const ts = new Date().toISOString();
  const hash = hashContent(html);
  const full: SnapshotMeta = { ...meta, ts, hash, bytes: Buffer.byteLength(html, 'utf8') };
  const stamp = ts.replace(/[:.]/g, '-');
  const dir = snapshotDir(meta.pageId, env);
  const base = `${stamp}_${hash}`;
  const htmlPath = join(dir, `${base}.html`);
  const metaPath = join(dir, `${base}.json`);
  await mkdir(dir, { recursive: true });
  await writeFile(htmlPath, html, 'utf8');
  await writeFile(metaPath, JSON.stringify(full, null, 2), 'utf8');
  return { htmlPath, metaPath, meta: full };
}

/** List snapshots for a page, newest first. */
export async function listSnapshots(
  pageId: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SnapshotEntry[]> {
  const dir = snapshotDir(pageId, env);
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const metas = entries.filter((f) => f.endsWith('.json')).sort().reverse();
  const out: SnapshotEntry[] = [];
  for (const f of metas) {
    const metaPath = join(dir, f);
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf8')) as SnapshotMeta;
      out.push({ metaPath, htmlPath: metaPath.replace(/\.json$/, '.html'), meta });
    } catch {
      // ignore malformed
    }
  }
  return out;
}

/** Read a snapshot's HTML + metadata, resolved by timestamp or by explicit path. */
export async function readSnapshot(
  entryOrPath: SnapshotEntry | string,
): Promise<{ html: string; meta: SnapshotMeta }> {
  const metaPath = typeof entryOrPath === 'string' ? entryOrPath : entryOrPath.metaPath;
  const htmlPath = metaPath.replace(/\.json$/, '.html');
  const [html, metaJson] = await Promise.all([readFile(htmlPath, 'utf8'), readFile(metaPath, 'utf8')]);
  return { html, meta: JSON.parse(metaJson) as SnapshotMeta };
}

/**
 * Extract a CXone revision identifier out of the loosely-typed postPageContents
 * response. The SDK returns an XML-derived JSON shape; revision lives under a
 * few different keys depending on content-type. Returns undefined if not found.
 */
export function extractRevisionId(pageResponse: unknown): string | number | undefined {
  if (!pageResponse || typeof pageResponse !== 'object') return undefined;
  const r = pageResponse as Record<string, unknown>;
  const page = (r.page ?? r) as Record<string, unknown> | undefined;
  if (!page) return undefined;
  const rev = (page as Record<string, unknown>)['@revision'] ?? (page as Record<string, unknown>)['revision'];
  if (typeof rev === 'string' || typeof rev === 'number') return rev;
  if (rev && typeof rev === 'object' && '#text' in (rev as Record<string, unknown>)) {
    const t = (rev as Record<string, unknown>)['#text'];
    if (typeof t === 'string' || typeof t === 'number') return t;
  }
  return undefined;
}
