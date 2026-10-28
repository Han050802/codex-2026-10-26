"""Stop only this application's recorded service process after identity checks."""
from __future__ import annotations
import argparse
from pathlib import Path
import json
import os
import signal
import sys
import time
import urllib.request

def main():
    p=argparse.ArgumentParser(description='停止本地代账服务')
    p.add_argument('--demo',action='store_true')
    p.add_argument('--port',type=int)
    a=p.parse_args()
    root=Path(__file__).resolve().parent
    folder=root/('demo-data' if a.demo else 'data')
    port=a.port or (8766 if a.demo else 8765)
    pidfile=folder/'server.pid'
    if not pidfile.exists():print('没有找到本应用启动的服务记录。');return
    pid=int(pidfile.read_text(encoding='ascii'))
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f'http://127.0.0.1:{port}/api/health',timeout=2) as response:health=json.load(response)
    except Exception:print('服务没有响应；为避免误停止其他进程，未发送停止信号。');return
    if health.get('app')!='yidaizhang-local' or health.get('pid')!=pid:
        raise RuntimeError('进程身份不匹配，已停止操作。')
    # Local launcher creates this process and records its pid. On Windows the
    # stdlib termination operation only targets that verified process.
    os.kill(pid,signal.SIGTERM)
    for _ in range(30):
        try:
            with opener.open(f'http://127.0.0.1:{port}/api/health',timeout=.3) as response:
                current=json.load(response)
            if current.get('pid')!=pid:break
        except Exception:break
        time.sleep(.1)
    else:raise RuntimeError('停止信号已发送，服务仍在退出；请稍后检查。')
    marker=folder/'server.lock'
    if marker.exists() and marker.read_text(encoding='utf-8').strip()==str(pid):
        marker.unlink()
    pidfile.unlink(missing_ok=True)
    print('本地代账服务已停止。')

if __name__=='__main__':
    try:main()
    except Exception as e:print(str(e),file=sys.stderr);raise SystemExit(1)
