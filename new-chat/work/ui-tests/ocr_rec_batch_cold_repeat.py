import json,time,sys,subprocess,psutil
from pathlib import Path
p=Path(r'D:\Codex\2026-10-26\new-chat\work\ui-tests')
if len(sys.argv)>1:
 from rapidocr_onnxruntime import RapidOCR
 sys.path.insert(0,r'D:\Codex\2026-10-26\new-chat\outputs\yidaizhang-local'); import reconciliation_ocr as o
 n=int(sys.argv[1]); cpu_before=psutil.cpu_percent(interval=0.4); mem_before=psutil.virtual_memory().available; t=time.perf_counter(); c=time.process_time(); e=RapidOCR(rec_batch_num=n); r=[]
 for name,kind in [('synthetic_bank.png','bank'),('synthetic_invoice_0.png','invoice'),('synthetic_invoice_180.png','invoice')]:
  x=o.run_one(p/name,kind,e); r.append({'fields':x['fields'],'rotation':x['rotation_ccw']})
 elapsed=time.perf_counter()-t; cpu_seconds=time.process_time()-c; print(json.dumps({'batch':n,'seconds':round(elapsed,2),'cpu_seconds':round(cpu_seconds,2),'cpu_before_percent':cpu_before,'available_memory_before_mb':round(mem_before/1024**2),'rss_mb':round(psutil.Process().memory_info().rss/1024**2),'results':r},ensure_ascii=True))
else:
 out=[]
 for n in [6,1,1,6]:
  cp=subprocess.run([sys.executable,str(__file__),str(n)],capture_output=True,text=True,check=True); x=json.loads(cp.stdout); out.append(x); print(n,x['seconds'],'CPU seconds',x['cpu_seconds'],'CPU before %',x['cpu_before_percent'],'available MB',x['available_memory_before_mb'],'RSS MB',x['rss_mb'],'equal',x['results']==out[0]['results'],flush=True)
 (p/'ocr_rec_batch_cold_repeat.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf8')

