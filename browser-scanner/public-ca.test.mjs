import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,chmod,mkdtemp,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {certificates} from './public-ca-fixture.mjs';
import {loadPublicCA} from './public-ca.mjs';

test('service trust accepts only bounded read-only public root CA PEM and freezes its exact content',async()=>{
 const c=await certificates(),dir=await mkdtemp('/tmp/lt239-input-');
 assert.equal(await loadPublicCA(undefined),null);
 const snapshot=await loadPublicCA(c.ca);assert.match(snapshot.sha256,/^[a-f0-9]{64}$/);assert.ok(Object.isFrozen(snapshot));assert.equal(snapshot.fingerprints.length,1);
 for(const [name,value] of [['empty',''],['malformed','not a certificate'],['mixed',(await readFile(c.ca,'utf8'))+'\n'+(await readFile(join(c.dir,'ca.key'),'utf8'))],['leaf',c.cert],['oversized','x'.repeat(65537)],['too-many',(await readFile(c.ca,'utf8')).repeat(9)],['duplicate',(await readFile(c.ca,'utf8')).repeat(2)]]){
  const file=join(dir,name);await writeFile(file,value,{mode:0o444});await assert.rejects(loadPublicCA(file),/Public CA/);
 }
 const writable=join(dir,'writable');await writeFile(writable,await readFile(c.ca),{mode:0o644});await assert.rejects(loadPublicCA(writable),/Public CA/);
 const unreadable=join(dir,'unreadable');await writeFile(unreadable,await readFile(c.ca),{mode:0o000});await assert.rejects(loadPublicCA(unreadable),/Public CA/);
 await assert.rejects(loadPublicCA(join(dir,'missing')),/Public CA/);await assert.rejects(loadPublicCA(dir),/Public CA/);await assert.rejects(loadPublicCA('relative.pem'),/Public CA/);
 const link=join(dir,'link');await symlink(c.ca,link);await assert.rejects(loadPublicCA(link),/Public CA/);
 // A later operator file replacement must not mutate jobs in this process.
 await chmod(c.ca,0o644);await writeFile(c.ca,'changed');assert.ok(snapshot.pem.includes('BEGIN CERTIFICATE'));assert.equal(snapshot.fingerprints.length,1);
});

test('nonregular FIFO is refused without blocking and exact-limit whitespace is bounded',async()=>{
 const {execFileSync}=await import('node:child_process');
 const {stagePublicCA}=await import('./public-ca.mjs');
 const dir=await mkdtemp('/tmp/lt239-finite-'),fifo=join(dir,'fifo');execFileSync('mkfifo',[fifo]);await chmod(fifo,0o444);
 const started=performance.now();await assert.rejects(loadPublicCA(fifo),/Public CA/);assert.ok(performance.now()-started<1000);
 const c=await certificates(),pem=await readFile(c.ca,'utf8'),file=join(dir,'maximum.pem');await writeFile(file,pem+'\n'.repeat(65536-Buffer.byteLength(pem)),{mode:0o444});
 const snapshot=await loadPublicCA(file);assert.equal(Buffer.byteLength(snapshot.pem),65536);
 const home=join(dir,'home');await (await import('node:fs/promises')).mkdir(home,{mode:0o700});await stagePublicCA(snapshot,home);assert.equal((await loadPublicCA(join(home,'operator-public-ca.pem'))).sha256,snapshot.sha256);
});
