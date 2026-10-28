import base64
import json
import sqlite3
import unittest
from unittest.mock import patch
import reconciliation as r
import reconciliation_ocr as ocr
from invoice_details import extract_details
from db import ApiError

class InvoiceDetailsTests(unittest.TestCase):
    def test_explicit_details_and_unknowns(self):
        text='发票号码：12345678\n*办公用品*办公用品\n*信息技术服务*服务费\n不含税金额：1,000.00\n税额合计：60.00'
        details=extract_details(text)
        self.assertEqual(details, {'item_name':'*办公用品*办公用品；*信息技术服务*服务费','invoice_type':'','net_amount':'1000.00','tax_amount':'60.00','business_purpose':''})
        self.assertEqual(r.parse_invoice(text,'x.pdf')['item_name'],details['item_name'])
        self.assertEqual(extract_details('公司名称：服务费有限公司\n价税合计：106.00')['tax_amount'],'')
        self.assertEqual(extract_details('税额合计：6.00\n税额合计：5.00')['tax_amount'],'')
        self.assertEqual(extract_details('电子发票（普通发票）')['invoice_type'],'ordinary')
        self.assertEqual(extract_details('电子发票普通发票）')['invoice_type'],'ordinary')
        self.assertEqual(extract_details('电子发票（普发票）')['invoice_type'],'')
        self.assertEqual(extract_details('增值税专用发票')['invoice_type'],'special')
        self.assertEqual(extract_details('增值税普通发票 增值税专用发票')['invoice_type'],'')
    def test_ocr_details_flow(self):
        items=[{'text':x,'x':20,'y':n} for n,x in enumerate(['电子发票（普通发票）','发票号码:12345678','*办公用品*办公用品','税额合计:6.00'])]
        fields=ocr.parse_invoice(items,100,100)
        self.assertEqual(fields['item_name'],'*办公用品*办公用品')
        item={'name':'test.jpg','content_base64':base64.b64encode(b'image').decode()}
        with patch.object(r.OCRWorker,'run',return_value=({'ok':True,'orientation_confident':True,'fields':fields},'')):
            invoice=r.parse({'invoices':[item]})['invoices'][0]
        self.assertEqual(invoice['item_name'],fields['item_name'])
        self.assertEqual(invoice['tax_amount'],'6.00')
        self.assertEqual(invoice['net_amount'],'')
        self.assertEqual(invoice['invoice_type'],'ordinary')
    def test_invoice_totals_need_aligned_unique_columns_and_a_matching_sum(self):
        items=[{'text':t,'x':x,'y':y} for t,x,y in [
            ('金额',700,100),('税额',900,100),('合',100,300),('计',150,300),
            ('￥101980.20',700,300),('￥1019.80',900,300),('（小写）￥103000.00',800,350)]]
        fields=ocr.parse_invoice(items,1000,500)
        self.assertEqual((fields['net_amount'],fields['tax_amount']),('101980.20','1019.80'))
        self.assertIsNone(ocr.invoice_table_amounts(items,1000,500,'103001.00'))
        self.assertIsNone(ocr.invoice_table_amounts(items+[{'text':'￥1019.80','x':900,'y':301}],1000,500,'103000.00'))
    def test_save_fields_and_batch_consistency(self):
        c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row
        c.executescript('CREATE TABLE clients(id INTEGER PRIMARY KEY,name TEXT,deleted INTEGER,profile_json TEXT);CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT);CREATE TABLE vouchers(id INTEGER PRIMARY KEY,client_id INTEGER,source_type TEXT,source_id TEXT,status TEXT);CREATE TABLE voucher_lines(id INTEGER PRIMARY KEY,voucher_id INTEGER,account_code TEXT);CREATE TABLE audit_logs(id INTEGER PRIMARY KEY,user_id INTEGER,username TEXT,action TEXT,entity TEXT,entity_id TEXT,detail TEXT,created_at TEXT);INSERT INTO clients VALUES(1,"客户公司",0,"{}");')
        r.init_schema(c)
        t={'date':'2026-09-09','amount':'-106.00','counterparty':'销售公司','note':'','source':'bank'}
        i={'date':'2026-09-08','amount':'106.00','seller':'销售公司','buyer':'客户公司','number':'123','source':'invoice','item_name':'*办公用品*纸','net_amount':'100.00','tax_amount':'6.00','business_purpose':'办公室使用','invoice_type':'ordinary'}
        p={'client_id':1,'account_name':'客户公司','transaction':t,'invoice':i,'batch':{'transactions':[t],'invoices':[i],'transaction_index':0,'invoice_index':0}}
        bad=dict(p,invoice=dict(i,business_purpose='销售使用'))
        with self.assertRaises(ApiError): r.save(c,bad,{'id':1,'username':'test'})
        r.save(c,p,{'id':1,'username':'test'})
        saved=json.loads(c.execute('SELECT invoice_json FROM reconciliation_records').fetchone()[0])
        for k in ('item_name','net_amount','tax_amount','business_purpose','invoice_type'): self.assertEqual(saved[k],i[k])
        c.close()
if __name__=='__main__':unittest.main()
