#!/usr/bin/env node
import 'dotenv/config';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { Command } from 'commander';
import kleur from 'kleur';
import {
  assertMutationProfileAllowed,
  scanPage,
  fixPage,
  runPipeline,
  listPageSnapshots,
  revertPage,
  describeClient,
  createExpertClient,
  restoreTagsFromManifest,
  revertPageTags,
  MissingEnvError,
  WriteNotAllowedError,
  WriteOutcomeError,
  writePageRevision,
  hashContent,
} from '@libretexts/remedy-core';
import type { TagRestoreManifest } from '@libretexts/remedy-core';
import { readFile } from 'node:fs/promises';
import { formatScanHuman } from './format.js';
import { scanFile } from './scan-file.js';
import { pipelineFile } from './pipeline-file.js';
import { confirm } from './confirm.js';

export const program = new Command();

program.hook('preAction', (_command, action) => {
  const opts = action.opts();
  if (opts.apply || (['revert','tags-restore','tags-revert'].includes(action.name()) && !opts.dryRun)) assertMutationProfileAllowed();
});

program
  .name('remedy')
  .description('LibreTexts accessibility remediation CLI')
  .version('0.0.1');

program
  .command('env')
  .description('Show which CXone Expert environment is configured (tokens masked).')
  .action(() => {
    console.log(describeClient());
  });

