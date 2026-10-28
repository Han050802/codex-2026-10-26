import sys,time,json,importlib.util
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
from rapidocr_onnxruntime import RapidOCR
p=Path(r'D:\Codex\2026-10-26\new-chat\work\ui-tests')
def mod(name,path):
 s=importlib.util.spec_from_file_location(name,path); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
base=mod('base',r'D:\Codex\2026-10-26\new-chat\outputs\yidaizhang-local\reconciliation_ocr.py'); fast=mod('fast',p/'ocr_rotated_candidate.py')
e=RapidOCR(); out=[]
for i in [0,90,180,270]:
 for mode,m in [('before',base),('after',fast)]:
  t=time.perf_counter(); r=m.run_one(p/f'synthetic_invoice_{i}.png','invoice',e); dt=time.perf_counter()-t
  out.append({'angle':i,'mode':mode,'seconds':round(dt,2),'rotation':r['rotation_ccw'],'passes':r['orientation_candidates_tried'],'confident':r['orientation_confident'],'fields':r['fields']})
  print(i,mode,round(dt,2),r['rotation_ccw'],r['orientation_candidates_tried'],flush=True)
(p/'ocr_rotated_compare.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf8')
