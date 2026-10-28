import time,json,sys
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
from rapidocr_onnxruntime import RapidOCR
sys.path.insert(0,r'D:\Codex\2026-10-26\new-chat\outputs\yidaizhang-local')
import reconciliation_ocr as ocr
here=Path(r'D:\Codex\2026-10-26\new-chat\work\ui-tests')
font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',25)
im=Image.new('RGB',(1800,1200),'white'); d=ImageDraw.Draw(im)
d.text((45,35),'账户名称 户名：鸿悦盛嘉（北京）医院管理有限公司',font=font,fill='black')
d.text((30,100),'交易日期       摘要                       交易金额                 账户余额                       对方户名',font=font,fill='black')
for i in range(12):
 y=150+i*75
 d.text((30,y),f'202609{i+1:02}',font=font,fill='black'); d.text((250,y),'服务费',font=font,fill='black'); d.text((590,y),('-112000.00' if i%2==0 else '37479.48'),font=font,fill='black'); d.text((1000,y),'北京超建邦科技有限公司',font=font,fill='black')
im.save(here/'synthetic_bank.png')
for n in [-1,1,2,4]:
 t=time.perf_counter(); engine=RapidOCR(**({} if n==-1 else {'intra_op_num_threads':n,'inter_op_num_threads':1})); init=time.perf_counter()-t
 for name,kind in [('synthetic_bank.png','bank'),('synthetic_invoice_0.png','invoice'),('synthetic_invoice_180.png','invoice')]:
  t=time.perf_counter(); out=ocr.run_one(here/name,kind,engine); dt=time.perf_counter()-t
  print(json.dumps({'threads':n,'init':round(init,2),'file':name,'seconds':round(dt,2),'fields':out['fields'],'rotation':out['rotation_ccw'],'passes':out['orientation_candidates_tried']},ensure_ascii=False),flush=True)
