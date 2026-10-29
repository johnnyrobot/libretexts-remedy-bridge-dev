import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PreviewCache } from './preview-cache.js';
test('rejects pressure without silently evicting reviewed tokens and reclaims expired bytes', () => {
  const cache = new PreviewCache<{expiresAt:number;beforeHtml:string;afterHtml:string}>({ entries:2, bytes:1000, previewBytes:10 });
  const live = {expiresAt:Date.now()+60000,beforeHtml:'1234',afterHtml:'5678'};
  cache.set('a',live); cache.set('b',live);
  assert.throws(()=>cache.set('c',live)); assert.equal(cache.get('a'),live);
  cache.delete('a'); assert.throws(()=>cache.set('c',{...live,afterHtml:'1234567'}));
  cache.set('expired',{...live,expiresAt:0}); cache.set('c',live);
  assert.equal(cache.size,2); assert.ok(cache.bytes <= 1000);
});
