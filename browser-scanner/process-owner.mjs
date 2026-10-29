import {readdir,readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function processes(){
 if(process.platform!=='linux'){
  const {stdout}=await promisify(execFile)('ps',['-eo','pid=,ppid=,pgid=,stat='],{timeout:2000,maxBuffer:1024*1024});
  return stdout.trim().split('\n').map(line=>{const [pid,ppid,group,state]=line.trim().split(/\s+/);return{pid:+pid,ppid:+ppid,group:+group,state};});
 }
 const names=(await readdir('/proc')).filter(name=>/^\d+$/.test(name));
 if(names.length>4096)throw Error('Process inventory exceeds ownership limit');
 return (await Promise.all(names.map(async name=>{
  try{const stat=await readFile(`/proc/${name}/stat`,'utf8');const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');return{pid:+name,ppid:+fields[1],group:+fields[2],state:fields[0]};}catch{return null;}
 }))).filter(Boolean);
}
/** Playwright launches Chromium in a separate group; freeze the owner before inventory. */
export async function terminateOwnedTree(pid,additionalRoots=[]){
 const roots=new Set([pid,...additionalRoots].filter(Boolean));
 for(const root of roots){try{process.kill(root,'SIGSTOP');}catch(error){if(error.code!=='ESRCH')throw error;}}
 let rows;
 for(let i=0;i<100;i++){
  rows=await processes();
  const running=rows.some(row=>roots.has(row.pid)&&!row.state.startsWith('T')&&!row.state.startsWith('Z'));
  if(!running)break;
  if(i===99)throw Error('Owner did not stop');
  await sleep(10);
 }
 const owned=new Set(roots);
 for(let changed=true;changed;){changed=false;for(const row of rows)if(owned.has(row.ppid)&&!owned.has(row.pid)){owned.add(row.pid);changed=true;}}
 const groups=new Set([...roots,...rows.filter(row=>owned.has(row.pid)).map(row=>row.group)]);
 for(const group of groups){try{process.kill(-group,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
 for(let i=0;i<100;i++){
  const active=(await processes()).some(row=>owned.has(row.pid)&&!row.state.startsWith('Z'));
  if(!active)return;
  await sleep(10);
 }
 throw Error('Owned descendants did not terminate');
}
