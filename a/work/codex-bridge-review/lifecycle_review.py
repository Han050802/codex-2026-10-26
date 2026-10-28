import ctypes as C, ctypes.wintypes as W, json, os, pathlib, shutil, subprocess, time
HERE=pathlib.Path(__file__).resolve().parent
SOURCE=pathlib.Path(os.environ.get('REVIEW_BRIDGE_SOURCE',str(HERE.parent/'codex-bridge'/'aionui-codex-bridge.exe')))
BRIDGE=HERE/'aionui-codex-bridge.exe'
shutil.copy2(SOURCE,BRIDGE)
(HERE/'codex-real-path.txt').write_text(str(HERE/'FakeChild.exe'),encoding='utf-8')
kernel=C.WinDLL('kernel32',use_last_error=True)
kernel.OpenProcess.argtypes=[W.DWORD,W.BOOL,W.DWORD]; kernel.OpenProcess.restype=W.HANDLE
kernel.CloseHandle.argtypes=[W.HANDLE]
kernel.GetExitCodeProcess.argtypes=[W.HANDLE,C.POINTER(W.DWORD)]
kernel.TerminateProcess.argtypes=[W.HANDLE,W.UINT]
kernel.CreateJobObjectW.argtypes=[C.c_void_p,W.LPCWSTR]; kernel.CreateJobObjectW.restype=W.HANDLE
kernel.AssignProcessToJobObject.argtypes=[W.HANDLE,W.HANDLE]
kernel.TerminateJobObject.argtypes=[W.HANDLE,W.UINT]
kernel.SetInformationJobObject.argtypes=[W.HANDLE,C.c_int,C.c_void_p,W.DWORD]
class BasicLimit(C.Structure):
    _fields_=[('ProcessTime',C.c_longlong),('JobTime',C.c_longlong),('LimitFlags',W.DWORD),('MinWork',C.c_size_t),('MaxWork',C.c_size_t),('ActiveProcesses',W.DWORD),('Affinity',C.c_size_t),('Priority',W.DWORD),('Scheduling',W.DWORD)]
class Counters(C.Structure):
    _fields_=[(x,C.c_ulonglong) for x in ('ReadOps','WriteOps','OtherOps','ReadBytes','WriteBytes','OtherBytes')]
class Extended(C.Structure):
    _fields_=[('Basic',BasicLimit),('IO',Counters),('ProcessMemory',C.c_size_t),('JobMemory',C.c_size_t),('PeakProcess',C.c_size_t),('PeakJob',C.c_size_t)]
def alive(pid):
    h=kernel.OpenProcess(0x1000,False,pid)
    if not h:return False
    code=W.DWORD();kernel.GetExitCodeProcess(h,C.byref(code));kernel.CloseHandle(h)
    return code.value==259
def pidfile(path):
    for _ in range(100):
        if path.exists():return int(path.read_text())
        time.sleep(.05)
    raise RuntimeError('fake child did not start')
def run(mode,label,suspended=False):
    env=os.environ.copy(); env.update(REVIEW_MODE=mode,REVIEW_PID_PATH=str(HERE/(label+'.pid')),REVIEW_INPUT_PATH=str(HERE/(label+'.stdin')))
    pathlib.Path(env['REVIEW_PID_PATH']).unlink(missing_ok=True)
    p=subprocess.Popen([str(BRIDGE),'app-server'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,creationflags=4 if suspended else 0)
    return p,pathlib.Path(env['REVIEW_PID_PATH'])
results={}
p,pf=run('eof','eof')
out,err=p.communicate('{"id":9,"method":"review/echo","params":{"text":"中文"}}\n'.encode('utf-8'),timeout=8)
results['stdin_eof']={'exit':p.returncode,'stdout':out.decode(),'stderr':err.decode(),'child_alive':alive(pidfile(pf))}
assert p.returncode==23 and err==b'REVIEW_STDERR_OK' and not results['stdin_eof']['child_alive']
job=kernel.CreateJobObjectW(None,None); assert job
info=Extended();info.Basic.LimitFlags=0x2000
assert kernel.SetInformationJobObject(job,9,C.byref(info),C.sizeof(info))
p,pf=run('hold','jobkill',True)
assert kernel.AssignProcessToJobObject(job,W.HANDLE(int(p._handle)))
ntdll=C.WinDLL('ntdll');ntdll.NtResumeProcess.argtypes=[W.HANDLE]; assert ntdll.NtResumeProcess(W.HANDLE(int(p._handle)))==0
child=pidfile(pf)
assert alive(child)
assert kernel.TerminateJobObject(job,37)
p.communicate(timeout=8)
for _ in range(100):
    if not alive(child):break
    time.sleep(.02)
results['aioncore_job_termination']={'wrapper_exit':p.returncode,'child_alive':alive(child)}
kernel.CloseHandle(job)
assert not alive(child)
p,pf=run('write','brokenstdout')
child=pidfile(pf)
p.stdout.close()
try:
    p.wait(timeout=3)
    for _ in range(100):
        if not alive(child):break
        time.sleep(.02)
    results['broken_stdout']={'wrapper_exit':p.returncode,'child_alive':alive(child)}
except subprocess.TimeoutExpired:
    results['broken_stdout']={'wrapper_hung':True,'child_alive':alive(child)}
finally:
    if p.poll() is None:p.kill()
    if alive(child):
        h=kernel.OpenProcess(1,False,child);kernel.TerminateProcess(h,1);kernel.CloseHandle(h)
    p.wait(timeout=3)
    p.stdin.close();p.stderr.close()
(HERE/'lifecycle-results.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
print(json.dumps(results))
