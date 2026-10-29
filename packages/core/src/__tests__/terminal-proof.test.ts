import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableLedger } from '../../../conductor-panel/server/durable-ledger.js';

const opened: DurableLedger[] = [];
afterEach(async () => { for (const ledger of opened.splice(0)) await ledger.close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'terminal-proof-')); await mkdir(join(root, 'ledger'));
  const options = {directory:join(root,'ledger'),fencePath:join(root,'fence.json'),trustEpoch:'proof-test'};
  const ledger = await DurableLedger.open({...options,initialize:true}); opened.push(ledger);
  return {root,options,ledger};
}
const query = {issuer:'urn:conductor:proof',jti:'A'.repeat(43)};
const input = { ...query, preview_token:'synthetic-preview',target:{hostname:'dev.libretexts.org',page_id:'1'},
  binding:{action:'cxone.apply' as const,before_sha256:'a'.repeat(64),after_sha256:'b'.repeat(64)},subject:'synthetic-reviewer',expires_at:4102444800 };
it('projects a bound terminal no-change proof without rewriting the existing operation',async()=>{
  const {options,ledger}=await fixture();const row=await ledger.claim(input);
  expect(await ledger.status(query)).toMatchObject({outcome:'pending',terminal_proof:null});
  await ledger.finish(row.operation_id,{outcome:'not_attempted',reason:'no_change'});
  const before=await ledger.reconciliationReport(), fence=await readFile(options.fencePath);
  const status=await ledger.status(query);
  expect(status).toMatchObject({outcome:'not_attempted',terminal_proof:{contract:'cxone-terminal-v1',...query,
    operation_id:row.operation_id,action:'cxone.apply',target:input.target,outcome:'not_attempted',reason:'no_change',audit_recorded:null,
    state:'terminal',trust_epoch:options.trustEpoch,durability_seq:2,terminal_updated_at:status!.updated_at,
    binding_sha256:before.operations[0].binding_sha256}});
  expect(await ledger.reconciliationReport()).toEqual(before);expect(await readFile(options.fencePath)).toEqual(fence);
  const readonly=await DurableLedger.open({...options,readOnly:true});opened.push(readonly);
  expect(await readonly.status(query)).toEqual(status);
  expect(await readonly.status({...query,jti:'B'.repeat(43)})).toBe(null);
});
it.each([true,false])('retains original known-success audit=%s through restart and query-only reads',async audit_recorded=>{
  const {root,options,ledger}=await fixture(); const row=await ledger.claim(input);
  const snapshot_path=join(root,'snapshot');await writeFile(snapshot_path,'synthetic');await ledger.start(row.operation_id,{snapshot_path});
  await ledger.finish(row.operation_id,{outcome:'known_success',audit_recorded});await ledger.close();
  const database=await readFile(join(options.directory,'claims.sqlite3')),fence=await readFile(options.fencePath);
  const readonly=await DurableLedger.open({...options,readOnly:true});opened.push(readonly);
  const status=await readonly.status(query);
  expect(status).toMatchObject({outcome:'known_success',audit_recorded,terminal_proof:{...query,outcome:'known_success',audit_recorded,state:'terminal',durability_seq:3}});
  expect(await readonly.status(query)).toEqual(status);
  expect(await readFile(join(options.directory,'claims.sqlite3'))).toEqual(database);expect(await readFile(options.fencePath)).toEqual(fence);
});
it('never turns unknown or unrecovered pending state into a terminal proof',async()=>{
  const {root,options,ledger}=await fixture();const row=await ledger.claim(input);const snapshot_path=join(root,'snapshot');await writeFile(snapshot_path,'synthetic');await ledger.start(row.operation_id,{snapshot_path});await ledger.close();
  const readonly=await DurableLedger.open({...options,readOnly:true});opened.push(readonly);
  expect(await readonly.status(query)).toMatchObject({outcome:'pending',terminal_proof:null});
  const restarted=await DurableLedger.open(options);opened.push(restarted);
  expect(await readonly.status(query)).toMatchObject({outcome:'unknown_write',requires_reconciliation:true,terminal_proof:null});
});

