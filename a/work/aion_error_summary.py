import pathlib,json,sqlite3,collections,sys,datetime
sys.stdout.reconfigure(encoding='utf-8',errors='replace')
for rootname in ['AionUi','AionUi-Dev']:
 root=pathlib.Path(r'C:\Users\Admin\AppData\Roaming')/rootname
 c=sqlite3.connect((root/'aionui'/'aionui-backend.db').as_uri()+'?mode=ro',uri=True)
 byid={r[0]:r[1] for r in c.execute('select conversation_id,agent_id from conversation_assistant_snapshots')}
 agent={r[0]:r[1] for r in c.execute('select agent_id,name from agent_metadata')}
 counts=collections.Counter()
 print(rootname)
 for p in sorted((root/'logs').rglob('*.aioncore.log')):
  for i,l in enumerate(p.read_text(encoding='utf-8',errors='replace').splitlines(),1):
   try:x=json.loads(l)
   except:continue
   f=x.get('fields',{})
   if f.get('message')=='feedback.runtime.turn_terminal':
    a=agent.get(byid.get(f.get('conversation_id')),f.get('conversation_id'));counts[(a,f.get('event_type'),f.get('error_code'))]+=1
 print(json.dumps([{'agent':k[0],'event':k[1],'code':k[2],'count':v}for k,v in counts.items()],ensure_ascii=False))
