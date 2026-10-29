import type { LLMClient } from './ai/llm-client.js';

export type Severity = 'error' | 'warning' | 'info';

export interface PageRef {
  id: number;
  path: string;
  title?: string;
  hostname: string;
}

export interface Finding {
  ruleId: string;
  wcag?: string;
  severity: Severity;
  message: string;
  selector?: string;
  snippet?: string;
  source: 'remedy' | 'cxone-health';
  fixable: boolean;
  data?: Record<string, unknown>;
}

export interface ScanResult {
  page: PageRef;
  scannedAt: string;
  findings: Finding[];
  wcagReview: WcagReview;
  dojExceptions: DojException[];
  stats: {
    total: number;
    byRule: Record<string, number>;
    bySeverity: Record<Severity, number>;
  };
}

export type FixMode = 'preview' | 'apply';

export type PatchFallbackReason =
  | 'unsupported-mutation'
  | 'no-source-location'
  | 'verification-mismatch'
  | 'parse-error';

export interface FixResult {
  page: PageRef;
  mode: FixMode;
  attempted: string[];
  applied: string[];
  before: string;
  after: string;
  diff: string;
  written: boolean;
  writeOutcome?: 'succeeded';
  auditRecorded?: boolean;
  auditError?: 'audit_append_failed';
  revisionSummary?: string;
  snapshotPath?: string;
  bytePreserved?: boolean;
  fallbackReason?: PatchFallbackReason;
  splicesApplied?: number;
  attemptedFindingIds?: string[];
  appliedFindingIds?: string[];
  fixErrors?: FixError[];
  llmCalls?: number;
}

export interface FixError {
  ruleId: string;
  findingId?: string;
  selector?: string;
  message: string;
}

export type RuleDetection = Omit<Finding, 'ruleId' | 'wcag' | 'severity' | 'source' | 'fixable'> & {
  fixable?: boolean;
};

export interface Rule {
  id: string;
  wcag?: string;
  severity: Severity;
  description: string;
  detect(doc: Document): RuleDetection[];
  fix?(doc: Document, finding: Finding, ctx: FixContext): Promise<boolean> | boolean;
}

export interface FixContext {
  page: PageRef;
  env: NodeJS.ProcessEnv;
  llm?: LLMClient;
  getLlm?: () => LLMClient;
  consumeLlmCall?: () => boolean;
  recordFixError?: (message: string) => void;
}

export type WcagLevel = 'A' | 'AA';

export type WcagPrinciple = 'Perceivable' | 'Operable' | 'Understandable' | 'Robust';

export type WcagCriterionStatus =
  | 'pass'
  | 'fail'
  | 'not_applicable'
  | 'manual_review'
  | 'not_tested';

export type WcagCriterionSource = 'scanner' | 'manual' | 'mixed' | 'not_tested';

export interface WcagCriterionDefinition {
  id: string;
  title: string;
  level: WcagLevel;
  principle: WcagPrinciple;
}

export interface WcagEvidence {
  scope?: string;
  owner?: string;
  source: Finding['source'];
  ruleId: string;
  findingId: string;
  severity: Severity;
  message: string;
  selector?: string;
  snippet?: string;
  fixable: boolean;
  exceptionId?: string;
  fixBlockedReason?: string;
  fixBlockedMessage?: string;
  imageUrl?: string;
  imageStatus?: number;
  imageMimeType?: string;
}

export interface WcagCriterionResult extends WcagCriterionDefinition {
  status: WcagCriterionStatus;
  applicabilityReason: string;
  source: WcagCriterionSource;
  evidence: WcagEvidence[];
  updatedAt: string;
}

export interface DojException {
  id: string;
  type: string;
  scope: 'page' | 'evidence';
  status: 'claimed' | 'verified' | 'rejected';
  reason: string;
  evidenceRefs: string[];
  source: 'scanner' | 'manual' | 'import';
  updatedAt: string;
}

export interface WcagReviewSummary {
  score: number | null;
  scorePassCount: number;
  scoreFailCount: number;
  scoreDenominator: number;
  passCount: number;
  failCount: number;
  manualReviewCount: number;
  notTestedCount: number;
  exceptionCount: number;
  verifiedExceptionCount: number;
  notApplicableCount: number;
  complete: boolean;
}

export interface WcagReview {
  target: 'DOJ Title II';
  standard: 'WCAG 2.1 Level A/AA';
  wcagVersion: '2.1';
  generatedAt: string;
  scannedAt: string;
  criteria: WcagCriterionResult[];
  summary: WcagReviewSummary;
}
