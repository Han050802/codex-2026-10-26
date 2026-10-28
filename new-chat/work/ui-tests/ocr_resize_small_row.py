import json,time,sys
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
from rapidocr_onnxruntime import RapidOCR
sys.path.insert(0,r'D:\Codex\2026-10-26\new-chat\outputs\yidaizhang-local'); import reconciliation_ocr as o
p=Path(r'D:\Codex\2026-10-26\new-chat\work\ui-tests'); im=Image.new('RGB',(1800,1200),'white'); d=ImageDraw.Draw(im)
reg=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',25); sm=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',10)
d.text((45,35),'户名：鸿悦盛嘉（北京）医院管理有限公司',font=reg,fill='black')
d.text((30,100),'交易日期       摘要                       交易金额                 对方户名',font=reg,fill='black')
for i in range(12):
 y=150+i*75; f=sm if i==11 else reg
 for x,text in [(30,f'202609{i+1:02}'),(250,'服务费'),(590,'-112000.00' if i%2==0 else '-37479.48'),(1000,'北京超建邦科技有限公司')]: d.text((x,y),text,font=f,fill='black')
im=im.resize((3600,2400),Image.Resampling.LANCZOS); e=RapidOCR(); out=[]
for side in [2000,1500]:
 inp=im.copy()
 if side==1500: inp.thumbnail((side,side),Image.Resampling.LANCZOS)
 t=time.perf_counter(); r=o.recognize(inp,'bank',e); out.append({'side':side,'seconds':round(time.perf_counter()-t,2),'fields':r['fields']})
 print(side,'seconds',out[-1]['seconds'],'rows',len(r['fields']['transactions']),flush=True)
(p/'ocr_resize_small_row.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf8')


