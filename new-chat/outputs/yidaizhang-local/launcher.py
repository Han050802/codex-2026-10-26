"""Start the local service without modifying Windows firewall or system settings."""
from __future__ import annotations
import argparse
import json
import ipaddress
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parent
if hasattr(sys.stdout,'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr,'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')
os.environ.setdefault('PYTHONUTF8','1')

def request_json(url):
    # Local readiness must not be sent through a configured system proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=2) as response:
        return json.load(response)

def addresses():
    found=[]
    try:
        for item in socket.getaddrinfo(socket.gethostname(),None,socket.AF_INET):
            addr=item[4][0]
            local=any(ipaddress.ip_address(addr) in ipaddress.ip_network(net) for net in ('10.0.0.0/8','172.16.0.0/12','192.168.0.0/16'))
            if local and addr not in found:
                found.append(addr)
    except OSError:
        pass
    return found

def server_python():
    """Prefer the bundled interpreter when the caller lacks PDF extraction."""
    try:
        import pypdf  # noqa: F401
        return sys.executable
    except ImportError:
        bundled=Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
        if bundled.is_file():
            try:
                flags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
                probe=subprocess.run([str(bundled),'-c','import pypdf'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10,creationflags=flags)
                if probe.returncode==0: return str(bundled)
            except (OSError,subprocess.TimeoutExpired):
                pass
        print('提示：未找到 PDF 文字提取组件；PDF 将尝试使用图像识别。',file=sys.stderr)
        return sys.executable

def main():
    parser=argparse.ArgumentParser(description='本机代账系统启动器')
    parser.add_argument('--demo',action='store_true')
    parser.add_argument('--no-open',action='store_true')
    parser.add_argument('--port',type=int)
    args=parser.parse_args()
    port=args.port or (8766 if args.demo else 8765)
    folder=ROOT/('demo-data' if args.demo else 'data')
    folder.mkdir(exist_ok=True)
    base=f'http://127.0.0.1:{port}'
    try:
        existing=request_json(base+'/api/health')
    except Exception:
        existing=None
    if existing is not None and existing.get('app')!='yidaizhang-local':
        raise RuntimeError(f'端口 {port} 被其他程序占用，请使用 --port 指定其他端口。')
    if existing is None:
        log=open(folder/'server.log','ab',buffering=0)
        cmd=[server_python(),str(ROOT/'server.py'),'--host','0.0.0.0','--port',str(port),'--data-dir',str(folder)]
        if args.demo:cmd.append('--demo')
        kwargs={'cwd':str(ROOT),'stdin':subprocess.DEVNULL,'stdout':log,'stderr':subprocess.STDOUT}
        if os.name=='nt':kwargs['creationflags']=subprocess.CREATE_NO_WINDOW|subprocess.CREATE_NEW_PROCESS_GROUP
        else:kwargs['start_new_session']=True
        process=subprocess.Popen(cmd,**kwargs)
        (folder/'server.pid').write_text(str(process.pid),encoding='ascii')
        for _ in range(60):
            if process.poll() is not None:
                raise RuntimeError(f'服务启动失败，请查看 {folder / "server.log"}')
            try:
                if request_json(base+'/api/health').get('app')=='yidaizhang-local':break
            except Exception:time.sleep(.25)
        else:raise RuntimeError('服务启动超时，请检查日志。')
    session=request_json(base+'/api/session')
    url=base+'/'
    if session.get('setup_required'):
        token_file=folder/'setup-token.txt'
        if not token_file.exists():raise RuntimeError('首次设置口令文件不存在，请查看服务日志。')
        from urllib.parse import quote
        url+='?setup_token='+quote(token_file.read_text(encoding='utf-8').strip())
    print('\n易代账本地工作台 · '+('独立本地测试环境' if args.demo else '正式环境'))
    print('本机访问：'+base+'/')
    for addr in addresses():print('局域网候选地址：'+f'http://{addr}:{port}/')
    print('数据目录：'+str(folder))
    print('服务日志：'+str(folder/'server.log'))
    print('首次账号设置请在服务器本机完成。请使用这台电脑的实际局域网 IPv4 地址。')
    if args.demo:print('测试数据与正式数据互相独立，不自动填充企业。测试账号见使用说明。')
    if not args.no_open:webbrowser.open(url)
    return 0

if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception as error:
        print('启动未完成：'+str(error),file=sys.stderr)
        raise SystemExit(1)
