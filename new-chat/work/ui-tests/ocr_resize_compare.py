import json,time,sys
from pathlib import Path
from PIL import Image,ImageFilter
from rapidocr_onnxruntime import RapidOCR
sys.path.insert(0,r'D:\Codex\2026-10-26\new-chat\outputs\yidaizhang-local'); import reconciliation_ocr as o
p=Path(r'D:\Codex\2026-10-26\new-chat\work\ui-tests'); e=RapidOCR(); out=[]
for name,kind,blur in [('synthetic_bank.png','bank',0),('synthetic_bank.png','bank',1.2)]+[(f'synthetic_invoice_{a}.png','invoice',0) for a in [0,90,180,270]]:
 original=Image.open(p/name).convert('RGB'); image=original.resize((original.width*2,original.height*2),Image.Resampling.LANCZOS)
 if blur: image=image.filter(ImageFilter.GaussianBlur(blur*2))
 for side in [2000,1500]:
  im=image.copy();
  if side==1500: im.thumbnail((side,side),Image.Resampling.LANCZOS)
  t=time.perf_counter(); r=o.recognize(im,kind,e); dt=round(time.perf_counter()-t,2)
  out.append({'file':name,'blur':blur,'side':side,'seconds':dt,'fields':r['fields'],'rotation':r['rotation_ccw'],'passes':r['orientation_candidates_tried']})
  print(name,blur,side,dt,flush=True)
(p/'ocr_resize_compare.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf8')

