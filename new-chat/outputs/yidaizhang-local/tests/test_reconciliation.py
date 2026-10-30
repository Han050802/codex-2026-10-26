"""Reconciliation regression tests use synthetic companies and transactions only."""
import base64, io, sqlite3, sys, tempfile, unittest, zipfile
from pathlib import Path
from unittest.mock import patch
import reconciliation as r
from db import ApiError

class ReconcileTests(unittest.TestCase):
    def setUp(self):
        self.t={'date':'2026-09-05','amount':'-1200.00','counterparty':'合成供应商甲有限公司','note':'服务费','source':'bank.pdf'}
        self.i={'date':'2026-09-04','amount':'1200.00','seller':'合成供应商甲有限公司','buyer':'客户公司','number':'123','source':'invoice.pdf'}
    def test_match_and_ambiguity(self):
        self.assertEqual(r.match([self.t],[self.i],'客户公司')['matches'][0]['status'],'matched')
        out=r.match([self.t],[self.i,self.i],'客户公司')['matches'][0]
        self.assertEqual(out['status'],'review');self.assertIsNone(out['invoice_index'])
        self.assertEqual(r.match([self.t],[dict(self.i,amount='1200.01')],'客户公司')['matches'][0]['status'],'review')
        self.assertEqual(r.match([dict(self.t,amount='1200.00')],[self.i],'客户公司')['matches'][0]['status'],'review')
        self.assertEqual(r.match([dict(self.t,needs_review=True)],[dict(self.i,needs_review=True)],'客户公司')['matches'][0]['status'],'matched')
        unverified=r.match([self.t],[self.i],'客户公司',account_needs_review=True)['matches'][0]
        self.assertEqual((unverified['invoice_index'],unverified['status']),(0,'matched'))
        self.assertFalse(unverified['reasons'])
        self.assertEqual(r.match([self.t],[dict(self.i,number='')],'客户公司')['matches'][0]['status'],'review')
        self.assertEqual(r.match([dict(self.t,date='')],[self.i],'客户公司')['matches'][0]['status'],'review')
        with self.assertRaises(ApiError):r.match([self.t],[self.i],'客户公司',account_needs_review='false')
        second_t=dict(self.t,date='2026-09-16',amount='-800.00')
        second_i=dict(self.i,date='2026-09-16',amount='800.00',number='456')
        bad_first=dict(self.i,seller='名称有误')
        result=r.match([self.t,second_t],[bad_first,second_i],'客户公司')['matches']
        self.assertEqual(result[0]['status'],'review')
        self.assertEqual((result[1]['invoice_index'],result[1]['status']),(1,'matched'))
    def test_zip_traversal(self):
        b=io.BytesIO()
        with zipfile.ZipFile(b,'w') as z:z.writestr('../x.pdf',b'%PDF-')
        with self.assertRaises(ApiError):r.files_from({'name':'x.zip','content_base64':base64.b64encode(b.getvalue()).decode()})
    def test_date_match_boundaries_and_invalid_dates(self):
        def check(transaction_date, invoice_date):
            return r.match([dict(self.t,date=transaction_date)],[dict(self.i,date=invoice_date)],'客户公司')['matches'][0]
        self.assertEqual(check('2026-01-01','2026-01-31')['status'],'matched')
        self.assertEqual(check('2026-02-01','2026-01-02')['status'],'matched')  # 30 days
        outside=check('2026-02-02','2026-01-02')  # 31 days
        self.assertEqual(outside['status'],'review')
        self.assertIn('交易日期与开票日期不在同月且相差超过30天',outside['reasons'])
        for bad in ('', '2026-02-30', '2026-2-01', 'not-a-date'):
            with self.subTest(bad=bad):
                self.assertEqual(check(bad,'2026-02-01')['status'],'review')
                self.assertEqual(check('2026-02-01',bad)['status'],'review')

    def test_multiple_invoice_candidates_are_non_posting_and_bounded(self):
        t=dict(self.t,amount='-100.00')
        invoices=[dict(self.i,amount='60.00',number='A'),dict(self.i,amount='40.00',number='B')]
        result=r.match([t],invoices,'客户公司')
        candidate=result['multi_invoice_candidates'][0]
        self.assertEqual(candidate['status'],'candidate')
        self.assertEqual(candidate['candidates'][0]['invoice_indices'],[0,1])
        self.assertEqual(result['matches'][0]['status'],'review')
        self.assertIsNone(result['matches'][0]['invoice_index'])
        dated=[dict(invoices[0],date=''),dict(invoices[1],date='2025-01-01')]
        warnings=r.match([t],dated,'客户公司')['multi_invoice_candidates'][0]['candidates'][0]['date_warnings']
        self.assertEqual(len(warnings),2)
        alternatives=invoices+[dict(self.i,amount='70.00',number='C'),dict(self.i,amount='30.00',number='D')]
        result=r.match([t],alternatives,'客户公司')['multi_invoice_candidates'][0]
        self.assertEqual(result['status'],'ambiguous')
        self.assertEqual(len(result['candidates']),2)
        overlap=r.match([t,dict(t,date='2026-09-10')],invoices,'客户公司')['multi_invoice_candidates']
        self.assertEqual([x['status'] for x in overlap],['ambiguous','ambiguous'])
        repeated=[dict(self.i,amount='50.00',number='A'),dict(self.i,amount='50.00',number='A')]
        self.assertEqual(r.match([t],repeated,'客户公司')['multi_invoice_candidates'],[])
        big=[dict(self.i,amount='1.00',number=str(n)) for n in range(15)]
        self.assertEqual(r.match([t],big,'客户公司')['multi_invoice_candidates'][0]['status'],'limit_exceeded')
    def test_income_and_expense_match_with_correct_invoice_roles(self):
        income_t=dict(self.t,amount='1200.00',counterparty='购买客户')
        income_i=dict(self.i,buyer='购买客户',seller='客户公司',number='sales-1')
        result=r.match([self.t,income_t],[self.i,income_i],'客户公司')['matches']
        self.assertEqual([(x['invoice_index'],x['status']) for x in result],[(0,'matched'),(1,'matched')])
        # Reversing parties is not an exact match, even with identical amounts.
        wrong=r.match([income_t],[dict(income_i,buyer='客户公司',seller='购买客户')],'客户公司')['matches'][0]
        self.assertEqual(wrong['status'],'review')
        self.assertTrue(any('购买方' in reason for reason in wrong['reasons']))
        wrong_amount=r.match([income_t],[dict(income_i,amount='1200.01')],'客户公司')['matches'][0]
        self.assertEqual(wrong_amount['status'],'review')
        self.assertIn('金额不一致',wrong_amount['reasons'])
        self.assertTrue(r.compare(dict(income_t,amount='0'),income_i,'客户公司'))

    def test_income_duplicates_and_multiple_candidates_require_review(self):
        t=dict(self.t,amount='1200.00',counterparty='购买客户')
        i=dict(self.i,buyer='购买客户',seller='客户公司',number='sales-1')
        duplicate_invoices=r.match([t],[i,dict(i,number='sales-2')],'客户公司')['matches'][0]
        self.assertEqual((duplicate_invoices['invoice_index'],duplicate_invoices['status']),(None,'review'))
        duplicate_transactions=r.match([t,dict(t,date='2026-09-10')],[i],'客户公司')['matches']
        self.assertTrue(all(x['status']=='review' for x in duplicate_transactions))
        self.assertTrue(all(x['invoice_index']==0 for x in duplicate_transactions))

    def test_business_account_suggestions_require_book_and_use(self):
        c=sqlite3.connect(':memory:'); c.row_factory=sqlite3.Row
        c.executescript('CREATE TABLE clients(id INTEGER PRIMARY KEY,name TEXT,deleted INTEGER,profile_json TEXT,standard TEXT); CREATE TABLE accounts(client_id INTEGER,code TEXT,name TEXT); INSERT INTO clients VALUES(1,"客户公司",0,\'{"enterprise_name":"客户公司全称"}\',"enterprise2007"); INSERT INTO accounts VALUES(1,"6602","管理费用"); INSERT INTO accounts VALUES(1,"6001","主营业务收入");')
        import account_rules
        account_rules.init_schema(c); account_rules.init_schema(c)
        purchase=dict(self.i,item_name='咨询服务',business_purpose='行政管理用途')
        receipt=dict(self.t,amount='1200.00',counterparty='购买客户')
        sale=dict(self.i,buyer='购买客户',seller='客户公司',number='sales-1',item_name='软件服务',business_purpose='主营业务服务')
        result=r.match([self.t,receipt],[purchase,sale],'客户公司',conn=c,client_id=1)
        self.assertEqual([x['account_code'] for x in result['classification_transactions']],['6602','6001'])
        self.assertEqual(r.match([self.t],[purchase],'客户公司')['classification_invoices'][0]['status'],'review')
        self.assertEqual(r.match([self.t],[dict(purchase,business_purpose='')],'客户公司',conn=c,client_id=1)['classification_invoices'][0]['status'],'review')
        self.assertEqual(r.match([self.t],[dict(purchase,item_name='办公用品；电脑')],'客户公司',conn=c,client_id=1)['classification_invoices'][0]['status'],'review')
        self.assertEqual(r.match([self.t],[dict(purchase,business_purpose='行政管理用途、广告宣传用途')],'客户公司',conn=c,client_id=1)['classification_invoices'][0]['status'],'review')
        self.assertEqual(r.match([self.t],[purchase],'其他客户',conn=c,client_id=1)['classification_invoices'][0]['status'],'review')
        full=r.match([], [dict(purchase,buyer='客户公司全称')],'客户公司全称',conn=c,client_id=1)['classification_invoices'][0]
        self.assertEqual(full['account_code'],'6602')
        self.assertIn('czj.sh.gov.cn',full['source_urls'][0])
        hints=r.match([], [dict(purchase,item_name='电脑；广告费',business_purpose='')],'客户公司',conn=c,client_id=1)['classification_invoices'][0]
        self.assertEqual(hints['status'],'review')
        self.assertEqual({x['account_name'] for x in hints['candidates']},{'固定资产','管理费用','销售费用'})
        asset=r.match([], [dict(purchase,item_name='电脑',business_purpose='行政管理用途')],'客户公司',conn=c,client_id=1)['classification_invoices'][0]
        self.assertEqual(asset['status'],'review')
        self.assertEqual(account_rules.list_rules(c,'6602',1)['rules'][0]['account_name'],'管理费用')
        receivable=account_rules.list_rules(c,'1122',1)['rules'][0]
        self.assertEqual(receivable['role'],'settlement')
        self.assertIn('其他期间流水',receivable['conditions'])
        self.assertIn('czj.sh.gov.cn',receivable['source_url'])
        self.assertEqual(account_rules.list_rules(c,'1123',1)['rules'][0]['account_name'],'预付账款')
        advance=account_rules.list_rules(c,'2203',1)['rules'][0]
        self.assertIn('合同负债',advance['conditions'])
        self.assertIn('csrc.gov.cn',advance['source_url'])
        c.execute('INSERT INTO accounts VALUES(1,"660201","办公费")')
        self.assertIsNone(r.match([self.t],[purchase],'客户公司',conn=c,client_id=1)['classification_invoices'][0]['account_code'])
        c.close()

    def test_ocr_warnings_identify_actual_gaps_and_do_not_create_empty_invoice(self):
        def item(name): return {'name':name,'content_base64':base64.b64encode(b'image').decode()}
        complete={'ok':True,'orientation_confident':True,'fields':{'invoice_number':'123','invoice_date':'2026-09-04','total_amount':'1200.00','buyer_name':'客户公司','seller_name':'合成供应商甲有限公司'}}
        partial={'ok':True,'orientation_confident':False,'fields':{'invoice_number':'456','buyer_name':'客户公司'}}
        empty={'ok':True,'orientation_confident':True,'fields':{}}
        with patch.object(r.OCRWorker,'run',side_effect=[(complete,''),(partial,''),(empty,'')]) as call:
            out=r.parse({'invoices':[item('complete.jpg'),item('partial.jpg'),item('empty.jpg')]})
        self.assertEqual(call.call_count,3)
        self.assertEqual([x['number'] for x in out['invoices']],['123','456'])
        self.assertFalse(any('complete.jpg' in x for x in out['warnings']))
        self.assertTrue(any('partial.jpg' in x and '发票方向' in x for x in out['warnings']))
        self.assertTrue(any('partial.jpg' in x and '开票日期' in x and '价税合计' in x and '销售方' in x for x in out['warnings']))
        self.assertTrue(any('empty.jpg' in x and '未识别到发票字段' in x for x in out['warnings']))

    def test_ocr_failure_does_not_discard_other_files(self):
        def item(name): return {'name':name,'content_base64':base64.b64encode(b'image').decode()}
        good={'ok':True,'fields':{'invoice_number':'123','invoice_date':'2026-09-04','total_amount':'1.00','buyer_name':'客户公司','seller_name':'销售公司'},'orientation_confident':True}
        with patch.object(r.OCRWorker,'run',side_effect=[(None,'OCR 识别超时，请检查文件或手工补录'),(good,'')]):
            out=r.parse({'invoices':[item('fail.jpg'),item('good.jpg')]})
        self.assertEqual(len(out['invoices']),1)
        self.assertTrue(any('fail.jpg' in x and '超时' in x for x in out['warnings']))
        self.assertEqual(len([x for x in out['warnings'] if 'fail.jpg' in x]),1)
        self.assertFalse(any('good.jpg' in x for x in out['warnings']))

    def test_bank_missing_fields_warns_specifically(self):
        item={'name':'bank.jpg','content_base64':base64.b64encode(b'image').decode()}
        result={'ok':True,'fields':{'account_name':None,'transactions':[{'date':'2026-09-05','amount':None,'counterparty':'张三'}]}}
        with patch.object(r.OCRWorker,'run',return_value=(result,'')):
            out=r.parse({'statement':item})
        self.assertEqual(len(out['transactions']),1)
        self.assertTrue(any('银行户名' in x for x in out['warnings']))
        self.assertTrue(any('第 1 条交易缺少金额' in x for x in out['warnings']))

    def test_worker_reuses_process_and_restarts_after_timeout(self):
        with tempfile.TemporaryDirectory() as folder:
            script=Path(folder)/'fake_worker.py'
            script.write_text("import sys,json,time\nn=0\nfor line in sys.stdin:\n r=json.loads(line); n+=1\n if r['path'].endswith('slow'): time.sleep(2)\n print(json.dumps({'ok':True,'count':n}),flush=True)\n",encoding='utf-8')
            worker=r.OCRWorker();worker.py=Path(sys.executable);worker.script=script;worker.timeout=.5
            try:
                self.assertEqual(worker.run(Path(folder)/'first','bank')[0]['count'],1)
                self.assertEqual(worker.run(Path(folder)/'second','bank')[0]['count'],2)
                self.assertIn('超时',worker.run(Path(folder)/'slow','bank')[1])
                self.assertEqual(worker.run(Path(folder)/'next','bank')[0]['count'],1)
            finally: worker.close()

    def test_pdf_page_failure_preserves_and_continues_results(self):
        class Worker:
            def __init__(self): self.count=0
            def run(self,image,kind):
                self.count+=1
                if self.count==2: return None,'OCR 识别超时'
                return {'ok':True,'fields':{'invoice_number':str(self.count)}},''
        def convert(args,**kwargs):
            for i in range(1,4): Path(args[-1]+f'-{i}.png').write_bytes(b'image')
            return type('Result',(),{'returncode':0})()
        worker=Worker()
        with patch.object(r.shutil,'which',return_value='pdftoppm'), patch.object(r.subprocess,'run',side_effect=convert):
            rows,error,accounts=r.ocr_file(b'%PDF-fake','.pdf','invoice','scan.pdf',worker)
        self.assertEqual([x['number'] for x in rows],['1','3'])
        self.assertIn('第 2 页',error)
        self.assertEqual(worker.count,3)

    def test_save_and_dedup(self):
        c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row
        c.executescript('CREATE TABLE clients(id INTEGER PRIMARY KEY,name TEXT,deleted INTEGER,profile_json TEXT);CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT);CREATE TABLE vouchers(id INTEGER PRIMARY KEY,client_id INTEGER,source_type TEXT,source_id TEXT,status TEXT);CREATE TABLE voucher_lines(id INTEGER PRIMARY KEY,voucher_id INTEGER,account_code TEXT);CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,user_id INTEGER,username TEXT,action TEXT,entity TEXT,entity_id TEXT,detail TEXT,created_at TEXT);INSERT INTO clients VALUES(1,"客户公司",0,"{}");INSERT INTO users VALUES(1,"测试");')
        r.init_schema(c)
        p={'client_id':1,'account_name':'客户公司','transaction':self.t,'invoice':self.i,'batch':{'transactions':[self.t],'invoices':[self.i],'transaction_index':0,'invoice_index':0}};u={'id':1,'username':'tester'}
        ambiguous=dict(p,batch={'transactions':[self.t],'invoices':[self.i,self.i],'transaction_index':0,'invoice_index':0})
        with self.assertRaises(ApiError):r.save(c,ambiguous,u)
        without_batch=dict(p);without_batch.pop('batch')
        with self.assertRaises(ApiError):r.save(c,without_batch,u)
        unverified=dict(p,account_needs_review=True)
        unverified.update(transaction=dict(self.t,date='2026-09-11',needs_review=True),invoice=dict(self.i,number='125',needs_review=True))
        unverified['batch']={'transactions':[unverified['transaction']],'invoices':[unverified['invoice']],'transaction_index':0,'invoice_index':0}
        self.assertEqual(r.save(c,unverified,u)['status'],'matched')
        saved=r.save(c,p,u)
        self.assertEqual(saved['status'],'matched')
        self.assertNotIn('voucher_id',saved)
        self.assertEqual(c.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0],0)
        with self.assertRaises(ApiError):r.save(c,p,u)
        bad=dict(p,invoice=dict(self.i,number='124',amount='1'),manual_pair=True)
        with self.assertRaises(ApiError):r.save(c,bad,u)
        bad.update(approved_review=True,review_note='核实')
        bad['transaction']=dict(self.t,date='2026-09-10')
        self.assertEqual(r.save(c,bad,u)['status'],'reviewed')
        self.assertEqual(len(r.records(c,1)['records']),3)
        self.assertEqual(c.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0],0)
        c.close()
if __name__=='__main__':unittest.main()
