import pathlib,json,urllib.request,urllib.error,sys,time,datetime
sys.stdout.reconfigure(encoding='utf-8',errors='replace')
ROOT=pathlib.Path(__file__).resolve().parent
STATE=json.loads((ROOT/'state.json').read_text(encoding='utf-8-sig'))
def request(method,path,payload=None,timeout=60):
 data=json.dumps(payload).encode() if payload is not None else None
 req=urllib.request.Request(STATE['base_url']+path,data=data,headers={'Content-Type':'application/json'},method=method)
 try:
  with urllib.request.urlopen(req,timeout=timeout) as resp:return resp.status,json.load(resp)
 except urllib.error.HTTPError as e:
  try:body=json.load(e)
  except:body={'error':'non-JSON response','status':e.code}
  return e.code,body
def main():
 backend=sys.argv[1]; label=sys.argv[2] if len(sys.argv)>2 else backend
 agent={'codex':'8e1acf31','cursor':'a0dfb1ec'}[backend]
 workdir=ROOT/'workspace'/label;workdir.mkdir(parents=True,exist_ok=True)
 body={'type':'acp','name':'AionUi isolated diagnostic '+label,'extra':{'workspace':str(workdir),'backend':backend,'agent_id':agent,'agent_source':'builtin','skills':[],'mcp_server_ids':[],'mcp_servers':[],'current_mode_id':'default'}}
 report={'backend':backend,'label':label,'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'create_request':body,'steps':[]}
 def save(): (ROOT/(label+'-result.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
 status,res=request('POST','/api/conversations',body);report['steps'].append({'step':'create','status':status,'response':res});save()
 if not res.get('success'):print(json.dumps(report,ensure_ascii=False));return
 conv=res['data']['id'];report['conversation_id']=conv
 status,res=request('POST','/api/conversations/'+conv+'/runtime/ensure',{});report['steps'].append({'step':'ensure','status':status,'response':res});save()
 if not res.get('success'): print(json.dumps(report,ensure_ascii=False));return
 status,res=request('POST','/api/conversations/'+conv+'/messages',{'content':'This is a connectivity diagnostic. Reply with exactly AIONUI_DIAGNOSTIC_OK and nothing else. Do not use tools. Do not read, create, or modify any files.'})
 report['steps'].append({'step':'send','status':status,'response':res});save()
 print(json.dumps({'label':label,'conversation_id':conv,'send_status':status,'response':res},ensure_ascii=False),flush=True)
 if not res.get('success'):return
 deadline=time.monotonic()+150
 while time.monotonic()<deadline:
  status,con=request('GET','/api/conversations/'+conv)
  status,msg=request('GET','/api/conversations/'+conv+'/messages?limit=50')
  report['conversation']=con;report['messages']=msg;save()
  if con.get('data',{}).get('status') in ['finished','error']:
   data=msg.get('data',[]);items=data.get('items',[]) if isinstance(data,dict) else data
   report['diagnostic_ok']=any('AIONUI_DIAGNOSTIC_OK' in json.dumps(m) and m.get('position')=='left' for m in items)
   report['finished_at']=datetime.datetime.now(datetime.timezone.utc).isoformat();save()
   print(json.dumps({'label':label,'status':con.get('data',{}).get('status'),'diagnostic_ok':report['diagnostic_ok'],'messages':msg},ensure_ascii=False),flush=True);return
  time.sleep(2)
 report['timed_out']=True;save();print(json.dumps({'label':label,'timed_out':True}),flush=True)
if __name__=='__main__':main()
