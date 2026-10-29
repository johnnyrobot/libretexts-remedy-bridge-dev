import { basename, dirname, join } from 'node:path';
import { operationStatusQuery } from './status-query.js';
import { DurableLedger, LedgerError } from './durable-ledger.js';
import { SignedRequestError } from './signed-writer.js';

/** Optional historical lookup. Query-only SQLite, no owner lock, recovery or claims. */
export class ReadOnlyStatus {
  private checking?: Promise<boolean>;
  private constructor(private readonly ledger: DurableLedger | null, private readonly issuer: string) {}
  static async open(env: NodeJS.ProcessEnv): Promise<ReadOnlyStatus | null> {
    const db = env.REMEDY_CLAIM_DB, fence = env.REMEDY_CLAIM_FENCE_DIR, epoch = env.REMEDY_REVIEWER_TRUST_EPOCH;
    const issuer = env.REMEDY_OPERATION_STATUS_ISSUER;
    if (!db || basename(db) !== 'claims.sqlite3' || !fence || !epoch || !issuer || issuer.length > 512) return null;
    try { return new ReadOnlyStatus(await DurableLedger.open({directory:dirname(db),fencePath:join(fence,'fence.json'),trustEpoch:epoch,readOnly:true}),issuer); }
    catch { return new ReadOnlyStatus(null,issuer); }
  }
  readable(): Promise<boolean> {
    if (!this.ledger) return Promise.resolve(false);
    if (!this.checking) this.checking = this.ledger.status({issuer:'',jti:''}).then(() => true, () => false).finally(() => {this.checking = undefined;});
    return this.checking;
  }
  async status(body: Record<string, unknown>) {
    const query = operationStatusQuery(body);
    if (!query || query.issuer !== this.issuer) throw new SignedRequestError(400,{error:'invalid_request'});
    if (!this.ledger) throw new LedgerError('claim_store_unavailable');
    const status = await this.ledger.status(query);
    if (!status) throw new SignedRequestError(404,{error:'operation_not_found'});
    return status;
  }
  close() { return this.ledger?.close(); }
}
