import sqlite3,pathlib,json,sys,re,datetime
sys.stdout.reconfigure(encoding='utf-8',errors='replace')
for name in ['AionUi','AionUi-Dev']:
 p=pathlib.Path(r'C:\Users\Admin\AppData\Roaming')/name/'aionui'/'aionui-backend.db'; c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
 print(name)
 for r in c.execute("select id,conversation_id,type,content,status,created_at from messages where status='error' and type in ('tips','text') order by created_at"):
  d=dict(r);x=json.loads(d.pop('content'));d['content_keys']=list(x) if isinstance(x,dict) else type(x).__name__
  d['time_local']=datetime.datetime.fromtimestamp(d['created_at']/1000,datetime.timezone(datetime.timedelta(hours=8))).isoformat()
  if d['type']=='tips':d['error_content']=x
  print(json.dumps(d,ensure_ascii=False))
 print('EXTRA SAFE FIELDS')
 for r in c.execute('select id,type,extra from conversations'):
  d=dict(r);x=json.loads(d.pop('extra') or '{}');d['extra_keys']=list(x)
  d['config']={k:v for k,v in x.items() if k in ['backend','agent_id','model','model_id','modelId','auth_type','agentType','cliPath','cli_path','env','provider_id'] and k!='env'}
  print(json.dumps(d,ensure_ascii=False))
