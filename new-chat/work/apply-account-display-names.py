"""Apply the user's three display names, retaining account identity and history."""
from pathlib import Path
from contextlib import closing
import hashlib
import json
import sys
import time

work=Path(__file__).resolve().parent
root=work.parent/'outputs'/'yidaizhang-local'
sys.path.insert(0,str(root))
import db
import maintenance

targets=('吕','会计1','会计2')
snapshots=[]
for folder in (root/'data',root/'demo-data'):
    with closing(db.connect(folder/'app.sqlite3')) as conn:
        rows=[dict(row) for row in conn.execute('SELECT id,username,name,version FROM users ORDER BY id')]
    if rows and len(rows)!=3:
        raise RuntimeError('Expected exactly three existing accounts in '+folder.name)
    snapshots.append((folder,rows))

report=[]
stamp=str(time.time_ns())
for folder,rows in snapshots:
    archive=work/f'before-account-display-names-{folder.name}-{stamp}.zip'
    maintenance.backup(folder,archive)
    changes=[]
    with closing(db.connect(folder/'app.sqlite3')) as conn:
        conn.execute('BEGIN IMMEDIATE')
        for row,target in zip(rows,targets):
            current=conn.execute('SELECT * FROM users WHERE id=?',(row['id'],)).fetchone()
            if current['version']!=row['version'] or current['name']!=row['name']:
                raise RuntimeError('Account changed while preparing display-name update')
            if current['name']==target:
                continue
            identity=(current['id'],current['username'],current['password_hash'],current['enabled'])
            conn.execute('UPDATE users SET name=?,version=version+1 WHERE id=? AND version=?',(target,row['id'],row['version']))
            changed=conn.execute('SELECT * FROM users WHERE id=?',(row['id'],)).fetchone()
            assert identity==(changed['id'],changed['username'],changed['password_hash'],changed['enabled'])
            db.audit(conn,{'id':None,'username':'local_maintenance'},'update','user',row['id'],{'fields':['name'],'before':{'name':row['name']},'after':{'name':target},'reason':'User-approved accountant display names'})
            changes.append({'id':row['id'],'username':row['username'],'before':row['name'],'after':target})
        conn.commit()
        assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert not conn.execute('PRAGMA foreign_key_check').fetchone()
    report.append({'database':folder.name,'backup':archive.name,'changes':changes,'account_identity_preserved':True})
(work/'account-display-names-update.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
