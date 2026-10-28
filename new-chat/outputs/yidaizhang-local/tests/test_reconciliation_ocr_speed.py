import io
import json
import sys
import tempfile
from pathlib import Path
import types
import unittest
from unittest.mock import patch
from PIL import Image
import reconciliation_ocr as ocr


def row(text,x,y,confidence=.99):
    return ([[x-2,y-2],[x+2,y-2],[x+2,y+2],[x-2,y+2]],text,confidence)

def invoice():
    return [row('发票号码:12345678901234567890',80,15), row('开票日期:2026年09月08日',80,22),
            row('购买方',20,28),row('销售方',70,28),
            row('名称:买方公司',20,35),row('名称:卖方公司',70,35),
            row('价税合计 小写 ¥112000.00',70,80)]

class FakeEngine:
    def __init__(self,results): self.results=iter(results); self.calls=0
    def __call__(self,image): self.calls+=1; return next(self.results),None

class Tests(unittest.TestCase):
    def test_incomplete_invoice_title_is_retried_without_guessing(self):
        initial=invoice()+[row('电子发票（普发票）',45,10)]
        engine=FakeEngine([initial,[row('电子发票普通发票）',45,10)]])
        result=ocr.recognize(Image.new('RGB',(100,100)),'invoice',engine)
        self.assertEqual(result['fields']['invoice_type'],'ordinary')
        engine=FakeEngine([initial,[row('电子发票（普发票）',45,10)]])
        result=ocr.recognize(Image.new('RGB',(100,100)),'invoice',engine)
        self.assertEqual(result['fields']['invoice_type'],'')

    def test_valid_first_pass_skips_second(self):
        engine=FakeEngine([invoice()])
        result=ocr.recognize(Image.new('RGB',(100,100)),'invoice',engine)
        self.assertEqual(engine.calls,1)
        self.assertEqual(result['fields']['buyer_name'],'买方公司')
        self.assertEqual(result['fields']['seller_name'],'卖方公司')
        self.assertEqual(result['fields']['total_amount'],'112000.00')
        self.assertTrue(result['orientation_confident'])
    def test_incomplete_first_pass_falls_back(self):
        engine=FakeEngine([invoice()[:-1],invoice()])
        result=ocr.recognize(Image.new('RGB',(100,100)),'invoice',engine)
        self.assertEqual(engine.calls,2); self.assertEqual(result['rotation_ccw'],180)
        self.assertTrue(result['orientation_confident'])
    def test_wrong_direction_with_complete_words_falls_back(self):
        upside=[(box,text,conf) for box,text,conf in invoice()]
        upside=[([[p[0],100-p[1]] for p in box],text,conf) for box,text,conf in upside]
        engine=FakeEngine([upside,invoice()])
        result=ocr.recognize(Image.new('RGB',(100,100)),'invoice',engine)
        self.assertEqual(engine.calls,2); self.assertEqual(result['rotation_ccw'],180)
        self.assertEqual(result['fields']['buyer_name'],'买方公司')
    def test_fallback_rejects_strongly_inverted_layout_with_more_text(self):
        upright=[r for r in invoice() if not r[1].startswith('发票号码')]
        upside=[([[100-p[0],100-p[1]] for p in box],text,conf) for box,text,conf in upright]
        upside.append(row('发票发票发票发票发票',40,50))
        engine=FakeEngine([upside,upright])
        result=ocr.recognize(Image.new('RGB',(100,100)),'invoice',engine)
        self.assertEqual(engine.calls,2); self.assertEqual(result['rotation_ccw'],180)
        self.assertFalse(result['orientation_confident'])

    def test_portrait_uses_90_and_270(self):
        engine=FakeEngine([[],invoice()])
        result=ocr.recognize(Image.new('RGB',(100,200)),'invoice',engine)
        self.assertEqual(result['rotation_ccw'],270); self.assertEqual(engine.calls,2)
    def test_missing_labels_force_fallback(self):
        data=[r for r in invoice() if r[1]!='购买方']
        engine=FakeEngine([data,data]); result=ocr.recognize(Image.new('RGB',(100,100)),'invoice',engine)
        self.assertEqual(engine.calls,2); self.assertFalse(result['orientation_confident'])
    def test_portrait_first_pass_is_90(self):
        engine=FakeEngine([invoice()])
        result=ocr.recognize(Image.new('RGB',(100,200)),'invoice',engine)
        self.assertEqual(result['rotation_ccw'],90); self.assertEqual(engine.calls,1)
    def test_exif_orientation_is_applied_before_recognition(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'rotated.jpg'
            image=Image.new('RGB',(40,80)); exif=image.getexif(); exif[274]=6
            image.save(path,exif=exif)
            with patch.object(ocr,'recognize',side_effect=lambda im,kind,engine: {'size':im.size}):
                result=ocr.run_one(path,'invoice',object())
            self.assertEqual(result['size'],(80,40))
    def test_worker_errors_are_isolated_and_engine_reused(self):
        created=[]
        def make_engine(**kwargs):
            self.assertEqual(kwargs, {'rec_batch_num':1})
            created.append(object()); return created[-1]
        rapid=types.SimpleNamespace(RapidOCR=make_engine)
        requests='\n'.join(map(json.dumps,[{'path':'bad','kind':'bank'},{'path':'one','kind':'bank'},{'path':'two','kind':'invoice'}]))+'\n'
        def run(path,kind,engine):
            if path=='bad': raise ValueError('bad image')
            return {'ok':True,'path':path}
        output=io.StringIO()
        with patch.dict(sys.modules,{'rapidocr_onnxruntime':rapid}), patch.object(sys,'stdin',io.StringIO(requests)), patch.object(sys,'stdout',output), patch.object(ocr,'run_one',run):
            ocr.worker()
        results=[json.loads(line) for line in output.getvalue().splitlines()]
        self.assertFalse(results[0]['ok']); self.assertTrue(results[1]['ok']); self.assertTrue(results[2]['ok'])
        self.assertEqual(len(created),1)

    def test_memory_error_is_categorized_without_exposing_exception_text(self):
        for exc in (MemoryError('secret account'), RuntimeError('Failed to allocate memory: secret account'), RuntimeError('bad allocation secret account')):
            result=ocr.error_result(exc)
            self.assertEqual(result['error_code'],'memory_allocation')
            self.assertIn('分批',result['error'])
            self.assertNotIn('secret account',json.dumps(result,ensure_ascii=False))
        other=ocr.error_result(ValueError('private document details'))
        self.assertEqual(other['error_code'],'recognition_failed')
        self.assertNotIn('private document details',json.dumps(other,ensure_ascii=False))

    def test_worker_recreates_engine_after_memory_error(self):
        created=[]
        def make_engine():
            created.append(object()); return created[-1]
        def run(path,kind,engine):
            if path=='large': raise RuntimeError('Failed to allocate memory, secret text')
            return {'ok':True}
        requests='\n'.join(map(json.dumps,[{'path':'large','kind':'bank'},{'path':'next','kind':'bank'}]))+'\n'
        output=io.StringIO()
        with patch.object(ocr,'create_engine',make_engine), patch.object(sys,'stdin',io.StringIO(requests)), patch.object(sys,'stdout',output), patch.object(ocr,'run_one',run):
            ocr.worker()
        results=[json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(results[0]['error_code'],'memory_allocation')
        self.assertNotIn('secret text',output.getvalue())
        self.assertTrue(results[1]['ok']); self.assertEqual(len(created),2)

if __name__=='__main__': unittest.main()
