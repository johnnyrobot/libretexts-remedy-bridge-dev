import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, copyFile, readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableLedger } from '../../../conductor-panel/server/durable-ledger.js';

const opened: DurableLedger[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(ledger => ledger.close())); });
async function store() {
  const root = await mkdtemp(join(tmpdir(), 'remedy-ledger-'));
  const directory = join(root, 'ledger'); await mkdir(directory);
  return { directory, fencePath: join(root, 'fence.json'), trustEpoch: 'synthetic-epoch-1' };
}
async function open(options: Parameters<typeof DurableLedger.open>[0]) {
  const ledger = await DurableLedger.open(options); opened.push(ledger); return ledger;
}
const input = (suffix = '1', page_id = '1') => ({ issuer: 'test-issuer', jti: `nonce-${suffix}`, preview_token: `preview-${suffix}`,
  target: { hostname: 'example.test', page_id }, binding: { action: 'cxone.apply' as const, before_sha256: 'a'.repeat(64), after_sha256: 'b'.repeat(64) },
  subject: 'reviewer-1', expires_at: 1_800_000_060 });

it('durably claims a nonce/token/target and exposes only fixed status metadata', async () => {
  const options = await store();
  const ledger = await open({ ...options, initialize: true });
  expect(ledger.ready).toBe(true);
  const pending = await ledger.claim(input());
  expect(pending).toMatchObject({ action: 'cxone.apply', outcome: 'pending', applied: null, restored: false, evidence_effect: 'hold' });
  await expect(ledger.claim(input())).rejects.toMatchObject({ code: 'claim_conflict' });
  await expect(ledger.claim(input('2'))).rejects.toMatchObject({ code: 'claim_conflict' });
  await ledger.finish(pending.operation_id, { outcome: 'not_attempted', reason: 'no_change' });
  const status = await ledger.status({ issuer: 'test-issuer', jti: 'nonce-1' });
  expect(status).toMatchObject({ outcome: 'not_attempted', applied: false, restored: false, reason: 'no_change', evidence_effect: 'preserve' });
  expect(Object.keys(status!).sort()).toEqual(['action', 'applied', 'audit_recorded', 'evidence_effect', 'operation_id', 'outcome', 'reason', 'reconciliation', 'requires_reconciliation', 'restored', 'updated_at']);
  await ledger.close();
  const restarted = await open(options);
  expect(await restarted.status({ issuer: 'test-issuer', jti: 'nonce-1' })).toEqual(status);
  await expect(restarted.claim(input())).rejects.toMatchObject({ code: 'claim_conflict' });
  await restarted.claim(input('2'));
});

it('persists dispatch and quarantines an uncertain attempt across restart', async () => {
  const options = await store(); const ledger = await open({ ...options, initialize: true });
  const claimed = await ledger.claim(input());
  const snapshot_path = join(options.directory, 'snapshot.html'); await writeFile(snapshot_path, '<p>synthetic</p>');
  await ledger.start(claimed.operation_id, { snapshot_path });
  await expect(ledger.finish(claimed.operation_id, { outcome: 'not_attempted' })).rejects.toMatchObject({ code: 'invalid_transition' });
  await ledger.close();
  const restarted = await open(options);
  expect(await restarted.status({ issuer: 'test-issuer', jti: 'nonce-1' })).toMatchObject({
    operation_id: claimed.operation_id, outcome: 'unknown_write', applied: null, restored: false,
    requires_reconciliation: true, reconciliation: 'required', evidence_effect: 'invalidate', reason: 'write_outcome_unknown',
  });
  await expect(restarted.claim(input('2'))).rejects.toMatchObject({ code: 'claim_conflict' });
  await expect(restarted.finish(claimed.operation_id, { outcome: 'known_success', audit_recorded: true })).rejects.toMatchObject({ code: 'invalid_transition' });
});

