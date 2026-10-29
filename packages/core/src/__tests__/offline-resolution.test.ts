import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { DurableLedger } from '../../../conductor-panel/server/durable-ledger.js';
const run = promisify(execFile);
const helper = fileURLToPath(new URL('../../../conductor-panel/server/ledger-helper.py', import.meta.url));
const claim = (n: string) => ({ issuer: 'synthetic', jti: `nonce-${n}`, preview_token: `token-${n}`, target: { hostname: 'example.test', page_id: n }, binding: { action: 'cxone.apply' as const }, subject: 'test-reviewer', expires_at: 1800000000 });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'offline-resolution-'));
  const directory = join(root, 'ledger'); await mkdir(directory);
  const options = { directory, fencePath: join(root, 'fence.json'), trustEpoch: 'synthetic' };
  const owner = await DurableLedger.open({ ...options, initialize: true });
  const snapshot_path = join(root, 'snapshot.html'); await writeFile(snapshot_path, '<p>synthetic</p>');
  for (const n of ['1', '2']) { const op = await owner.claim(claim(n)); await owner.start(op.operation_id, { snapshot_path }); await owner.finish(op.operation_id, { outcome: 'unknown_write' }); }
  const report = await owner.reconciliationReport();
  const selected = report.operations.find(op => op.target.page_id === '1')!;
  const reportFile = join(root, 'report.json'), decisionFile = join(root, 'decision.json');
  const bytes = JSON.stringify(report); await writeFile(reportFile, bytes);
  const decision = { operation_id: selected.operation_id, target: claim('1').target, trust_epoch: 'synthetic', expected_seq: report.durability_seq, expected_state: 'terminal', expected_outcome: 'unknown_write', expected_updated_at: selected.updated_at,
    report_sha256: createHash('sha256').update(bytes).digest('hex'), operator: 'synthetic-operator', reason: 'Synthetic externally settled request, evidence reviewed', external_settlement_acknowledged: true, writer_drained: true };
  await writeFile(decisionFile, JSON.stringify(decision));
  const args = [helper, '--directory', directory, '--fence', options.fencePath, '--epoch', 'synthetic', '--offline-resolve', decisionFile, '--report-file', reportFile];
  return { owner, options, report, selected, decision, decisionFile, reportFile, args };
}
it('requires a drained exclusive owner, appends resolution, preserves unknown/tombstones and releases exactly one target', async () => {
  const f = await fixture();
  try { await expect(run('python3', f.args)).rejects.toMatchObject({ code: 1 }); } finally { await f.owner.close(); }
  const result = JSON.parse((await run('python3', f.args)).stdout);
  expect(result).toMatchObject({ outcome: 'unknown_write', reconciliation: 'resolved', requires_reconciliation: false, applied: null, evidence_effect: 'invalidate' });
  const ledger = await DurableLedger.open(f.options);
  try {
    expect(await ledger.status({ issuer: 'synthetic', jti: 'nonce-1' })).toEqual(result);
    expect(await ledger.status({ issuer: 'synthetic', jti: 'nonce-2' })).toMatchObject({ reconciliation: 'required' });
    await expect(ledger.claim({ ...claim('1'), preview_token: 'fresh-token' })).rejects.toMatchObject({ code: 'claim_conflict' });
    await expect(ledger.claim({ ...claim('1'), jti: 'fresh-nonce' })).rejects.toMatchObject({ code: 'claim_conflict' });
    await ledger.claim({ ...claim('3'), target: claim('1').target });
    await expect(ledger.claim({ ...claim('4'), target: claim('2').target })).rejects.toMatchObject({ code: 'claim_conflict' });
  } finally { await ledger.close(); }
  await expect(run('python3', f.args)).rejects.toMatchObject({ code: 1 });
});
it.each([
  { trust_epoch: 'wrong' }, { expected_seq: 0 }, { expected_state: 'write_started' },
  { expected_outcome: 'not_attempted' }, { expected_updated_at: 'old' },
  { target: { hostname: 'other.test', page_id: '1' } }, { operation_id: 'missing' },
  { report_sha256: '0'.repeat(64) }, { operator: '' }, { reason: '' },
  { external_settlement_acknowledged: false }, { writer_drained: false },
])('refuses mismatched or incomplete operator evidence %j', async patch => {
  const f = await fixture(); await f.owner.close();
  await writeFile(f.decisionFile, JSON.stringify({ ...f.decision, ...patch }));
  await expect(run('python3', f.args)).rejects.toMatchObject({ code: 1, stdout: '{"error":"offline_resolution_refused"}\n' });
  const ledger = await DurableLedger.open(f.options);
  try { expect(await ledger.reconciliationReport()).toEqual(f.report); } finally { await ledger.close(); }
});
it.each(['crash_before_db_commit', 'disk_full_before_commit', 'crash_after_db_commit', 'disk_full_before_fence', 'crash_after_fence_file_fsync', 'crash_after_fence_commit'])(
  'never exposes an uncommitted release after %s', async fault => {
    const f = await fixture(); await f.owner.close();
    await expect(run('python3', [...f.args, '--test-fault', fault, '--test-fault-on', 'resolve'])).rejects.toBeDefined();
    if (['crash_after_db_commit', 'disk_full_before_fence', 'crash_after_fence_file_fsync'].includes(fault)) {
      await expect(DurableLedger.open(f.options)).rejects.toMatchObject({ code: 'claim_store_unavailable' });
    } else {
      const ledger = await DurableLedger.open(f.options);
      try { expect(await ledger.status({ issuer: 'synthetic', jti: 'nonce-1' })).toMatchObject({
        outcome: 'unknown_write', reconciliation: fault === 'crash_after_fence_commit' ? 'resolved' : 'required',
      }); } finally { await ledger.close(); }
    }
  });
