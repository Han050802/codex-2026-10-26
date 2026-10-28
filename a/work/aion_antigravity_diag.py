import pathlib,json,sqlite3,sys,re,datetime
sys.stdout.reconfigure(encoding='utf-8',errors='replace')
p=pathlib.Path(r'C:\Users\Admin\AppData\Roaming\AionUi\logs\2026\10\21\2026-10-21.aioncore.log')
allow={'message','conversation_id','backend','elapsed_ms','error','error_code','status','turn_id','model','current_model_id','pid','stderr','event_type','exit_code','text_len','saw_tool_or_side_effect','decision','args_len','command_len'}
for i,l in enumerate(p.read_text(encoding='utf-8').splitlines(),1):
 try:x=json.loads(l)
 except:continue
 if (970<=i<=1010 or 1340<=i<=1385 or 2315<=i<=2335):
  f=x.get('fields',{}); d={k:v for k,v in f.items() if k in allow}
  if 'stderr' in d and not re.search('(?i)error|failed', d['stderr']):d['stderr']='[omitted]'
  print(i,x.get('timestamp'),json.dumps(d,ensure_ascii=False))
c=sqlite3.connect(pathlib.Path(r'C:\Users\Admin\AppData\Roaming\AionUi\aionui\aionui-backend.db').as_uri()+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
print('Tool content key structure for failed conversation')
for r in c.execute("select id,type,status,created_at,content from messages where conversation_id='7a7f8ac0' and type in ('tool_call','acp_tool_call') order by created_at"):
 d=dict(r);x=json.loads(d.pop('content'));d['keys']=list(x) if isinstance(x,dict) else type(x).__name__
 if isinstance(x,dict):
  d['safe']={k:v for k,v in x.items() if k in ['name','tool_name','status','error','toolCallId','tool_call_id','id']}
  d['nested_keys']={k:list(v) for k,v in x.items() if isinstance(v,dict)}
 print(json.dumps(d,ensure_ascii=False))
