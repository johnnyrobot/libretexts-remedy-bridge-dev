import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Expert from '@libretexts/cxone-expert-node';
import { fixPage } from '../fix.js';
import { headingAsBoldRule, imgAltRule, mathAccessibleRule } from '../rules/index.js';
import { scanHtml } from '../scan.js';

const DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX///+nxBvIAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';

describe('fixPage', () => {
  it('retains reviewer identity through deterministic apply into audit and snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'remedy-deterministic-audit-'));
    const expert = {
      pages: {
        getPageInfo: async () => ({ '@id': '3971', path: 'Sandboxes/johnnyphung/Test', title: 'Test' }),
        getPageContents: async () => ({ body: '<p><strong>Section</strong></p><p>Text</p>' }),
        postPageContents: async () => ({ page: { '@revision': '43' } }),
      },
    } as unknown as Expert;
    const env = {
      CXONE_INTEGRATION_ENABLED: 'true', SERVER_DOMAIN: 'dev.libretexts.org',
      SERVER_KEY: 'test', SERVER_SECRET: 'test', SERVER_USER: 'test', USER: 'bridge-process',
      REMEDY_WRITE_ALLOWLIST: '^Sandboxes/johnnyphung(?:/|$)',
      REMEDY_SNAPSHOT_DIR: join(dir, 'snapshots'), REMEDY_AUDIT_LOG: join(dir, 'audit.log'),
    };
    try {
      const result = await fixPage(3971, {
        expert, env, rules: [headingAsBoldRule], mode: 'apply',
        findingIds: ['heading-as-bold#0'], requestedBy: 'authenticated-reviewer',
      });
      expect(result.written).toBe(true);
      const audit = JSON.parse((await readFile(env.REMEDY_AUDIT_LOG, 'utf8')).trim());
      const snapshot = JSON.parse(await readFile(result.snapshotPath!, 'utf8'));
      expect(audit).toMatchObject({ requestedBy: 'authenticated-reviewer', operator: 'bridge-process' });
      expect(snapshot).toMatchObject({ requestedBy: 'authenticated-reviewer', operator: 'bridge-process' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('replaces overlong alt text with generated vision alt text', async () => {
    const longAlt = 'Flowchart showing scientific method: Observation to Hypothesis to Experiment to Conclusion/Theory, with feedback loop to revise hypothesis if experiment fails';
    const expert = fakeExpert(`<img src="${DATA_URL}" alt="${longAlt}">`);

    const result = await fixPage(3971, {
      expert,
      rules: [imgAltRule],
      mode: 'preview',
      findingIds: ['img-alt#0'],
      llm: stubLlm({ visionReturn: 'Scientific method flowchart from observation to hypothesis, experiment, and conclusion.' }),
      env: { SERVER_DOMAIN: 'dev.libretexts.org' },
    });

    expect(result.attempted).toEqual(['img-alt']);
    expect(result.applied).toEqual(['img-alt']);
    expect(result.after).not.toEqual(result.before);

    const alt = result.after.match(/alt="([^"]+)"/)?.[1] ?? '';
    expect(alt.length).toBeLessThanOrEqual(150);
    expect(alt).toBe('Scientific method flowchart from observation to hypothesis, experiment, and conclusion.');
    expect(alt).not.toMatch(/(\.\.\.|…)$/);
    expect(result.llmCalls).toBe(1);
  });

  it('preserves source bytes around the changed alt attribute', async () => {
    const longAlt = 'Flowchart showing scientific method: Observation to Hypothesis to Experiment to Conclusion/Theory, with feedback loop to revise hypothesis if experiment fails';
    const before = `<p>Intro<br /></p><img src="${DATA_URL}" alt="${longAlt}" />`;
    const expert = fakeExpert(before);

    const result = await fixPage(3971, {
      expert,
      rules: [imgAltRule],
      mode: 'preview',
      findingIds: ['img-alt#0'],
      llm: stubLlm({ visionReturn: 'Scientific method flowchart from observation to hypothesis, experiment, and conclusion.' }),
      env: { SERVER_DOMAIN: 'dev.libretexts.org' },
    });

    const alt = result.after.match(/alt="([^"]+)"/)?.[1] ?? '';
    expect(result.bytePreserved).toBe(true);
    expect(result.splicesApplied).toBe(1);
    expect(result.after).toContain('<br />');
    expect(result.after).toContain('/>');
    expect(result.after.replace(`alt="${alt}"`, `alt="${longAlt}"`)).toBe(before);
  });

  it('exposes rendered MathJax SVG findings as targeted fixes', () => {
    const findings = scanHtml('<mjx-container><svg><path></path></svg></mjx-container>', [mathAccessibleRule]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'math-accessible',
      fixable: true,
      data: {
        sourceKind: 'svg',
        reason: 'rendered-svg',
      },
    });
  });

  it('adds aria-labels for rendered MathJax SVG using vision', async () => {
    const html = '<mjx-container><svg role="img" viewBox="0 0 20 20"><path d="M0 10h20"></path></svg></mjx-container>';
    const expert = fakeExpert(html);
    const visionImages: Array<{ kind: string; bytes?: Buffer | Uint8Array; mimeType?: string }> = [];

    const result = await fixPage(3971, {
      expert,
      rules: [mathAccessibleRule],
      mode: 'preview',
      findingIds: ['math-accessible#0'],
      llm: {
        vision: async (req: { image: { kind: string; bytes?: Buffer | Uint8Array; mimeType?: string } }) => {
          visionImages.push(req.image);
          return 'x squared plus one';
        },
        chat: async () => '',
      } as never,
      env: { SERVER_DOMAIN: 'dev.libretexts.org' },
    });

    expect(result.attempted).toEqual(['math-accessible']);
    expect(result.applied).toEqual(['math-accessible']);
    expect(result.after).toContain('aria-label="x squared plus one"');
    expect(result.after).toContain('role="math"');
    expect(result.after).toContain('aria-hidden="true"');
    expect(result.llmCalls).toBe(1);
    expect(visionImages[0]).toMatchObject({ kind: 'bytes', mimeType: 'image/png' });
    expect(Buffer.from(visionImages[0].bytes ?? []).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('repairs overlong rendered MathJax descriptions before giving up', async () => {
    const html = '<mjx-container><svg role="img" viewBox="0 0 20 20"><path d="M0 10h20"></path></svg></mjx-container>';
    const expert = fakeExpert(html);

    const result = await fixPage(3971, {
      expert,
      rules: [mathAccessibleRule],
      mode: 'preview',
      findingIds: ['math-accessible#0'],
      llm: {
        vision: async () => 'x squared plus one '.repeat(30),
        chat: async () => 'x squared plus one',
      } as never,
      env: { SERVER_DOMAIN: 'dev.libretexts.org' },
    });

    expect(result.applied).toEqual(['math-accessible']);
    expect(result.after).toContain('aria-label="x squared plus one"');
    expect(result.fixErrors).toEqual([]);
    expect(result.llmCalls).toBe(2);
  });
});

function fakeExpert(html: string): Expert {
  return {
    pages: {
      getPageInfo: async () => ({
        '@id': '3971',
        path: 'Sandboxes/johnnyphung/chem51/01:_Chapter_Notes/Chap_01',
        title: 'Chap 01',
      }),
      getPageContents: async () => ({
        body: html,
      }),
    },
  } as unknown as Expert;
}

function stubLlm(opts: { visionReturn?: string; chatReturn?: string }) {
  return {
    vision: async () => opts.visionReturn ?? '',
    chat: async () => opts.chatReturn ?? '',
  } as never;
}