program
  .command('scan-file')
  .description('Scan a local HTML file (no API credentials required).')
  .argument('<file>', 'path to an HTML file')
  .option('-o, --out <file>', 'write findings JSON to this file')
  .option('--json', 'print findings as JSON to stdout (machine-readable)')
  .action(async (file: string, opts: { out?: string; json?: boolean }) => {
    try {
      const code = await scanFile(file, opts);
      process.exitCode = code;
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('pipeline-file')
  .description('Run the full remediation pipeline locally against an HTML file. No CXone writes.')
  .argument('<file>', 'path to an HTML file')
  .option('-o, --out <dir>', 'output directory (default: .remedy/local/<basename>)')
  .option('--only <ids>', 'comma-separated rule ids to restrict findings')
  .option('--max-llm <n>', 'cap LLM calls (0 disables LLM-dependent strategies)')
  .option('--json', 'machine-readable summary to stdout')
  .action(
    async (
      file: string,
      opts: { out?: string; only?: string; maxLlm?: string; json?: boolean },
    ) => {
      try {
        const code = await pipelineFile(file, opts);
        process.exitCode = code;
      } catch (err) {
        handleError(err);
      }
    },
  );

program
  .command('scan')
  .description('Scan a LibreTexts page and report accessibility findings.')
  .argument('<page>', 'page URL, path (Sandboxes/…), or numeric id')
  .option('-o, --out <file>', 'write findings JSON to this file')
  .option('--html <file>', 'write fetched HTML to this file')
  .option('--json', 'print findings as JSON to stdout (machine-readable)')
  .action(async (page: string, opts: { out?: string; html?: string; json?: boolean }) => {
    try {
      const result = await scanPage(page);
      const { html, ...withoutHtml } = result;

      if (opts.out) {
        const outPath = resolve(opts.out);
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, JSON.stringify(withoutHtml, null, 2), 'utf8');
        console.error(kleur.dim(`wrote findings → ${outPath}`));
      }
      if (opts.html) {
        const htmlPath = resolve(opts.html);
        await mkdir(dirname(htmlPath), { recursive: true });
        await writeFile(htmlPath, html, 'utf8');
        console.error(kleur.dim(`wrote html     → ${htmlPath}`));
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(withoutHtml, null, 2) + '\n');
      } else {
        console.log(formatScanHuman(result));
      }

      if (result.stats.bySeverity.error > 0) process.exitCode = 1;
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('fix')
  .description(
    'Generate fixes for a page. Dry-run by default — writes a diff + fixed.html locally, no server write.',
  )
  .argument('<page>', 'page URL, path, or numeric id')
  .option('--apply', 'write fixes back to CXone as a new revision (requires confirmation)')
  .option('--i-have-confirmed', 'skip the interactive y/N gate (still honors allowlist + audit log)')
  .option('--only <ruleIds>', 'comma-separated rule ids to fix (default: all fixable)')
  .option('--out-dir <dir>', 'directory for diff/fixed.html/findings.json', 'out')
  .option('--message <msg>', 'custom revision summary')
  .action(
    async (
      page: string,
      opts: {
        apply?: boolean;
        iHaveConfirmed?: boolean;
        only?: string;
        outDir: string;
        message?: string;
      },
    ) => {
      try {
        const mode: 'preview' | 'apply' = opts.apply ? 'apply' : 'preview';
        const onlyRuleIds = opts.only ? opts.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

        // For apply mode, gate on confirmation BEFORE doing expensive work (vision call, etc.).
        // For preview, proceed directly.
        const result = await fixPage(page, {
          mode: 'preview',
          onlyRuleIds,
          revisionSummary: opts.message,
        });

        const outDir = resolve(opts.outDir);
        await mkdir(outDir, { recursive: true });
        const diffPath = resolve(outDir, `${slugify(result.page.path || String(result.page.id))}.diff`);
        const htmlPath = resolve(outDir, `${slugify(result.page.path || String(result.page.id))}.fixed.html`);
        const findingsPath = resolve(outDir, `${slugify(result.page.path || String(result.page.id))}.findings.json`);
        await writeFile(diffPath, result.diff, 'utf8');
        await writeFile(htmlPath, result.after, 'utf8');
        await writeFile(
          findingsPath,
          JSON.stringify({ page: result.page, findings: result.findings }, null, 2),
          'utf8',
        );

        console.log(kleur.bold(`Page ${result.page.id}  ${result.page.title ?? ''}`));
        console.log(kleur.dim(`  path: ${result.page.path}`));
        console.log();
        console.log(
          `Attempted: ${kleur.cyan(result.attempted.join(', ') || '(none)')}\n` +
          `Applied:   ${kleur.green(result.applied.join(', ') || '(none)')}`,
        );
        const changedBytes = Math.abs(result.after.length - result.before.length);
        console.log(
          `Changed:   ${result.before === result.after ? kleur.dim('no changes') : kleur.yellow(`${changedBytes}B delta`)}`,
        );
        console.log();
        console.log(kleur.dim(`wrote diff     → ${diffPath}`));
        console.log(kleur.dim(`wrote html     → ${htmlPath}`));
        console.log(kleur.dim(`wrote findings → ${findingsPath}`));

        if (mode === 'preview') {
          console.log();
          console.log(kleur.cyan('Preview only. Re-run with --apply to write back to CXone.'));
          return;
        }

        // Apply mode
        if (result.before === result.after) {
          console.log(kleur.dim('\nNo changes to apply — skipping write.'));
          return;
        }

        if (!opts.iHaveConfirmed) {
          const ok = await confirm(
            `\nApply ${result.applied.length} fix(es) to ${result.page.path} on ${result.page.hostname}?`,
            'n',
          );
          if (!ok) {
            console.log(kleur.yellow('Aborted.'));
            process.exitCode = 4;
            return;
          }
        }

        const appliedResult = await writePageRevision({
          expert: createExpertClient(), pageInput: page, page: result.page,
          beforeHtml: result.before, afterHtml: result.after, rules: result.applied,
          source: 'fix', revisionSummary: opts.message ?? `remedy-v0: fix ${result.applied.join(',')}`,
        });
        reportAuditFailure(appliedResult);
        if (appliedResult.written) {
          console.log(
            kleur.green(`✓ Revision written.`) + kleur.dim(` ${appliedResult.revisionSummary ?? ''}`),
          );
        } else {
          console.log(kleur.yellow('Apply produced no write (no effective changes).'));
        }
      } catch (err) {
        handleError(err);
      }
    },
  );

program
  .command('snapshots')
  .description('List on-disk HTML snapshots saved before a page was last written.')
  .argument('<page>', 'page URL, path, or numeric id')
  .action(async (page: string) => {
    try {
      const snapshots = await listPageSnapshots(page);
      if (snapshots.length === 0) {
        console.log(kleur.dim('No snapshots recorded for this page.'));
        return;
      }
      console.log(kleur.bold(`Snapshots for page (newest first):`));
      for (const s of snapshots) {
        console.log(
          `  ${kleur.cyan(s.meta.ts)}  ${kleur.dim(s.meta.hash)}  ` +
          `${s.meta.bytes.toLocaleString()}B  ` +
          kleur.dim(`rules=${s.meta.rules.join(',') || '∅'}  source=${s.meta.source ?? '?'}`),
        );
        console.log(kleur.dim(`    html: ${s.htmlPath}`));
      }
    } catch (err) {
      handleError(err);
    }
  });

program
  .command('revert')
  .description('Restore a page from a saved snapshot. Saves an extra pre-revert safety snapshot.')
  .argument('<page>', 'page URL, path, or numeric id')
  .option('--snapshot <ts>', 'pin a specific snapshot by its ISO timestamp (defaults to newest)')
  .option('--snapshot-path <path>', 'pin a specific snapshot by the .json or .html path')
  .option('--dry-run', 'show what would change; do not write')
  .option('--i-have-confirmed', 'skip the interactive y/N prompt')
  .option('--message <msg>', 'custom revision summary written to CXone')
  .action(
    async (
      page: string,
      opts: { snapshot?: string; snapshotPath?: string; dryRun?: boolean; iHaveConfirmed?: boolean; message?: string },
    ) => {
      try {
        // First, dry-run to compute the diff and show it.
        const preview = await revertPage(page, {
          snapshotTs: opts.snapshot,
          snapshotPath: opts.snapshotPath,
          dryRun: true,
        });
        console.log(kleur.bold(`Page ${preview.pageId}  ${preview.pagePath}`));
        console.log(kleur.dim(`  using snapshot: ${preview.snapshotUsed.ts}  (${preview.snapshotUsed.hash})`));
        console.log(kleur.dim(`  html: ${preview.snapshotUsed.htmlPath}`));
        if (preview.currentHtml === preview.revertedToHtml) {
          console.log(kleur.green('✓ Live page already matches the snapshot — nothing to do.'));
          return;
        }
        const delta = Math.abs(preview.currentHtml.length - preview.revertedToHtml.length);
        console.log(kleur.yellow(`  byte delta: ${delta}B`));

        if (opts.dryRun) {
          console.log(kleur.cyan('Dry-run only. Re-run without --dry-run to restore.'));
          return;
        }
        if (!opts.iHaveConfirmed) {
          const ok = await confirm(
            `Restore page ${preview.pagePath} to snapshot ${preview.snapshotUsed.ts}?`,
            'n',
          );
          if (!ok) {
            console.log(kleur.yellow('Aborted.'));
            process.exitCode = 4;
            return;
          }
        }
        const result = await revertPage(preview.pageId, {
          snapshotPath: preview.snapshotUsed.metaPath,
          revisionSummary: opts.message,
          expectedCurrentHash: hashContent(preview.currentHtml),
          expectedRestoredHash: hashContent(preview.revertedToHtml),
        });
        reportAuditFailure({ ...result, snapshotPath: result.preRevertSnapshotPath });
        if (result.written) {
          console.log(kleur.green('✓ Page restored.'));
          console.log(kleur.dim(`  pre-revert safety snapshot: ${result.preRevertSnapshotPath}`));
          if (result.cxoneRevisionId !== undefined) {
            console.log(kleur.dim(`  CXone revision id: ${result.cxoneRevisionId}`));
          }
        } else {
          console.log(kleur.yellow('No write performed (live state already matched snapshot).'));
        }
      } catch (err) {
        handleError(err);
      }
    },
  );

program
  .command('pipeline')
  .description(
    'Run the full remediation pipeline (deterministic + strategies + optional agent loop). ' +
    'Preview-only by default; always writes an on-disk snapshot before any --apply.',
  )
  .argument('<page>', 'page URL, path, or numeric id')
  .option('--tier <n>', 'max tier to run (1 cheap, 2 strong, 3 agent loop)', (v) => Number(v), 1)
  .option('--apply', 'write the final HTML back to CXone as a new revision (gated)')
  .option('--i-have-confirmed', 'skip the interactive y/N prompt on apply')
  .option('--max-llm-calls <n>', 'budget for LLM calls across the run', (v) => Number(v), 30)
  .option('--only <ruleIds>', 'comma-separated rule ids to fix (default: all fixable)')
  .option('--out-dir <dir>', 'directory for diff/fixed.html/result.json', 'out')
  .option('--message <msg>', 'custom revision summary')
  .action(
    async (
      page: string,
      opts: {
        tier: number;
        apply?: boolean;
        iHaveConfirmed?: boolean;
        maxLlmCalls: number;
        only?: string;
        outDir: string;
        message?: string;
      },
    ) => {
      try {
        const tier = [1, 2, 3].includes(opts.tier) ? (opts.tier as 1 | 2 | 3) : 1;
        // Always run preview first so we can show the diff + collect a snapshot path.
        const previewResult = await runPipeline(page, {
          tier,
          mode: 'preview',
          maxLlmCalls: opts.maxLlmCalls,
          onlyRuleIds: opts.only ? opts.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
          revisionSummary: opts.message,
        });

        const outDir = resolve(opts.outDir);
        await mkdir(outDir, { recursive: true });
        const slug = slugify(previewResult.pagePath || String(previewResult.pageId));
        const diffPath = resolve(outDir, `${slug}.pipeline.diff`);
        const htmlPath = resolve(outDir, `${slug}.pipeline.fixed.html`);
        const resultPath = resolve(outDir, `${slug}.pipeline.json`);
        await writeFile(diffPath, previewResult.diff, 'utf8');
        await writeFile(htmlPath, previewResult.finalHtml, 'utf8');
        await writeFile(resultPath, JSON.stringify(previewResult, null, 2), 'utf8');

        console.log(kleur.bold(`Page ${previewResult.pageId}  ${previewResult.pagePath}`));
        for (const t of previewResult.tiersRun) {
          console.log(
            `  Tier ${t.tier}: ${kleur.yellow(String(t.before))} → ${kleur.green(String(t.after))} findings` +
            kleur.dim(`  (${t.elapsedMs}ms)`),
          );
        }
        console.log(
          `  Final findings: ${kleur.bold(String(previewResult.finalFindingsCount))}  ` +
          (previewResult.beforeHtml === previewResult.finalHtml
            ? kleur.dim('no html change')
            : kleur.yellow(`${Math.abs(previewResult.finalHtml.length - previewResult.beforeHtml.length)}B delta`)),
        );
        console.log(kleur.dim(`wrote diff   → ${diffPath}`));
        console.log(kleur.dim(`wrote html   → ${htmlPath}`));
        console.log(kleur.dim(`wrote result → ${resultPath}`));

        if (!opts.apply) {
          console.log(kleur.cyan('Preview only. Re-run with --apply to write back to CXone.'));
          return;
        }
        if (previewResult.beforeHtml === previewResult.finalHtml) {
          console.log(kleur.dim('No html change produced — skipping write.'));
          return;
        }
        if (!opts.iHaveConfirmed) {
          const ok = await confirm(
            `Apply pipeline result to ${previewResult.pagePath} on ${previewResult.hostname}? (a pre-write snapshot will be saved)`,
            'n',
          );
          if (!ok) {
            console.log(kleur.yellow('Aborted.'));
            process.exitCode = 4;
            return;
          }
        }
        const applyResult = await writePageRevision({
          expert: createExpertClient(), pageInput: page,
          page: { id: previewResult.pageId, path: previewResult.pagePath, hostname: previewResult.hostname },
          beforeHtml: previewResult.beforeHtml, afterHtml: previewResult.finalHtml,
          rules: previewResult.appliedRuleIds, source: 'pipeline',
          revisionSummary: opts.message ?? `remedy-pipeline: reviewed Tier ${tier} result`,
        });
        reportAuditFailure(applyResult);
        if (applyResult.written) {
          console.log(kleur.green('✓ Revision written. Pre-write snapshot saved under .remedy/snapshots/.'));
          console.log(kleur.dim('  Run  remedy revert <page>  to restore.'));
        } else {
          console.log(kleur.yellow('Apply produced no write (empty delta).'));
        }
      } catch (err) {
        handleError(err);
      }
    },
  );

program
  .command('tags-restore')
  .description(
    'Restore license/attribution page tags from a manifest (built by tools/build-biology-tag-manifest.mjs). Merges: never removes an existing tag.',
  )
  .requiredOption('--manifest <file>', 'manifest JSON with per-page restore lists')
  .option('--page <id>', 'only touch this sandbox page id (one-page trial)', (v) => Number(v))
  .option('--dry-run', 'show the per-page tag diff; do not write')
  .option('--i-have-confirmed', 'skip the interactive y/N prompt')
  .option('--message <msg>', 'revision summary recorded in the audit log', 'REM-02: restore license and attribution tags')
  .option('-o, --out <file>', 'write the per-page results JSON to this file')
  .action(
    async (opts: { manifest: string; page?: number; dryRun?: boolean; iHaveConfirmed?: boolean; message: string; out?: string }) => {
      try {
        const manifest = JSON.parse(await readFile(opts.manifest, 'utf8')) as TagRestoreManifest;
        const expert = createExpertClient();
        const inScope = opts.page === undefined ? manifest.pages : manifest.pages.filter((p) => p.sandboxPageId === opts.page);
        const eligible = inScope.filter((p) => p.crosscheck !== 'mismatch');
        console.log(kleur.bold(`${inScope.length} page(s) in scope, ${eligible.length} eligible (cross-check ok)`));

        // Always plan first so the operator sees the diff before any write.
        const plan = await restoreTagsFromManifest(manifest, { expert, dryRun: true, onlyPageId: opts.page });
        let toWrite = 0;
        for (const r of plan) {
          const added = r.result?.added ?? [];
          const tag = r.status === 'skipped-crosscheck' ? kleur.red('SKIP') : added.length ? kleur.yellow(`+${added.length}`) : kleur.dim('ok');
          console.log(`  ${tag.padEnd(14)} ${r.sandboxPageId}  ${r.sandboxPath}` + (added.length ? kleur.dim(`  ${added.join(' ')}`) : ''));
          if (r.status === 'planned' && added.length) toWrite++;
        }
        if (opts.dryRun) {
          console.log(kleur.cyan(`Dry-run only. ${toWrite} page(s) would be written.`));
          if (opts.out) await writeFile(opts.out, JSON.stringify(plan, null, 2) + '\n', 'utf8');
          return;
        }
        if (toWrite === 0) {
          console.log(kleur.green('✓ Nothing to write.'));
          return;
        }
        if (!opts.iHaveConfirmed) {
          const ok = await confirm(`Write tags to ${toWrite} page(s) on ${describeClient()}?`, 'n');
          if (!ok) {
            console.log(kleur.yellow('Aborted.'));
            return;
          }
        }
        const results = await restoreTagsFromManifest(manifest, { expert, onlyPageId: opts.page, revisionSummary: opts.message });
        const counts: Record<string, number> = {};
        for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
        for (const r of results) {
          if (r.result) reportAuditFailure(r.result);
          if (r.status === 'error') console.log(kleur.red(`  ✖ ${r.sandboxPageId}  ${r.error}`));
        }
        console.log(kleur.green(`✓ done: ${JSON.stringify(counts)}`));
        if (opts.out) await writeFile(opts.out, JSON.stringify(results, null, 2) + '\n', 'utf8');
      } catch (err) {
        handleError(err);
      }
    },
  );

program
  .command('tags-revert')
  .description('Put a page\'s tag list back to exactly what a *.tags.json snapshot recorded (replace, not merge).')
  .requiredOption('--snapshot-path <path>', 'the .tags.json file written by tags-restore')
  .option('--i-have-confirmed', 'skip the interactive y/N prompt')
  .action(async (opts: { snapshotPath: string; iHaveConfirmed?: boolean }) => {
    try {
      const snapshot = JSON.parse(await readFile(opts.snapshotPath, 'utf8')) as { meta: { pageId: number; pagePath: string }; tags: string[] };
      console.log(kleur.bold(`Page ${snapshot.meta.pageId}  ${snapshot.meta.pagePath}`));
      console.log(kleur.dim(`  revert to: [${snapshot.tags.join(', ')}]`));
      if (!opts.iHaveConfirmed) {
        const ok = await confirm(`Replace the live tag list on page ${snapshot.meta.pageId} with the snapshot?`, 'n');
        if (!ok) {
          console.log(kleur.yellow('Aborted.'));
          return;
        }
      }
      const r = await revertPageTags({ expert: createExpertClient(), snapshotPath: opts.snapshotPath });
      if (!r.written) {
        console.log(kleur.green('✓ Live tags already match the snapshot — nothing to do.'));
        return;
      }
      reportAuditFailure(r);
      console.log(kleur.green(`✓ reverted: -${r.removed.length} +${r.added.length}; safety snapshot ${r.snapshotPath}`));
    } catch (err) {
      handleError(err);
    }
  });

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'page';
}

function reportAuditFailure(result: { auditRecorded?: boolean; snapshotPath?: string }): void {
  if (result.auditRecorded === false) {
    console.error(kleur.yellow(`Write succeeded, but audit recording failed. Preserve snapshot ${result.snapshotPath ?? '(see snapshot storage)'} and reconcile the audit; do not repeat the write.`));
  }
}

function handleError(err: unknown): never {
  if (err instanceof MissingEnvError) {
    console.error(kleur.red('✖ Missing environment configuration.'));
    console.error(kleur.dim(err.message));
    console.error(kleur.dim('Copy .env.example to .env and fill in SERVER_DOMAIN/KEY/SECRET/USER.'));
    process.exit(2);
  }
  if (err instanceof WriteNotAllowedError) {
    console.error(kleur.red('✖ Write refused by namespace allowlist.'));
    console.error(kleur.dim(err.message));
    process.exit(3);
  }
  if (err instanceof WriteOutcomeError) {
    console.error(kleur.red('Write outcome unknown. Do not retry; reconcile CXone revision history first.'));
    console.error(kleur.dim(`Recovery snapshot: ${err.snapshotPath ?? '(see snapshot storage)'}`));
    process.exit(5);
  }
  console.error(kleur.red('✖ Unexpected error:'), err instanceof Error ? err.message : err);
  if (process.env.DEBUG) console.error(err);
  process.exit(10);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  program.parseAsync(process.argv).catch(handleError);
}
