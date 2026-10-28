import pathlib,json,time,sys,sqlite3,datetime
from run_test import ROOT,request
sys.stdout.reconfigure(encoding='utf-8',errors='replace')
p=ROOT/'codex-subagent-baseline-result.json';report=json.loads(p.read_text(encoding='utf-8'));conv=report['conversation_id']
db=sqlite3.connect((ROOT/'data'/'aionui-backend.db').as_uri()+'?mode=ro',uri=True)
sid=db.execute('select session_id from acp_session where conversation_id=?',(conv,)).fetchone()[0];report['codex_session_id']=sid
for roll in pathlib.Path(r'C:\Users\Admin\.codex\sessions').rglob('*'+sid+'.jsonl'):
 for line in roll.read_text(encoding='utf-8').splitlines():
  event=json.loads(line);payload=event.get('payload',{})
  if event.get('type')=='event_msg' and payload.get('type')=='task_complete':report['raw_parent_complete']={'timestamp':event.get('timestamp'),'payload':payload}
_,report['messages']=request('GET','/api/conversations/'+conv+'/messages?limit=100')
report['parent_marker_missing']=not any(x.get('type')=='text' and x.get('position')=='left' and 'PARENT_DIAGNOSTIC_OK' in x.get('content',{}).get('content','') for x in report['messages']['data']['items'])
status,res=request('POST','/api/conversations/'+conv+'/messages',{'content':'Reply with exactly FOLLOWUP_DIAGNOSTIC_OK and nothing else. Do not use tools or modify files.'});report['steps'].append({'step':'followup_send','status':status,'response':res})
p.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'send_status':status,'parent_marker_missing':report['parent_marker_missing'],'response':res}),flush=True)
deadline=time.monotonic()+80
while time.monotonic()<deadline:
 _,m=request('GET','/api/conversations/'+conv+'/messages?limit=100');items=m.get('data',{}).get('items',[])
 if any(x.get('type')=='text' and x.get('position')=='left' and x.get('content',{}).get('content','').strip()=='FOLLOWUP_DIAGNOSTIC_OK' for x in items):report['followup_ok']=True;report['final_messages']=m;break
 time.sleep(.5)
else:report['followup_ok']=False
report['finished_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();p.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'followup_ok':report['followup_ok'],'premature_finished':report.get('premature_finished'),'parent_marker_missing':report['parent_marker_missing']}),flush=True)
