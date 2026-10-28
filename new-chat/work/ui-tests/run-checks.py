"""Run DOM workflows against one disposable local demo HTTP service."""
from contextlib import closing
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]/'outputs'/'yidaizhang-local'
NODE=Path('C:/Users/Admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe')
sys.path.insert(0,str(ROOT))
import server

with tempfile.TemporaryDirectory(prefix='client-panel-qa-',dir=HERE) as directory:
    assert Path(directory).resolve().is_relative_to(HERE.resolve())
    app=server.Application(directory,demo=True)
    # Explicit fixture only in this asserted disposable QA directory. Runtime
    # application startup deliberately creates no synthetic customer companies.
    import db
    import seed
    with closing(db.connect(app.db_path)) as conn,conn:
        seed.seed(conn,dict(conn.execute('SELECT id,username,name FROM users ORDER BY id LIMIT 1').fetchone()))
    http=server.make_server('127.0.0.1',0,app)
    thread=threading.Thread(target=http.serve_forever,daemon=True)
    thread.start()
    base=f'http://127.0.0.1:{http.server_address[1]}'
    try:
        scripts=sys.argv[1:] or ['dom-check.mjs','client-editor-check.mjs']
        for script in scripts:
            command=[str(NODE),str(HERE/script),base]
            if script=='dom-check.mjs':command.append('--workflows')
            subprocess.run(command,cwd=HERE,check=True,timeout=90)
    finally:
        http.shutdown();http.server_close();thread.join(timeout=3)
