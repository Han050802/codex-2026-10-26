"""OCR helper for reconciliation prototype. All outputs are suggestions requiring review.
CLI: python -X utf8 reconciliation_ocr.py <image-path> <bank|invoice>
Prints exactly one UTF-8 JSON object to stdout. Diagnostics go to stderr.
"""
from __future__ import annotations
import json, re, sys, unicodedata
from contextlib import redirect_stdout
from datetime import date
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


def to_items(result):
    items=[]
    for box,text,confidence in result:
        xs=[float(point[0]) for point in box]; ys=[float(point[1]) for point in box]
        items.append({'text':str(text),'confidence':round(float(confidence),4),'x':(min(xs)+max(xs))/2,'y':(min(ys)+max(ys))/2,'box':box})
    return items


def invoice_layout_direction(items, height):
    """Use visible layout evidence to distinguish upright and inverted text.

    OCR can read rotated text in either direction, so text count alone cannot
    identify buyer and seller. Missing or contradictory evidence stays neutral.
    """
    def anchor(text):
        return [x for x in items if text in normalize(x['text']) and x['confidence'] >= .8]
    votes=[]
    upper=anchor('发票号码')+anchor('开票日期')
    lower=anchor('小写')
    if upper and lower:
        delta=max(x['y'] for x in lower)-min(x['y'] for x in upper)
        if abs(delta)>=height*.18: votes.append(1 if delta>0 else -1)
    purchase=anchor('购买方'); sales=anchor('销售方')
    if purchase and sales:
        delta=max(x['x'] for x in sales)-min(x['x'] for x in purchase)
        if abs(delta)>1: votes.append(1 if delta>0 else -1)
    if votes and all(v==1 for v in votes): return 1
    if votes and all(v==-1 for v in votes): return -1
    return 0


def invoice_orientation_confident(items, fields, width, height):
    """Only skip the second pass when complete fields and layout agree.

    The two passes remain the fallback for unfamiliar invoice layouts, partial
    OCR results, uncertain text, or a document seen upside down.
    """
    number=fields.get('invoice_number') or ''
    invoice_date=fields.get('invoice_date') or ''
    buyer=fields.get('buyer_name') or ''
    seller=fields.get('seller_name') or ''
    total=fields.get('total_amount') or ''
    if not re.fullmatch(r'\d{8,24}',number): return False
    try:
        date.fromisoformat(invoice_date)
        if Decimal(total)<=0: return False
    except (ValueError,InvalidOperation): return False
    if not buyer or not seller or buyer==seller: return False
    # Require recognized anchors at normal positions. This avoids accepting an
    # upside-down invoice just because its OCR happened to find some fields.
    def anchor(text):
        return [x for x in items if text in normalize(x['text']) and x['confidence'] >= .8]
    number_boxes=anchor('发票号码'); date_boxes=anchor('开票日期')
    total_boxes=anchor('小写'); name_boxes=anchor('名称')
    if not number_boxes or not date_boxes or not total_boxes or len(name_boxes)<2: return False
    upper=min(x['y'] for x in number_boxes+date_boxes)
    lower=max(x['y'] for x in total_boxes)
    if upper >= height*.45 or lower <= height*.48 or lower-upper < height*.18: return False
    if not any(x['y'] < lower for x in number_boxes) or not any(x['y'] < lower for x in date_boxes): return False
    names=sorted(name_boxes,key=lambda x:x['x'])
    if names[0]['x'] >= names[-1]['x'] or any(not (upper < x['y'] < lower) for x in (names[0],names[-1])): return False
    # A purchasing/selling heading is mandatory evidence of orientation; their
    # positions must match the parser's left-to-right buyer/seller ordering.
    purchase=anchor('购买方'); sales=anchor('销售方')
    if not purchase or not sales or min(x['x'] for x in purchase)>=max(x['x'] for x in sales): return False
    return True


