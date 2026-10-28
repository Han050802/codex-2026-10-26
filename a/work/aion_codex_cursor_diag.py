import pathlib,json,sqlite3,sys,re,collections
sys.stdout.reconfigure(encoding='utf-8',errors='replace')
for root in ['AionUi','AionUi-Dev']:
 print('ROOT',root)
 for p in sorted((pathlib.Path(r'C:\Users\Admin\AppData\Roaming')/root/'logs').rglob('*.aioncore.log')):
  rows=[]
  for i,l in enumerate(p.read_text(encoding='utf-8',errors='replace').splitlines(),1):
   try:x=json.loads(l)
   except:continue
   f=x.get('fields',{});s=json.dumps(x)
   relevant=any(k in s for k in ['codex','cursor','c8157dbb','6811341a','527b6276','871ac1a2','32f3a3a6','c5728ee8','51c5b524'])
   if relevant and (x.get('level') in ['WARN','ERROR'] or f.get('message') in ['feedback.runtime.turn_terminal','direct CLI version detected','direct CLI version drift','CLI process started','Agent initialization complete','ACP initialized','Idle kill: ACP process shutdown completed']):
    allow={'message','conversation_id','backend','error','error_code','exit_code','code','version','detected_version','verified_version','stderr','event_type','pid','elapsed_ms','result','retryable','agent_type','installed_version','expected_version'}
    d={k:v for k,v in f.items() if k in allow}
    d['span']=x.get('span')
    print(p.name,i,x.get('timestamp'),json.dumps(d,ensure_ascii=False))
