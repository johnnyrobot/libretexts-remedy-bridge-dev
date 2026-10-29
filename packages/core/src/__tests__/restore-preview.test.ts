import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { saveSnapshot, hashContent } from '../guardrails.js';
import { revertPage } from '../revert.js';

it('restore rejects stale previews, cross-page snapshots and corrupted snapshots; saves a recovery snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'restore-test-'));
  const path = 'Sandboxes/johnnyphung/Test';
  const env = { CXONE_INTEGRATION_ENABLED: 'true', SERVER_DOMAIN: 'dev.libretexts.org', SERVER_KEY: 'test', SERVER_SECRET: 'test', SERVER_USER: 'test', REMEDY_WRITE_ALLOWLIST: '^Sandboxes/johnnyphung(?:/|$)', REMEDY_SNAPSHOT_DIR: dir, REMEDY_AUDIT_LOG: join(dir, 'audit.log'), USER: 'bridge-operator' };
  const post = vi.fn().mockResolvedValue({});
  const expert = { pages: { getPageInfo: async () => ({ '@id': 4218, path }), getPageContents: async () => ({ body: '<p>New</p>' }), postPageContents: post } } as any;
  try {
    const meta = { pageId: 4218, pagePath: path, hostname: 'dev.libretexts.org', operator: 'test', rules: ['img-alt'], revisionSummary: 'test' };
    const snapshot = await saveSnapshot('<p>Original</p>', meta, env);
    const base = { env, expert, snapshotTs: snapshot.meta.ts, requestedBy: 'authenticated-reviewer' };
    const preview = await revertPage(4218, { ...base, dryRun: true });
    expect(preview.written).toBe(false); expect(post).not.toHaveBeenCalled();
    await expect(revertPage(4218, { ...base, expectedCurrentHash: 'stale' })).rejects.toThrow('Page changed');
    const other = await saveSnapshot('<p>Other</p>', { ...meta, pageId: 999 }, env);
    await expect(revertPage(4218, { env, expert, snapshotPath: other.metaPath })).rejects.toThrow('does not match');
    expect(post).not.toHaveBeenCalled();
    await expect(revertPage(4218, { ...base, expectedRestoredHash: 'wrong' })).rejects.toThrow('Restored output changed');
    const result = await revertPage(4218, { ...base, expectedCurrentHash: hashContent('<p>New</p>') });
    expect(result.written).toBe(true); expect(result.preRevertSnapshotPath).toBeTruthy(); expect(post).toHaveBeenCalledTimes(1);
    const recovery = JSON.parse(await readFile(result.preRevertSnapshotPath!, 'utf8'));
    expect(recovery).toMatchObject({ operator: 'bridge-operator', requestedBy: 'authenticated-reviewer' });
    const audit = JSON.parse((await readFile(env.REMEDY_AUDIT_LOG, 'utf8')).trim());
    expect(audit).toMatchObject({ mode: 'revert', operator: 'bridge-operator', requestedBy: 'authenticated-reviewer' });
    await writeFile(snapshot.htmlPath, '<p>Corrupted</p>');
    await expect(revertPage(4218, { ...base, dryRun: true })).rejects.toThrow('integrity');
    expect(post).toHaveBeenCalledTimes(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
