import { basename, dirname, join } from 'node:path';
import { DurableLedger } from './durable-ledger.js';
import { SignedRequestError } from './signed-writer.js';

/** Optional historical lookup. Query-only SQLite, no owner lock, recovery or claims. */
export class ReadOnlyStatus {
  private checking?: Promise<boolean>;
  private constructor(private readonly ledger: DurableLedger, private readonly issuer: string) {}
  static async open(env: NodeJS.ProcessEnv): Promise<ReadOnlyStatus | null> {
    const db = env.REMEDY_CLAIM_DB, fence = env.REMEDY_CLAIM_FENCE_DIR, epoch = env.REMEDY_REVIEWER_TRUST_EPOCH;
    const issuer = env.REMEDY_OPERATION_STATUS_ISSUER;
    if (!db || basename(db) !== 'claims.sqlite3' || !fence || !epoch || !issuer || issuer.length > 512) return null;
    try { return new ReadOnlyStatus(await DurableLedger.open({directory:dirname(db),fencePath:join(fence,'fence.json'),trustEpoch:epoch,readOnly:true}),issuer); }
    catch { return null; }
  }
  readable(): Promise<boolean> {
    if (!this.checking) this.checking = this.ledger.status({issuer:'',jti:''}).then(() => true, () => false).finally(() => {this.checking = undefined;});
    return this.checking;
  }
  async status(body: Record<string, unknown>) {
    if (Object.keys(body).length !== 2 || body.issuer !== this.issuer || typeof body.jti !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.jti) || Buffer.from(body.jti,'base64url').toString('base64url') !== body.jti) throw new SignedRequestError(400,{error:'invalid_request'});
    const status = await this.ledger.status({issuer:this.issuer,jti:body.jti});
    if (!status) throw new SignedRequestError(404,{error:'operation_not_found'});
    return status;
  }
  close() { return this.ledger.close(); }
}