it('persists successful writes, pre-dispatch recovery and monotonic revocations without repairing by reads', async () => {
  const options = await store(); const ledger = await open({ ...options, initialize: true });
  await ledger.recordRevocations(['retired-key']);
  await ledger.recordRevocations([]);
  const pending = await ledger.claim(input());
  const before = await ledger.status({ issuer: 'test-issuer', jti: 'nonce-1' });
  expect(await ledger.reconciliationReport()).toMatchObject({ operations: [before] });
  expect(await ledger.status({ issuer: 'test-issuer', jti: 'nonce-1' })).toEqual(before);
  await ledger.close();
  const restarted = await open(options);
  expect(await restarted.isRevoked('retired-key')).toBe(true);
  expect(await restarted.getRevocations()).toEqual(['retired-key']);
  expect(await restarted.isRevoked('new-key')).toBe(false);
  expect(await restarted.status({ issuer: 'test-issuer', jti: 'nonce-1' })).toMatchObject({ outcome: 'not_attempted', reason: 'pre_dispatch_failure', operation_id: pending.operation_id });
  const restore = await restarted.claim({ ...input('2'), binding: { action: 'cxone.restore' } });
  const snapshot_path = join(options.directory, 'snapshot.html'); await writeFile(snapshot_path, '<p>before</p>');
  await restarted.start(restore.operation_id, { snapshot_path });
  expect(await restarted.finish(restore.operation_id, { outcome: 'known_success', audit_recorded: false, cxone_revision_id: '9' })).toMatchObject({
    outcome: 'known_success', applied: false, restored: true, audit_recorded: false, evidence_effect: 'invalidate',
  });
  await expect(restarted.claim({ ...input('3'), preview_token: 'preview-2' })).rejects.toMatchObject({ code: 'claim_conflict' });
});

const helperPath = fileURLToPath(new URL('../../../conductor-panel/server/ledger-helper.py', import.meta.url));
async function helper(options: Awaited<ReturnType<typeof store>>, fault?: string, on = 'claim') {
  const child = spawn('python3', ['-u', helperPath, '--directory', options.directory, '--fence', options.fencePath,
    '--epoch', options.trustEpoch, ...(fault ? ['--test-fault', fault, '--test-fault-on', on] : [])], { stdio: 'pipe' });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  const reader = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const first = await reader.next();
  return { child, exited, ready: first.done ? false : JSON.parse(first.value).ready,
    async command(command: string, data: unknown) {
      child.stdin.write(JSON.stringify({ id: 1, command, data }) + '\n');
      const next = await reader.next(); return next.done ? null : JSON.parse(next.value);
    },
    async stop() { child.stdin.end(); await exited; },
  };
}

it('retains a stable OS lock inode and rejects an actual second process', async () => {
  const options = await store(); const ledger = await open({ ...options, initialize: true });
  const inode = (await stat(join(options.directory, 'owner.lock'))).ino;
  const second = await helper(options);
  expect(second.child.pid).toBeGreaterThan(0); expect(second.ready).toBe(false); await second.exited;
  expect(ledger.ready).toBe(true); await ledger.close();
  const next = await open(options);
  expect((await stat(join(options.directory, 'owner.lock'))).ino).toBe(inode);
  expect(next.ready).toBe(true);
});

it('rejects a restored older ledger against the independent current fence', async () => {
  const options = await store(); const ledger = await open({ ...options, initialize: true }); await ledger.close();
  const backup = join(options.directory, 'old-backup.sqlite3');
  await copyFile(join(options.directory, 'claims.sqlite3'), backup);
  const next = await open(options); await next.claim(input()); await next.close();
  await copyFile(backup, join(options.directory, 'claims.sqlite3'));
  await expect(open(options)).rejects.toMatchObject({ code: 'claim_store_unavailable' });
  await expect(open({ ...options, initialize: true })).rejects.toMatchObject({ code: 'claim_store_unavailable' });
});

it('fails closed on missing/corrupt/epoch-mismatched fences and refuses implicit provisioning', async () => {
  const options = await store();
  await expect(open(options)).rejects.toMatchObject({ code: 'claim_store_unavailable' });
  const ledger = await open({ ...options, initialize: true }); await ledger.close();
  await expect(open({ ...options, trustEpoch: 'other-epoch' })).rejects.toMatchObject({ code: 'claim_store_unavailable' });
  await writeFile(options.fencePath, 'not json');
  await expect(open(options)).rejects.toMatchObject({ code: 'claim_store_unavailable' });
});

