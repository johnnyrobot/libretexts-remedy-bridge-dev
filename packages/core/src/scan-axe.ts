import { JSDOM, VirtualConsole } from 'jsdom';
// axe-core's published types target the browser DOM, not jsdom's. Dynamic import
// avoids Node/TS resolution headaches with its bundled UMD+ESM split.
import axe from 'axe-core';
import type { Finding, Severity } from './types.js';

/**
 * Subset of axe rules that meaningfully apply to static HTML extracted from
 * CXone Expert. Excludes rules that need a live browser (focus-order, etc.).
 */
const JSDOM_LIMITED_RULES = new Set(['color-contrast', 'target-size', 'link-in-text-block']);

/**
 * After unwrapEditorChrome() (scan.ts), the HTML we hand axe is authored
 * content only — no <title>, no real <html lang>, no <meta>. Rules that
 * target platform chrome produce false-positives (or false-negatives against
 * our synthetic <!doctype><html lang="en"><body> shell) and must be disabled:
 *   - document-title, html-has-lang, html-lang-valid, html-xml-lang-mismatch
 *   - meta-refresh, meta-viewport
 *   - frame-title (iframes, if any, belong to chrome)
 *   - heading-order (we handle h1-clamp + outline normalization in
 *     HeadingStrategy, which knows the platform provides the page h1)
 */
const DEFAULT_RULES = [
  'area-alt',
  'aria-allowed-attr',
  'aria-hidden-body',
  'aria-hidden-focus',
  'aria-input-field-name',
  'aria-required-attr',
  'aria-required-children',
  'aria-required-parent',
  'aria-roles',
  'aria-valid-attr',
  'aria-valid-attr-value',
  'button-name',
  // 'color-contrast' — disabled: jsdom has no canvas, so axe's pixel sampling
  // always fails. Contrast is covered separately in strategies/contrast.ts.
  'duplicate-id-aria',
  'empty-heading',
  'empty-table-header',
  'form-field-multiple-labels',
  'image-alt',
  'input-button-name',
  'input-image-alt',
  'label',
  'link-name',
  'list',
  'listitem',
  'object-alt',
  'role-img-alt',
  'select-name',
  // 'svg-img-alt' — disabled: fires on every MathJax-rendered <svg>. MathJax
  // exposes its accessible name on the parent <mjx-container> (covered by
  // math-accessible rule), not the inner SVG. Re-enable when we have a
  // dedicated diagram-SVG strategy that can scope this away from MathJax.
  'table-duplicate-name',
  'table-fake-caption',
  'td-has-header',
  'th-has-data-cells',
  'valid-lang',
];

export interface AxeScanOptions {
  html: string;
  /**
   * Rule set to enable. Defaults to `DEFAULT_RULES`.
   * Pass an empty array to run every axe rule (noisy).
   */
  rules?: string[];
  /** Axe tags to filter by, e.g. ['wcag2a', 'wcag2aa']. Applied in addition to the rule list. */
  tags?: string[];
}

export class ScanEngineError extends Error {
  constructor() { super('Accessibility scan engine failed; evidence is unusable.'); this.name = 'ScanEngineError'; }
}

export async function scanHtmlWithAxe(opts: AxeScanOptions): Promise<Finding[]> {
  const virtualConsole = new VirtualConsole();
  // jsdom routes unimplemented-feature messages here (canvas.getContext, etc.).
  // They're noise for our use; axe returns `incomplete` results when something
  // couldn't be measured, which is the signal we care about.
  virtualConsole.on('jsdomError', () => {});
  virtualConsole.on('error', () => {});

  const dom = new JSDOM(`<!doctype html><html lang="en"><body>${opts.html}</body></html>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;

  try {
    // Each window owns its axe instance, setup, execution and teardown. No host
    // globals or module-singleton axe state are shared with concurrent callers.
    window.eval(axe.source);
    const axeRunner = (window as unknown as { axe: typeof axe }).axe;

    // Explicit rule allowlist. An empty array from the caller means "run every
    // axe rule" (noisy but useful for debugging); otherwise we constrain axe to
    // exactly the rules we've vetted for authored content. Without runOnly, axe
    // silently enables its full default rule set — including chrome-scope rules
    // like `region` and MathJax-incompatible rules like `svg-img-alt`.
    const runOptions: Record<string, unknown> = {
      resultTypes: ['violations', 'incomplete'],
    };
    if (opts.tags?.length) {
      runOptions.runOnly = { type: 'tag', values: opts.tags };
    } else if (opts.rules === undefined || opts.rules.length > 0) {
      runOptions.runOnly = {
        type: 'rule',
        values: opts.rules ?? DEFAULT_RULES,
      };
    }

    // Pass the body element as context so axe scans the content we fetched.
    const results = await axeRunner.run(window.document.body, runOptions) as unknown as { violations: AxeViolation[]; incomplete: AxeViolation[] };

    const findings: Finding[] = [];
    for (const v of results.violations) {
      for (const node of v.nodes) {
        findings.push(mapAxeFinding(v, node, 'error'));
      }
    }
    for (const v of results.incomplete) {
      // Skip incomplete results that are purely jsdom-limitation noise.
      if (JSDOM_LIMITED_RULES.has(v.id)) continue;
      for (const node of v.nodes) {
        findings.push(mapAxeFinding(v, node, 'info'));
      }
    }
    return findings;
  } catch { throw new ScanEngineError(); }
  finally { window.close(); }
}

export function mapAxeFinding(v: AxeViolation, node: AxeNode, defaultSeverity: Severity): Finding {
  // An incomplete check is not a confirmed violation, regardless of impact.
  const sev: Severity = defaultSeverity === 'info' ? 'info' :
    v.impact === 'critical' || v.impact === 'serious'
      ? 'error'
      : v.impact === 'moderate'
      ? 'warning'
      : v.impact === 'minor'
      ? 'info'
      : defaultSeverity;
  const wcag = (v.tags ?? [])
    .map((t) => t.match(/^wcag(\d)(\d\d?)$/))
    .filter(Boolean)
    .map((m) => `${m![1]}.${m![2].split('').join('.')}`)
    .join(', ');
  return {
    ruleId: `axe/${v.id}`,
    wcag: wcag || undefined,
    severity: sev,
    message: `${v.help} — ${node.failureSummary ?? ''}`.replace(/\s+$/, ''),
    selector: node.target?.[0],
    snippet: node.html?.slice(0, 300),
    source: 'cxone-health',
    fixable: false,
    data: {
      axeRuleId: v.id,
      impact: v.impact,
      tags: v.tags,
      helpUrl: v.helpUrl,
    },
  };
}

interface AxeViolation {
  id: string;
  help: string;
  helpUrl?: string;
  impact?: 'critical' | 'serious' | 'moderate' | 'minor' | null;
  tags?: string[];
  nodes: AxeNode[];
}

interface AxeNode {
  html?: string;
  target?: string[];
  failureSummary?: string;
}
