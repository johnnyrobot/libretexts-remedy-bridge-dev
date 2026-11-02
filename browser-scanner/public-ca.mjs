import {constants} from 'node:fs';
import {open,mkdir,writeFile,lstat,readdir} from 'node:fs/promises';
import {createHash,X509Certificate} from 'node:crypto';
import {isAbsolute,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

export const PUBLIC_CA_LIMITS=Object.freeze({inputBytes:65536,certificates:8,derivedBytes:1024*1024,derivedEntries:32});
const hash=value=>createHash('sha256').update(value).digest('hex');
const invalid=()=>Error('Public CA configuration invalid or unavailable');
function parse(pem){
 if(typeof pem!=='string'||Buffer.byteLength(pem)>PUBLIC_CA_LIMITS.inputBytes)throw invalid();
 const blocks=pem.match(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g)??[];
 if(!blocks.length||blocks.length>PUBLIC_CA_LIMITS.certificates||pem.replace(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g,'').trim())throw invalid();
 const certificates=blocks.map(block=>{
  const cert=new X509Certificate(block),der=Buffer.from(block.replace(/-----[A-Z ]+-----/g,'').replace(/\s/g,''),'base64');
  // Explicit trust anchors only: no leaf, intermediate, key or client identity.
  if(!cert.raw.equals(der)||!cert.ca||!cert.checkIssued(cert)||!cert.verify(cert.publicKey))throw invalid();
  return cert;
 });
 if(new Set(certificates.map(c=>c.fingerprint256)).size!==certificates.length)throw invalid();
 return certificates;
}
/** Capture the operator's finite public-only input once, before listening. */
export async function loadPublicCA(file){
 if(!file)return null;
 let handle;
 try{
  if(!isAbsolute(file))throw invalid();
  handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const before=await handle.stat();
  if(!before.isFile()||(before.mode&0o222)||!(before.mode&0o444)||before.size>PUBLIC_CA_LIMITS.inputBytes)throw invalid();
  const buffer=Buffer.alloc(PUBLIC_CA_LIMITS.inputBytes+1);
  let length=0;
  while(length<buffer.length){const {bytesRead}=await handle.read(buffer,length,buffer.length-length,null);if(!bytesRead)break;length+=bytesRead;}
  const after=await handle.stat();
  if(length>PUBLIC_CA_LIMITS.inputBytes||length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw invalid();
  const pem=buffer.subarray(0,length).toString('utf8'),certificates=parse(pem);
  return Object.freeze({pem,sha256:hash(pem),fingerprints:Object.freeze(certificates.map(c=>c.fingerprint256))});
 }catch{throw invalid();}finally{await handle?.close();}
}
const snapshotFile=home=>join(home,'operator-public-ca.pem');
export async function stagePublicCA(snapshot,home){
 if(snapshot)await writeFile(snapshotFile(home),snapshot.pem,{mode:0o400,flag:'wx'});
}
const execute=promisify(execFile);
/** Runs inside the owned worker: every tool child inherits its guardian/lifetime. */
export async function provisionPublicCA(expectedHash,home){
 if(!expectedHash)return;
 if(process.platform!=='linux')throw invalid();
 const snapshot=await loadPublicCA(snapshotFile(home));
 if(snapshot.sha256!==expectedHash)throw invalid();
 const certificates=parse(snapshot.pem);
 const root=await lstat(home);
 if(!root.isDirectory()||root.isSymbolicLink()||root.uid!==process.getuid()||(root.mode&0o077))throw invalid();
 process.umask(0o077);
 // Chromium >=146 reuses a pre-existing legacy DB; older releases use it too.
 const database=join(home,'.pki','nssdb');
 await mkdir(join(home,'.pki'),{mode:0o700});await mkdir(database,{mode:0o700});
 const run=args=>execute('/usr/bin/certutil',['-d',`sql:${database}`,...args],{timeout:5000,killSignal:'SIGKILL',maxBuffer:8192});
 await run(['-N','--empty-password']);
 for(const [index,certificate] of certificates.entries()){
  const input=join(home,'.pki',`ca-${index}.pem`);
  await writeFile(input,certificate.toString(),{mode:0o600,flag:'wx'});
  await run(['-A','-a','-t','C,,','-n',`operator-ca-${index}`,'-i',input]);
 }
 await writeFile(join(home,'.pki','public-ca.json'),JSON.stringify({sha256:snapshot.sha256,fingerprints:certificates.map(c=>c.fingerprint256)}),{mode:0o600,flag:'wx'});
 let bytes=0,entries=0;const pending=[home];
 while(pending.length){
  const directory=pending.pop();
  for(const name of await readdir(directory)){
   const target=join(directory,name),stat=await lstat(target);
   if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory())||stat.uid!==root.uid||(stat.mode&0o077))throw invalid();
   bytes+=Math.max(stat.size,stat.blocks*512);entries++;
   if(bytes>PUBLIC_CA_LIMITS.derivedBytes||entries>PUBLIC_CA_LIMITS.derivedEntries)throw invalid();
   if(stat.isDirectory())pending.push(target);
  }
 }
}
