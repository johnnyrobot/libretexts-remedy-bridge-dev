import {readdir,readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class OwnershipFailure extends Error {
 constructor(code,details={}){super(code);this.code=code;this.details=Object.freeze(details);}
}
async function processes(){
 if(process.platform!=='linux'){
  const {stdout}=await promisify(execFile)('ps',['-eo','pid=,ppid=,pgid=,stat='],{timeout:2000,maxBuffer:1024*1024});
  return{rows:stdout.trim().split('\n').map(line=>{const [pid,ppid,group,state]=line.trim().split(/\s+/);return{pid:+pid,ppid:+ppid,group:+group,state};}),uncertain:false};
 }
 const names=(await readdir('/proc')).filter(name=>/^\d+$/.test(name));
 if(names.length>4096)throw Error('Process inventory exceeds ownership limit');
 const missing=[];
 const rows=(await Promise.all(names.map(async name=>{
  try{const stat=await readFile(`/proc/${name}/stat`,'utf8');const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');return{pid:+name,ppid:+fields[1],group:+fields[2],state:fields[0]};}catch(error){if(error.code==='ENOENT'||error.code==='ESRCH'){missing.push(+name);return null;}throw error;}
 }))).filter(Boolean);
 return{rows,uncertain:missing.length>0,missing};
}
/** Playwright launches Chromium in a separate group; freeze the owner before inventory. */
export async function terminateOwnedTree(pid,additionalRoots=[]){
 const roots=new Set([pid,...additionalRoots].filter(Boolean));
 if([...roots].some(root=>!Number.isSafeInteger(root)||root<=1||root===process.pid))throw Error('Invalid process ownership');
 const owned=new Set(roots),groups=new Set(roots),stopped=new Set();
 let rows,uncertain=false;const reasons=new Set(),missing=new Set();
 const details=()=>({reasons:[...reasons].sort(),owned:owned.size,stopped:stopped.size,missingCount:missing.size,missingSample:[...missing].sort((a,b)=>a-b).slice(0,8)});
 for(let i=0;i<100;i++){
  // Freeze every discovered descendant before taking a stable inventory. A child
  // that forks into another group during the first inventory is found next time.
  for(const member of owned){try{process.kill(member,'SIGSTOP');}catch(error){if(error.code!=='ESRCH')throw error;if(!roots.has(member)&&!stopped.has(member)){uncertain=true;reasons.add('unfrozen_member_disappeared');}}}
  const inventory=await processes();rows=inventory.rows;uncertain ||= inventory.uncertain;if(inventory.uncertain){reasons.add('global_inventory_disappearance');for(const member of inventory.missing??[])missing.add(member);}
  for(let changed=true;changed;){changed=false;for(const row of rows)if(owned.has(row.ppid)&&!owned.has(row.pid)){owned.add(row.pid);changed=true;}}
  for(const row of rows)if(owned.has(row.pid)){groups.add(row.group);if(row.state.startsWith('T'))stopped.add(row.pid);else if(row.state.startsWith('Z')&&!roots.has(row.pid)&&!stopped.has(row.pid)){uncertain=true;reasons.add('unfrozen_descendant_zombie');}}
  const running=rows.some(row=>owned.has(row.pid)&&!row.state.startsWith('T')&&!row.state.startsWith('Z'));
  if(!running)break;
  if(i===99)throw new OwnershipFailure('owner_stop_unproved',details());
  await sleep(10);
 }
 for(const group of groups){try{process.kill(-group,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
 for(let i=0;i<100;i++){
  const active=(await processes()).rows.some(row=>(owned.has(row.pid)||groups.has(row.group))&&!row.state.startsWith('Z'));
  if(!active){if(uncertain)throw new OwnershipFailure('ownership_uncertain',details());return;}
  await sleep(10);
 }
 throw new OwnershipFailure('termination_unproved',details());
}
