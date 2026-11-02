import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,chmod} from 'node:fs/promises';
import {join} from 'node:path';
export async function certificates(host='dev.libretexts.org',roots=1){
 const dir=await mkdtemp('/tmp/lt239-certs-');
 const openssl=args=>execFileSync('openssl',args,{cwd:dir,stdio:'ignore'});
 openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','2','-subj','/CN=LT239 Synthetic CA','-addext','basicConstraints=critical,CA:TRUE']);
 openssl(['req','-newkey','rsa:2048','-nodes','-keyout','leaf.key','-out','leaf.csr','-subj','/CN=dev.libretexts.org']);
 await writeFile(join(dir,'leaf.ext'),`subjectAltName=DNS:${host}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
 openssl(['x509','-req','-in','leaf.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out','leaf.pem','-days','2','-extfile','leaf.ext']);
 let bundle=await readFile(join(dir,'ca.pem'),'utf8');
 for(let i=1;i<roots;i++){
  openssl(['req','-x509','-new','-key','ca.key','-out',`root-${i}.pem`,'-days','2','-subj',`/CN=LT239 Synthetic CA ${i}`,'-addext','basicConstraints=critical,CA:TRUE']);
  bundle+=await readFile(join(dir,`root-${i}.pem`),'utf8');
 }
 await writeFile(join(dir,'ca.pem'),bundle);
 await chmod(join(dir,'ca.pem'),0o444);
 return{dir,ca:join(dir,'ca.pem'),key:await readFile(join(dir,'leaf.key')),cert:await readFile(join(dir,'leaf.pem'))};
}
