import cv2,json,time,sys
from pathlib import Path
from rapidocr_onnxruntime import RapidOCR
sys.path.insert(0,r'D:\Codex\2026-10-26\new-chat\outputs\yidaizhang-local'); import reconciliation_ocr as o
p=Path(r'D:\Codex\2026-10-26\new-chat\work\ui-tests'); out=[]; engine=RapidOCR()
for n in [8,1,2,4]:
 cv2.setNumThreads(n)
 for name,kind in [('synthetic_bank.png','bank'),('synthetic_invoice_0.png','invoice')]:
  t=time.perf_counter(); x=o.run_one(p/name,kind,engine)
  out.append({'threads':n,'file':name,'seconds':round(time.perf_counter()-t,2),'fields':x['fields'],'rotation':x['rotation_ccw']})
  print(n,name,out[-1]['seconds'],flush=True)
(p/'ocr_cv_threads_compare.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf8')