it('detects a real helper crash between SQLite FULL commit and independent fence commit', async () => {
  const options = await store(); const ledger = await open({ ...options, initialize: true }); await ledger.close();
  const crashed = await helper(options, 'crash_after_db_commit');
  expect(crashed.ready).toBe(true);
  expect(await crashed.command('claim', input())).toBe(null); await crashed.exited;
  await expect(open(options)).rejects.toMatchObject({ code: 'claim_store_unavailable' });
});

it.each(['crash_after_db_commit', 'crash_after_fence_file_fsync'])('fails closed at dispatch-marker boundary %s', async fault => {
  const options = await store(); const ledger = await open({ ...options, initialize: true }); await ledger.close();
  const crashed = await helper(options, fault, 'start');
  const row = (await crashed.command('claim', input())).result;
  const snapshot_path = join(options.directory, 'snapshot.html'); await writeFile(snapshot_path, '<p>before</p>');
  expect(await crashed.command('start', { operation_id: row.operation_id, snapshot_path })).toBe(null); await crashed.exited;
  await expect(open(options)).rejects.toMatchObject({ code: 'claim_store_unavailable' });
});

it('quarantines a durable dispatch marker when the owner dies before sending or recording its response', async () => {
  const options = await store(); const ledger = await open({ ...options, initialize: true }); await ledger.close();
  const crashed = await helper(options, 'crash_after_fence_commit', 'start');
  const row = (await crashed.command('claim', input())).result;
  const snapshot_path = join(options.directory, 'snapshot.html'); await writeFile(snapshot_path, '<p>before</p>');
  expect(await crashed.command('start', { operation_id: row.operation_id, snapshot_path })).toBe(null); await crashed.exited;
  const restarted = await open(options);
  expect(await restarted.status({ issuer: 'test-issuer', jti: 'nonce-1' })).toMatchObject({ outcome: 'unknown_write', requires_reconciliation: true });
  await expect(restarted.claim(input('2'))).rejects.toMatchObject({ code: 'claim_conflict' });
});

it('rolls back a precommit disk-full claim and never reports it as admitted', async () => {
  const options = await store(); const ledger = await open({ ...options, initialize: true }); await ledger.close();
  const full = await helper(options, 'disk_full_before_commit');
  expect(await full.command('claim', input())).toMatchObject({ error: 'claim_store_unavailable' }); await full.exited;
  const restarted = await open(options);
  expect(await restarted.status({ issuer: 'test-issuer', jti: 'nonce-1' })).toBe(null);
  await restarted.claim(input());
});

it('fails globally on disk full after observed success and recovers conservatively instead of retrying', async () => {
  const options = await store(); const ledger = await open({ ...options, initialize: true }); await ledger.close();
  const full = await helper(options, 'disk_full_before_commit', 'finish');
  const row = (await full.command('claim', input())).result;
  const snapshot_path = join(options.directory, 'snapshot.html'); await writeFile(snapshot_path, '<p>before</p>');
  await full.command('start', { operation_id: row.operation_id, snapshot_path });
  expect(await full.command('finish', { operation_id: row.operation_id, outcome: 'known_success', audit_recorded: true })).toMatchObject({ error: 'claim_store_unavailable' }); await full.exited;
  const restarted = await open(options);
  expect(await restarted.status({ issuer: 'test-issuer', jti: 'nonce-1' })).toMatchObject({ outcome: 'unknown_write', applied: null });
  await expect(restarted.claim(input('2'))).rejects.toMatchObject({ code: 'claim_conflict' });
});

it('disables an active adapter after fence outage and keeps status failures safe', async () => {
  const options = await store(); const ledger = await open({ ...options, initialize: true }); await ledger.claim(input());
  await writeFile(options.fencePath, '{}');
  await expect(ledger.status({ issuer: 'test-issuer', jti: 'nonce-1' })).rejects.toMatchObject({ code: 'claim_store_unavailable' });
  expect(ledger.ready).toBe(false);
  await expect(ledger.claim(input('2'))).rejects.toMatchObject({ code: 'claim_store_unavailable' });
});

it('retains ownership in Node after killing its failed helper until the drained owner explicitly closes', async () => {
  const options = await store(); const ledger = await open({ ...options, initialize: true });
  const originalFence = await readFile(options.fencePath);
  await writeFile(options.fencePath, '{}');
  await expect(ledger.status({ issuer: 'test-issuer', jti: 'unknown' })).rejects.toMatchObject({ code: 'claim_store_unavailable' });
  // Repairing this synthetic read failure cannot release the owner's flock.
  await writeFile(options.fencePath, originalFence);
  await expect(open(options)).rejects.toMatchObject({ code: 'claim_store_unavailable' });
  expect(ledger.ready).toBe(false);
  await ledger.close();
  expect((await open(options)).ready).toBe(true);
});

