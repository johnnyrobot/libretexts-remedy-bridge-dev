import { mkdtemp, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { writePageRevision } from '../write-page.js';

async function fixture(id = 8765) {
  const root = await mkdtemp(join(tmpdir(), 'remedy-safety-'));
  const page = { id, path: 'Sandboxes/johnnyphung/Safety', hostname: 'dev.libretexts.org' };
  const env = { CXONE_INTEGRATION_ENABLED: 'true', SERVER_DOMAIN: page.hostname, SERVER_KEY: 'fake', SERVER_SECRET: 'fake', SERVER_USER: 'fake', REMEDY_SNAPSHOT_DIR: join(root, 'snapshots'), REMEDY_AUDIT_LOG: join(root, 'audit.log') };
  let html = '<p>before</p>';
  const post = vi.fn(async (_id: number, content: string) => { html = content; return { page: { '@revision': '7' } }; });
  const expert = { pages: { getPageInfo: vi.fn(async () => ({ '@id': id, path: page.path })), getPageContents: vi.fn(async () => ({ body: html })), postPageContents: post } } as any;
  const options = { expert, pageInput: id, page, beforeHtml: html, afterHtml: '<p>reviewed</p>', rules: [], revisionSummary: 'test', source: 'fix' as const, env };
  return { root, page, env, expert, post, options };
}

describe('reviewed write safety', () => {
  it('rejects a canonical target outside the asserted sandbox', async () => {
    const f = await fixture();
    f.expert.pages.getPageInfo.mockResolvedValue({ '@id': f.page.id, path: 'Bookshelves/Outside' });
    await expect(writePageRevision(f.options)).rejects.toMatchObject({ reason: 'target_mismatch' });
    expect(f.post).not.toHaveBeenCalled();
  });
  it('writes exactly reviewed bytes and serializes distinct simultaneous attempts', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([writePageRevision(f.options), writePageRevision({ ...f.options, expert: { pages: { ...f.expert.pages } } })]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(f.post).toHaveBeenCalledExactlyOnceWith(f.page.id, '<p>reviewed</p>', expect.any(Object));
    expect((results[1] as PromiseRejectedResult).reason.message).toContain('Page changed');
  });
  it('never reserializes a reviewed output before writing it', async () => {
    const f = await fixture();
    const beforeHtml = "<p class='note'>before<br /></p>";
    const afterHtml = '<p class="note">reviewed<br></p>';
    f.expert.pages.getPageContents.mockResolvedValue({ body: beforeHtml });
    await writePageRevision({ ...f.options, beforeHtml, afterHtml });
    expect(f.post).toHaveBeenCalledExactlyOnceWith(f.page.id, afterHtml, expect.any(Object));
  });
  it('reports remote success when local audit append fails', async () => {
    const f = await fixture();
    await mkdir(f.env.REMEDY_AUDIT_LOG);
    const result = await writePageRevision(f.options);
    expect(result).toMatchObject({ written: true, writeOutcome: 'succeeded', auditRecorded: false, auditError: 'audit_append_failed', cxoneRevisionId: '7' });
    expect(f.post).toHaveBeenCalledTimes(1);
  });
  it('quarantines an uncertain remote write across new attempts and clients', async () => {
    const f = await fixture(8766);
    f.post.mockRejectedValueOnce(new Error('response lost'));
    await expect(writePageRevision(f.options)).rejects.toMatchObject({ name: 'WriteOutcomeError', outcome: 'unknown', retrySafe: false });
    await expect(writePageRevision({ ...f.options, expert: { pages: { ...f.expert.pages } } })).rejects.toMatchObject({ outcome: 'unknown' });
    expect(f.post).toHaveBeenCalledTimes(1);
  });

  it('rejects an independent page input before snapshot or mutation', async () => {
    const f = await fixture();
    f.expert.pages.getPageInfo.mockImplementation(async (id: number) => ({ '@id': id, path: f.page.path }));
    await expect(writePageRevision({ ...f.options, pageInput: 9999 })).rejects.toThrow('target');
    expect(f.post).not.toHaveBeenCalled();
    await expect(readdir(f.env.REMEDY_SNAPSHOT_DIR)).rejects.toThrow();
  });
});
