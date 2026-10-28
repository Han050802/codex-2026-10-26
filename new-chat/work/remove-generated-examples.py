"""Remove verified factory examples only, preserving every non-example row.

Default is a dry run on a SQLite backup copy. --apply stops the recorded demo
service, creates a consistent recovery ZIP, commits one FK-checked transaction,
and restarts without opening a browser. User-created companies are never matched
by a loose name prefix.
"""
from contextlib import closing
from pathlib import Path
import argparse
import hashlib
import json
import re
import sqlite3
import subprocess
import sys
import tempfile
import time

WORK=Path(__file__).resolve().parent
ROOT=WORK.parent/'outputs'/'yidaizhang-local'
sys.path.insert(0,str(ROOT))
import maintenance
import db

def targets(conn):
    if not conn.execute("SELECT 1 FROM meta WHERE key='synthetic_seeded'").fetchone():return []
    proven={}
    for row in conn.execute("SELECT entity_id,detail FROM audit_logs WHERE entity='clients' AND action='create' ORDER BY id"):
        after=json.loads(row['detail']).get('after',{})
        code=after.get('code','')
        if re.fullmatch(r'DEMO\d{4}',code) and 1<=int(code[4:])<=200 and after.get('name')==f'演示企业{int(code[4:]):03d}有限公司':
            proven[int(row['entity_id'])]=(code,after['name'])
    return [r['id'] for r in conn.execute('SELECT id,code,name FROM clients') if proven.get(r['id'])==(r['code'],r['name'])]

def q(name):return '"'+name.replace('"','""')+'"'

def rows_to_keep(conn,ids):
    ids=set(ids)
    asset_ids={r[0] for r in conn.execute('SELECT id FROM assets WHERE client_id IN ('+','.join('?'*len(ids))+')',tuple(ids))} if ids else set()
    result={}
    for item in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall():
        name=item[0]
        if name in ('meta','audit_logs','sessions'):continue
        kept=[]
        for row in conn.execute('SELECT * FROM '+q(name)):
            row=dict(row)
            if name=='clients' and row['id'] in ids:continue
            if 'client_id' in row and row['client_id'] in ids:continue
            if name=='asset_depreciations' and row['asset_id'] in asset_ids:continue
            kept.append(json.dumps(row,ensure_ascii=False,sort_keys=True,separators=(',',':')))
        result[name]=hashlib.sha256('\n'.join(sorted(kept)).encode()).hexdigest()
    return result

def purge(conn):
    ids=targets(conn)
    if not ids:return {'removed_companies':0,'kept_companies':conn.execute('SELECT COUNT(*) FROM clients').fetchone()[0],'non_example_rows_unchanged':True}
    placeholders=','.join('?'*len(ids));params=tuple(ids)
    before=rows_to_keep(conn,ids)
    by_table={}
    for table in ('clients','notes','invoices','contracts','receipts','projects','tax_records','tax_agents','invoice_requests','accounts','vouchers','assets','inventory_items','payroll','journals'):
        key='id' if table=='clients' else 'client_id'
        by_table[table]={str(r[0]) for r in conn.execute('SELECT id FROM '+q(table)+' WHERE '+key+' IN ('+placeholders+')',params)}
    aliases={'book':'clients','client':'clients','voucher':'vouchers','asset':'assets','account':'accounts','inventory_item':'inventory_items','journal':'journals'}
    def refers(value):
        if isinstance(value,dict):return any((k=='client_id' and str(v) in by_table['clients']) or refers(v) for k,v in value.items())
        if isinstance(value,list):return any(refers(v) for v in value)
        return False
    audit_ids=[]
    for row in conn.execute('SELECT id,entity,entity_id,detail FROM audit_logs'):
        entity=aliases.get(row['entity'],row['entity'])
        if str(row['entity_id']) in by_table.get(entity,set()) or refers(json.loads(row['detail'])):audit_ids.append(row['id'])
    deleted={}
    conn.execute('PRAGMA secure_delete=ON')
    with conn:
        conn.execute('BEGIN IMMEDIATE')
        cursor=conn.execute('DELETE FROM asset_depreciations WHERE asset_id IN (SELECT id FROM assets WHERE client_id IN ('+placeholders+'))',params)
        deleted['asset_depreciations']=cursor.rowcount
        order=('inventory_movements','payroll','journals','assets','book_periods','opening_balances','voucher_lines','vouchers','inventory_items','accounts','book_settings','receipts','contracts','notes','invoices','projects','tax_records','tax_agents','invoice_requests')
        for table in order:
            deleted[table]=conn.execute('DELETE FROM '+q(table)+' WHERE client_id IN ('+placeholders+')',params).rowcount
        deleted['clients']=conn.execute('DELETE FROM clients WHERE id IN ('+placeholders+')',params).rowcount
        if audit_ids:
            conn.executemany('DELETE FROM audit_logs WHERE id=?',[(i,) for i in audit_ids])
        conn.execute("DELETE FROM meta WHERE key='synthetic_seeded'")
        conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('factory_examples_removed','true')")
        db.audit(conn,None,'remove_factory_examples','maintenance','factory_examples',{'removed_companies':len(ids),'deleted_row_counts':deleted,'recovery_backup_created':True})
        if conn.execute('PRAGMA foreign_key_check').fetchone():raise RuntimeError('Foreign key verification failed; cleanup rolled back')
        if rows_to_keep(conn,ids)!=before:raise RuntimeError('Non-example rows changed; cleanup rolled back')
    conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    conn.execute('VACUUM')
    assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    return {'removed_companies':len(ids),'kept_companies':conn.execute('SELECT COUNT(*) FROM clients').fetchone()[0],'deleted_row_counts':deleted,'non_example_rows_unchanged':True,'integrity':'ok'}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--apply',action='store_true');args=parser.parse_args()
    directory=ROOT/'demo-data';source=directory/'app.sqlite3'
    if not args.apply:
        with tempfile.TemporaryDirectory(prefix='example-cleanup-dry-',dir=WORK) as temporary:
            assert Path(temporary).resolve().is_relative_to(WORK)
            stage=Path(temporary)/'copy.sqlite3'
            with closing(sqlite3.connect(source.as_uri()+'?mode=ro',uri=True)) as original,closing(sqlite3.connect(stage)) as copied:original.backup(copied)
            with closing(db.connect(stage)) as conn:report=purge(conn)
            report['mode']='dry_run_copy'
    else:
        subprocess.run([sys.executable,str(ROOT/'stop.py'),'--demo'],cwd=ROOT,check=True)
        maintenance.assert_offline(directory)
        backup=WORK/('before-example-removal-'+str(time.time_ns())+'.zip')
        maintenance.backup(directory,backup)
        try:
            with closing(db.connect(source)) as conn:report=purge(conn)
        finally:
            subprocess.run([sys.executable,str(ROOT/'launcher.py'),'--demo','--no-open'],cwd=ROOT,check=True)
        report.update(mode='applied',backup=backup.name)
    (WORK/('example-cleanup-applied.json' if args.apply else 'example-cleanup-dry.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))

if __name__=='__main__':main()
