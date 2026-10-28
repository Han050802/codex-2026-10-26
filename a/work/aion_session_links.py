import pathlib,sqlite3,json,sys
sys.stdout.reconfigure(encoding='utf-8',errors='replace')
p=pathlib.Path(r'C:\Users\Admin\AppData\Roaming\AionUi\aionui\aionui-backend.db');c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
for r in c.execute("select conversation_id,agent_id,session_id,session_config from acp_session where agent_id in ('8e1acf31','a0dfb1ec')"):
 d=dict(r);x=json.loads(d.pop('session_config')); d['config_keys']=list(x)
 d['model_related']={k:v for k,v in x.items() if 'model' in k or 'thread' in k or 'effort' in k or 'session' in k}
 print(json.dumps(d,ensure_ascii=False))
