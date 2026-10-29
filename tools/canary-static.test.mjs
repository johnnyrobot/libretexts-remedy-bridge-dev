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
test('interruption after reservation preserves a descriptive pending attempt without an outcome',()=>{
 const directory=mkdtempSync(join(tmpdir(),'canary-pending-'));
 const functions=readFileSync(wizard,'utf8').split('\nrun_wizard "$@"; exit')[0];
 const script=functions+`\nCANARY_DIRECTORY="$1"\nENV_FILE="$1/canary.env"\nMUTATION_ATTEMPTS=0\nconfirm(){ return 0; }\npause(){ exit 97; }\nmanual_attempt 'Synthetic accepted control' success\n`;
 let code=0;try{execFileSync('/bin/bash',['-c',script,'synthetic-test',directory],{stdio:'pipe'});}catch(error){code=error.status;}
 assert.equal(code,97);
 const row=readFileSync(join(directory,'attempts.tsv'),'utf8').trim().split('\t');
 assert.equal(row[0],'1');assert.equal(row[1],'reserved');assert.equal(row[3],'success');assert.equal(row[4],'Synthetic accepted control');assert.equal(row[5],'pending');
});
test('synthetic manual outcomes append to the same reserved attempt without overwriting it',()=>{
 const directory=mkdtempSync(join(tmpdir(),'canary-outcome-'));
 const functions=readFileSync(wizard,'utf8').split('\nrun_wizard "$@"; exit')[0];
 const script=functions+`\nCANARY_DIRECTORY="$1"\nENV_FILE="$1/canary.env"\nMUTATION_ATTEMPTS=0\nconfirm(){ return 0; }\npause(){ test -s "$CANARY_DIRECTORY/attempts.tsv"; }\nask(){ printf -v "$1" '%s' success; }\nmanual_attempt 'Synthetic accepted control' success\n`;
 execFileSync('/bin/bash',['-c',script,'synthetic-test',directory],{stdio:'pipe'});
 const rows=readFileSync(join(directory,'attempts.tsv'),'utf8').trim().split('\n').map(row=>row.split('\t'));
 assert.equal(rows.length,2);assert.equal(rows[0][0],rows[1][0]);assert.equal(rows[0][1],'reserved');assert.equal(rows[0][5],'pending');assert.equal(rows[1][1],'outcome');assert.equal(rows[1][5],'success');
});
test('non-terminal operator mode refuses before setup or any manual workflow',()=>{
 const directory=mkdtempSync(join(tmpdir(),'canary-no-tty-'));
 let code=0;try{execFileSync('/bin/bash',[wizard,'--operator'],{cwd:directory,stdio:'pipe'});}catch(error){code=error.status;assert.match(error.stdout.toString(),/interactive terminal/);}
 assert.equal(code,1);assert.deepEqual(readdirSync(directory),[]);
});
