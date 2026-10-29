import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

const cxone = vi.hoisted(() => ({ html: '<p><strong>Chapter</strong></p>', writes: [] as string[], writtenIds: [] as number[], aliasId: 1, gate: undefined as Promise<void> | undefined, loseResponse: false, onResolve: undefined as (() => void) | undefined }));
vi.mock('dotenv/config', () => ({}));
vi.mock('dotenv', () => ({ config: () => ({}) }));
// Only the external CXone SDK is fake. HTTP handlers, preview generation,
// source checks, guarded writer, snapshots and audit all execute real code.
vi.mock('@libretexts/cxone-expert-node', () => ({ default: class {
  pages = {
    getPageInfo: async (input: string | number) => {
      cxone.onResolve?.();
      await cxone.gate;
      const id = input === 'review-alias' ? cxone.aliasId : input === 2 || String(input).endsWith('/Other') ? 2 : 1;
      return { '@id': id, path: `Sandboxes/johnnyphung/${id === 2 ? 'Other' : 'Page'}` };
    },
    getPageContents: async () => ({ body: cxone.html }),
    postPageContents: async (_id: number, html: string) => {
      cxone.writtenIds.push(_id); cxone.writes.push(html); cxone.html = html;
      if (cxone.loseResponse) throw new Error('synthetic response lost');
      return { page: { '@revision': '7' } };
    },
  };
} }));
let server: Server, base: string;
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-http-'));
  vi.stubEnv('CXONE_INTEGRATION_ENABLED', 'true');
  vi.stubEnv('SERVER_DOMAIN', 'dev.libretexts.org');
  vi.stubEnv('SERVER_KEY', 'fake-key'); vi.stubEnv('SERVER_SECRET', 'fake-secret'); vi.stubEnv('SERVER_USER', 'fake-user');
  vi.stubEnv('REMEDY_WRITE_ALLOWLIST', '^Sandboxes/johnnyphung(?:/|$)');
  vi.stubEnv('REMEDY_SNAPSHOT_DIR', join(dir, 'snapshots')); vi.stubEnv('REMEDY_AUDIT_LOG', join(dir, 'audit.log'));
  vi.stubEnv('REMEDY_LLM_PROVIDER', 'ollama-local');
  server = (await import('../../../conductor-panel/server/server.js')).server;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); vi.unstubAllEnvs(); });
beforeEach(() => { cxone.html = '<p><strong>Chapter</strong></p>'; cxone.writes.length = 0; cxone.writtenIds.length = 0; cxone.aliasId = 1; cxone.gate = undefined; cxone.loseResponse = false; cxone.onResolve = undefined; });
async function post(path: string, body: unknown, signal?: AbortSignal) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  return { status: r.status, body: await r.json() };
}
it('requires a cached reviewed output on the tokenless compatibility path', async () => {
  const r = await post('/v1/cxone/page/apply-fix', { page_id: 1, preview_hash: 'source-only', finding_ids: [] });
  expect(r.status).toBe(409); expect(r.body.error).toBe('preview_required'); expect(cxone.writes).toEqual([]);
});

it('claims a targeted preview before awaiting target resolution', async () => {
  const p = await post('/v1/cxone/page/preview-fix', { page_id: 1 });
  expect(p.status).toBe(200);
  expect(p.body.after_html).not.toBe(p.body.before_html);
  let release!: () => void;
  cxone.gate = new Promise<void>(resolve => { release = resolve; });
  const request = { page_id: 1, preview_token: p.body.preview_token, preview_hash: p.body.preview_hash };
  let entered!: () => void;
  const resolving = new Promise<void>(resolve => { entered = resolve; });
  cxone.onResolve = entered;
  const a = post('/v1/cxone/page/apply-fix', request);
  await resolving;
  try {
    // A replay must reject while the first request is still awaiting CXone.
    expect((await post('/v1/cxone/page/apply-fix', request, AbortSignal.timeout(1000))).status).toBe(409);
  } finally { release(); }
  expect((await a).status).toBe(200);
  expect(cxone.writes).toEqual([p.body.after_html]);
});

it('binds panel apply to the reviewed page, tier and exact output', async () => {
  const p = await post('/api/preview', { page: '1', tier: 1 });
  expect(p.status).toBe(200);
  expect(p.body.finalHtml).not.toBe(p.body.beforeHtml);
  const changed = await post('/api/apply', { page: '1', tier: 2, preview_token: p.body.previewToken, preview_hash: p.body.previewHash });
  expect(changed.status).toBe(409); expect(cxone.writes).toEqual([]);
  const p2 = await post('/api/preview', { page: '1', tier: 1 });
  const mismatch = await post('/api/apply', { page: '2', tier: 1, preview_token: p2.body.previewToken, preview_hash: p2.body.previewHash });
  expect(mismatch.status).toBe(409); expect(cxone.writes).toEqual([]);
  const p3 = await post('/api/preview', { page: '1', tier: 1 });
  const applied = await post('/api/apply', { page: '1', tier: 1, preview_token: p3.body.previewToken, preview_hash: p3.body.previewHash });
  expect(applied.status).toBe(200); expect(applied.body.applied).toBe(true);
  expect(cxone.writes).toEqual([p3.body.finalHtml]);
});


