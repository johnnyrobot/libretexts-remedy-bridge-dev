import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type Expert from '@libretexts/cxone-expert-node';
import { WriteNotAllowedError } from '../guardrails.js';
import { restoreTagsFromManifest, revertPageTags, selectRestorableTags, writePageTags } from '../write-tags.js';

function fakeExpert(currentTags: string[], calls: unknown[][], path = 'Sandboxes/johnnyphung/biology/1.02'): Expert {
  return {
    pages: {
      getPageInfo: async () => ({ '@id': 4219, path }),
      getPageTags: async () => ({
        tag: currentTags.map((v) => ({ '@value': v, title: v })),
      }),
      putPageTags: async (...args: unknown[]) => {
        calls.push(args);
        return {};
      },
    },
  } as unknown as Expert;
}

async function testEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), 'remedy-write-tags-'));
  return {
    CXONE_INTEGRATION_ENABLED: 'true',
    SERVER_DOMAIN: 'dev.libretexts.org',
    SERVER_KEY: 'key',
    SERVER_SECRET: 'secret',
    SERVER_USER: 'user',
    REMEDY_WRITE_ALLOWLIST: '^Sandboxes/johnnyphung(?:/|$)',
    REMEDY_SNAPSHOT_DIR: join(dir, 'snapshots'),
    REMEDY_AUDIT_LOG: join(dir, 'audit.log'),
    USER: 'tester',
  };
}

