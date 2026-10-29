import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const fault = vi.hoisted(() => ({ code: '' }));
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>();
  return { ...real, open: (...args: Parameters<typeof real.open>) => {
    if (fault.code) return Promise.reject(Object.assign(new Error('Synthetic storage failure'), { code: fault.code }));
    return real.open(...args);
  } };
});
import { saveSnapshot, readSnapshot, listSnapshots } from '../guardrails.js';
afterEach(() => { fault.code = ''; });
it.each(['EIO', 'EMFILE', 'EACCES'])('surfaces %s storage errors instead of falling back to older recovery evidence', async code => {
  const dir = await mkdtemp(join(tmpdir(), 'snapshot-io-'));
  const env = { REMEDY_SNAPSHOT_DIR: dir };
  const saved = await saveSnapshot('preserve', { pageId: 818, pagePath: 'Sandboxes/johnnyphung/Storage', hostname: 'dev.libretexts.org', operator: 'fake', rules: [] }, env);
  fault.code = code;
  await expect(listSnapshots(818, env)).rejects.toMatchObject({ code });
  await expect(readSnapshot(saved.htmlPath, env)).rejects.toMatchObject({ code });
});
