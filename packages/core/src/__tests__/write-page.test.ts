import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type Expert from '@libretexts/cxone-expert-node';
import { writePageRevision } from '../write-page.js';

describe('writePageRevision', () => {
  it('writes through shared guardrails and records snapshot/audit metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'remedy-write-page-'));
    const calls: unknown[] = [];
    const expert = {
      pages: {
        postPageContents: async (...args: unknown[]) => {
          calls.push(args);
          return { page: { '@revision': '42' } };
        },
      },
    } as unknown as Expert;

    try {
      const result = await writePageRevision({
        expert,
        pageInput: 123,
        page: {
          id: 123,
          path: 'Sandboxes/johnnyphung/Test/Page',
          hostname: 'dev.libretexts.org',
        },
        beforeHtml: '<p>Before</p>',
        afterHtml: '<p>After</p>',
        rules: ['img-alt'],
        revisionSummary: 'Remedy test write',
        source: 'pipeline',
        requestedBy: 'authenticated-reviewer',
        env: {
          CXONE_INTEGRATION_ENABLED: 'true',
          SERVER_DOMAIN: 'dev.libretexts.org',
          SERVER_KEY: 'key',
          SERVER_SECRET: 'secret',
          SERVER_USER: 'user',
          REMEDY_WRITE_ALLOWLIST: '^Sandboxes/johnnyphung(?:/|$)',
          REMEDY_SNAPSHOT_DIR: join(dir, 'snapshots'),
          REMEDY_AUDIT_LOG: join(dir, 'audit.log'),
          USER: 'tester',
        },
      });

      expect(result.written).toBe(true);
      expect(result.snapshotPath).toMatch(/\.json$/);
      expect(result.cxoneRevisionId).toBe('42');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual([
        123,
        '<p>After</p>',
        expect.objectContaining({ comment: 'Remedy test write' }),
      ]);

      const audit = JSON.parse((await readFile(join(dir, 'audit.log'), 'utf8')).trim());
      expect(audit).toMatchObject({
        operator: 'tester',
        requestedBy: 'authenticated-reviewer',
        rules: ['img-alt'],
        mode: 'apply',
        revisionSummary: 'Remedy test write',
        snapshotPath: result.snapshotPath,
        cxoneRevisionId: '42',
      });
      const snapshot = JSON.parse(await readFile(result.snapshotPath!, 'utf8'));
      expect(snapshot).toMatchObject({ operator: 'tester', requestedBy: 'authenticated-reviewer' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not write when the preview has no content changes', async () => {
    const expert = {
      pages: {
        postPageContents: async () => {
          throw new Error('should not write');
        },
      },
    } as unknown as Expert;

    const result = await writePageRevision({
      expert,
      pageInput: 123,
      page: {
        id: 123,
        path: 'Sandboxes/Test/Page',
        hostname: 'dev.libretexts.org',
      },
      beforeHtml: '<p>No change</p>',
      afterHtml: '<p>No change</p>',
      rules: [],
      revisionSummary: 'No-op',
      source: 'fix',
    });

    expect(result).toEqual({ written: false, revisionSummary: 'No-op' });
  });

  it.each([
    ['wrong owner', 'dev.libretexts.org', 'Sandboxes/another-owner/Page'],
    ['prefix collision', 'dev.libretexts.org', 'Sandboxes/johnnyphung-evil/Page'],
    ['production host', 'chem.libretexts.org', 'Sandboxes/johnnyphung/Page'],
    ['encoded traversal', 'dev.libretexts.org', 'Sandboxes/johnnyphung/%2e%2e/Other'],
    ['backslash', 'dev.libretexts.org', 'Sandboxes/johnnyphung\\Other'],
  ])('rejects %s before snapshot or network write', async (_label, hostname, path) => {
    const dir = await mkdtemp(join(tmpdir(), 'remedy-write-reject-'));
    const calls: unknown[] = [];
    const expert = {
      pages: {
        postPageContents: async (...args: unknown[]) => {
          calls.push(args);
          return {};
        },
      },
    } as unknown as Expert;
    const env = {
      CXONE_INTEGRATION_ENABLED: 'true',
      SERVER_DOMAIN: 'dev.libretexts.org',
      SERVER_KEY: 'key',
      SERVER_SECRET: 'secret',
      SERVER_USER: 'user',
      REMEDY_WRITE_ALLOWLIST: '^Sandboxes/johnnyphung(?:/|$)',
      REMEDY_SNAPSHOT_DIR: join(dir, 'snapshots'),
      REMEDY_AUDIT_LOG: join(dir, 'audit.log'),
    };

    try {
      await expect(writePageRevision({
        expert,
        pageInput: 123,
        page: { id: 123, path, hostname },
        beforeHtml: '<p>Before</p>',
        afterHtml: '<p>After</p>',
        rules: ['img-alt'],
        revisionSummary: 'Rejected write',
        source: 'fix',
        env,
      })).rejects.toThrow('outside the configured CXone owner sandbox');
      expect(calls).toHaveLength(0);
      await expect(readdir(join(dir, 'snapshots'))).rejects.toThrow();
      await expect(readFile(join(dir, 'audit.log'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a widening legacy allowlist before writing', async () => {
    const expert = {
      pages: { postPageContents: async () => ({}) },
    } as unknown as Expert;
    await expect(writePageRevision({
      expert,
      pageInput: 123,
      page: { id: 123, path: 'Sandboxes/johnnyphung/Page', hostname: 'dev.libretexts.org' },
      beforeHtml: '<p>Before</p>',
      afterHtml: '<p>After</p>',
      rules: [],
      revisionSummary: 'Rejected configuration',
      source: 'fix',
      env: {
        CXONE_INTEGRATION_ENABLED: 'true',
        SERVER_DOMAIN: 'dev.libretexts.org',
        SERVER_KEY: 'key',
        SERVER_SECRET: 'secret',
        SERVER_USER: 'user',
        REMEDY_WRITE_ALLOWLIST: '^Sandboxes/',
      },
    })).rejects.toThrow('outside the configured CXone owner sandbox');
  });
});
