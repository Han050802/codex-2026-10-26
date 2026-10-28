import json,time,sys
from pathlib import Path
sys.path.insert(0,r'D:\Codex\2026-10-26\new-chat\outputs\yidaizhang-local'); import reconciliation_ocr as o
p=Path(r'D:\Codex\2026-10-26\new-chat\work\ui-tests'); tasks=[('synthetic_bank.png','bank'),('synthetic_invoice_0.png','invoice'),('synthetic_invoice_180.png','invoice')]
t=time.perf_counter(); e=o.create_engine(); results=[]
for name,kind in tasks:
 start=time.perf_counter(); r=o.run_one(p/name,kind,e); results.append({'fields':r['fields'],'rotation':r['rotation_ccw']}); print(name,round(time.perf_counter()-start,2),flush=True)
base=json.load(open(p/'ocr_parallel_serial.json',encoding='utf8')); print('total',round(time.perf_counter()-t,2),'baseline',base['seconds'],'fields_equal',results==base['results'],flush=True)
