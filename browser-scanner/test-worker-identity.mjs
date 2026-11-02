import assert from 'node:assert/strict';
export function findOwnedWorker(rows,serverPid){
 const owned=new Set([String(serverPid)]);
 for(let changed=true;changed;){changed=false;for(const row of rows)if(owned.has(row[1])&&!owned.has(row[0])){owned.add(row[0]);changed=true;}}
 const worker=rows.find(row=>owned.has(row[0])&&/^(?:\S*\/)?node(?:\s|$)/.test(row.slice(4).join(' '))&&row.slice(4).join(' ').includes('scan-worker.mjs'));
 if(!worker)return null;
 if(process.platform==='linux'){
  const guardian=rows.find(row=>row[0]===worker[1]);
  assert.ok(guardian&&+guardian[1]===serverPid&&guardian.slice(4).join(' ').includes('process-guardian.py'),'actual Node worker must belong to its dedicated guardian');
 }
 return{owned,workerPid:worker[0]};
}
