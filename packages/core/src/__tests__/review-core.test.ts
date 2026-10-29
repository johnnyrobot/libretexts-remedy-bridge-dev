import { expect, it, vi } from 'vitest';
import { writePageRevision, fixPage, runPipeline, revertPage, writePageTags, revertPageTags, restoreTagsFromManifest } from '../index.js';
it('review-only rejects every core mutation entry before even no-op, local files or external reads', async () => {
  const read = vi.fn(async () => { throw Error('Unexpected external read'); });
  const expert = {pages:{getPageInfo:read,getPageContents:read,getPageTags:read,postPageContents:read,putPageTags:read}} as any;
  const env = {REMEDY_BRIDGE_PROFILE:'review-only',NODE_ENV:'development'};
  const page = {id:1,path:'Sandboxes/johnnyphung/Page',hostname:'dev.libretexts.org'};
  const calls = [
    () => writePageRevision({expert,env,page,pageInput:1,beforeHtml:'same',afterHtml:'same',rules:[],revisionSummary:'test',source:'fix'}),
    () => fixPage(1,{expert,env,mode:'apply'}), () => runPipeline(1,{expert,env,mode:'apply'}),
    () => revertPage(1,{expert,env}), () => writePageTags({expert,env,page,tags:[]}),
    () => revertPageTags({expert,env,snapshotPath:'/nonexistent'}),
    () => restoreTagsFromManifest({pages:[],generatedAt:'synthetic'} as any,{expert,env}),
  ];
  for (const call of calls) await expect(call()).rejects.toMatchObject({name:'ReviewOnlyProfileError'});
  expect(read).not.toHaveBeenCalled();
});