it('runs entirely offline and preserves original claim evidence in the report', async () => {
  const f = await fixture(); await f.owner.close();
  const denyNetwork = `import runpy,sys\ndef reject(event,args):\n if event.startswith('socket.'): raise RuntimeError('network forbidden')\nsys.addaudithook(reject)\nsys.argv=sys.argv[1:]\nrunpy.run_path(sys.argv[0],run_name='__main__')`;
  await run('python3', ['-c', denyNetwork, ...f.args]);
  const ledger = await DurableLedger.open(f.options);
  try {
    const op = (await ledger.reconciliationReport()).operations.find(op => op.operation_id === f.selected.operation_id)!;
    expect({ ...op, reconciliation: 'required', requires_reconciliation: true, updated_at: f.selected.updated_at }).toEqual(f.selected);
  } finally { await ledger.close(); }
});

it('rejects a genuinely stale preserved report after another durable event', async () => {
  const f = await fixture(); await f.owner.recordRevocations(['synthetic-retired']); await f.owner.close();
  await expect(run('python3', f.args)).rejects.toMatchObject({ code: 1 });
});
it('refuses missing evidence and missing decision fields without changing claims', async () => {
  const f = await fixture(); await f.owner.close();
  await expect(run('python3', [...f.args.slice(0, -1), f.reportFile + '.missing'])).rejects.toMatchObject({ code: 1 });
  const { operator: _omitted, ...incomplete } = f.decision;
  await writeFile(f.decisionFile, JSON.stringify(incomplete));
  await expect(run('python3', f.args)).rejects.toMatchObject({ code: 1 });
  const ledger = await DurableLedger.open(f.options);
  try { expect(await ledger.reconciliationReport()).toEqual(f.report); } finally { await ledger.close(); }
});
it('rejects an explicitly empty offline path without recovering pending claims', async () => {
  const f = await fixture();
  await f.owner.claim(claim('pending'));
  const before = await f.owner.reconciliationReport(); await f.owner.close();
  const args = [...f.args]; args[args.indexOf('--offline-resolve')+1] = '';
  await expect(run('python3',args,{timeout:1000})).rejects.toMatchObject({code:1,stdout:'{"error":"offline_resolution_refused"}\n'});
  const report = JSON.parse((await run('python3',[helper,'--directory',f.options.directory,'--fence',f.options.fencePath,'--epoch',f.options.trustEpoch,'--readonly-report'])).stdout);
  expect(report).toEqual(before);
});
