"""Apply/revert the narrowly scoped AionUi Codex command override offline."""
import argparse, datetime, json, pathlib, sqlite3, subprocess, time

DB = pathlib.Path(r'C:\Users\Admin\AppData\Roaming\AionUi\aionui\aionui-backend.db')
INSTALL = pathlib.Path(r'D:\AIONUI\compat\codex-bridge')
BACKUPS = pathlib.Path(r'D:\AIONUI\repair-backups')
AGENT = '8e1acf31'

def ensure_stopped():
    ps = r"@(Get-CimInstance Win32_Process | Where-Object {($_.Name -eq 'AionUi.exe' -and $_.ExecutablePath -eq 'D:\AIONUI\AionUi.exe') -or ($_.Name -eq 'aioncore.exe' -and $_.CommandLine -and $_.CommandLine.Contains('C:\Users\Admin\AppData\Roaming\AionUi\aionui'))}) | Select-Object ProcessId | ConvertTo-Json -Compress"
    result = subprocess.run(['powershell.exe','-NoProfile','-Command',ps], capture_output=True, text=True, check=True)
    if result.stdout.strip() not in ('', 'null', '[]'):
        raise SystemExit('AionUi or its production backend is still running; close the application before applying or reverting.')

def read_state(c):
    row = c.execute('SELECT agent_id, command_override, updated_at FROM agent_metadata WHERE agent_id=? AND backend=?', (AGENT,'codex')).fetchone()
    if row is None: raise SystemExit('Expected built-in Codex agent was not found.')
    return dict(zip(('agent_id','command_override','updated_at'), row))

def apply():
    ensure_stopped()
    exe = INSTALL/'aionui-codex-bridge.exe'
    if not exe.is_file(): raise SystemExit('Tested bridge executable is missing.')
    with sqlite3.connect(DB) as c:
        state = read_state(c)
        if state['command_override'] is not None:
            raise SystemExit('Unexpected existing override; refusing to overwrite it.')
        timestamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        dest = BACKUPS/timestamp
        dest.mkdir(parents=True, exist_ok=False)
        with sqlite3.connect(dest/'aionui-backend.db') as backup:
            c.backup(backup)
            assert backup.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        manifest = {'database':str(DB), 'backup_database':str(dest/'aionui-backend.db'), 'before':state, 'after_command_override':str(exe), 'applied_at_utc':timestamp}
        (dest/'codex-override.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
        with c:
            cur=c.execute('UPDATE agent_metadata SET command_override=?,updated_at=? WHERE agent_id=? AND command_override IS NULL', (str(exe), int(time.time()*1000), AGENT))
            if cur.rowcount!=1: raise RuntimeError('Concurrent metadata change; no override applied.')
        assert c.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        print(json.dumps({'manifest':str(dest/'codex-override.json'),'after':read_state(c)},ensure_ascii=False))

def rollback(manifest_path):
    ensure_stopped()
    manifest=json.loads(pathlib.Path(manifest_path).read_text(encoding='utf-8'))
    if manifest['database']!=str(DB) or manifest['before']['agent_id']!=AGENT: raise SystemExit('Wrong manifest.')
    with sqlite3.connect(DB) as c:
        if read_state(c)['command_override']!=manifest['after_command_override']:
            raise SystemExit('Override has changed since repair; refusing to overwrite a later change.')
        c.execute('UPDATE agent_metadata SET command_override=?,updated_at=? WHERE agent_id=?', (manifest['before']['command_override'],int(time.time()*1000),AGENT))
        c.commit()
        print(json.dumps({'rolled_back':read_state(c)},ensure_ascii=False))

parser=argparse.ArgumentParser()
parser.add_argument('mode',choices=['inspect','apply','rollback'])
parser.add_argument('--manifest')
args=parser.parse_args()
if args.mode=='apply': apply()
elif args.mode=='rollback': rollback(args.manifest)
else:
    with sqlite3.connect('file:'+DB.as_posix()+'?mode=ro',uri=True) as c:
        print(json.dumps({'override':read_state(c),'conversations':[{'id':r[0],'type':r[1],'status':r[2]} for r in c.execute('SELECT id,type,status FROM conversations')]},ensure_ascii=False))
