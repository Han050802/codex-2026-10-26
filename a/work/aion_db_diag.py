import sqlite3, pathlib, json,sys,re
sys.stdout.reconfigure(encoding='utf-8',errors='replace')
for name in ['AionUi','AionUi-Dev']:
 p=pathlib.Path(r'C:\Users\Admin\AppData\Roaming')/name/'aionui'/'aionui-backend.db'
 c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True); c.row_factory=sqlite3.Row
 print('\nDB',name)
 queries=[
 ('conversations', 'select id,type,model,status,created_at,updated_at from conversations order by updated_at desc limit 30'),
 ('snapshots','select conversation_id,agent_id,resolved_model_id,default_model_mode from conversation_assistant_snapshots'),
 ('acp_session','select conversation_id,agent_id,session_status,last_active_at,suspended_at from acp_session'),
 ('agents','select agent_id,name,backend,enabled,command,command_override,last_check_status,last_check_kind,last_check_error_code,last_check_error_message,last_check_at from agent_metadata'),
 ('providers','select id,platform,name,base_url,enabled,models,model_health from providers'),
 ('message types','select type,status,count(*) as count from messages group by type,status')]
 for label,q in queries:
  print(label)
  for r in c.execute(q): print(json.dumps(dict(r),ensure_ascii=False))
