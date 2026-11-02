import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
test('unprivileged image positively adopts and retains its child identity until reap',{skip:process.platform!=='linux',timeout:10000},async()=>{
 const script=`import ctypes,os,signal,json,time
lib=ctypes.CDLL(None,use_errno=True);assert lib.prctl(38,1,0,0,0)==0;assert lib.prctl(36,1,0,0,0)==0
flag=ctypes.c_int();assert lib.prctl(37,ctypes.byref(flag),0,0,0)==0 and flag.value==1
r,w=os.pipe();worker=os.fork();grand=None;fd=None
if worker==0:
 os.close(r);grand=os.fork()
 if grand==0:
  os.setsid();os.write(w,str(os.getpid()).encode());os.close(w);time.sleep(8);os._exit(0)
 os._exit(0)
os.close(w)
try:
 grand=int(os.read(r,64));os.close(r);os.waitpid(worker,0)
 raw=open('/proc/'+str(grand)+'/stat').read();fields=raw[raw.rfind(')')+2:].split()
 assert int(fields[1])==os.getpid() and int(fields[3])==grand
 pidfd_error=None
 try:
  fd=os.pidfd_open(grand)
 except OSError as e:pidfd_error=e.errno
 assert os.waitid(os.P_PID,grand,os.WEXITED|os.WNOHANG|os.WNOWAIT) is None
 if fd is not None:signal.pidfd_send_signal(fd,signal.SIGKILL)
 else:os.kill(grand,signal.SIGKILL)
 waited=os.waitid(os.P_PID,grand,os.WEXITED|os.WNOWAIT);assert waited.si_pid==grand
 zombie=open('/proc/'+str(grand)+'/stat').read();assert zombie[zombie.rfind(')')+2:].split()[0]=='Z'
 os.waitpid(grand,0)
 try:os.waitpid(-1,os.WNOHANG);raise RuntimeError('Child remained')
 except ChildProcessError:pass
 status=open('/proc/self/status').read().splitlines();safe={k:v.strip() for k,v in (line.split(':',1) for line in status) if k in ('CapEff','NoNewPrivs','Seccomp')}
 print(json.dumps({'subreaper':flag.value,'adopted':True,'pidfd':fd is not None,'pidfd_error':pidfd_error,'unreaped_identity':True,'echild':True,'uid':os.getuid(),'policy':safe}))
finally:
 if fd is not None:os.close(fd)
 for pid in (worker,grand):
  if pid is None:continue
  try:
   known,st=os.waitpid(pid,os.WNOHANG)
   if known==0:os.kill(pid,signal.SIGKILL);os.waitpid(pid,0)
  except ChildProcessError:pass`;
 const {stdout}=await promisify(execFile)('python3',['-c',script],{timeout:8000,maxBuffer:8192});const proof=JSON.parse(stdout);console.log(JSON.stringify({phase:'kernel_owner_probe',...proof}));assert.equal(proof.subreaper,1);assert.equal(proof.adopted,true);assert.equal(proof.unreaped_identity,true);assert.equal(proof.echild,true);assert.equal(proof.policy.NoNewPrivs,'1');
 // RUN_BROWSER_TESTS selects the existing hardened shipping-image suite.
 if(process.env.RUN_BROWSER_TESTS==='1'){assert.notEqual(proof.uid,0);assert.match(proof.policy.CapEff,/^0+$/);assert.equal(proof.policy.Seccomp,'2');}
});
