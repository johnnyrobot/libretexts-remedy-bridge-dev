export class CapacityError extends Error {
  readonly status = 503;
  readonly body = { error: 'capacity_unavailable' };
}
export function finiteLimit(value: string | undefined, fallback: number, maximum: number, minimum = 1): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < minimum || n > maximum) throw new Error('invalid_resource_limit');
  return n;
}
export const previewLimits = () => ({
  entries: finiteLimit(process.env.REMEDY_PREVIEW_ENTRIES,128,128),
  bytes: finiteLimit(process.env.REMEDY_PREVIEW_BYTES,64*1024*1024,64*1024*1024),
  previewBytes: finiteLimit(process.env.REMEDY_PREVIEW_MAX_BYTES,8*1024*1024,8*1024*1024),
});
type Entry = { expiresAt: number; beforeHtml: string; afterHtml: string };
/** One shared pool across all preview kinds; live tokens are never evicted. */
export class PreviewPool {
  readonly caches = new Set<PreviewCache<any>>();
  constructor(readonly limits = previewLimits()) {}
  prune() { for (const cache of this.caches) for (const [key,value] of cache) if (value.expiresAt <= Date.now()) cache.delete(key); }
  get bytes() { return [...this.caches].reduce((n,c)=>n+c.bytes,0); }
  get size() { return [...this.caches].reduce((n,c)=>n+c.size,0); }
}
export class PreviewCache<T extends Entry> extends Map<string,T> {
  private readonly pool: PreviewPool;
  private sizes = new Map<string,number>();
  bytes = 0;
  constructor(limits: ReturnType<typeof previewLimits> | PreviewPool = previewLimits()) {
    super(); this.pool = limits instanceof PreviewPool ? limits : new PreviewPool(limits); this.pool.caches.add(this);
  }
  override set(key: string,value: T): this {
    this.pool.prune();
    const htmlBytes = Buffer.byteLength(value.beforeHtml)+Buffer.byteLength(value.afterHtml);
    // Include diff, image metadata and other retained fields in the aggregate budget.
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (htmlBytes > this.pool.limits.previewBytes || this.pool.size + (this.has(key)?0:1) > this.pool.limits.entries || this.pool.bytes - (this.sizes.get(key)??0) + bytes > this.pool.limits.bytes) throw new CapacityError();
    this.delete(key); super.set(key,value); this.sizes.set(key,bytes); this.bytes+=bytes; return this;
  }
  override delete(key: string): boolean { this.bytes-=this.sizes.get(key)??0; this.sizes.delete(key); return super.delete(key); }
  override clear() { super.clear(); this.sizes.clear(); this.bytes=0; }
}
