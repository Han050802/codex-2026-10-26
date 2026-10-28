"""OCR helper for reconciliation prototype. All outputs are suggestions requiring review.
CLI: python -X utf8 reconciliation_ocr.py <image-path> <bank|invoice>
Prints exactly one UTF-8 JSON object to stdout. Diagnostics go to stderr.
"""
from __future__ import annotations
import json, re, sys, unicodedata
from pathlib import Path
from decimal import Decimal, InvalidOperation


def normalize(s):
    return unicodedata.normalize('NFKC', str(s)).strip()


def amount(s):
    s = normalize(s).replace(',', '').replace('¥', '').replace('￥', '').strip()
    m = re.search(r'(?<!\d)(-?\d+(?:\.\d{2}))(?!\d)', s)
    if not m:
        return None
    try:
        return format(Decimal(m.group(1)), '.2f')
    except InvalidOperation:
        return None


def iso_date(s):
    s = normalize(s)
    m = re.search(r'(20\d{2})\D?(\d{2})\D?(\d{2})', s)
    return '-'.join(m.groups()) if m else None


def parse_bank(items, width, height):
    dates = [x for x in items if x['x'] < width * .16 and re.fullmatch(r'20\d{6}', normalize(x['text']))]
    dates.sort(key=lambda x:x['y'])
    account = next((re.sub(r'^.*?户名\s*[:：]', '', x['text']).strip() for x in items if re.search(r'户名\s*[:：]', x['text'])), None)
    entries=[]
    for i,d in enumerate(dates):
        lower = (dates[i-1]['y']+d['y'])/2 if i else d['y']-35
        upper = (d['y']+dates[i+1]['y'])/2 if i+1<len(dates) else d['y']+60
        row=[x for x in items if lower <= x['y'] < upper]
        nums=[x for x in row if width*.30 < x['x'] < width*.46 and amount(x['text']) is not None]
        nums.sort(key=lambda x:abs(x['y']-d['y']))
        payee=[x for x in row if width*.54 < x['x'] < width*.88 and not re.search(r'^[A-Za-z0-9]+$',normalize(x['text'])) and re.search(r'[\u4e00-\u9fff]',x['text'])]
        payee.sort(key=lambda x:abs(x['y']-d['y']))
        desc=[x['text'] for x in row if width*.12 < x['x'] < width*.34]
        value=amount(nums[0]['text']) if nums else None
        entries.append({'date':iso_date(d['text']),'amount':value,'counterparty':payee[0]['text'] if payee else None,'description':' '.join(desc),'needs_review':True,'source':{'date':d['text'],'amount':nums[0]['text'] if nums else None,'counterparty':payee[0]['text'] if payee else None}})
    return {'account_name':account,'transactions':entries}


def parse_invoice(items, width, height):
    number=next((re.sub(r'\D','',normalize(x['text']).split(':',1)[-1]) for x in items if '发票号码' in x['text']), None)
    invoice_date=next((iso_date(x['text']) for x in items if '开票日期' in x['text']),None)
    names=[]
    for x in items:
        match=re.search(r'名称\s*[:：]\s*(.+)',x['text'])
        if match: names.append((x['x'],match.group(1).strip()))
    names.sort()
    total=None
    small=[x for x in items if '小写' in x['text'] and amount(x['text']) is not None]
    if small: total=amount(small[-1]['text'])
    if not total:
        # Some layouts split the marker and amount into adjacent OCR boxes.
        marks=[x for x in items if '小写' in x['text']]
        for mark in marks:
            candidates=[x for x in items if abs(x['y']-mark['y'])<height*.03 and x['x']>=mark['x'] and amount(x['text']) is not None]
            if candidates:
                candidates.sort(key=lambda x:x['x']); total=amount(candidates[0]['text']); break
    return {'invoice_number':number,'invoice_date':invoice_date,'buyer_name':names[0][1] if len(names)>0 else None,'seller_name':names[-1][1] if len(names)>1 else None,'total_amount':total,'needs_review':True}


def main():
    if len(sys.argv)!=3 or sys.argv[2] not in ('bank','invoice'):
        raise ValueError('Usage: reconciliation_ocr.py IMAGE_PATH bank|invoice')
    from PIL import Image, ImageOps
    import numpy as np
    from rapidocr_onnxruntime import RapidOCR
    kind=sys.argv[2]; path=Path(sys.argv[1]); image=ImageOps.exif_transpose(Image.open(path)).convert('RGB'); engine=RapidOCR()
    if kind=='bank': angles=[0]  # Bank sheet usually portrait; rotate manually if needed.
    elif image.height>image.width: angles=[90,270]
    else: angles=[0,180]
    best=None
    for angle in angles:
        im=image.rotate(angle,expand=True) if angle else image
        result,_=engine(np.asarray(im))
        result=result or []
        texts=' '.join(str(row[1]) for row in result)
        keywords=['发票','购买方','销售方','价税合计','开票日期','服务费'] if kind=='invoice' else ['交易金额','对方户名']
        score=sum(texts.count(word)*10 for word in keywords)+sum(len(re.findall(r'[\u4e00-\u9fff]',str(row[1]))) for row in result)*.02
        if best is None or score>best[0]: best=(score,angle,im.size,result)
    _,angle,(w,h),result=best
    items=[]
    for box,text,confidence in result:
        xs=[float(point[0]) for point in box]; ys=[float(point[1]) for point in box]
        items.append({'text':str(text),'confidence':round(float(confidence),4),'x':(min(xs)+max(xs))/2,'y':(min(ys)+max(ys))/2,'box':box})
    fields=parse_bank(items,w,h) if kind=='bank' else parse_invoice(items,w,h)
    out={'ok':True,'kind':kind,'rotation_ccw':angle,'image_width':w,'image_height':h,'requires_human_review':True,'fields':fields,'ocr':items}
    print(json.dumps(out,ensure_ascii=False,default=lambda x:float(x)))

if __name__=='__main__':
    try: main()
    except Exception as exc:
        print(json.dumps({'ok':False,'error':str(exc),'requires_human_review':True},ensure_ascii=False))
        sys.exit(1)
