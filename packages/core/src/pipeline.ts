import { assertMutationProfileAllowed } from './profile.js';
/**
 * Remediation pipeline orchestrator.
 *
 * Wires together:
 *   1. Deterministic scan (scan.ts)           -> initial findings
 *   2. Deterministic rule fixes (fix.ts path) -> Tier-0 cleanup (optional)
 *   3. LLM strategies (strategies/)           -> Tier 1 / Tier 2
 *   4. Agent loop (agent-loop.ts)             -> Tier 3
 *
 * Between each phase we re-scan and compute the findings delta. If the
 * current tier did not reduce findings by at least `escalateThreshold`
 * (default 50%), we escalate to the next tier until we hit the cap.
 *
 * The strategies module is imported dynamically. If Agent A1 has not
 * landed `packages/core/src/strategies/index.ts` yet (or if it fails to
 * load), we degrade to running just the deterministic fix layer and log
 * a warning — the pipeline still returns a useful result.
 */
import { JSDOM } from 'jsdom';
import { createPatch } from 'diff';
import type Expert from '@libretexts/cxone-expert-node';
import { LLMClient } from './ai/llm-client.js';
import { runAgentLoop } from './agent-loop.js';
import { createExpertClient } from './client.js';
import { defaultRules } from './rules/index.js';
import { scanHtmlFull, scanPage, ScanEngineError } from './scan.js';
import { isNoiseOnlyChange } from './serialize.js';
import { buildTierClient, shouldEscalate } from './tiers.js';
import type { Finding, FixMode, PageRef, Rule } from './types.js';
import { writePageRevision, type WritePageRevisionResult } from './write-page.js';
import { WriteOutcomeError } from './write-safety.js';

export interface PipelineOptions {
  /** Max tier to run. Default 1. */
  tier?: 1 | 2 | 3;
  /** "preview" returns the diff; "apply" writes back to CXone. Default "preview". */
  mode?: FixMode;
  /** Restrict deterministic fixes to these rule ids. */
  onlyRuleIds?: string[];
  /** Shared LLM budget across strategies + agent loop. */
  maxLlmCalls?: number;
  /** Model overrides per tier; fall back to env. */
  tier1Model?: string;
  tier2Model?: string;
  tier1VisionModel?: string;
  tier2VisionModel?: string;
  /**
   * Escalate when Tier-N did not reduce findings by at least this fraction.
   * Default 0.5 — "if Tier 1 didn't cut findings in half, try Tier 2".
   */
  escalateThreshold?: number;
  /** Axe-core on/off for scans. Default true. */
  axe?: boolean;
  /** Override rule set. */
  rules?: Rule[];
  /** Inject an existing Expert client (tests). */
  expert?: Expert;
  env?: NodeJS.ProcessEnv;
  /** Revision summary written on apply. */
  revisionSummary?: string;
}

export interface TierRunRecord {
  tier: number;
  before: number;
  after: number;
  reports: unknown[];
  elapsedMs: number;
}

export interface PipelineResult {
  pageId: number;
  pagePath: string;
  hostname: string;
  tiersRun: TierRunRecord[];
  finalFindingsCount: number;
  finalHtml: string;
  beforeHtml: string;
  diff: string;
  appliedRuleIds: string[];
  applied: boolean;
  writeOutcome?: 'succeeded';
  auditRecorded?: boolean;
  auditError?: 'audit_append_failed';
  applyError?: string;
  revisionSummary?: string;
  snapshotPath?: string;
}

