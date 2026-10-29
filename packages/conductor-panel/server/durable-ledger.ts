import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

export type Outcome = 'pending' | 'not_attempted' | 'known_success' | 'unknown_write';
export type Reason = 'no_change' | 'stale_preview' | 'target_mismatch' | 'pre_dispatch_failure' | 'write_outcome_unknown';
export interface OperationStatus {
  operation_id: string; action: 'cxone.apply' | 'cxone.restore'; outcome: Outcome;
  reason: Reason | null; applied: boolean | null; restored: boolean | null; audit_recorded: boolean | null;
  requires_reconciliation: boolean; reconciliation: 'none' | 'required';
  evidence_effect: 'hold' | 'preserve' | 'invalidate'; updated_at: string;
}
export interface ClaimInput {
  issuer: string; jti: string; preview_token: string; target: { hostname: string; page_id: string };
  binding: { action: 'cxone.apply' | 'cxone.restore'; [key: string]: unknown };
  subject: string; expires_at: number;
}
export interface ReconciliationOperation extends OperationStatus {
  issuer: string; jti: string; target: { hostname: string; page_id: string };
  binding_sha256: string; subject: string; expires_at: number;
  snapshot_path: string | null; cxone_revision_id: string | null; created_at: string;
}
export interface ReconciliationReport {
  trust_epoch: string; durability_seq: number; operations: ReconciliationOperation[];
}
export interface LedgerOptions {
  directory: string; fencePath: string; trustEpoch: string;
  /** Explicit local provisioning only: existing/partial stores are never initialized. */
  initialize?: boolean; python?: string;
}
export class LedgerError extends Error {
  constructor(readonly code: 'claim_store_unavailable' | 'claim_conflict' | 'invalid_transition' | 'operation_not_found') {
    super(code); this.name = 'LedgerError';
  }
}

/** Node and its POSIX helper retain the same flock open-file description.
 * Production startup must omit initialize. The independently mounted fence must
 * be outside directory and excluded from all ledger backup/rollback operations.
 */
export class DurableLedger {
  private available = false;
  private sequence = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly exited: Promise<void>;
  private constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly ownerFile: FileHandle) {
    this.exited = new Promise(resolve => child.once('close', () => { this.fail(); resolve(); }));
    child.on('error', () => this.fail());
    child.stdin.on('error', () => this.fail());
    // The helper emits no private diagnostics. Drain stderr without retaining it.
    child.stderr.resume();
  }
  static async open(options: LedgerOptions): Promise<DurableLedger> {
    let ownerFile: FileHandle;
    let directory: string;
    try {
      directory = await realpath(options.directory);
      ownerFile = await open(join(directory, 'owner.lock'), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    } catch { throw new LedgerError('claim_store_unavailable'); }
    const args = [fileURLToPath(new URL('./ledger-helper.py', import.meta.url)),
      '--directory', directory, '--fence', options.fencePath, '--epoch', options.trustEpoch, '--owner-fd', '3'];
    if (options.initialize) args.push('--initialize');
    let ledger: DurableLedger;
    try {
      const child = spawn(options.python ?? 'python3', ['-u', ...args], { stdio: ['pipe', 'pipe', 'pipe', ownerFile.fd] });
      ledger = new DurableLedger(child as ChildProcessWithoutNullStreams, ownerFile);
    } catch { await ownerFile.close(); throw new LedgerError('claim_store_unavailable'); }
    const lines = createInterface({ input: ledger.child.stdout });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { ledger.fail(); reject(new LedgerError('claim_store_unavailable')); }, 10_000);
        const onExit = () => { clearTimeout(timer); reject(new LedgerError('claim_store_unavailable')); };
        ledger.child.once('close', onExit); ledger.child.once('error', onExit);
        lines.once('line', line => {
          clearTimeout(timer); ledger.child.off('close', onExit); ledger.child.off('error', onExit);
          try { if (JSON.parse(line).ready !== true) throw new Error(); ledger.available = true; resolve(); }
          catch { reject(new LedgerError('claim_store_unavailable')); }
        });
      });
      lines.on('line', line => ledger.receive(line));
      return ledger;
    } catch { ledger.fail(); await ledger.exited; await ownerFile.close(); throw new LedgerError('claim_store_unavailable'); }
  }
  get ready(): boolean { return this.available; }
  private fail() {
    this.available = false;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new LedgerError('claim_store_unavailable')); }
    this.pending.clear();
    if (this.child.exitCode === null && !this.child.killed) this.child.kill('SIGKILL');
  }
  private receive(line: string) {
    try {
      const reply = JSON.parse(line);
      const request = this.pending.get(reply.id);
      if (!request) { this.fail(); return; }
      clearTimeout(request.timer); this.pending.delete(reply.id);
      if (reply.error) {
        const code = ['claim_conflict', 'invalid_transition', 'operation_not_found'].includes(reply.error) ? reply.error : 'claim_store_unavailable';
        if (code === 'claim_store_unavailable') this.fail();
        request.reject(new LedgerError(code));
      } else request.resolve(reply.result);
    } catch { this.fail(); }
  }
  private request<T>(command: string, data: unknown = {}): Promise<T> {
    if (!this.ready) return Promise.reject(new LedgerError('claim_store_unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => this.fail(), 10_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.child.stdin.write(JSON.stringify({ id, command, data }) + '\n', error => { if (error) this.fail(); }); }
      catch { this.fail(); }
    });
  }
  claim(input: ClaimInput): Promise<OperationStatus> { return this.request('claim', input); }
  start(operation_id: string, references: { snapshot_path: string }): Promise<OperationStatus> {
    return this.request('start', { operation_id, ...references });
  }
  finish(operation_id: string, result: {
    outcome: Exclude<Outcome, 'pending'>; reason?: Reason; audit_recorded?: boolean;
    snapshot_path?: string; cxone_revision_id?: string; applied?: boolean | null; restored?: boolean | null;
  }): Promise<OperationStatus> { return this.request('finish', { operation_id, ...result }); }
  status(query: { issuer: string; jti: string }): Promise<OperationStatus | null> { return this.request('status', query); }
  async recordRevocations(kids: string[]): Promise<void> { await this.request('revoke', { kids }); }
  isRevoked(kid: string): Promise<boolean> { return this.request('is_revoked', { kid }); }
  getRevocations(): Promise<string[]> { return this.request('revocations'); }
  reconciliationReport(): Promise<ReconciliationReport> { return this.request('report'); }
  async close(): Promise<void> {
    // Call only after server drain: helper failure must keep ownership while an
    // already dispatched remote request may still be in flight in this process.
    this.available = false;
    this.child.stdin.end();
    await this.exited;
    await this.ownerFile.close();
  }
}
