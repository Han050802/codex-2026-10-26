import pathlib,json,time,sys,datetime,sqlite3
from run_test import ROOT,request
sys.stdout.reconfigure(encoding='utf-8',errors='replace')
label=sys.argv[1] if len(sys.argv)>1 else 'codex-subagent-baseline'
workdir=ROOT/'workspace'/label;workdir.mkdir(parents=True,exist_ok=True)
report={'label':label,'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'steps':[],'timeline':[]}
def save():(ROOT/(label+'-result.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
body={'type':'acp','name':'AionUi subagent diagnostic '+label,'extra':{'workspace':str(workdir),'backend':'codex','agent_id':'8e1acf31','agent_source':'builtin','skills':[],'mcp_server_ids':[],'mcp_servers':[],'current_mode_id':'default'}}
status,res=request('POST','/api/conversations',body);report['steps'].append({'step':'create','status':status,'response':res});save()
if not res.get('success'):print(json.dumps(report));sys.exit(1)
conv=res['data']['id'];report['conversation_id']=conv
status,res=request('POST','/api/conversations/'+conv+'/runtime/ensure',{});report['steps'].append({'step':'ensure','status':status,'response':res});save()
if not res.get('success'):print(json.dumps(report));sys.exit(1)
prompt='This is an isolated agent lifecycle diagnostic. Use the available collaboration tool to spawn exactly one child subagent. Instruct that child: Reply with exactly CHILD_DIAGNOSTIC_OK, do not spawn agents, use tools, access the network, or read or modify any files. You, the parent, must wait for that child to finish using only collaboration tools if needed. After receiving its result, reply with exactly PARENT_DIAGNOSTIC_OK as your final answer. Do not use shell, browser, file, or network tools. The child final is not your final; you must emit the parent final marker yourself.'
status,res=request('POST','/api/conversations/'+conv+'/messages',{'content':prompt});report['steps'].append({'step':'send','status':status,'response':res});save();print(json.dumps({'label':label,'conversation_id':conv,'send':res}),flush=True)
if not res.get('success'):sys.exit(1)
db=sqlite3.connect((ROOT/'data'/'aionui-backend.db').as_uri()+'?mode=ro',uri=True)
start=time.monotonic();deadline=start+120;last=None;parent_seen=False;first_finish=None;raw_complete=None;raw_completed_at=None
while time.monotonic()<deadline:
 status,c=request('GET','/api/conversations/'+conv)
 status,m=request('GET','/api/conversations/'+conv+'/messages?limit=100')
 items=m.get('data',{}).get('items',[])
 texts=[x.get('content',{}).get('content','') for x in items if x.get('type')=='text' and x.get('position')=='left']
 parent_seen=any('PARENT_DIAGNOSTIC_OK' in t for t in texts)
 snap={'status':c.get('data',{}).get('status'),'parent_marker':parent_seen,'left_text_count':len(texts),'types':[(x.get('type'),x.get('status')) for x in items if x.get('position')=='left']}
 if snap!=last:
  entry={'seconds':round(time.monotonic()-start,3),'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),**snap};report['timeline'].append(entry);save();print(json.dumps(entry),flush=True);last=snap
 if snap['status']=='finished' and first_finish is None:
  first_finish=round(time.monotonic()-start,3);report['first_finished_seconds']=first_finish;report['premature_finished']=not parent_seen;save()
 if parent_seen and snap['status']=='finished':report['messages']=m;report['conversation']=c;break
 if first_finish is not None:
  row=db.execute('select session_id from acp_session where conversation_id=?',(conv,)).fetchone()
  if row:
   report['codex_session_id']=row[0]
   for roll in pathlib.Path(r'C:\Users\Admin\.codex\sessions').rglob('*'+row[0]+'.jsonl'):
    for line in roll.read_text(encoding='utf-8').splitlines():
     event=json.loads(line);payload=event.get('payload',{})
     if event.get('type')=='event_msg' and payload.get('type')=='task_complete' and payload.get('last_agent_message')=='PARENT_DIAGNOSTIC_OK':
      raw_complete={'timestamp':event.get('timestamp'),'payload':payload};report['raw_parent_complete']=raw_complete
      if raw_completed_at is None:raw_completed_at=time.monotonic()
   if raw_completed_at is not None and time.monotonic()-raw_completed_at>3:
    report['messages']=m;report['conversation']=c;report['parent_marker_missing']=not parent_seen;break
 time.sleep(.2)
else:report['timed_out']=True
if parent_seen or raw_complete:
 status,res=request('POST','/api/conversations/'+conv+'/messages',{'content':'Reply with exactly FOLLOWUP_DIAGNOSTIC_OK and nothing else. Do not use tools or modify files.'});report['steps'].append({'step':'followup_send','status':status,'response':res});save()
 deadline=time.monotonic()+90
 while time.monotonic()<deadline:
  _,c=request('GET','/api/conversations/'+conv);_,m=request('GET','/api/conversations/'+conv+'/messages?limit=100')
  items=m.get('data',{}).get('items',[])
  if any(x.get('type')=='text' and x.get('position')=='left' and x.get('content',{}).get('content','').strip()=='FOLLOWUP_DIAGNOSTIC_OK' for x in items):
   report['followup_ok']=True;report['final_messages']=m;break
  time.sleep(.5)
 else:report['followup_ok']=False
db=sqlite3.connect((ROOT/'data'/'aionui-backend.db').as_uri()+'?mode=ro',uri=True)
row=db.execute('select session_id from acp_session where conversation_id=?',(conv,)).fetchone()
report['codex_session_id']=row[0] if row else None
if row:
 for roll in pathlib.Path(r'C:\Users\Admin\.codex\sessions').rglob('*'+row[0]+'.jsonl'):
  for line in roll.read_text(encoding='utf-8').splitlines():
   event=json.loads(line);payload=event.get('payload',{})
   if event.get('type')=='event_msg' and payload.get('type')=='task_complete' and payload.get('last_agent_message')=='PARENT_DIAGNOSTIC_OK':
    report['raw_parent_complete']={'timestamp':event.get('timestamp'),'payload':payload}
items=report.get('messages',{}).get('data',{}).get('items',[])
report['parent_marker_missing']=not any(x.get('type')=='text' and x.get('position')=='left' and 'PARENT_DIAGNOSTIC_OK' in x.get('content',{}).get('content','') for x in items)
report['child_marker_leaked']=any(x.get('type')=='text' and x.get('position')=='left' and 'CHILD_DIAGNOSTIC_OK' in x.get('content',{}).get('content','') for x in items)
report['finished_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();save()
print(json.dumps({k:v for k,v in report.items() if k not in ['steps','messages','conversation','final_messages','timeline']},ensure_ascii=False),flush=True)
