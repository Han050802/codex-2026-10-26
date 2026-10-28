"""Run real HTTP + app.js DOM linkage checks in an unseeded temporary DB."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1] / 'outputs' / 'yidaizhang-local'
sys.path.insert(0, str(ROOT))
import server

node = shutil.which('node')
if not node:
    raise RuntimeError('node must be available on PATH')
with tempfile.TemporaryDirectory(prefix='progress-linkage-qa-') as directory:
    temporary = Path(directory).resolve()
    assert temporary not in ((ROOT / 'data').resolve(), (ROOT / 'demo-data').resolve())
    app = server.Application(temporary, demo=True)
    http = server.make_server('127.0.0.1', 0, app)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    try:
        subprocess.run([node, str(HERE / 'progress-linkage-check.mjs'),
                        f'http://127.0.0.1:{http.server_address[1]}'],
                       cwd=HERE, check=True, timeout=90)
    finally:
        http.shutdown()
        http.server_close()
        thread.join(timeout=3)
