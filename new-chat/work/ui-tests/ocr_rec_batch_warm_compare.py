import json,time,sys
from pathlib import Path
from rapidocr_onnxruntime import RapidOCR
sys.path.insert(0,r'D:\Codex\2026-10-26\new-chat\outputs\yidaizhang-local'); import reconciliation_ocr as o
p=Path(r'D:\Codex\2026-10-26\new-chat\work\ui-tests'); e=RapidOCR(); out=[]
# Warm both detector and recognizer with the same workload before comparisons.
o.run_one(p/'synthetic_bank.png','bank',e)
for n in [6,1,2,3,6,3,2,1,6]:
 e.text_rec.rec_batch_num=n
 t=time.perf_counter(); r=o.run_one(p/'synthetic_bank.png','bank',e); secs=round(time.perf_counter()-t,2)
 out.append({'batch':n,'seconds':secs,'fields':r['fields'],'rotation':r['rotation_ccw']}); print(n,secs,flush=True)
(p/'ocr_rec_batch_warm_compare.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf8')