it('drops helper ownership when its actual Node parent dies and preserves consumed claims', async () => {
  const options = await store(); const ledger = await open({ ...options, initialize: true }); await ledger.close();
  const moduleUrl = new URL('../../../conductor-panel/server/durable-ledger.ts', import.meta.url).href;
  const script = `import { DurableLedger } from ${JSON.stringify(moduleUrl)};
    const ledger = await DurableLedger.open(${JSON.stringify(options)});
    await ledger.claim(${JSON.stringify(input())}); console.log('ready'); process.stdin.resume();`;
  const owner = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: 'pipe' });
  const exited = new Promise<void>(resolve => owner.once('close', () => resolve()));
  const lines = createInterface({ input: owner.stdout })[Symbol.asyncIterator]();
  expect((await lines.next()).value).toBe('ready');
  owner.kill('SIGKILL'); await exited;
  let restarted: DurableLedger | undefined;
  for (let i = 0; i < 30 && !restarted; i++) {
    try { restarted = await open(options); }
    catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  expect(restarted).toBeDefined();
  expect(await restarted!.status({ issuer: 'test-issuer', jti: 'nonce-1' })).toMatchObject({ outcome: 'not_attempted', reason: 'pre_dispatch_failure' });
  await expect(restarted!.claim(input())).rejects.toMatchObject({ code: 'claim_conflict' });
});

const run = promisify(execFile);
it('reports reconciliation through a separate readonly process while a writer owns the ledger', async () => {
  const options = await store(); const ledger = await open({ ...options, initialize: true });
  const row = await ledger.claim(input());
  const snapshot_path = join(options.directory, 'snapshot.html'); await writeFile(snapshot_path, '<p>before</p>');
  await ledger.start(row.operation_id, { snapshot_path });
  const before = await ledger.status({ issuer: 'test-issuer', jti: 'nonce-1' });
  const files = ['claims.sqlite3', 'claims.sqlite3-wal', 'claims.sqlite3-shm'].map(name => join(options.directory, name)).concat(options.fencePath);
  const bytesBefore = await Promise.all(files.map(file => readFile(file)));
  const denyNetwork = `import runpy,sys
def no_network(event,args):
    if event.startswith('socket.'):
        raise RuntimeError('network forbidden during local report')
sys.addaudithook(no_network)
sys.argv=sys.argv[1:]
runpy.run_path(sys.argv[0],run_name='__main__')`;
  const reportArgs = [helperPath, '--directory', options.directory, '--fence', options.fencePath,
    '--epoch', options.trustEpoch, '--readonly-report'];
  const { stdout } = await run('python3', ['-c', denyNetwork, ...reportArgs]);
  const report = JSON.parse(stdout);
  expect(report).toMatchObject({ trust_epoch: options.trustEpoch, durability_seq: 2,
    operations: [{ ...before, issuer: 'test-issuer', jti: 'nonce-1', target: { hostname: 'example.test', page_id: '1' },
      subject: 'reviewer-1', expires_at: 1_800_000_060, snapshot_path, cxone_revision_id: null }] });
  expect(report.operations[0].binding_sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(report)).not.toContain('<p>');
  expect(await Promise.all(files.map(file => readFile(file)))).toEqual(bytesBefore);
  expect(await ledger.status({ issuer: 'test-issuer', jti: 'nonce-1' })).toEqual(before);
  expect(ledger.ready).toBe(true);
  await writeFile(options.fencePath, '{}');
  await expect(run('python3', [helperPath, '--directory', options.directory, '--fence', options.fencePath,
    '--epoch', options.trustEpoch, '--readonly-report'])).rejects.toMatchObject({ stdout: '{"error":"claim_store_unavailable"}\n' });
  await writeFile(options.fencePath, JSON.stringify({ trust_epoch: options.trustEpoch, durability_seq: 999 }));
  await expect(run('python3', reportArgs)).rejects.toMatchObject({ stdout: '{"error":"claim_store_unavailable"}\n' });
});