describe('writePageTags', () => {
  it('rejects manifest-like asserted sandbox metadata for a different canonical page', async () => {
    const calls: unknown[][] = [];
    const expert = fakeExpert([], calls);
    expert.pages.getPageInfo = async () => ({ '@id': 4219, path: 'Bookshelves/Outside' }) as any;
    await expect(writePageTags({ expert, page: { id: 4219, path: 'Sandboxes/johnnyphung/biology/1.02', hostname: 'dev.libretexts.org' }, tags: ['license:ccby'], env: await testEnv() })).rejects.toThrow('outside');
    expect(calls).toHaveLength(0);
  });

  it('refuses a page outside the sandbox before touching the SDK', async () => {
    const calls: unknown[][] = [];
    const expert = fakeExpert([], calls);

    await expect(
      writePageTags({
        expert,
        page: { id: 3742, path: 'Bookshelves/Biology_(Kimball)/1.02', hostname: 'bio.libretexts.org' },
        tags: ['license:ccby'],
        env: await testEnv(),
      }),
    ).rejects.toBeInstanceOf(WriteNotAllowedError);

    expect(calls).toHaveLength(0);
  });

  it('dry run reports the tags it would add and makes no write', async () => {
    const calls: unknown[][] = [];
    const expert = fakeExpert(['article:topic'], calls);

    const result = await writePageTags({
      expert,
      page: { id: 4219, path: 'Sandboxes/johnnyphung/biology/1.02', hostname: 'dev.libretexts.org' },
      tags: ['article:topic', 'license:ccby', 'licenseversion:30'],
      dryRun: true,
      env: await testEnv(),
    });

    expect(result).toMatchObject({
      written: false,
      before: ['article:topic'],
      after: ['article:topic', 'license:ccby', 'licenseversion:30'],
      added: ['license:ccby', 'licenseversion:30'],
      removed: [],
    });
    expect(calls).toHaveLength(0);
  });

  it('apply snapshots the prior tags before the PUT, sends Deki XML, and audits', async () => {
    const env = await testEnv();
    const calls: unknown[][] = [];
    const snapshotsAtPutTime: string[] = [];
    const expert = fakeExpert(['article:topic'], calls);
    // Capture what is on disk at the moment the PUT happens.
    const original = expert.pages.putPageTags.bind(expert.pages);
    expert.pages.putPageTags = async (...args: unknown[]) => {
      snapshotsAtPutTime.push(...(await readdir(join(env.REMEDY_SNAPSHOT_DIR!, '4219'))));
      return (original as (...a: unknown[]) => Promise<unknown>)(...args);
    };

    const result = await writePageTags({
      expert,
      page: { id: 4219, path: 'Sandboxes/johnnyphung/biology/1.02', hostname: 'dev.libretexts.org' },
      tags: ['article:topic', 'license:ccby'],
      revisionSummary: 'REM-02 restore license tags',
      env,
    });

    expect(result.written).toBe(true);
    expect(result.snapshotPath).toMatch(/\.tags\.json$/);
    expect(snapshotsAtPutTime).toHaveLength(1);
    const snapshot = JSON.parse(await readFile(result.snapshotPath!, 'utf8'));
    expect(snapshot).toMatchObject({
      meta: { pageId: 4219, pagePath: 'Sandboxes/johnnyphung/biology/1.02', hostname: 'dev.libretexts.org', operator: 'tester' },
      tags: ['article:topic'],
    });

    expect(calls).toHaveLength(1);
    const [id, body, , funcArgs] = calls[0] as [number, string, unknown, { headers: Record<string, string> }];
    expect(id).toBe(4219);
    expect(body).toBe('<tags><tag value="article:topic"/><tag value="license:ccby"/></tags>');
    expect(funcArgs.headers['Content-Type']).toMatch(/^application\/xml/);

    const audit = JSON.parse((await readFile(env.REMEDY_AUDIT_LOG!, 'utf8')).trim());
    expect(audit).toMatchObject({
      mode: 'apply',
      rules: ['page-tags'],
      page: { id: 4219 },
      operator: 'tester',
      revisionSummary: 'REM-02 restore license tags',
      snapshotPath: result.snapshotPath,
    });
  });

  it('merge mode keeps tags the page already has and only adds the requested ones', async () => {
    const calls: unknown[][] = [];
    const expert = fakeExpert(['hydrogen'], calls);

    const result = await writePageTags({
      expert,
      page: { id: 4219, path: 'Sandboxes/johnnyphung/biology/1.02', hostname: 'dev.libretexts.org' },
      tags: ['license:ccby'],
      merge: true,
      dryRun: true,
      env: await testEnv(),
    });

    expect(result.after).toEqual(['hydrogen', 'license:ccby']);
    expect(result.removed).toEqual([]);
  });

  it('is a no-op when the page already carries exactly the target tags', async () => {
    const env = await testEnv();
    const calls: unknown[][] = [];
    const expert = fakeExpert(['license:ccby', 'article:topic'], calls);

    const result = await writePageTags({
      expert,
      page: { id: 4219, path: 'Sandboxes/johnnyphung/biology/1.02', hostname: 'dev.libretexts.org' },
      tags: ['article:topic', 'license:ccby'],
      env,
    });

    expect(result).toMatchObject({ written: false, added: [], removed: [] });
    expect(result.snapshotPath).toBeUndefined();
    expect(calls).toHaveLength(0);
    await expect(readFile(env.REMEDY_AUDIT_LOG!, 'utf8')).rejects.toThrow();
  });
});

describe('selectRestorableTags', () => {
  it('keeps only license and licenseversion tags', () => {
    const source = [
      'article:topic',
      'authorname:kimballj',
      'biology',
      'periodic table',
      'showtoc:no',
      'license:ccby',
      'licenseversion:30',
      'source@https://www.biology-pages.info/',
      'hydrogen',
    ];

    const { restore, omitted } = selectRestorableTags(source);

    expect(restore).toEqual(['license:ccby', 'licenseversion:30']);
    // article:* and authorname:* drive site templates (broken Template:AutoDefinitionList on dev;
    // author box with alt=" "); source@ is inert metadata. Attribution text is already in the body.
    expect(omitted).toEqual([
      'article:topic',
      'authorname:kimballj',
      'biology',
      'periodic table',
      'showtoc:no',
      'source@https://www.biology-pages.info/',
      'hydrogen',
    ]);
  });
});

