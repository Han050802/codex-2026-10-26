import json,time,sys
from pathlib import Path
from rapidocr_onnxruntime import RapidOCR
sys.path.insert(0,r'D:\Codex\2026-10-26\new-chat\outputs\yidaizhang-local'); import reconciliation_ocr as o
p=Path(r'D:\Codex\2026-10-26\new-chat\work\ui-tests'); e=RapidOCR(); out=[]
o.run_one(p/'synthetic_invoice_0.png','invoice',e)
for a in [0,90,180,270]:
 for n in ([6,1] if a in [0,180] else [1,6]):
  e.text_rec.rec_batch_num=n
  t=time.perf_counter(); r=o.run_one(p/f'synthetic_invoice_{a}.png','invoice',e); secs=round(time.perf_counter()-t,2)
  out.append({'batch':n,'angle':a,'seconds':secs,'fields':r['fields'],'rotation':r['rotation_ccw'],'passes':r['orientation_candidates_tried']}); print(a,n,secs,flush=True)
(p/'ocr_rec_batch_invoice_compare.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf8')
