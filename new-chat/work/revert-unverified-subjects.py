import sqlite3, sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd()))
import db
path=Path('data/app.sqlite3')
backup=Path('data/backup-before-subject-list-company2-20261027.sqlite3')
conn=db.connect(path)
old=sqlite3.connect(f'file:{backup.resolve().as_posix()}?mode=ro', uri=True)
old.row_factory=sqlite3.Row
codes=('1133','5403','5901')
try:
    conn.execute('BEGIN IMMEDIATE')
    before={r['code']:dict(r) for r in old.execute('SELECT * FROM accounts WHERE client_id=2 AND code IN (?,?,?)',codes)}
    now={r['code']:dict(r) for r in conn.execute('SELECT * FROM accounts WHERE client_id=2 AND code IN (?,?,?)',codes)}
    assert set(before)=={'5403'} and set(now)==set(codes)
    assert now['5403']['name']=='税金及附加' and before['5403']['name']=='营业税金及附加' and now['5403']['version']==before['5403']['version']+1
    assert now['1133']['version']==1 and now['5901']['version']==1
    for table, in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
        if table in ('accounts','audit_logs'): continue
        columns=[x[1] for x in conn.execute('PRAGMA table_info("'+table.replace('"','""')+'")')]
        if 'client_id' not in columns: continue
        for row in conn.execute('SELECT * FROM "'+table.replace('"','""')+'" WHERE client_id=?',(2,)):
            for value in row:
                if isinstance(value,str) and any(code in value for code in codes):
                    raise RuntimeError('发现可能的业务引用：'+table)
    for code in ('1133','5901'):
        if conn.execute('SELECT 1 FROM accounts WHERE client_id=2 AND code LIKE ? AND code<>?',(code+'%',code)).fetchone(): raise RuntimeError('存在下级科目：'+code)
    conn.execute('DELETE FROM accounts WHERE client_id=2 AND code IN (?,?)',('1133','5901'))
    conn.execute('UPDATE accounts SET name=?,version=version+1 WHERE client_id=2 AND code=?',(before['5403']['name'],'5403'))
    db.audit(conn,None,'revert_unverified_subject_list','book',2,{'reason':'清单仅确认属于另一账套，适用性未核实','reverts_audit_id':34,'changed_codes':list(codes)})
    conn.commit()
    print('Reverted unverified migration; account count:', conn.execute('SELECT COUNT(*) FROM accounts WHERE client_id=2').fetchone()[0])
except Exception:
    conn.rollback()
    raise
finally:
    conn.close(); old.close()