describe('restoreTagsFromManifest', () => {
  const manifest = {
    generatedAt: '2026-09-15T06:00:00.000Z',
    pages: [
      {
        sandboxPageId: 4219,
        sandboxPath: 'Sandboxes/johnnyphung/biology/01:_The_Chemical_Basis_of_Life/1.02:_Elements_and_Atoms',
        sourcePath: 'Bookshelves/Introductory_and_General_Biology/Biology_(Kimball)/01:_The_Chemical_Basis_of_Life/1.02:_Elements_and_Atoms',
        sourcePageId: 3742,
        crosscheck: 'match' as const,
        tags: { restore: ['article:topic', 'license:ccby'], omitted: ['biology'] },
      },
      {
        sandboxPageId: 4220,
        sandboxPath: 'Sandboxes/johnnyphung/biology/01:_The_Chemical_Basis_of_Life/1.03:_X',
        sourcePath: 'Bookshelves/Introductory_and_General_Biology/Biology_(Kimball)/01:_The_Chemical_Basis_of_Life/1.03:_X',
        sourcePageId: 3743,
        crosscheck: 'mismatch' as const,
        tags: { restore: ['license:ccby'], omitted: [] },
      },
    ],
  };

  it('skips pages whose source cross-check failed and applies the rest', async () => {
    const env = await testEnv();
    const calls: unknown[][] = [];
    const expert = fakeExpert([], calls, manifest.pages[0].sandboxPath);

    const results = await restoreTagsFromManifest(manifest, { expert, env, revisionSummary: 'REM-02' });

    expect(results.map((r) => [r.sandboxPageId, r.status])).toEqual([
      [4219, 'written'],
      [4220, 'skipped-crosscheck'],
    ]);
    expect(calls).toHaveLength(1);
    expect((calls[0] as [number])[0]).toBe(4219);
  });

  it('dry run plans every eligible page and writes nothing', async () => {
    const env = await testEnv();
    const calls: unknown[][] = [];
    const expert = fakeExpert([], calls, manifest.pages[0].sandboxPath);

    const results = await restoreTagsFromManifest(manifest, { expert, env, dryRun: true });

    expect(results.map((r) => r.status)).toEqual(['planned', 'skipped-crosscheck']);
    expect(results[0].result?.added).toEqual(['article:topic', 'license:ccby']);
    expect(calls).toHaveLength(0);
  });

  it('restricts the run to a single page when asked', async () => {
    const env = await testEnv();
    const calls: unknown[][] = [];
    const expert = fakeExpert([], calls, manifest.pages[0].sandboxPath);

    const results = await restoreTagsFromManifest(manifest, { expert, env, onlyPageId: 4219 });

    expect(results).toHaveLength(1);
    expect(results[0].sandboxPageId).toBe(4219);
  });
});

describe('revertPageTags', () => {
  it('puts back exactly the tag list recorded in a snapshot and audits it as a revert', async () => {
    const env = await testEnv();
    const calls: unknown[][] = [];
    const expert = fakeExpert(['article:topic', 'license:ccby'], calls);

    // Produce a real snapshot first: page had only "hydrogen" before an earlier write.
    const snapshotPath = join(env.REMEDY_SNAPSHOT_DIR!, '4219', '2026-09-15T15-48-46-700Z_abc.tags.json');
    await mkdir(join(env.REMEDY_SNAPSHOT_DIR!, '4219'), { recursive: true });
    await writeFile(
      snapshotPath,
      JSON.stringify({ meta: { pageId: 4219, pagePath: 'Sandboxes/johnnyphung/biology/1.02', hostname: 'dev.libretexts.org' }, tags: ['hydrogen'] }),
    );

    const result = await revertPageTags({ expert, snapshotPath, env });

    expect(result).toMatchObject({ written: true, before: ['article:topic', 'license:ccby'], after: ['hydrogen'] });
    expect(calls).toHaveLength(1);
    expect((calls[0] as [number, string])[1]).toBe('<tags><tag value="hydrogen"/></tags>');
    const audit = JSON.parse((await readFile(env.REMEDY_AUDIT_LOG!, 'utf8')).trim().split('\n').pop()!);
    expect(audit).toMatchObject({ mode: 'revert', page: { id: 4219 }, revertedFrom: snapshotPath });
  });
});
