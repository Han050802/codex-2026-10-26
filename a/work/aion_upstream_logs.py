import pathlib,sys,json,re,collections
sys.stdout.reconfigure(encoding='utf-8',errors='replace')
p=pathlib.Path(r'C:\Users\Admin\.codex\sessions\2026\10\23\rollout-2026-10-23T17-19-22-01a1680e-c49e-7fe0-9991-baa3521959ca.jsonl')
counts=collections.Counter(); errors=[]
for i,l in enumerate(p.read_text(encoding='utf-8',errors='replace').splitlines(),1):
 try:x=json.loads(l)
 except:continue
 y=x.get('payload',{}); t=y.get('type');counts[(x.get('type'),t)]+=1
 if 'error' in str(t).lower() or x.get('type')=='error':
  errors.append({'line':i,'timestamp':x.get('timestamp'),'type':x.get('type'),'payload':y})
print('Codex event counts',repr(counts));print('structured errors',json.dumps(errors,ensure_ascii=False))
p=pathlib.Path(r'C:\Users\Admin\AppData\Local\cursor-agent\worker-startup.log')
for i,l in enumerate(p.read_text(encoding='utf-8',errors='replace').splitlines(),1):
 if re.search(r'(?i)error|failed|exception|spawn|ready|started|version',l):
  l=re.sub(r'(?i)(token|apikey|api_key|password|secret)(\s*[=:]\s*)[^\s,}]+',r'\1\2[REDACTED]',l)
  print('cursor-startup',i,l[:500])
