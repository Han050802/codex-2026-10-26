from contextlib import closing
from pathlib import Path
import json
import re
import sqlite3

ROOT=Path(__file__).resolve().parents[1]/'outputs'/'yidaizhang-local'
reports=[]
for directory in ('data','demo-data'):
    path=ROOT/directory/'app.sqlite3'
    with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)) as conn:
        conn.row_factory=sqlite3.Row
        meta={r[0]:r[1] for r in conn.execute('SELECT key,value FROM meta')}
        clients=[dict(r) for r in conn.execute('SELECT id,name,code,created_at,updated_at,deleted FROM clients')]
        origins={}
        for row in conn.execute("SELECT entity_id,detail,created_at FROM audit_logs WHERE entity='clients' AND action='create' ORDER BY id"):
            try:
                after=json.loads(row['detail']).get('after',{})
                code=after.get('code','')
                if re.fullmatch(r'DEMO\d{4}',code) and 1<=int(code[4:])<=200 and after.get('name')==f'演示企业{int(code[4:]):03d}有限公司':
                    origins[int(row['entity_id'])]={'code':code,'created_at':row['created_at']}
            except (ValueError,TypeError):
                continue
        targets=[r['id'] for r in clients if r['id'] in origins and r['code']==origins[r['id']]['code'] and r['name']==f'演示企业{int(r["code"][4:]):03d}有限公司']
        stats={r[0]:conn.execute('SELECT COUNT(*) FROM '+r[0]).fetchone()[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()}
        reports.append({'directory':directory,'demo':meta.get('demo'),'has_seed_marker':bool(meta.get('synthetic_seeded')),'total_clients':len(clients),'verified_seed_targets':targets,'other_clients':len(clients)-len(targets),'seed_origins_with_changed_profile':sum(1 for r in clients if r['id'] in origins and r['id'] not in targets),'table_counts':stats})
out=Path(__file__).resolve().parent/'example-inventory.json'
out.write_text(json.dumps(reports,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps([{k:v for k,v in r.items() if k not in ('verified_seed_targets','table_counts')} for r in reports],ensure_ascii=False))