export async function runPipeline(
  pageInput: string | number,
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  const env = opts.env ?? process.env;
  if (opts.mode === 'apply') assertMutationProfileAllowed(env);
  const expert = opts.expert ?? createExpertClient(env);
  const rules = opts.rules ?? defaultRules;
  const mode: FixMode = opts.mode ?? 'preview';
  const tierCap = opts.tier ?? 1;
  const threshold = opts.escalateThreshold ?? 0.5;
  const axe = opts.axe ?? true;

  // Phase 1: scan.
  const scan = await scanPage(pageInput, { expert, rules, env, axe });
  const page: PageRef = scan.page;
  const beforeHtml = scan.html;
  const beforeFindings = scan.findings;

  const tiersRun: TierRunRecord[] = [];
  let currentHtml = beforeHtml;
  let currentFindings: Finding[] = beforeFindings;

  // Load the strategy runner lazily. If it's missing we still run Tier 3
  // (agent loop) if requested; Tier 1/2 degrade to "no-op strategies".
  const strategyRunner = await loadStrategyRunner(env);

  for (let tier: 1 | 2 | 3 = 1; tier <= tierCap; tier = (tier + 1) as 1 | 2 | 3) {
    if (currentFindings.length === 0) break;

    const t0 = Date.now();
    const before = currentFindings.length;
    let reports: unknown[] = [];

    if (tier === 3) {
      // Agent loop.
      const client = buildTierClient(
        {
          tier: 3,
          textModel: opts.tier2Model ?? opts.tier1Model,
          visionModel: opts.tier2VisionModel ?? opts.tier1VisionModel,
        },
        env,
      );
      try {
        const loop = await runAgentLoop({
          client,
          html: currentHtml,
          findings: currentFindings,
          page,
          rules,
          env,
          maxIterations: 8,
        });
        currentHtml = loop.finalHtml;
        reports = [{ kind: 'agent-loop', iterations: loop.iterations }];
      } catch (err) {
        if (err instanceof ScanEngineError) throw err;
        reports = [{ kind: 'agent-loop', error: errorMessage(err) }];
      }
    } else {
      // Tier 1 / Tier 2 strategy run.
      const tierCfg =
        tier === 1
          ? {
              tier: 1 as const,
              textModel: opts.tier1Model,
              visionModel: opts.tier1VisionModel,
            }
          : {
              tier: 2 as const,
              textModel: opts.tier2Model,
              visionModel: opts.tier2VisionModel,
            };

      // Tier 2 requires either an explicit override or REMEDY_TIER2_TEXT_MODEL
      // in env. If neither is set we still run strategies but with the
      // Tier-1 client — the escalation check below will stop us from
      // looping forever when Tier 2 produces identical output.
      const client = buildTierClient(tierCfg, env);

      if (strategyRunner) {
        try {
          const out = await strategyRunner.run(currentHtml, {
            hostname: page.hostname,
            pageId: page.id,
            pagePath: page.path,
            llm: client,
            maxLlmCalls: opts.maxLlmCalls,
          });
          currentHtml = out.html;
          reports = out.reports;
        } catch (err) {
          if (err instanceof ScanEngineError) throw err;
          reports = [{ kind: 'strategy-error', error: errorMessage(err) }];
        }
      } else {
        // No strategies module loaded. Fall back to running deterministic
        // rule fixes in place — this still produces some improvement when
        // Tier 1 gets invoked.
        const det = await runDeterministicFixes({
          html: currentHtml,
          findings: currentFindings,
          rules,
          page,
          env,
          onlyRuleIds: opts.onlyRuleIds,
        });
        currentHtml = det.html;
        reports = [
          {
            kind: 'deterministic-fallback',
            applied: det.applied,
            attempted: det.attempted,
            note: 'strategies/ module unavailable; ran rule.fix() pass only',
          },
        ];
      }
    }

    // Re-scan after the tier's work.
    currentFindings = await scanHtmlFull(currentHtml, { rules, axe });
    const after = currentFindings.length;
    const elapsedMs = Date.now() - t0;

    tiersRun.push({ tier, before, after, reports, elapsedMs });

    if (after === 0) break;
    if (!shouldEscalate(before, after, threshold)) break;
    if (tier >= tierCap) break;
  }

  // Diff.
  const diff = createPatch(
    page.path || `page-${page.id}`,
    beforeHtml,
    currentHtml,
    'before',
    'after',
    { context: 3 },
  );

  // Apply gate (mirrors fix.ts guardrails — we cannot call fixPage in apply
  // mode because it would re-derive the "after" HTML from scratch).
  const appliedRuleIds = collectAppliedRules(tiersRun);
  let applied = false;
  let writeOutcome: WritePageRevisionResult | undefined;
  let applyError: string | undefined;
  let revisionSummary: string | undefined;
  let snapshotPath: string | undefined;
  if (mode === 'apply' && currentHtml !== beforeHtml && !isNoiseOnlyChange(beforeHtml, currentHtml)) {
    try {
      revisionSummary =
        opts.revisionSummary ??
        `remedy-pipeline: ${tiersRun.map((t) => `T${t.tier}:${t.before}→${t.after}`).join(' ')}`;
      const write = await writePageRevision({
        expert,
        pageInput,
        page,
        beforeHtml,
        afterHtml: currentHtml,
        rules: appliedRuleIds,
        revisionSummary,
        source: 'pipeline',
        env,
      });
      writeOutcome = write;
      applied = write.written;
      snapshotPath = write.snapshotPath;
    } catch (err) {
      if (err instanceof WriteOutcomeError) throw err;
      applyError = errorMessage(err);
    }
  }

  return {
    pageId: page.id,
    pagePath: page.path,
    hostname: page.hostname,
    tiersRun,
    finalFindingsCount: currentFindings.length,
    finalHtml: currentHtml,
    beforeHtml,
    diff,
    appliedRuleIds,
    applied,
    writeOutcome: writeOutcome?.writeOutcome,
    auditRecorded: writeOutcome?.auditRecorded,
    auditError: writeOutcome?.auditError,
    applyError,
    revisionSummary,
    snapshotPath,
  };
}

