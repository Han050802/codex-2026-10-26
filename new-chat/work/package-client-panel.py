from pathlib import Path
import hashlib
import json
import py_compile
import subprocess
import urllib.request
import zipfile

WORK=Path(__file__).resolve().parent
ROOT=WORK.parent/'outputs'/'yidaizhang-local'
NODE=Path('C:/Users/Admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe')
for source in [*ROOT.glob('*.py'),*ROOT.joinpath('tests').glob('*.py')]:
    py_compile.compile(str(source),doraise=True)
for module in sorted((ROOT/'public').glob('*.js')):
    subprocess.run([str(NODE),'--check',str(module)],check=True)
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
checks=[]
for base in ('http://127.0.0.1:8765','http://127.0.0.1:8766','http://192.168.5.41:8765'):
    with opener.open(base+'/api/health',timeout=5) as response:
        health=json.load(response)
    assert health['app']=='yidaizhang-local'
    checks.append({'url':base,'healthy':True})
for name in ['index.html',*[p.name for p in sorted((ROOT/'public').glob('*.js'))],*[p.name for p in sorted((ROOT/'public').glob('*.css'))]]:
    with opener.open('http://127.0.0.1:8765/'+name,timeout=5) as response:
        assert response.read()==(ROOT/'public'/name).read_bytes()
archive=ROOT.parent/'yidaizhang-local-v1.zip'
blocked={'data','demo-data','__pycache__','.git','node_modules'}
sources=[p for p in ROOT.rglob('*') if p.is_file() and not any(part in blocked for part in p.relative_to(ROOT).parts)]
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as bundle:
    for path in sources:
        bundle.write(path,Path(ROOT.name)/path.relative_to(ROOT))
with zipfile.ZipFile(archive) as bundle:
    assert bundle.testzip() is None
    assert not any(any(part in blocked for part in Path(name).parts) for name in bundle.namelist())
result={'python_compile':True,'javascript_syntax':True,'services':checks,'current_assets_served':True,'source_files':len(sources),'zip_size':archive.stat().st_size,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest()}
(WORK/'client-panel-package-check.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False))
