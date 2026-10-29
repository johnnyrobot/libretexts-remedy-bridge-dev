import { mkdtemp, mkdir, readFile, writeFile, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { saveSnapshot, readSnapshot } from '../guardrails.js';
import { listPageSnapshots, revertPage } from '../revert.js';
import { writePageTags } from '../write-tags.js';

it('restores the latest valid HTML pair from a real mixed HTML/tag history, with both explicit extensions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'snapshot-history-'));
  const page = { id: 813, path: 'Sandboxes/johnnyphung/History', hostname: 'dev.libretexts.org' };
  const env = { CXONE_INTEGRATION_ENABLED: 'true', SERVER_DOMAIN: page.hostname, SERVER_KEY: 'fake', SERVER_SECRET: 'fake', SERVER_USER: 'fake', REMEDY_SNAPSHOT_DIR: dir, REMEDY_AUDIT_LOG: join(dir, 'audit.log') };
  const post = vi.fn().mockResolvedValue({});
  const expert = { pages: { getPageInfo: async () => ({ '@id': page.id, path: page.path }), getPageContents: async () => ({ body: '<p>Current</p>' }), postPageContents: post, getPageTags: async () => ({ tag: [] }), putPageTags: async () => ({}) } } as any;
  const saved = await saveSnapshot('<p>Recover me</p>', { pageId: page.id, pagePath: page.path, hostname: page.hostname, operator: 'fake', rules: [], source: 'fix' }, env);
  await writePageTags({ expert, page, tags: ['test'], mode: 'apply', env });
  await writeFile(join(dir, String(page.id), '9999_bad.json'), '{"ts":"newest"}');
  expect((await listPageSnapshots(page.id, { expert, env })).map(s => s.metaPath)).toEqual([saved.metaPath]);
  for (const snapshotPath of [undefined, saved.metaPath, saved.htmlPath]) {
    const result = await revertPage(page.id, { expert, env, snapshotPath, dryRun: true });
    expect(result.revertedToHtml).toBe('<p>Recover me</p>');
    expect(result.snapshotUsed.metaPath).toBe(saved.metaPath);
  }
  expect(post).not.toHaveBeenCalled();
  const result = await revertPage(page.id, { expert, env });
  expect(post).toHaveBeenCalledExactlyOnceWith(page.id, '<p>Recover me</p>', expect.anything());
  const recovery = result.preRevertSnapshotPath!.replace(/\.json$/, '.html');
  expect(await readFile(recovery, 'utf8')).toBe('<p>Current</p>');
});

it.each(['hash', 'bytes', 'pageId', 'pagePath', 'hostname', 'ts', 'rules', 'missing', 'utf8', 'symlink', 'pairedIdentity'])('rejects explicit %s corruption and skips it in default history', async fault => {
  const dir = await mkdtemp(join(tmpdir(), 'snapshot-invalid-'));
  const page = { id: 814, path: 'Sandboxes/johnnyphung/History', hostname: 'dev.libretexts.org' };
  const env = { SERVER_DOMAIN: page.hostname, REMEDY_SNAPSHOT_DIR: dir };
  const expert = { pages: { getPageInfo: async () => ({ '@id': page.id, path: page.path }), getPageContents: async () => ({ body: 'current' }) } } as any;
  const saved = await saveSnapshot('original', { pageId: page.id, pagePath: page.path, hostname: page.hostname, operator: 'fake', rules: [] }, env);
  const metadata: any = { ...saved.meta };
  if (fault === 'missing') await rename(saved.htmlPath, saved.htmlPath + '.kept');
  else if (fault === 'utf8') await writeFile(saved.htmlPath, Buffer.from([0xff]));
  else if (fault === 'symlink') {
    await rename(saved.htmlPath, saved.htmlPath + '.kept');
    await symlink(saved.htmlPath + '.kept', saved.htmlPath);
  } else {
    const values: Record<string, unknown> = { hash: '0'.repeat(16), bytes: 0, pageId: 999, pagePath: 'Sandboxes/johnnyphung/Other', hostname: 'other.example', ts: 'invalid', rules: null, pairedIdentity: undefined };
    if (fault === 'pairedIdentity') metadata.ts = '2020-01-01T00:00:00.000Z';
    else metadata[fault] = values[fault];
    await writeFile(saved.metaPath, JSON.stringify(metadata));
  }
  for (const snapshotPath of [saved.metaPath, saved.htmlPath]) await expect(revertPage(page.id, { expert, env, snapshotPath, dryRun: true })).rejects.toThrow('integrity');
  expect(await listPageSnapshots(page.id, { expert, env })).toEqual([]);
  await expect(revertPage(page.id, { expert, env, dryRun: true })).rejects.toThrow('No snapshots');
});

it('rejects traversal, external paths, mismatched entry pairs and symlink directories without deleting evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'snapshot-path-'));
  const env = { REMEDY_SNAPSHOT_DIR: join(dir, 'root') };
  const saved = await saveSnapshot('evidence', { pageId: 815, pagePath: 'Sandboxes/johnnyphung/History', hostname: 'dev.libretexts.org', operator: 'fake', rules: [] }, env);
  await expect(readSnapshot(saved.metaPath.replace('/815/', '/815/../815/'), env)).rejects.toThrow('integrity');
  await expect(readSnapshot(saved.metaPath, { REMEDY_SNAPSHOT_DIR: join(dir, 'other') })).rejects.toThrow('integrity');
  await expect(readSnapshot({ ...saved, htmlPath: saved.htmlPath + '.other' }, env)).rejects.toThrow('integrity');
  await rename(join(env.REMEDY_SNAPSHOT_DIR, '815'), join(dir, 'kept-page'));
  await symlink(join(dir, 'kept-page'), join(env.REMEDY_SNAPSHOT_DIR, '815'));
  await expect(readSnapshot(saved.metaPath, env)).rejects.toThrow('integrity');
  await rename(env.REMEDY_SNAPSHOT_DIR, join(dir, 'kept-root'));
  await symlink(join(dir, 'kept-root'), env.REMEDY_SNAPSHOT_DIR);
  await expect(readSnapshot(saved.metaPath, env)).rejects.toThrow('integrity');
  expect(await readFile(join(dir, 'kept-page', saved.htmlPath.split('/').at(-1)!), 'utf8')).toBe('evidence');
});
