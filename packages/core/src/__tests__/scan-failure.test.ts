import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
const runtime = vi.hoisted(() => ({ starts: 0, failAt: 1, failRun: false, created: 0, closed: 0, writes: 0 }));
vi.mock('axe-core', async original => {
  const real = await original<typeof import('axe-core')>();
  return { default: { get source() {
    runtime.starts++;
    if (runtime.starts === runtime.failAt) return runtime.failRun
      ? 'window.axe = { run: async () => { throw new Error("synthetic private runtime failure"); } };'
      : 'throw new Error("synthetic private setup failure");';
    return real.default.source;
  } } };
});
vi.mock('jsdom', async original => {
  const real = await original<typeof import('jsdom')>();
  return { ...real, JSDOM: class extends real.JSDOM {
    constructor(...args: ConstructorParameters<typeof real.JSDOM>) {
      super(...args);
      if (args[1]?.runScripts === 'outside-only') {
        runtime.created++;
        const close = this.window.close.bind(this.window);
        this.window.close = () => { runtime.closed++; close(); };
      }
    }
  } };
});
vi.mock('dotenv', () => ({ config: () => ({}) }));
vi.mock('dotenv/config', () => ({}));
vi.mock('@libretexts/cxone-expert-node', () => ({ default: class { pages = {
  getPageInfo: async () => ({ '@id': 902, path: 'Sandboxes/johnnyphung/Test' }),
  getPageContents: async () => ({ body: '<button></button>' }),
  postPageContents: async () => { runtime.writes++; return {}; },
}; } }));
import { scanHtmlFull } from '../scan.js';
import { fixPage } from '../fix.js';
import { runPipeline } from '../pipeline.js';
import { LLMClient } from '../ai/llm-client.js';
import { runLocalPipeline } from '../local-pipeline.js';
let server: Server, base: string;
beforeAll(async () => {
  for (const [k, v] of Object.entries({ REMEDY_REVIEWER_REQUIRED: 'false', NODE_ENV: 'test', CXONE_INTEGRATION_ENABLED: 'true', SERVER_DOMAIN: 'dev.libretexts.org', SERVER_KEY: 'fake', SERVER_SECRET: 'fake', SERVER_USER: 'fake' })) vi.stubEnv(k, v);
  { const bridge = await import('../../../conductor-panel/server/server.js'); server = bridge.createBridgeServer(bridge.executeReadInline); }
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllEnvs(); });
afterEach(() => { runtime.starts = 0; runtime.failAt = 1; runtime.failRun = false; runtime.created = 0; runtime.closed = 0; runtime.writes = 0; });
it.each([false, true])('rejects public full scans on setup/run failure (%s) and closes owned windows', async run => {
  runtime.failRun = run;
  await expect(scanHtmlFull('<button></button>')).rejects.toThrow('evidence is unusable');
  expect(runtime.created).toBe(1); expect(runtime.closed).toBe(1);
  runtime.failAt = 0;
  expect((await scanHtmlFull('<button></button>')).some(f => f.ruleId === 'axe/button-name')).toBe(true);
  expect(runtime.closed).toBe(2);
});
it('prevents fix/apply and page pipeline from proceeding on incomplete engine evidence', async () => {
  await expect(fixPage(902, { mode: 'apply' })).rejects.toThrow('evidence is unusable');
  runtime.starts = 0;
  await expect(runPipeline(902, { mode: 'apply' })).rejects.toThrow('evidence is unusable');
  expect(runtime.writes).toBe(0); expect(runtime.closed).toBe(runtime.created);
});
it('rejects a pipeline whose final rescan fails instead of returning a clean result', async () => {
  runtime.failAt = 2;
  await expect(runLocalPipeline('<button></button>', { maxLlmCalls: 0 })).rejects.toThrow('evidence is unusable');
  expect(runtime.starts).toBe(2); expect(runtime.closed).toBe(runtime.created);
});
it.each(['/v1/cxone/page/scan', '/v1/cxone/page/preview-fix'])('returns explicit unusable engine evidence through HTTP %s', async path => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page_id: 902 }) });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'scan_engine_failed', evidence_usable: false });
  expect(runtime.writes).toBe(0); expect(runtime.closed).toBe(runtime.created);
});

it('propagates a tier-3 agent rescan failure instead of recovering a usable old-source preview', async () => {
  runtime.failAt = 4; // source, tier1, tier2, agent mutation
  const tools = vi.spyOn(LLMClient.prototype, 'chatTools').mockResolvedValue({ role: 'assistant', content: '', tool_calls: [{ id: 'fake', type: 'function', function: { name: 'set_attribute', arguments: JSON.stringify({ selector: 'button', attr: 'aria-label', value: 'Named' }) } }] });
  try {
    await expect(runPipeline(902, { tier: 3, mode: 'apply', maxLlmCalls: 0 })).rejects.toThrow('evidence is unusable');
    expect(runtime.starts).toBe(4); expect(runtime.writes).toBe(0);
  } finally { tools.mockRestore(); }
});
it('refuses a manual-image review preview when source scan evidence fails', async () => {
  const response = await fetch(base + '/v1/cxone/page/preview-fix', { method: 'POST', body: JSON.stringify({ page_id: 902, review_images: true }) });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'scan_engine_failed', evidence_usable: false });
});
