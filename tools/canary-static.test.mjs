import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const wizard=fileURLToPath(new URL('./cxone-canary-wizard.sh',import.meta.url));
test('default and dry-run preparation perform no network, credential lookup or file writes',()=>{
 const directory=mkdtempSync(join(tmpdir(),'canary-static-'));
 for(const name of ['curl','wget','open','xdg-open','gh','python3','node'])writeFileSync(join(directory,name),'#!/bin/sh\nexit 99\n',{mode:0o700});
 const before=readdirSync(directory);
 for(const args of [[],['--dry-run']]){
  const result=execFileSync('/bin/bash',[wizard,...args],{cwd:directory,env:{PATH:directory},encoding:'utf8'});
  assert.match(result,/No network, credentials or files/);assert.match(result,/Maximum12/);
 }
 assert.deepEqual(readdirSync(directory),before);
});
test('wizard library remains the exact Matt template prefix',()=>{
 const prefix=readFileSync(wizard,'utf8').split('run_wizard() {')[0];
 assert.equal(createHash('sha256').update(prefix).digest('hex'),'0394d53662b5aa17057d3f58f15ac25a26a6f62baef227e4e86618759f43c510');
});
