import sys,time,json,concurrent.futures,psutil
from pathlib import Path
from rapidocr_onnxruntime import RapidOCR
sys.path.insert(0,r'D:\Codex\2026-10-26\new-chat\outputs\yidaizhang-local'); import reconciliation_ocr as o
p=Path(r'D:\Codex\2026-10-26\new-chat\work\ui-tests'); tasks=[('synthetic_bank.png','bank'),('synthetic_invoice_0.png','invoice'),('synthetic_invoice_180.png','invoice')]
for mode in ['serial','parallel']:
 t=time.perf_counter(); cfg={} if mode=='serial' else {'intra_op_num_threads':2,'inter_op_num_threads':1}
 engines=[RapidOCR(**cfg) for i in range(1 if mode=='serial' else 2)]
 def run(task,engine): return o.run_one(p/task[0],task[1],engine)
 if mode=='serial': outs=[run(task,engines[0]) for task in tasks]
 else:
  def batch(items,e): return [run(task,e) for task in items]
  with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
   a=pool.submit(batch,[tasks[0]],engines[0]); b=pool.submit(batch,tasks[1:],engines[1]); outs=a.result()+b.result()
 res={'mode':mode,'seconds':round(time.perf_counter()-t,2),'memory_mb':round(psutil.Process().memory_info().rss/1024/1024),'results':[{'fields':x['fields'],'rotation':x['rotation_ccw']} for x in outs]}
 print(json.dumps(res,ensure_ascii=True),flush=True)
 (p/('ocr_parallel_'+mode+'.json')).write_text(json.dumps(res,ensure_ascii=False),encoding='utf8')
