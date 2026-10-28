"""Back up and restart the two recorded app services without opening browsers."""
from contextlib import closing
from pathlib import Path
import json
import sqlite3
import subprocess
import sys
import time
import urllib.request

WORK=Path(__file__).resolve().parent
ROOT=WORK.parent/'outputs'/'yidaizhang-local'
tables=('clients','users','vouchers','invoices','contracts','receipts','tax_records','projects')
def counts(folder):
    with closing(sqlite3.connect(folder/'app.sqlite3')) as conn:
        return {table:conn.execute('SELECT COUNT(*) FROM '+table).fetchone()[0] for table in tables}
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
report=[]
for demo in (False,True):
    folder=ROOT/('demo-data' if demo else 'data')
    before=counts(folder)
    args=['--demo'] if demo else []
    subprocess.run([sys.executable,str(ROOT/'stop.py'),*args],cwd=ROOT,check=True)
    archive=WORK/('before-client-panel-'+('demo' if demo else 'production')+'-'+str(time.time_ns())+'.zip')
    subprocess.run([sys.executable,str(ROOT/'maintenance.py'),'backup',str(archive),'--data-dir',str(folder)],cwd=ROOT,check=True)
    subprocess.run([sys.executable,str(ROOT/'launcher.py'),*args,'--no-open'],cwd=ROOT,check=True)
    after=counts(folder)
    assert before==after,'Existing business row counts changed during migration'
    with closing(sqlite3.connect(folder/'app.sqlite3')) as conn:
        assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert not conn.execute('PRAGMA foreign_key_check').fetchone()
        columns={row[1] for row in conn.execute('PRAGMA table_info(clients)')}
        assert {'profile_json','sensitive_json'}.issubset(columns)
    port=8766 if demo else 8765
    with opener.open(f'http://127.0.0.1:{port}/api/health',timeout=5) as response:
        health=json.load(response)
    assert health['app']=='yidaizhang-local'
    report.append({'demo':demo,'port':port,'existing_rows_preserved':before==after,'integrity':'ok','backup':archive.name})
(WORK/'client-panel-service-update.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False))
