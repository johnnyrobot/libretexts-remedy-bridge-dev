import type { DojException, Finding, PageRef, WcagReview } from '@libretexts/remedy-core';

export interface ScanResponse {
  page: PageRef;
  findings: Finding[];
  wcagReview: WcagReview;
  dojExceptions: DojException[];
  stats: { bySeverity: { error: number; warning: number; info: number } };
  scannedAt: string;
}

export interface PreviewResponse {
  previewToken: string;
  previewHash: string;
  pageId: number;
  pagePath: string;
  hostname: string;
  tiersRun: Array<{ tier: number; before: number; after: number; elapsedMs: number }>;
  finalFindingsCount: number;
  diff: string;
  beforeHtml: string;
  finalHtml: string;
  noiseOnlyChange: boolean;
}

export interface ApplyResponse {
  applied: boolean;
  audit_recorded?: boolean;
  write_outcome?: 'succeeded';
  applyError?: string;
  snapshotPath?: string;
  revisionSummary?: string;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const problem = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(problem.message ?? `Request failed (${res.status}).`);
  }
  return res.json();
}

export const api = {
  scan:    (page: string): Promise<ScanResponse>    => post('/api/scan',    { page }),
  preview: (page: string, tier: 1 | 2 | 3): Promise<PreviewResponse> => post('/api/preview', { page, tier }),
  apply:   (page: string, tier: 1 | 2 | 3, preview: PreviewResponse): Promise<ApplyResponse> => post('/api/apply', { page, tier, preview_token: preview.previewToken, preview_hash: preview.previewHash }),
};

// --- Local Lab API ---

export interface LocalFixture {
  name: string;
  relPath: string;
  size: number;
}

export interface LocalStrategyReport {
  strategyId: string;
  fixesApplied: string[];
  errors: string[];
  llmCalls: number;
}

export interface LocalRunResponse {
  fixtureName?: string;
  beforeHtml: string;
  afterHtml: string;
  diff: string;
  findingsBefore: Finding[];
  findingsAfter: Finding[];
  strategyReports: LocalStrategyReport[];
  bytePreserved: boolean;
  fallbackReason?: string;
  splicesApplied?: number;
  elapsedMs: number;
}

export const localApi = {
  async listFixtures(): Promise<{ fixtures: LocalFixture[] }> {
    const res = await fetch('/api/local/fixtures');
    if (!res.ok) throw new Error(`listFixtures: ${res.status}`);
    return res.json();
  },
  runFixture(relPath: string, maxLlm?: number): Promise<LocalRunResponse> {
    return post('/api/local/run', { source: 'fixture', relPath, maxLlm });
  },
  runInline(html: string, maxLlm?: number): Promise<LocalRunResponse> {
    return post('/api/local/run', { source: 'inline', html, maxLlm });
  },
};
