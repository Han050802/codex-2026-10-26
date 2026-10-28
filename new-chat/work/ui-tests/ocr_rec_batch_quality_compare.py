import json,time,sys
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont,ImageFilter
from rapidocr_onnxruntime import RapidOCR
sys.path.insert(0,r'D:\Codex\2026-10-26\new-chat\outputs\yidaizhang-local'); import reconciliation_ocr as o
p=Path(r'D:\Codex\2026-10-26\new-chat\work\ui-tests'); im=Image.open(p/'synthetic_bank.png').convert('RGB'); small=im.copy(); d=ImageDraw.Draw(small); y=150+11*75; d.rectangle((0,y-5,1799,y+40),fill='white'); f=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',10)
for x,text in [(30,'20260912'),(250,'服务费'),(590,'-37479.48'),(1000,'北京超建邦科技有限公司')]: d.text((x,y),text,font=f,fill='black')
images=[('small',small),('blur',im.filter(ImageFilter.GaussianBlur(1.2))),('clear',im)]; out=[]; e=RapidOCR(); o.recognize(im,'bank',e)
for name,image in images:
 for n in ([1,6] if name=='small' else [6,1]):
  e.text_rec.rec_batch_num=n; t=time.perf_counter(); r=o.recognize(image,'bank',e); sec=round(time.perf_counter()-t,2)
  out.append({'case':name,'batch':n,'seconds':sec,'fields':r['fields'],'rotation':r['rotation_ccw']}); print(name,n,sec,len(r['fields']['transactions']),flush=True)
(p/'ocr_rec_batch_quality_compare.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf8')
