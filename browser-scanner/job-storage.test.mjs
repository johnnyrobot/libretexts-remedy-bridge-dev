import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,symlink,rename,readdir,open} from 'node:fs/promises';
import {join} from 'node:path';
import {createJobStorage} from './job-storage.mjs';

test('cleanup unlinks job symlinks without touching a different job or caller data',async()=>{
 const foreign=await mkdtemp('/tmp/lt162-foreign-'),sentinel=join(foreign,'preserve');await writeFile(sentinel,'owned elsewhere');
 const a=await createJobStorage(),b=await createJobStorage();
 await symlink(foreign,join(a.path,'foreign'));await symlink(b.path,join(a.path,'other-job'));
 await a.cleanup();assert.equal(await readFile(sentinel,'utf8'),'owned elsewhere');assert.deepEqual(await readdir(b.path),['home']);await b.cleanup();
});
test('replacement job root refuses cleanup and preserves both identities',async()=>{
 const job=await createJobStorage(),moved=job.path+'-preserved';await rename(job.path,moved);await symlink(moved,job.path);
 await assert.rejects(job.cleanup(),/ownership changed/);assert.deepEqual(await readdir(moved),['home']);
});
test('storage accounting counts sparse logical bytes and refuses an oversized retained job',async()=>{
 const job=await createJobStorage(),file=await open(join(job.path,'sparse-fixture'),'w');await file.truncate(128*1024*1024+1);await file.close();
 await assert.rejects(job.inspect(),/budget exceeded/);await assert.rejects(job.cleanup(),/budget exceeded/);
});
