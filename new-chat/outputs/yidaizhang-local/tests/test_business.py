import base64
import csv
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import business
import db
import finance
import maintenance
import server


class BusinessTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.root=Path(self.tmp.name)
        self.app=server.Application(self.root/'production')
        self.conn=db.connect(self.app.db_path)
        with self.conn:self.conn.execute('INSERT INTO users(username,name,password_hash) VALUES(?,?,?)',('tester','测试员',server.password_hash('StrongTest123!')))
        self.user=dict(self.conn.execute('SELECT id,username,name FROM users').fetchone())
        self.client=business.handle(self.conn,'POST','/api/clients',dict(name='合成测试客户',code='TEST001',taxpayer_type='small',standard='small2013',start_period='2026-01'),self.user,{})

    def tearDown(self):
        self.conn.close();self.tmp.cleanup()

    def call(self,method,path,payload):
        return business.handle(self.conn,method,path,payload,self.user,{})

    def csv_payload(self,kind,rows,**extra):
        buffer=io.StringIO(newline='');writer=csv.DictWriter(buffer,fieldnames=business.TEMPLATES[kind]);writer.writeheader();writer.writerows(rows)
        return dict(filename='test.csv',content_base64=base64.b64encode(buffer.getvalue().encode('utf-8-sig')).decode(),**extra)

    def test_empty_production_and_demo_separation(self):
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM clients').fetchone()[0],1)
        demo=server.Application(self.root/'demo',True)
        c=db.connect(demo.db_path)
        try:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM clients').fetchone()[0],0)
            self.assertEqual(c.execute('SELECT COUNT(*) FROM users').fetchone()[0],3)
        finally:c.close()
        with self.assertRaises(RuntimeError):server.Application(self.root/'demo',False)

    def test_stale_edit_and_recycle(self):
        changed=self.call('PATCH',f"/api/clients/{self.client['id']}",{'version':1,'note':'记录'})
        self.assertEqual(changed['version'],2)
        with self.assertRaises(db.ApiError) as e:self.call('PATCH',f"/api/clients/{self.client['id']}",{'version':1,'note':'旧版本'})
        self.assertEqual(e.exception.status,409)
        deleted=self.call('DELETE',f"/api/clients/{self.client['id']}",{'version':2})
        restored=self.call('POST',f"/api/clients/{self.client['id']}/restore",{'version':deleted['version']})
        self.assertEqual(restored['deleted'],0)

    def test_period_receivable_and_reversal_audit(self):
        contract=self.call('POST','/api/contracts',dict(client_id=self.client['id'],service='代理记账',start_period='2026-01',end_period='2026-12',monthly_fee_fen=10000))
        receipt=self.call('POST','/api/receipts',dict(contract_id=contract['id'],date='2026-02-10',amount_fen=50000,method='银行'))
        january=business.contract_stats(self.conn,contract,'2026-01');march=business.contract_stats(self.conn,contract,'2026-03')
        self.assertEqual(january['due_fen'],10000);self.assertEqual(january['received_fen'],0)
        self.assertEqual(march['due_fen'],30000);self.assertEqual(march['prepaid_fen'],20000)
        self.call('POST',f"/api/receipts/{receipt['id']}/reverse",{'version':1,'date':'2026-03-10','note':'登记错误'})
        after=business.contract_stats(self.conn,contract,'2026-03')
        self.assertEqual(after['received_fen'],0);self.assertEqual(after['debt_fen'],30000)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM audit_logs WHERE action='reverse'").fetchone()[0],1)
        with self.assertRaises(db.ApiError):self.call('POST',f"/api/receipts/{receipt['id']}/reverse",{'version':2,'date':'2026-03-10','note':'再冲销'})

    def test_invoice_post_once_and_period_stats(self):
        invoice=self.call('POST','/api/invoices',dict(client_id=self.client['id'],period='2026-02',kind='expense',number='SYN001',date='2026-02-10',amount_fen=10000,tax_fen=0,total_fen=10000))
        posted=self.call('POST',f"/api/invoices/{invoice['id']}/post",{'version':1,'debit_account':'5602','credit_account':'1002'})
        self.assertEqual(posted['status'],'posted')
        with self.assertRaises(db.ApiError):self.call('POST',f"/api/invoices/{invoice['id']}/post",{'version':2,'debit_account':'5602','credit_account':'1002'})
        b=business.bootstrap(self.conn,'2026-02',False)
        self.assertEqual(b['book_periods'][0]['voucher_count'],1)
        with self.assertRaises(db.ApiError):self.call('DELETE',f"/api/invoices/{invoice['id']}",{'version':2})

    def test_atomic_client_import_and_formula_safe_export(self):
        row=dict(name='=unsafe',code='IMPORT001',taxpayer_type='small',standard='small2013',industry='',region='',start_period='2026-01',accountant_id='',labels='合成',note='')
        bad={**row,'code':'IMPORT002','start_period':'wrong'}
        with self.assertRaises(db.ApiError):business.import_csv(self.conn,'clients',self.csv_payload('clients',[row,bad]),self.user)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM clients').fetchone()[0],1)
        result=business.import_csv(self.conn,'clients',self.csv_payload('clients',[row]),self.user)
        self.assertEqual(result['imported'],1)
        self.assertIn("'=unsafe",business.export_csv(self.conn,'clients',{}).decode('utf-8-sig'))

    def test_bank_import_rolls_back_finance_validation(self):
        first=dict(date='2026-02-10',summary='合成流水一',bank_account='1002',counter_account='5001',direction='income',amount='10.00')
        second={**first,'summary':'合成流水二','counter_account':'99999'}
        with self.assertRaises(db.ApiError):business.import_csv(self.conn,'bank',self.csv_payload('bank',[first,second],client_id=self.client['id']),self.user)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM journals').fetchone()[0],0)

    def test_tax_evidence_and_step_executor(self):
        p=dict(client_id=self.client['id'],period='2026-01',tax_type='增值税',status='submitted')
        with self.assertRaises(db.ApiError):self.call('POST','/api/tax-records',p)
        record=self.call('POST','/api/tax-records',{**p,'reference':'MANUAL001'})
        self.assertEqual(record['source'],'manual')
        project=self.call('POST','/api/projects',dict(client_id=self.client['id'],name='合成工商事项',due_date='2026-02-01',steps=[{'title':'收集资料','done':True,'completed_by':999,'completed_at':'fake'}]))
        self.assertEqual(project['steps'][0]['completed_by'],self.user['id'])
        self.assertNotEqual(project['steps'][0]['completed_at'],'fake')

    def test_backup_restore_and_password_hash(self):
        original=self.app.create_backup(self.conn)
        target=self.root/'backup.zip';target.write_bytes(original)
        with zipfile.ZipFile(target) as z:self.assertEqual(json.loads(z.read('manifest.json'))['format'],'yidaizhang-local-v1')
        self.conn.close()
        maintenance.restore(self.root/'restored',target)
        self.conn=db.connect(self.app.db_path)
        restored=db.connect(self.root/'restored'/'app.sqlite3')
        try:self.assertEqual(restored.execute('SELECT COUNT(*) FROM clients').fetchone()[0],1)
        finally:restored.close()
        stored=server.password_hash('StrongTest123!')
        self.assertTrue(server.password_verify('StrongTest123!',stored));self.assertFalse(server.password_verify('wrong',stored))

    def test_disabled_and_recycled_client_reject_business_writes(self):
        invoice=self.call('POST','/api/invoices',dict(client_id=self.client['id'],period='2026-02',kind='expense',number='FROZEN01',date='2026-02-10',amount_fen=100,tax_fen=0,total_fen=100))
        changed=self.call('PATCH',f"/api/clients/{self.client['id']}",{'version':1,'enabled':False})
        with self.assertRaises(db.ApiError):self.call('POST','/api/notes',{'client_id':self.client['id'],'text':'应拒绝'})
        with self.assertRaises(db.ApiError):self.call('DELETE',f"/api/invoices/{invoice['id']}",{'version':1})
        with self.assertRaises(db.ApiError):self.call('POST','/api/contracts',dict(client_id=self.client['id'],service='代理记账',start_period='2026-01',end_period='2026-12',monthly_fee_fen=10000))
        enabled=self.call('PATCH',f"/api/clients/{self.client['id']}",{'version':changed['version'],'enabled':True})
        self.call('DELETE',f"/api/clients/{self.client['id']}",{'version':enabled['version']})
        with self.assertRaises(db.ApiError):self.call('PATCH',f"/api/invoices/{invoice['id']}",{'version':1,'summary':'应拒绝'})
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM invoices').fetchone()[0],1)

    def test_paid_contract_terms_frozen_and_termination_history(self):
        today=business.dt.date.today();year=today.year;pd=today.strftime('%Y-%m')
        contract=self.call('POST','/api/contracts',dict(client_id=self.client['id'],service='代理记账',start_period=f'{year}-01',end_period=f'{year+1}-12',monthly_fee_fen=10000))
        self.call('POST','/api/receipts',dict(contract_id=contract['id'],date=today.isoformat(),amount_fen=10000,method='银行'))
        with self.assertRaises(db.ApiError):self.call('PATCH',f"/api/contracts/{contract['id']}",{'version':1,'end_period':f'{year}-01'})
        with self.assertRaises(db.ApiError):self.call('PATCH',f"/api/contracts/{contract['id']}",{'version':1,'monthly_fee_fen':99999})
        before=business.contract_stats(self.conn,contract,pd)
        stopped=self.call('PATCH',f"/api/contracts/{contract['id']}",{'version':1,'status':'terminated'})
        after=business.contract_stats(self.conn,stopped,pd)
        self.assertEqual(stopped['end_period'],pd);self.assertEqual(before['due_fen'],after['due_fen'])
        record=self.conn.execute("SELECT detail FROM audit_logs WHERE entity='contracts' AND action='update' ORDER BY id DESC LIMIT 1").fetchone()
        detail=json.loads(record['detail']);self.assertEqual(detail['before']['end_period'],f'{year+1}-12');self.assertEqual(detail['after']['end_period'],pd)
        with self.assertRaises(db.ApiError):self.call('PATCH',f"/api/contracts/{contract['id']}",{'version':2,'status':'active'})

    def test_process_lock_only_recovers_proven_dead_pid(self):
        marker=server.acquire_process_lock(self.root)
        self.assertTrue(server.process_alive(os.getpid()))
        with self.assertRaises(RuntimeError):server.acquire_process_lock(self.root)
        ended=subprocess.run([sys.executable,'-c','import os; print(os.getpid())'],capture_output=True,text=True,check=True)
        ended_pid=int(ended.stdout.strip());self.assertFalse(server.process_alive(ended_pid))
        marker.write_text(str(ended_pid),encoding='utf-8')
        recovered=server.acquire_process_lock(self.root)
        self.assertEqual(int(recovered.read_text()),os.getpid())
        recovered.unlink()

    def test_tax_agents_version_crud_and_global_labels(self):
        contact=self.call('POST','/api/tax-agents',{'name':'合成办税联系人','phone':'13800000001','role':'办税人','client_id':None})
        self.assertIsNone(contact['client_id'])
        changed=self.call('PATCH',f"/api/tax-agents/{contact['id']}",{'version':1,'client_id':self.client['id'],'note':'关联客户'})
        with self.assertRaises(db.ApiError):self.call('PATCH',f"/api/tax-agents/{contact['id']}",{'version':1,'name':'旧版'})
        self.call('DELETE',f"/api/tax-agents/{contact['id']}",{'version':changed['version']})
        self.assertEqual(business.bootstrap(self.conn,'2026-01',False)['tax_agents'],[])
        result=self.call('POST','/api/settings',{'version':1,'labels':['重点客户','资料待补']})
        self.assertEqual(result['labels'],['重点客户','资料待补'])
        with self.assertRaises(db.ApiError):self.call('POST','/api/settings',{'version':result['version'],'labels':['重复','重复']})
        self.assertEqual(business.settings(self.conn)['version'],result['version'])

    def test_invoice_request_is_local_draft_not_tax_invoice(self):
        request=self.call('POST','/api/invoice-requests',{'client_id':self.client['id'],'buyer_name':'合成购方','content':'服务费','amount_fen':10000,'tax_fen':300})
        self.assertEqual(request['status'],'draft')
        ready=self.call('PATCH',f"/api/invoice-requests/{request['id']}",{'version':1,'status':'ready'})
        listed=business.bootstrap(self.conn,'2026-01',False)['invoice_requests'][0]
        self.assertFalse(listed['valid_invoice']);self.assertNotIn('number',listed)
        cancelled=self.call('PATCH',f"/api/invoice-requests/{request['id']}",{'version':ready['version'],'status':'cancelled'})
        with self.assertRaises(db.ApiError):self.call('PATCH',f"/api/invoice-requests/{request['id']}",{'version':cancelled['version'],'status':'ready'})
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM invoices').fetchone()[0],0)

    def test_terminate_prepaid_future_contract_never_creates_future_due(self):
        today=business.dt.date.today();future=f'{today.year+1}-01'
        contract=self.call('POST','/api/contracts',dict(client_id=self.client['id'],service='未来服务',start_period=future,end_period=f'{today.year+1}-12',monthly_fee_fen=10000))
        self.call('POST','/api/receipts',dict(contract_id=contract['id'],date=today.isoformat(),amount_fen=10000,method='预收'))
        cancelled=self.call('PATCH',f"/api/contracts/{contract['id']}",{'version':1,'status':'terminated'})
        self.assertLess(cancelled['termination_period'],future)
        future_stats=business.contract_stats(self.conn,cancelled,f'{today.year+1}-12')
        self.assertEqual(future_stats['due_fen'],0);self.assertEqual(future_stats['prepaid_fen'],10000)

    def test_demo_seed_current_books_have_real_linked_business(self):
        import datetime
        import seed
        demo=server.Application(self.root/'rich-demo',True)
        conn=db.connect(demo.db_path)
        try:
            with conn:seed.seed(conn,dict(conn.execute('SELECT id,username,name FROM users ORDER BY id LIMIT 1').fetchone()))
            period=datetime.date.today().strftime('%Y-%m')
            all_vouchers=[]
            for cid in (1,2,3):
                book=finance.bundle(conn,cid,period)
                self.assertGreaterEqual(len(book['vouchers']),2)
                self.assertTrue(book['reports']['balance_sheet']['balanced'])
                self.assertTrue(all(v['status']=='active' and '合成演示' in v['summary'] for v in book['vouchers']))
                all_vouchers.extend(book['vouchers'])
            self.assertTrue(any(v['reviewed'] for v in all_vouchers))
            self.assertTrue(any(not v['reviewed'] for v in all_vouchers))
            first=finance.bundle(conn,1,period);second=finance.bundle(conn,2,period)
            self.assertEqual(len(first['assets']),1)
            self.assertEqual(len(first['inventory_movements']),2)
            self.assertEqual(first['inventory_items'][0]['quantity'],'7')
            self.assertEqual(first['inventory_items'][0]['value_fen'],140000)
            self.assertEqual(len(second['payroll']),1)
            self.assertIsNotNone(second['payroll'][0]['voucher_id'])
            self.assertEqual(second['payroll'][0]['net_fen'],708000)
            self.assertFalse(any(p['closed'] for p in first['periods'] if p['period']==period))
            expected=min(datetime.date.today().month-1,2)
            self.assertEqual(sum(bool(p['closed']) for p in first['periods']),expected)
            before=conn.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0]
            seed.seed(conn,self.user)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0],before)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM clients').fetchone()[0],200)
        finally:conn.close()


if __name__=='__main__':unittest.main()