it.each(['binding_sha256','state','audit_recorded'])('refuses malformed terminal storage %s instead of manufacturing proof',async field=>{
  const {options,ledger}=await fixture();const row=await ledger.claim(input);await ledger.finish(row.operation_id,{outcome:'not_attempted',reason:'no_change'});await ledger.close();
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
  const value=field==='binding_sha256'?'bad':field==='state'?'claimed':1;
  await promisify(execFile)('python3',['-c','import sqlite3,sys;db=sqlite3.connect(sys.argv[1]);db.execute("UPDATE claims SET "+sys.argv[2]+"=?",(sys.argv[3],));db.commit()',join(options.directory,'claims.sqlite3'),field,String(value)]);
  const readonly=await DurableLedger.open({...options,readOnly:true});opened.push(readonly);
  await expect(readonly.status(query)).rejects.toMatchObject({code:'claim_store_unavailable'});
});
it('refuses a fence changing inside the actual read transaction',async()=>{
  const {options,ledger}=await fixture();const row=await ledger.claim(input);await ledger.finish(row.operation_id,{outcome:'not_attempted',reason:'no_change'});await ledger.close();
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
  const helper=new URL('../../../conductor-panel/server/ledger-helper.py',import.meta.url).pathname;
  const database=await readFile(join(options.directory,'claims.sqlite3'));
  const script=`import importlib.util,json,sys\nfrom types import SimpleNamespace\nspec=importlib.util.spec_from_file_location('ledger',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\noriginal=m.Ledger.read_fence\ncalls=0\ndef changing(path):\n global calls\n value=original(path);calls+=1\n if calls==1:\n  with open(path,'w') as f: json.dump({**value,'durability_seq':value['durability_seq']+1},f)\n return value\nm.Ledger.read_fence=staticmethod(changing)\ntry:\n m.readonly_report(SimpleNamespace(directory=sys.argv[2],fence=sys.argv[3],epoch=sys.argv[4]),json.loads(sys.argv[5]))\n raise RuntimeError('race accepted')\nexcept ValueError: print('race_refused')`;
  const result=await promisify(execFile)('python3',['-B','-c',script,helper,options.directory,options.fencePath,options.trustEpoch,JSON.stringify(query)]);
  expect(result.stdout.trim()).toBe('race_refused');expect(await readFile(join(options.directory,'claims.sqlite3'))).toEqual(database);
});
it.each(['not_attempted','known_success'] as const)('exposes committed %s after helper dies before acknowledging terminal commit',async outcome=>{
  const {root,options,ledger}=await fixture();await ledger.close();
  const {spawn}=await import('node:child_process'),{createInterface}=await import('node:readline');
  const helper=new URL('../../../conductor-panel/server/ledger-helper.py',import.meta.url).pathname;
  const child=spawn('python3',['-u',helper,'--directory',options.directory,'--fence',options.fencePath,'--epoch',options.trustEpoch,'--test-fault','crash_after_fence_commit','--test-fault-on','finish'],{stdio:'pipe'});
  const exited=new Promise<void>(r=>child.once('close',()=>r()));const reader=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  async function command(command:string,data:unknown){child.stdin.write(JSON.stringify({id:1,command,data})+'\n');const next=await reader.next();return next.done?null:JSON.parse(next.value);}
  try{
    expect(JSON.parse((await reader.next()).value!).ready).toBe(true);
    const row=(await command('claim',input)).result;
    if(outcome==='known_success'){const snapshot_path=join(root,'snapshot');await writeFile(snapshot_path,'synthetic');await command('start',{operation_id:row.operation_id,snapshot_path});}
    expect(await command('finish',{operation_id:row.operation_id,outcome,...(outcome==='known_success'?{audit_recorded:false}:{reason:'no_change'})})).toBe(null);await exited;
    const readonly=await DurableLedger.open({...options,readOnly:true});opened.push(readonly);
    expect(await readonly.status(query)).toMatchObject({outcome,terminal_proof:{operation_id:row.operation_id,outcome}});
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;}
});

it('matches independent published canonical binding bytes and digest including a non-ASCII page path',async()=>{
  const {createHash}=await import('node:crypto');
  const vectors=JSON.parse(await readFile(new URL('../../../../docs/contracts/cxone-terminal-v1-fixtures.json',import.meta.url),'utf8'));
  function canonical(value:any):string{
    if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
    if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>canonical(k)+':'+canonical(value[k])).join(',')+'}';
    return JSON.stringify(value).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
  }
  expect(canonical(vectors.binding)).toBe(vectors.binding_canonical_json);
  expect(createHash('sha256').update(vectors.binding_canonical_json).digest('hex')).toBe(vectors.binding_sha256);
  const {ledger}=await fixture();const row=await ledger.claim({...input,target:vectors.statuses[0].body.terminal_proof.target,binding:vectors.binding});
  await ledger.finish(row.operation_id,{outcome:'not_attempted',reason:'no_change'});
  expect((await ledger.status(query))!.terminal_proof!.binding_sha256).toBe(vectors.binding_sha256);
});

it.each(['no_change','stale_preview','target_mismatch','pre_dispatch_failure'] as const)('preserves original %s evidence semantics for terminal restore intent',async reason=>{
 const {ledger}=await fixture();const row=await ledger.claim({...input,binding:{...input.binding,action:'cxone.restore'}});
 await ledger.finish(row.operation_id,{outcome:'not_attempted',reason});
 expect(await ledger.status(query)).toMatchObject({outcome:'not_attempted',reason,restored:false,evidence_effect:['stale_preview','target_mismatch'].includes(reason)?'invalidate':'preserve',terminal_proof:{action:'cxone.restore',reason,outcome:'not_attempted'}});
});
