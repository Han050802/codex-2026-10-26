import pathlib,json,sys,time,datetime,sqlite3
from run_test import ROOT,request
sys.stdout.reconfigure(encoding='utf-8',errors='replace')
label=sys.argv[1] if len(sys.argv)>1 else 'codex-subagent-bridge'
prior=json.loads((ROOT/(label+'-result.json')).read_text(encoding='utf-8'));conv=prior['conversation_id']
db=sqlite3.connect((ROOT/'data'/'aionui-backend.db').as_uri()+'?mode=ro',uri=True)
def sid():
 row=db.execute('select session_id from acp_session where conversation_id=?',(conv,)).fetchone();return row[0] if row else None
report={'conversation_id':conv,'before_session_id':sid(),'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'steps':[],'timeline':[]}
out=ROOT/(label+'-resume-result.json')
def save():out.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
for step in ['restart','ensure']:
 status,res=request('POST','/api/conversations/'+conv+'/runtime/'+step,{})
 report['steps'].append({'step':step,'status':status,'response':res});save()
 if not res.get('success'):print(json.dumps(report));sys.exit(1)
report['after_session_id']=sid();report['same_session']=report['before_session_id']==report['after_session_id']
send_epoch_ms=int(time.time()*1000)
status,res=request('POST','/api/conversations/'+conv+'/messages',{'content':'Reply with exactly RESUME_DIAGNOSTIC_OK and nothing else. Do not use tools or modify files.'})
report['expected_turn_id']=res.get('data',{}).get('turn_id');report['send_epoch_ms']=send_epoch_ms
report['steps'].append({'step':'send','status':status,'response':res});save();print(json.dumps({'label':label,'same_session':report['same_session'],'send_status':status,'response':res}),flush=True)
deadline=time.monotonic()+90;start=time.monotonic();last=None
while time.monotonic()<deadline:
 _,c=request('GET','/api/conversations/'+conv);_,m=request('GET','/api/conversations/'+conv+'/messages?limit=100')
 fresh=[x for x in m.get('data',{}).get('items',[]) if x.get('created_at',0)>=send_epoch_ms and x.get('position')=='left']
 ok=any(x.get('type')=='text' and x.get('content',{}).get('content','').strip()=='RESUME_DIAGNOSTIC_OK' for x in fresh)
 snap={'status':c.get('data',{}).get('status'),'resume_marker':ok}
 if snap!=last:report['timeline'].append({'seconds':round(time.monotonic()-start,3),**snap});last=snap;save()
 if ok or any(x.get('status')=='error' for x in fresh):report['resume_ok']=ok;report['messages']=m;break
 time.sleep(.2)
else:report['timed_out']=True;report['resume_ok']=False
report['premature_finished']=False
report['terminal_events']=[]
for log in (ROOT/'logs').rglob('*.aioncore.log'):
 for line in log.read_text(encoding='utf-8',errors='replace').splitlines():
  try:event=json.loads(line)
  except:continue
  fields=event.get('fields',{})
  if fields.get('message')=='feedback.runtime.turn_terminal' and fields.get('turn_id')==report.get('expected_turn_id'):
   report['terminal_events'].append(event)
   if fields.get('event_type')=='Finish' and not report.get('resume_ok'):report['premature_finished']=True
report['finished_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();save()
print(json.dumps({k:v for k,v in report.items() if k not in ['steps','messages','timeline']}),flush=True)
