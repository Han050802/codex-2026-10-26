import json,sys,time
from pathlib import Path
from rapidocr_onnxruntime import RapidOCR
sys.path.insert(0,r'D:\Codex\2026-10-26\new-chat\outputs\yidaizhang-local')
import reconciliation_ocr as ocr
p=Path(r'D:\Codex\2026-10-26\new-chat\work\ui-tests')
results=[]
for n in [6,12,16]:
 engine=RapidOCR(rec_batch_num=n)
 for name,kind in [('synthetic_bank.png','bank'),('synthetic_invoice_0.png','invoice'),('synthetic_invoice_180.png','invoice')]:
  t=time.perf_counter(); out=ocr.run_one(p/name,kind,engine); elapsed=time.perf_counter()-t
  results.append({'batch':n,'file':name,'seconds':round(elapsed,2),'fields':out['fields'],'rotation':out['rotation_ccw'],'passes':out['orientation_candidates_tried']})
  print(n,name,round(elapsed,2),flush=True)
(p/'ocr_batch_param_results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf8')