def recognize(image, kind, engine):
    import numpy as np
    if kind=='bank': angles=[0]
    elif image.height>image.width: angles=[90,270]
    else: angles=[0,180]
    best=None; tried=0
    for angle in angles:
        im=image.rotate(angle,expand=True) if angle else image
        result,_=engine(np.asarray(im))
        result=result or []
        items=to_items(result)
        fields=parse_bank(items,*im.size) if kind=='bank' else parse_invoice(items,*im.size)
        texts=' '.join(str(row[1]) for row in result)
        keywords=['发票','购买方','销售方','价税合计','开票日期','服务费'] if kind=='invoice' else ['交易金额','对方户名']
        score=sum(texts.count(word)*10 for word in keywords)+sum(len(re.findall(r'[\u4e00-\u9fff]',str(row[1]))) for row in result)*.02
        confident=kind=='invoice' and invoice_orientation_confident(items,fields,*im.size)
        direction=invoice_layout_direction(items,im.height) if kind=='invoice' else 0
        tried+=1
        if kind=='invoice' and direction==-1:
            w,h=im.size
            upright=[]
            for row in items:
                item=dict(row)
                item['x']=w-row['x']; item['y']=h-row['y']
                item['box']=[[w-float(x),h-float(y)] for x,y in row['box']]
                upright.append(item)
            corrected=parse_invoice(upright,w,h)
            key=[x for x in upright if any(a in normalize(x['text']) for a in ('发票号码','开票日期','名称','小写','购买方','销售方'))]
            if key and all(x['confidence']>=.97 for x in key) and invoice_orientation_confident(upright,corrected,w,h):
                angle=(angle+180)%360
                candidate=(1,score,angle,im.size,upright,corrected,True)
                best=candidate
                break
        candidate=(direction,score,angle,im.size,items,fields,confident)
        if best is None:
            best=candidate
        elif direction==1 and best[0]==-1:
            best=candidate
        elif not (direction==-1 and best[0]==1) and score>best[1]:
            best=candidate
        if confident:
            best=candidate
            break
    _,_,angle,(w,h),items,fields,confident=best
    return {'ok':True,'kind':kind,'rotation_ccw':angle,'image_width':w,'image_height':h,'requires_human_review':True,'fields':fields,'ocr':items,'orientation_confident':bool(confident),'orientation_candidates_tried':tried}


def run_one(path,kind,engine):
    if kind not in ('bank','invoice'): raise ValueError('kind must be bank or invoice')
    from PIL import Image, ImageOps
    with Image.open(Path(path)) as source:
        image=ImageOps.exif_transpose(source).convert('RGB')
    return recognize(image,kind,engine)


def error_result(exc):
    return {'ok':False,'error':str(exc),'requires_human_review':True}


def worker():
    # Construct once per process, lazily, so individual malformed requests do
    # not prevent subsequent lines from being processed.
    engine=None
    for line in sys.stdin:
        try:
            request=json.loads(line)
            if not isinstance(request,dict) or not isinstance(request.get('path'),str) or request.get('kind') not in ('bank','invoice'):
                raise ValueError('Expected path and kind (bank|invoice)')
            with redirect_stdout(sys.stderr):
                if engine is None:
                    from rapidocr_onnxruntime import RapidOCR
                    engine=RapidOCR()
                out=run_one(request['path'],request['kind'],engine)
        except Exception as exc:
            out=error_result(exc)
        print(json.dumps(out,ensure_ascii=False,default=lambda x:float(x)),flush=True)


def main():
    if len(sys.argv)==2 and sys.argv[1]=='--worker':
        worker(); return
    if len(sys.argv)!=3 or sys.argv[2] not in ('bank','invoice'):
        raise ValueError('Usage: reconciliation_ocr.py IMAGE_PATH bank|invoice | --worker')
    with redirect_stdout(sys.stderr):
        from rapidocr_onnxruntime import RapidOCR
        result=run_one(sys.argv[1],sys.argv[2],RapidOCR())
    print(json.dumps(result,ensure_ascii=False,default=lambda x:float(x)))

if __name__=='__main__':
    try: main()
    except Exception as exc:
        print(json.dumps(error_result(exc),ensure_ascii=False))
        sys.exit(1)
