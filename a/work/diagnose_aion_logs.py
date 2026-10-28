import pathlib, re, json, sqlite3, collections, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
roots=[pathlib.Path(r'C:\Users\Admin\AppData\Roaming\AionUi'),pathlib.Path(r'C:\Users\Admin\AppData\Roaming\AionUi-Dev')]
def safe(s):
    s=re.sub(r'(?i)(bearer\s+)[\w.\-]+', r'\1[REDACTED]',s)
    s=re.sub(r'(?i)((?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[=:]\s*["\']?)[^"\'\s,}]+',r'\1[REDACTED]',s)
    s=re.sub(r'\b(?:sk|pk)-[A-Za-z0-9_-]{10,}', '[REDACTED]',s)
    s=re.sub(r'(?i)(https?://)[^/@\s]+:[^/@\s]+@', r'\1[REDACTED]@',s)
    return s[:1800]
for root in roots:
    print('\nROOT',root.name)
    for p in sorted((root/'logs').rglob('*.aioncore.log'), reverse=True):
        lines=p.read_text(encoding='utf-8',errors='replace').splitlines()
        hits=[(i+1,safe(l)) for i,l in enumerate(lines) if re.search(r'(?i)(?:upstream|上游|\berror\b|\bfatal\b|\bfailed\b|\b401\b|\b403\b|\b429\b|\b502\b|\b503\b)',l)]
        print(p.name,'bytes',p.stat().st_size,'lines',len(lines),'hits',len(hits))
        for i,l in hits[-50:]:
            if re.search(r'(?i)(prompt|content|messages)\s*[=:]',l) and not re.search(r'(?i)upstream|上游|status.?code',l):
                print(i,'[omitted potentially conversational error line]')
            else: print(i,l)
    db=root/'aionui'/'aionui-backend.db'
    if db.exists():
        c=sqlite3.connect(db.as_uri()+'?mode=ro',uri=True)
        print('DATABASE TABLES')
        for name,sql in c.execute("select name,sql from sqlite_master where type='table'"):
            print(name,sql)
