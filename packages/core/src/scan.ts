import { JSDOM } from 'jsdom';
import type Expert from '@libretexts/cxone-expert-node';
import { createExpertClient, normalizePageInput, resolvePageRef } from './client.js';
import { defaultRules } from './rules/index.js';
import { scanHtmlWithAxe } from './scan-axe.js';
import { buildWcagReview } from './wcag.js';
import { markUnavailableImageFixes } from './image-availability.js';
import type { Finding, PageRef, Rule, ScanResult, Severity } from './types.js';

export interface ScanPageOptions {
  expert?: Expert;
  rules?: Rule[];
  env?: NodeJS.ProcessEnv;
  /** Also run axe-core and merge its findings. Default: true. */
  axe?: boolean;
}

export async function fetchPageHtml(
  expert: Expert,
  pageInput: string | number,
): Promise<string> {
  const id = normalizePageInput(pageInput);
  // mode=edit returns the page SOURCE (what users see in the wiki editor) —
  // no MindTouch-injected anchors, mt-section-origin wrappers, rendered MathJax,
  // etc. Using mode=view pollutes writes: its output contains auto-injected
  // IDs that get duplicated on the next render when we POST them back as source.
  const res = await expert.pages.getPageContents(id as number, {
    mode: 'edit',
  } as unknown as Parameters<typeof expert.pages.getPageContents>[1]);
  // The SDK returns a JSON envelope for contents; the HTML lives under body[0] or body['#text'].
  // Defensive extraction to handle XML-to-JSON vagaries.
  const anyRes = res as unknown as Record<string, unknown>;
  const body = (anyRes.body ?? anyRes['#text'] ?? anyRes) as unknown;
  const raw = extractBodyString(body, res);
  return unwrapEditorChrome(raw);
}

function extractBodyString(body: unknown, res: unknown): string {
  if (typeof body === 'string') return body;
  if (Array.isArray(body)) {
    const str = body.find((b) => typeof b === 'string') as string | undefined;
    if (str) return str;
  }
  if (body && typeof body === 'object' && '#text' in (body as Record<string, unknown>)) {
    const t = (body as Record<string, unknown>)['#text'];
    if (typeof t === 'string') return t;
  }
  throw new Error(`Could not extract HTML body from getPageContents response: ${JSON.stringify(res).slice(0, 300)}`);
}

/**
 * CXone's mode=edit response wraps the page source in editor chrome:
 *   <header><nav>…breadcrumb…</nav><h1>…title…</h1></header>
 *   <main><div id="preview"><div id="preview-content">AUTHORED CONTENT</div></div></main>
 *
 * Scanning + writing that wrapper back as new source means the next render
 * nests chrome inside chrome. This function reduces the HTML to just the
 * authored content. If the chrome markers aren't present (simpler pages, or
 * future CXone versions), the input is returned unchanged.
 */
function unwrapEditorChrome(html: string): string {
  if (!html.includes('id="preview-content"')) return html;
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  try {
    const content = dom.window.document.querySelector('#preview-content');
    return content ? content.innerHTML : html;
  } finally { dom.window.close(); }
}

export function scanHtml(html: string, rules: Rule[] = defaultRules): Finding[] {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  try {
    const doc = dom.window.document;
    const findings: Finding[] = [];
    for (const rule of rules) {
      const raw = rule.detect(doc);
      for (const r of raw) {
        findings.push({
          ...r,
          ruleId: rule.id,
          wcag: rule.wcag,
          severity: rule.severity,
          source: 'remedy',
          fixable: typeof rule.fix === 'function' && (r.fixable ?? true),
        });
      }
    }
    return findings;
  } finally { dom.window.close(); }
}

export async function scanHtmlFull(
  html: string,
  opts: { rules?: Rule[]; axe?: boolean } = {},
): Promise<Finding[]> {
  const rules = opts.rules ?? defaultRules;
  const axeEnabled = opts.axe ?? true;
  const deterministic = scanHtml(html, rules);
  if (!axeEnabled) return deterministic;
  const axe = await scanHtmlWithAxe({ html });
  return [...deterministic, ...axe];
}

export function buildStats(findings: Finding[]): ScanResult['stats'] {
  const byRule: Record<string, number> = {};
  const bySeverity: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) {
    byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1;
    bySeverity[f.severity] += 1;
  }
  return { total: findings.length, byRule, bySeverity };
}

export async function scanPage(
  pageInput: string | number,
  opts: ScanPageOptions = {},
): Promise<ScanResult & { html: string }> {
  const env = opts.env ?? process.env;
  const expert = opts.expert ?? createExpertClient(env);
  const rules = opts.rules ?? defaultRules;

  const axeEnabled = opts.axe ?? true;

  const page: PageRef = await resolvePageRef(expert, pageInput, env);
  const html = await fetchPageHtml(expert, pageInput);
  let findings = await scanHtmlFull(html, { rules, axe: axeEnabled });
  findings = await markUnavailableImageFixes(findings, page, { env });
  const scannedAt = new Date().toISOString();

  return {
    page,
    scannedAt,
    findings,
    wcagReview: buildWcagReview({ html, findings, scannedAt, page }),
    dojExceptions: [],
    stats: buildStats(findings),
    html,
  };
}

export { ScanEngineError } from './scan-axe.js';