it('serializes distinct preview tokens and rejects the stale second source', async () => {
  const a = await post('/v1/cxone/page/preview-fix', { page_id: 1 });
  const b = await post('/v1/cxone/page/preview-fix', { page_id: 1 });
  const results = await Promise.all([a, b].map(p => post('/v1/cxone/page/apply-fix', {
    page_id: 1, preview_token: p.body.preview_token, preview_hash: p.body.preview_hash,
  })));
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  expect(cxone.writes).toEqual([a.body.after_html]);
});

it('claims restore previews before awaiting resolution and restores exact reviewed bytes', async () => {
  const { saveSnapshot } = await import('../guardrails.js');
  const snapshot = await saveSnapshot('<p>Restored</p>', { pageId: 1, pagePath: 'Sandboxes/johnnyphung/Page', hostname: 'dev.libretexts.org', operator: 'fake', rules: [], source: 'fix' }, process.env);
  const p = await post('/v1/cxone/page/restore-preview', { page_id: 1, snapshot_timestamp: snapshot.meta.ts });
  expect(p.status).toBe(200);
  let release!: () => void;
  cxone.gate = new Promise<void>(resolve => { release = resolve; });
  const request = { page_id: 1, preview_token: p.body.preview_token, preview_hash: p.body.preview_hash };
  let entered!: () => void;
  const resolving = new Promise<void>(resolve => { entered = resolve; });
  cxone.onResolve = entered;
  const a = post('/v1/cxone/page/restore', request);
  await resolving;
  try {
    expect((await post('/v1/cxone/page/restore', request, AbortSignal.timeout(1000))).status).toBe(409);
  } finally { release(); }
  expect((await a).status).toBe(200);
  expect(cxone.writes).toEqual([p.body.after_html]);
});

it('consumes preview after a known write even when audit recording fails', async () => {
  const previous = process.env.REMEDY_AUDIT_LOG!;
  vi.stubEnv('REMEDY_AUDIT_LOG', process.env.REMEDY_SNAPSHOT_DIR!);
  try {
    const p = await post('/v1/cxone/page/preview-fix', { page_id: 1 });
    const request = { page_id: 1, preview_token: p.body.preview_token, preview_hash: p.body.preview_hash };
    const r = await post('/v1/cxone/page/apply-fix', request);
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ applied: true, write_outcome: 'succeeded', audit_recorded: false });
    expect((await post('/v1/cxone/page/apply-fix', request)).status).toBe(409);
    expect(cxone.writes).toEqual([p.body.after_html]);
  } finally { vi.stubEnv('REMEDY_AUDIT_LOG', previous); }
});

it('invalidates panel confirmation when page or tier changes and sends the reviewed token', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: base });
  const originalFetch = globalThis.fetch;
  const auditPath = process.env.REMEDY_AUDIT_LOG!;
  vi.stubEnv('REMEDY_AUDIT_LOG', process.env.REMEDY_SNAPSHOT_DIR!);
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator); vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), base);
    if (url.origin !== base) throw new Error('External network forbidden in synthetic UI check');
    return originalFetch(url, init);
  });
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Simulate } = await import('react-dom/test-utils');
  const { ProductionTab } = await import('../../../conductor-panel/src/tabs/Production.js');
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await act(async () => root.render(createElement(ProductionTab)));
    const doc = dom.window.document, input = doc.querySelector('input')!, select = doc.querySelector('select')!;
    const button = (text: string) => [...doc.querySelectorAll('button')].find(b => b.textContent === text);
    async function preview() {
      await act(async () => { button('Preview fix')!.click(); });
      await vi.waitFor(() => expect(button('Apply (write revision)')).toBeDefined());
    }
    await act(async () => { Simulate.change(input, { target: { value: '1' } } as any); });
    await preview();
    await act(async () => { Simulate.change(select, { target: { value: '2' } } as any); });
    expect(button('Apply (write revision)')).toBeUndefined();
    await preview();
    await act(async () => { Simulate.change(input, { target: { value: '2' } } as any); });
    expect(button('Apply (write revision)')).toBeUndefined();
    await act(async () => { Simulate.change(input, { target: { value: '1' } } as any); });
    await preview();
    await act(async () => { button('Apply (write revision)')!.click(); });
    await vi.waitFor(() => expect(doc.body.textContent).toContain('Written.'));
    expect(cxone.writes).toHaveLength(1);
    expect(doc.body.textContent).toContain('Audit recording failed');
    expect(doc.body.textContent).toContain('Snapshot:');
    expect(doc.body.textContent).toContain('CXone revision: 7');
    expect(button('Apply (write revision)')).toBeUndefined();
  } finally { await act(async () => root.unmount()); dom.window.close(); vi.unstubAllGlobals(); vi.stubEnv('REMEDY_AUDIT_LOG', auditPath); }
});

