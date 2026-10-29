import { boundedFetch } from '../../../tools/request-policy.cjs';
import type { Finding } from './types.js';
export interface RenderedScan {
  state: 'complete' | 'incomplete' | 'error' | 'not_configured';
  scannedAt?: string; url?: string; sourceHash?: string; renderedHash?: string; platformHash?: string;
  browser?: string; axeVersion?: string; scope?: string; error?: string;
  violations?: any[]; incomplete?: any[]; passedRules?: string[]; inapplicableRules?: string[];
  [key: string]: unknown;
}
export async function scanRenderedPage(url: string): Promise<RenderedScan> {
  const base = process.env.RENDER_SCANNER_URL, token = process.env.RENDER_SCANNER_TOKEN;
  if (!base || !token) return {state:'not_configured', error:'Rendered-page scanner is not configured.'};
  try {
    const response = await boundedFetch(`${base.replace(/\/$/,'')}/scan`, {method:'POST',
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`}, body:JSON.stringify({url}), signal:AbortSignal.timeout(120000)});
    const data = await response.json() as RenderedScan;
    if (data.state === 'error') return data;
    if (!response.ok) return {state:'error',error:data.error || 'Rendered scan failed.'};
    if (!['complete','incomplete'].includes(data.state) || !Array.isArray(data.violations) || !Array.isArray(data.incomplete) || !data.renderedHash || !data.platformHash) return {state:'error',error:'Invalid rendered scan response.'};
    return data;
  } catch { return {state:'error',error:'Rendered-page scanner unavailable. Retry the scan.'}; }
}
export function mergeRenderedFindings(source: Finding[], rendered: RenderedScan): { findings: Finding[]; resolvedSourceChecks: Finding[] } {
  const covered = rendered.state === 'complete' || (rendered.state === 'incomplete' && (rendered.math as any)?.ready === true);
  const resolved = new Set(covered ? [...rendered.passedRules || [], ...rendered.inapplicableRules || []] : []);
  // Only supersede scanner execution errors, never genuine source findings or manual judgments.
  const isResolved = (f: Finding) => f.severity === 'info' && f.ruleId.startsWith('axe/') &&
    resolved.has(f.ruleId.slice(4)) && /Axe encountered an error/i.test(f.message);
  const findings = source.filter(f=>!isResolved(f));
  if (rendered.state === 'incomplete') findings.push({ruleId:'rendered/page-readiness',severity:'info',source:'remedy',fixable:false,wcag:'4.1.2',
    message:'The browser ran, but the full reader has unresolved resource or readiness failures. Individual rule results do not establish full-page conformance.',
    data:{scope:'full-reader-page',owner:'platform-or-content-review',readinessErrors:rendered.readinessErrors,failedResources:rendered.failedResources,blockedResources:rendered.blockedResources}});
  for (const [group,severity] of [['violations','warning'],['incomplete','info']] as const) {
    for (const rule of rendered[group] || []) for (const node of rule.nodes || []) {
      const ids = (rule.tags || []).map((t:string)=>/^wcag(\d)(\d)(\d+)$/.exec(t)).filter(Boolean).map((m:string[])=>`${m[1]}.${m[2]}.${m[3]}`);
      findings.push({ruleId:`axe/${rule.id}`,severity,source:'remedy',fixable:false,wcag:ids.join(','),
        message:`Rendered page: ${node.failureSummary || rule.description}`,selector:JSON.stringify(node.target),snippet:node.html,
        data:{axeRuleId:rule.id,scope:'full-reader-page',owner:'platform-or-content-review'}});
    }
  }
  return {findings,resolvedSourceChecks:source.filter(isResolved)};
}