// ---------- helpers ----------

interface StrategyRunnerLike {
  run(
    html: string,
    ctx: {
      hostname: string;
      pageId?: number;
      pagePath?: string;
      llm?: LLMClient;
      maxLlmCalls?: number;
    },
  ): Promise<{ html: string; reports: unknown[] }>;
}

async function loadStrategyRunner(env: NodeJS.ProcessEnv): Promise<StrategyRunnerLike | null> {
  try {
    // Dynamic import so the package still builds when strategies/index.ts
    // doesn't exist yet (Agent A1 is landing it in parallel).
    const mod = (await import('./strategies/index.js')) as unknown as {
      StrategyRunner?: new (strategies?: unknown[]) => StrategyRunnerLike;
      createStrategyRunner?: () => StrategyRunnerLike;
      defaultStrategies?: unknown[];
    };
    if (typeof mod.createStrategyRunner === 'function') {
      return mod.createStrategyRunner();
    }
    if (typeof mod.StrategyRunner === 'function') {
      return new mod.StrategyRunner(mod.defaultStrategies);
    }
    if (env.DEBUG) {
      console.warn(
        'pipeline: strategies/index.ts loaded but no StrategyRunner/createStrategyRunner export found; falling back.',
      );
    }
    return null;
  } catch (err) {
    if (env.DEBUG) {
      console.warn(
        'pipeline: strategies/ module unavailable, falling back to deterministic fixes only:',
        errorMessage(err),
      );
    }
    return null;
  }
}

async function runDeterministicFixes({
  html,
  findings,
  rules,
  page,
  env,
  onlyRuleIds,
}: {
  html: string;
  findings: Finding[];
  rules: Rule[];
  page: PageRef;
  env: NodeJS.ProcessEnv;
  onlyRuleIds?: string[];
}): Promise<{ html: string; attempted: string[]; applied: string[] }> {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  const doc = dom.window.document;
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const attempted: string[] = [];
  const applied: string[] = [];
  const filter = onlyRuleIds ? new Set(onlyRuleIds) : null;

  for (const f of findings) {
    if (filter && !filter.has(f.ruleId)) continue;
    const rule = ruleById.get(f.ruleId);
    if (!rule?.fix) continue;
    attempted.push(f.ruleId);
    try {
      const ok = await rule.fix(doc, f, { page, env });
      if (ok) applied.push(f.ruleId);
    } catch (err) {
      if (env.DEBUG) console.error(`pipeline fallback fix ${f.ruleId} threw:`, err);
    }
  }

  return {
    html: doc.body.innerHTML,
    attempted: unique(attempted),
    applied: unique(applied),
  };
}

function collectAppliedRules(tiersRun: TierRunRecord[]): string[] {
  const rules = new Set<string>();
  for (const t of tiersRun) {
    for (const r of t.reports) {
      if (r && typeof r === 'object') {
        const rep = r as Record<string, unknown>;
        if (Array.isArray(rep.fixesApplied)) {
          for (const id of rep.fixesApplied) if (typeof id === 'string') rules.add(id);
        }
        if (Array.isArray(rep.applied)) {
          for (const id of rep.applied) if (typeof id === 'string') rules.add(id);
        }
      }
    }
  }
  return Array.from(rules);
}

function unique<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
