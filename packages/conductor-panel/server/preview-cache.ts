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
type Usage = {bytes:number;htmlBytes:number;beforeHtml:string;afterHtml:string};
/** Shared tokens/HTML are counted once; each owner's retained metadata is charged. */
export class PreviewPool {
  readonly caches = new Set<PreviewCache<any>>();
  private tokens = new Map<string,Map<PreviewCache<any>,Usage>>();
  bytes = 0;
  constructor(readonly limits = previewLimits()) {}
  prune() { for (const cache of this.caches) for (const [key,value] of cache) if (value.expiresAt <= Date.now()) cache.delete(key); }
  get size() { return this.tokens.size; }
  private cost(owners:Map<PreviewCache<any>,Usage>) {
    const unique:Usage[]=[];
    let metadata=0;
    for(const usage of owners.values()) {
      metadata+=usage.bytes-usage.htmlBytes;
      if(!unique.some(other=>other.beforeHtml===usage.beforeHtml&&other.afterHtml===usage.afterHtml)) unique.push(usage);
    }
    return metadata+unique.reduce((sum,value)=>sum+value.htmlBytes,0);
  }
  reserve(cache:PreviewCache<any>,key:string,usage:Usage) {
    const prior=this.tokens.get(key)??new Map();
    const owners=new Map(prior); owners.set(cache,usage);
    const bytes=this.bytes-this.cost(prior)+this.cost(owners);
    if(usage.htmlBytes>this.limits.previewBytes || this.size+(this.tokens.has(key)?0:1)>this.limits.entries || bytes>this.limits.bytes) throw new CapacityError();
    this.tokens.set(key,owners); this.bytes=bytes;
  }
  release(cache:PreviewCache<any>,key:string) {
    const owners=this.tokens.get(key); if(!owners)return;
    const before=this.cost(owners); owners.delete(cache);
    this.bytes+=this.cost(owners)-before;
    if(!owners.size)this.tokens.delete(key);
  }
  consume(key:string) {for(const cache of this.caches)cache.delete(key);}
}
export class PreviewCache<T extends Entry> extends Map<string,T> {
  private readonly pool: PreviewPool;
  private sizes = new Map<string,number>();
  bytes = 0;
  constructor(limits: ReturnType<typeof previewLimits> | PreviewPool = previewLimits()) {
    super(); this.pool = limits instanceof PreviewPool ? limits : new PreviewPool(limits); this.pool.caches.add(this);
  }
  override set(key:string,value:T):this {
    this.pool.prune();
    const bytes=Buffer.byteLength(JSON.stringify(value));
    const htmlBytes=Buffer.byteLength(value.beforeHtml)+Buffer.byteLength(value.afterHtml);
    this.pool.reserve(this,key,{bytes,htmlBytes,beforeHtml:value.beforeHtml,afterHtml:value.afterHtml});
    this.bytes+=bytes-(this.sizes.get(key)??0); this.sizes.set(key,bytes); super.set(key,value); return this;
  }
  override delete(key:string):boolean {this.pool.release(this,key);this.bytes-=this.sizes.get(key)??0;this.sizes.delete(key);return super.delete(key);}
  consume(key:string) {this.pool.consume(key);}
  override clear() {for(const key of this.keys())this.delete(key);}
}