it('CLI restore pins the reviewed ID and snapshot even if its locator is retargeted', async () => {
  const { program } = await import('../../../cli/src/index.js');
  const { saveSnapshot } = await import('../guardrails.js');
  for (const id of [1, 2]) {
    await saveSnapshot('<p>Identical restore content</p>', { pageId: id, pagePath: `Sandboxes/johnnyphung/${id === 1 ? 'Page' : 'Other'}`, hostname: 'dev.libretexts.org', operator: 'fake', rules: [], source: 'fix' }, process.env);
  }
  const log = vi.spyOn(console, 'log').mockImplementation((...args) => {
    if (args.join(' ').includes('byte delta:')) cxone.aliasId = 2;
  });
  try {
    await program.parseAsync(['node', 'remedy', 'revert', 'review-alias', '--i-have-confirmed']);
    expect(cxone.writtenIds).toEqual([1]);
    expect(cxone.writes).toEqual(['<p>Identical restore content</p>']);
  } finally { log.mockRestore(); }
});

it('CLI fix rejects a source change after showing the reviewed output', async () => {
  const { program } = await import('../../../cli/src/index.js');
  const dir = await mkdtemp(join(tmpdir(), 'bridge-cli-'));
  const log = vi.spyOn(console, 'log').mockImplementation((...args) => {
    if (args.join(' ').includes('wrote findings')) cxone.html = '<p><strong>Unreviewed replacement</strong></p>';
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('synthetic CLI exit'); });
  try {
    await expect(program.parseAsync(['node', 'remedy', 'fix', '1', '--apply', '--i-have-confirmed', '--out-dir', dir])).rejects.toThrow('synthetic CLI exit');
    expect(cxone.writes).toEqual([]);
    expect(error.mock.calls.flat().join(' ')).toContain('Page changed since preview');
  } finally { log.mockRestore(); error.mockRestore(); exit.mockRestore(); }
});

it('CLI pipeline writes the saved reviewed output and warns on audit failure', async () => {
  const { program } = await import('../../../cli/src/index.js');
  const { readFile, readdir } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'bridge-cli-'));
  const previous = process.env.REMEDY_AUDIT_LOG!;
  vi.stubEnv('REMEDY_AUDIT_LOG', process.env.REMEDY_SNAPSHOT_DIR!);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await program.parseAsync(['node', 'remedy', 'pipeline', '1', '--apply', '--i-have-confirmed', '--tier', '1', '--out-dir', dir]);
    const htmlFile = (await readdir(dir)).find(name => name.endsWith('.fixed.html'))!;
    expect(cxone.writes).toEqual([await readFile(join(dir, htmlFile), 'utf8')]);
    expect(error.mock.calls.flat().join(' ')).toContain('Write succeeded, but audit recording failed');
  } finally { log.mockRestore(); error.mockRestore(); vi.stubEnv('REMEDY_AUDIT_LOG', previous); }
});

it('quarantines an unknown write and rejects replay and new previews without another mutation', async () => {
  const p = await post('/v1/cxone/page/preview-fix', { page_id: 2 });
  cxone.loseResponse = true;
  const request = { page_id: 2, preview_token: p.body.preview_token, preview_hash: p.body.preview_hash };
  const r = await post('/v1/cxone/page/apply-fix', request);
  expect(r.status).toBe(409); expect(r.body).toMatchObject({ error: 'write_outcome_unknown', write_outcome: 'unknown', retry_safe: false });
  expect((await post('/v1/cxone/page/apply-fix', request)).status).toBe(409);
  // New source/preview cannot silently clear the process quarantine.
  cxone.html = '<p><strong>New source</strong></p>';
  const p2 = await post('/v1/cxone/page/preview-fix', { page_id: 2 });
  const r2 = await post('/v1/cxone/page/apply-fix', { page_id: 2, preview_token: p2.body.preview_token, preview_hash: p2.body.preview_hash });
  expect(r2.body.error).toBe('write_outcome_unknown'); expect(cxone.writes).toHaveLength(1);
});
