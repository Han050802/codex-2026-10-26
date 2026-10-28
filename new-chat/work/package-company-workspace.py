"""Validate local assets, preserve existing business data and package sources."""
from pathlib import Path
from contextlib import closing
import hashlib
import json
import sqlite3
import tempfile
import urllib.request
import zipfile

work=Path(__file__).resolve().parent
root=work.parent/'outputs'/'yidaizhang-local'
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
tables=('clients','users','vouchers','voucher_lines','opening_balances','accounts','invoices','contracts','receipts','tax_records','projects')
report={'business_data':[], 'services':[], 'assets':[]}
for label,port in [('production',8765),('demo',8766)]:
    folder=root/('data' if label=='production' else 'demo-data')
    with closing(sqlite3.connect(folder/'app.sqlite3')) as conn:
        before={table:conn.execute('SELECT COUNT(*) FROM '+table).fetchone()[0] for table in tables}
        assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert not conn.execute('PRAGMA foreign_key_check').fetchone()
    archive=work/f'before-company-workspace-{label}.zip'
    with tempfile.TemporaryDirectory(prefix='company-backup-check-') as directory:
        with zipfile.ZipFile(archive) as bundle: bundle.extract('app.sqlite3',directory)
        with closing(sqlite3.connect(Path(directory)/'app.sqlite3')) as conn:
            saved={table:conn.execute('SELECT COUNT(*) FROM '+table).fetchone()[0] for table in tables}
        assert before==saved, label+' business rows changed'
    report['business_data'].append({'database':label,'rows_unchanged':True,'integrity':'ok','counts':before})
    with opener.open(f'http://127.0.0.1:{port}/api/health',timeout=5) as response:
        health=json.load(response)
    assert health['app']=='yidaizhang-local'
    report['services'].append({'port':port,'healthy':True})
    for path in (root/'public').iterdir():
        if path.suffix not in ('.html','.css','.js'):continue
        with opener.open(f'http://127.0.0.1:{port}/'+path.name,timeout=5) as response:
            assert response.read()==path.read_bytes(),path.name
    report['assets'].append({'port':port,'current_source_served':True})
blocked={'data','demo-data','__pycache__','.git','node_modules'}
sources=[p for p in root.rglob('*') if p.is_file() and not any(part in blocked for part in p.relative_to(root).parts)]
archive=root.parent/'yidaizhang-local-v1.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as bundle:
    for path in sources:bundle.write(path,Path(root.name)/path.relative_to(root))
with zipfile.ZipFile(archive) as bundle:
    assert bundle.testzip() is None
    assert not any(any(part in blocked for part in Path(name).parts) for name in bundle.namelist())
report.update(source_files=len(sources),zip_size=archive.stat().st_size,sha256=hashlib.sha256(archive.read_bytes()).hexdigest(),version=json.loads((root/'package.json').read_text(encoding='utf-8'))['version'])
(work/'company-workspace-package-check.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
