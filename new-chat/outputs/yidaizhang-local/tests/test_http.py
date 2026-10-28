"""End-to-end HTTP checks against a temporary, empty production database."""
import base64
from concurrent.futures import ThreadPoolExecutor
import csv
import http.cookiejar
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import server


class Client:
    def __init__(self,base):
        self.base=base;self.csrf=None;self.cookies=http.cookiejar.CookieJar()
        self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(self.cookies))
    def call(self,path,body=None,method=None,headers=None,csrf=True):
        method=method or ('POST' if body is not None else 'GET')
        hs={'Origin':self.base}
        if body is not None:hs['Content-Type']='application/json'
        if csrf and self.csrf:hs['X-CSRF-Token']=self.csrf
        hs.update(headers or {})
        req=urllib.request.Request(self.base+path,data=json.dumps(body,ensure_ascii=False).encode() if body is not None else None,headers=hs,method=method)
        try:res=self.opener.open(req,timeout=25)
        except urllib.error.HTTPError as e:res=e
        data=res.read();ctype=res.headers.get('Content-Type','')
        obj=json.loads(data) if 'application/json' in ctype else data
        if isinstance(obj,dict) and obj.get('csrf'):self.csrf=obj['csrf']
        return res.code,obj,res.headers


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='ydz-http-test-')
        self.app=server.Application(self.temp.name)
        self.http=server.make_server('127.0.0.1',0,self.app)
        self.thread=threading.Thread(target=self.http.serve_forever,daemon=True);self.thread.start()
        self.base=f'http://127.0.0.1:{self.http.server_address[1]}'
        self.client=Client(self.base)
        self.users=[{'username':f'test{i}','name':f'测试操作员{i}','password':f'TestOnly-{i}-Strong!'} for i in range(1,4)]
    def tearDown(self):
        self.http.shutdown();self.http.server_close();self.thread.join(timeout=3);self.temp.cleanup()
    def setup(self):
        status,obj,_=self.client.call('/api/setup',{'company_name':'验收测试机构','users':self.users},headers={'X-Setup-Token':self.app.setup_token})
        self.assertEqual(status,200,obj)
        return obj
    def create_client(self,code='HTTP-1',standard='enterprise2007'):
        data={'name':'验收合成客户'+code,'code':code,'taxpayer_type':'general','standard':standard,'start_period':'2026-01','industry':'商务服务','region':'本地','accountant_id':1,'labels':['验收'],'enabled':True}
        status,obj,_=self.client.call('/api/clients',data);self.assertEqual(status,200,obj);return obj
    def test_automatic_account_codes_are_sequential_scoped_and_safe_under_concurrency(self):
        self.setup(); first=self.create_client('AUTO-1'); second=self.create_client('AUTO-2')
        path=f'/api/books/{first["id"]}/accounts'
        def create(client,path,parent,name):
            status,obj,_=client.call(path,{'parent_code':parent,'name':name})
            self.assertEqual(200,status,obj)
            return obj
        a=create(self.client,path,'1122','往来一')
        b=create(self.client,path,'1122','往来二')
        self.assertEqual(['112201','112202'],[a['code'],b['code']])
        self.assertEqual('220201',create(self.client,path,'2202','另一父科目')['code'])
        self.assertEqual('11220101',create(self.client,path,'112201','更下一级')['code'])
        self.assertEqual('112201',create(self.client,f'/api/books/{second["id"]}/accounts','1122','另一账套')['code'])
        status,manual,_=self.client.call(path,{'code':'112205','name':'已有编号','category':'asset','direction':'debit'})
        self.assertEqual(200,status,manual)
        self.assertEqual('112206',create(self.client,path,'1122','跳过空号')['code'])
        other=Client(self.base)
        status,login,_=other.call('/api/login',{'username':'test2','password':'TestOnly-2-Strong!'})
        self.assertEqual(200,status,login)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda item:create(item[0],path,'1122',item[1]),[(self.client,'并发一'),(other,'并发二')]))
        self.assertEqual(['112207','112208'],sorted(row['code'] for row in results))

    def test_manual_voucher_metadata_balance_range_and_company_dashboard(self):
        self.setup();customer=self.create_client();cid=customer['id']
        payload={'date':'2026-01-12','summary':'HTTP凭证摘要','attachment_count':3,
                 'lines':[{'account_code':'1002','debit_fen':12345,'credit_fen':0,'summary':'银行逐行摘要','cashflow_category':'operating'},
                          {'account_code':'6001','debit_fen':0,'credit_fen':12345,'summary':'营业收入摘要'}]}
        status,voucher,_=self.client.call(f'/api/books/{cid}/vouchers',payload)
        self.assertEqual(200,status,voucher)
        self.assertEqual((3,'测试操作员1'),(voucher['attachment_count'],voucher['created_by_name']))
        status,report,_=self.client.call(f'/api/books/{cid}/balance?start=2026-01&end=2026-02')
        self.assertEqual(200,status,report)
        bank=next(r for r in report['trial_balance_rollup'] if r['account_code']=='1002')
        self.assertEqual((12345,12345),(bank['closing_debit_fen'],bank['ytd_debit_fen']))
        self.assertEqual('银行逐行摘要',report['ledger'][0]['summary'])
        self.assertEqual(12345,report['totals']['debit_fen'])
        status,book,_=self.client.call(f'/api/books/{cid}?period=2026-01')
        self.assertEqual(200,status,book)
        self.assertEqual((1,3),(book['dashboard']['voucher_count'],book['dashboard']['attachment_count']))
        self.assertEqual(12345,book['dashboard']['funds']['bank_fen'])
        changed=dict(payload,version=voucher['version'],attachment_count=4)
        status,updated,_=self.client.call(f'/api/books/{cid}/vouchers/{voucher["id"]}',changed,'PATCH')
        self.assertEqual(200,status,updated);self.assertEqual(4,updated['attachment_count'])
        self.assertEqual(409,self.client.call(f'/api/books/{cid}/vouchers/{voucher["id"]}',changed,'PATCH')[0])
        self.assertEqual(400,self.client.call(f'/api/books/{cid}/balance?start=2026-02&end=2026-01')[0])

    def test_setup_auth_and_csrf_boundary(self):
        self.assertEqual(self.client.call('/api/bootstrap')[0],401)
        self.assertEqual(self.client.call('/api/setup',{'users':self.users,'company_name':'测试'})[0],403)
        self.setup()
        self.assertFalse(self.client.call('/api/session')[1]['setup_required'])
        self.assertEqual(self.client.call('/api/clients',{},csrf=False)[0],403)
        self.assertEqual(self.client.call('/api/clients',{},headers={'Origin':'https://foreign.example'})[0],403)
        self.assertEqual(self.client.call('/api/health',headers={'Host':'attacker.example'})[0],403)
        bootstrap=self.client.call('/api/bootstrap')[1]
        self.assertEqual(len(bootstrap['users']),3);self.assertEqual(bootstrap['clients'],[])
        self.assertNotIn('password_hash',json.dumps(bootstrap))
        self.assertEqual(self.client.call('/data/app.sqlite3')[0],404)
        self.assertEqual(self.client.call('/../server.py')[0],404)
    def test_three_users_and_concurrent_edit_conflict(self):
        self.setup();customer=self.create_client()
        second=Client(self.base);third=Client(self.base)
        for i,c in [(2,second),(3,third)]:
            status,body,_=c.call('/api/login',{'username':f'test{i}','password':f'TestOnly-{i}-Strong!'});self.assertEqual(status,200,body)
        def update(c,text):return c.call(f'/api/clients/{customer["id"]}',{**customer,'note':text},'PATCH')
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda pair:update(*pair),[(second,'第二人修改'),(third,'第三人修改')]))
        self.assertEqual(sorted(r[0] for r in results),[200,409])
        b=self.client.call('/api/bootstrap')[1]
        self.assertEqual(b['clients'][0]['version'],customer['version']+1)
        names={r['username'] for r in b['audit_logs']}
        self.assertTrue({'test2','test3'}.issubset(names))
        self.assertNotIn('TestOnly-',json.dumps(b['audit_logs']))
    def test_atomic_import_and_200_company_capacity(self):
        self.setup()
        header=self.client.call('/api/templates/clients.csv')[1].decode('utf-8-sig')
        columns=next(csv.reader(io.StringIO(header)));out=io.StringIO();writer=csv.DictWriter(out,fieldnames=columns);writer.writeheader()
        for i in range(200):
            row={k:'' for k in columns};row.update(name=f'合成验收企业{i+1:03}',code=f'C-{i+1:03}',taxpayer_type='general' if i%2 else 'small',standard='enterprise2007' if i%2 else 'small2013',start_period='2026-01',accountant_id='1')
            writer.writerow(row)
        body={'filename':'clients.csv','content_base64':base64.b64encode(out.getvalue().encode()).decode()}
        status,data,_=self.client.call('/api/import/clients',body);self.assertEqual(status,200,data);self.assertEqual(data['imported'],200)
        boot=self.client.call('/api/bootstrap?period=2026-10')[1];self.assertEqual(len(boot['clients']),200)
        # Re-importing the same batch fails without adding any duplicate company.
        self.assertEqual(self.client.call('/api/import/clients',body)[0],400)
        self.assertEqual(len(self.client.call('/api/bootstrap')[1]['clients']),200)
        for cid in (1,200):
            code,bundle,_=self.client.call(f'/api/books/{cid}?period=2026-10');self.assertEqual(code,200,bundle);self.assertTrue(bundle['accounts']);self.assertTrue(bundle['reports']['balance_sheet']['balanced'])
    def test_invoice_to_voucher_reports_export_and_no_duplicate(self):
        self.setup();customer=self.create_client();cid=customer['id']
        inv={'client_id':cid,'period':'2026-10','date':'2026-10-05','kind':'output','number':'VERIFY-001','summary':'销售业务验收','category':'销售','amount_fen':10000,'tax_fen':1300,'total_fen':11300}
        status,invoice,_=self.client.call('/api/invoices',inv);self.assertEqual(status,200,invoice)
        status,posted,_=self.client.call(f'/api/invoices/{invoice["id"]}/post',{'version':invoice['version'],'debit_account':'1122','credit_account':'6001','tax_account':'2221'});self.assertEqual(status,200,posted)
        book=self.client.call(f'/api/books/{cid}?period=2026-10')[1]
        self.assertEqual(len(book['vouchers']),1)
        self.assertEqual(book['reports']['profit_loss']['profit_fen'],10000)
        self.assertTrue(book['reports']['balance_sheet']['balanced'])
        self.assertNotEqual(self.client.call(f'/api/invoices/{invoice["id"]}/post',{'version':invoice['version'],'debit_account':'1122','credit_account':'6001','tax_account':'2221'})[0],200)
        self.assertEqual(len(self.client.call(f'/api/books/{cid}?period=2026-10')[1]['vouchers']),1)
        status,export,headers=self.client.call(f'/api/export/vouchers.csv?client_id={cid}&period=2026-10');self.assertEqual(status,200);self.assertIn('销售业务验收',export.decode('utf-8-sig'));self.assertIn('attachment',headers['Content-Disposition'])
    def test_period_fees_and_reversal_over_http(self):
        self.setup();c=self.create_client()
        payload={'client_id':c['id'],'service':'代理记账','start_period':'2026-01','end_period':'2026-12','monthly_fee_fen':30000,'status':'active','note':''}
        status,contract,_=self.client.call('/api/contracts',payload);self.assertEqual(status,200,contract)
        status,receipt,_=self.client.call('/api/receipts',{'contract_id':contract['id'],'date':'2026-02-10','amount_fen':100000,'method':'银行转账','note':'验收收款'});self.assertEqual(status,200,receipt)
        march=self.client.call('/api/bootstrap?period=2026-03')[1]['contracts'][0]
        self.assertEqual(march['due_fen'],90000);self.assertEqual(march['prepaid_fen'],10000)
        self.assertEqual(self.client.call(f'/api/receipts/{receipt["id"]}/reverse',{'version':receipt['version'],'date':'2026-03-10','note':'验收冲销'})[0],200)
        changed=self.client.call('/api/bootstrap?period=2026-03')[1]['contracts'][0]
        self.assertEqual(changed['received_fen'],0);self.assertEqual(changed['debt_fen'],90000)
    def test_evidence_file_and_consistent_backup(self):
        self.setup();c=self.create_client()
        record={'client_id':c['id'],'period':'2026-10','tax_type':'VAT','status':'submitted','payment_status':'unpaid','confirmation_status':'pending','amount_fen':1300,'paid_fen':0,'source':'manual'}
        self.assertEqual(self.client.call('/api/tax-records',record)[0],400)
        status,attachment,_=self.client.call('/api/upload',{'name':'验收回执.txt','content_base64':base64.b64encode('仅为合成验收数据'.encode()).decode()});self.assertEqual(status,200,attachment)
        record.update(attachment_id=attachment['id'],reference='LOCAL-TEST-001')
        self.assertEqual(self.client.call('/api/tax-records',record)[0],200)
        self.assertEqual(self.client.call(f'/api/files/{attachment["id"]}')[1].decode(),'仅为合成验收数据')
        status,archive,_=self.client.call('/api/backup');self.assertEqual(status,200)
        with zipfile.ZipFile(io.BytesIO(archive)) as z:
            self.assertEqual(z.testzip(),None);manifest=json.loads(z.read('manifest.json'));self.assertEqual(manifest['format'],'yidaizhang-local-v1')
            self.assertEqual(len(manifest['files']),1);self.assertIn('app.sqlite3',z.namelist());self.assertNotIn('setup-token.txt',z.namelist())
        self.assertEqual(Client(self.base).call('/api/backup')[0],401)
    def test_static_local_assets_have_no_remote_dependencies(self):
        self.assertEqual(self.client.call('/')[0],200)
        for name in ('app.js','styles.css','finance-ui.js','finance.css'):
            status,data,headers=self.client.call('/'+name);self.assertEqual(status,200,name)
            self.assertIn("default-src 'self'",headers['Content-Security-Policy'])
            self.assertNotIn(b'https://cdn.',data)


if __name__=='__main__':unittest.main(verbosity=2)
