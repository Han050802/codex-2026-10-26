import datetime
import os
import sqlite3
import tempfile
import threading
import unittest

import db
import finance
import business


class FinanceTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.path=os.path.join(self.tmp.name,'test.sqlite3')
        db.initialize(self.path)
        self.conn=db.connect(self.path)
        with self.conn:
            self.conn.execute("INSERT INTO users(id,username,name,password_hash) VALUES(1,'tester','测试员','unused')")
            for cid,std in [(1,'small2013'),(2,'enterprise2007')]:
                self.conn.execute("INSERT INTO clients(id,name,code,taxpayer_type,standard,start_period,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",(cid,f'合成企业{cid}',f'T{cid}','general',std,'2026-01',db.now(),db.now()))
                finance.ensure_book(self.conn,dict(self.conn.execute('SELECT * FROM clients WHERE id=?',(cid,)).fetchone()))
        self.user={'id':1,'username':'tester','name':'测试员'}

    def tearDown(self):
        self.conn.close(); self.tmp.cleanup()

    def call(self,route='',payload=None,method='POST',cid=1,period='2026-01'):
        return finance.handle(self.conn,method,f'/api/books/{cid}'+('/'+route if route else ''),payload or {},self.user,{'period':period})

    def voucher(self,value=10000,cid=1,date='2026-01-10',debit='1002',credit=None,category='operating'):
        credit=credit or ('5001' if cid==1 else '6001')
        return self.call('vouchers',{'date':date,'summary':'合成销售收入','lines':[{'account_code':debit,'debit_fen':value,'credit_fen':0,'cashflow_category':category},{'account_code':credit,'debit_fen':0,'credit_fen':value}]},cid=cid)

    def review_all(self,cid=1,period='2026-01'):
        for v in self.call(method='GET',cid=cid,period=period)['vouchers']:
            if v['status']=='active' and not v['reviewed']:
                self.call(f'vouchers/{v["id"]}/review',{'version':v['version'],'reviewed':True},cid=cid)

    def assertError(self,status,func,*args,**kwargs):
        with self.assertRaises(db.ApiError) as got: func(*args,**kwargs)
        self.assertEqual(status,got.exception.status,got.exception.message)
        return got.exception

    def test_subject_list_migration_is_scoped_idempotent_and_blocks_prior_adjustment_posting(self):
        with self.conn:
            self.conn.execute("DELETE FROM accounts WHERE client_id=1 AND code IN ('1133','5901')")
            self.conn.execute("UPDATE accounts SET name='营业税金及附加' WHERE client_id=1 AND code='5403'")
        before_other=[tuple(r) for r in self.conn.execute('SELECT * FROM accounts WHERE client_id=2 ORDER BY code')]
        with self.conn:
            result=finance.apply_subject_list_to_book(self.conn,1,'合成企业1',self.user)
        self.assertEqual(['1133','5901','5403'],result['changed_codes'])
        rows={r['code']:dict(r) for r in self.conn.execute('SELECT * FROM accounts WHERE client_id=1')}
        self.assertEqual(68,len(rows))
        self.assertEqual(('应收出口退税款','debit','asset','receivable'),tuple(rows['1133'][k] for k in ('name','direction','category','report_key')))
        self.assertEqual(('以前年度损益调整','debit','expense','prior_adjustment'),tuple(rows['5901'][k] for k in ('name','direction','category','report_key')))
        self.assertEqual('税金及附加',rows['5403']['name'])
        self.assertEqual(before_other,[tuple(r) for r in self.conn.execute('SELECT * FROM accounts WHERE client_id=2 ORDER BY code')])
        with self.conn:
            self.assertEqual([],finance.apply_subject_list_to_book(self.conn,1,'合成企业1',self.user)['changed_codes'])
        self.assertEqual(1,self.conn.execute("SELECT COUNT(*) FROM audit_logs WHERE action='apply_subject_list'").fetchone()[0])
        error=self.assertError(409,self.voucher,debit='5901')
        self.assertIn('暂不支持记账',error.message)
        self.assertEqual(0,self.conn.execute('SELECT COUNT(*) FROM vouchers WHERE client_id=1').fetchone()[0])
        self.voucher(debit='1133')

    def test_subject_list_migration_refuses_wrong_or_customized_book_without_changes(self):
        before=[tuple(r) for r in self.conn.execute('SELECT * FROM accounts WHERE client_id=1 ORDER BY code')]
        self.assertError(409,finance.apply_subject_list_to_book,self.conn,1,'其他公司',self.user)
        self.assertError(409,finance.apply_subject_list_to_book,self.conn,2,'合成企业2',self.user)
        with self.conn:
            self.conn.execute("UPDATE accounts SET name='自定义名称' WHERE client_id=1 AND code='5403'")
        custom=[tuple(r) for r in self.conn.execute('SELECT * FROM accounts WHERE client_id=1 ORDER BY code')]
        self.assertError(409,finance.apply_subject_list_to_book,self.conn,1,'合成企业1',self.user)
        self.assertEqual(custom,[tuple(r) for r in self.conn.execute('SELECT * FROM accounts WHERE client_id=1 ORDER BY code')])
        self.assertNotEqual(before,custom)

    def test_small_template_reconciliation_preserves_existing_and_is_idempotent(self):
        self.voucher()
        with self.conn:
            self.conn.execute("DELETE FROM accounts WHERE client_id=1 AND code IN ('1133','5901')")
            self.conn.execute("UPDATE accounts SET name='自定义税金' WHERE client_id=1 AND code='5403'")
            self.conn.execute("INSERT INTO accounts(client_id,code,name,direction,category,report_key) VALUES(1,'100201','基本户','debit','asset','cash')")
        before_vouchers=[tuple(row) for row in self.conn.execute('SELECT * FROM vouchers ORDER BY id')]
        before_lines=[tuple(row) for row in self.conn.execute('SELECT * FROM voucher_lines ORDER BY id')]
        preview=finance.reconcile_small_subject_template(self.conn,1)
        self.assertEqual(['1133','5901'],preview['added_codes'])
        self.assertEqual(['5403'],[x['code'] for x in preview['conflicts']])
        self.assertEqual(0,self.conn.execute("SELECT COUNT(*) FROM accounts WHERE client_id=1 AND code='1133'").fetchone()[0])
        with self.conn:
            result=finance.reconcile_small_subject_template(self.conn,1,True,self.user)
        self.assertEqual(preview['added_codes'],result['added_codes'])
        self.assertEqual('自定义税金',self.conn.execute("SELECT name FROM accounts WHERE client_id=1 AND code='5403'").fetchone()[0])
        self.assertEqual(1,self.conn.execute("SELECT COUNT(*) FROM accounts WHERE client_id=1 AND code='100201'").fetchone()[0])
        self.assertEqual(before_vouchers,[tuple(row) for row in self.conn.execute('SELECT * FROM vouchers ORDER BY id')])
        self.assertEqual(before_lines,[tuple(row) for row in self.conn.execute('SELECT * FROM voucher_lines ORDER BY id')])
        with self.conn:
            self.assertEqual([],finance.reconcile_small_subject_template(self.conn,1,True,self.user)['added_codes'])
        self.assertEqual(1,self.conn.execute("SELECT COUNT(*) FROM audit_logs WHERE action='reconcile_small_subject_template'").fetchone()[0])
        self.assertError(409,finance.reconcile_small_subject_template,self.conn,2)

    def test_small_template_reconciliation_reports_incompatible_descendant(self):
        with self.conn:
            self.conn.execute("DELETE FROM accounts WHERE client_id=1 AND code='1133'")
            self.conn.execute("INSERT INTO accounts(client_id,code,name,direction,category,report_key) VALUES(1,'113301','自定义明细','credit','liability','payable')")
        result=finance.reconcile_small_subject_template(self.conn,1)
        self.assertNotIn('1133',result['added_codes'])
        self.assertIn('1133',[x['code'] for x in result['conflicts']])

    def test_voucher_line_summaries_and_attachment_counts_persist_with_versions(self):
        payload={'date':'2026-01-12','summary':'凭证总摘要','attachment_count':3,
                 'lines':[dict(finance._entry('5602',78460),summary='通讯费'),finance._entry('2202',credit=78460)]}
        created=self.call('vouchers',payload)
        self.assertEqual('测试员',created['created_by_name'])
        self.assertEqual(3,created['attachment_count'])
        self.assertEqual(['通讯费','凭证总摘要'],[r['summary'] for r in created['lines']])
        reopened=db.connect(self.path)
        try:
            stored=finance._voucher(reopened,1,created['id'])
            self.assertEqual(3,stored['attachment_count'])
            self.assertEqual('通讯费',stored['lines'][0]['summary'])
        finally: reopened.close()
        changed=dict(payload,version=created['version'],attachment_count=5)
        changed['lines']=[dict(finance._entry('5602',78460),summary='更新后的逐行摘要'),finance._entry('2202',credit=78460)]
        updated=self.call(f'vouchers/{created["id"]}',changed,method='PATCH')
        self.assertEqual(2,updated['version']); self.assertEqual(5,updated['attachment_count'])
        self.assertError(409,self.call,f'vouchers/{created["id"]}',changed,method='PATCH')
        for invalid in (True,-1,10000,'3',1.5):
            self.assertError(400,self.call,'vouchers',dict(payload,attachment_count=invalid))
        bad=dict(payload,lines=[dict(finance._entry('5602',78460),summary='长'*201),finance._entry('2202',credit=78460)])
        self.assertError(400,self.call,'vouchers',bad)
        self.assertEqual(1,self.conn.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0])
        self.assertEqual('更新后的逐行摘要',self.call(method='GET')['ledger'][0]['summary'])
        self.assertEqual('更新后的逐行摘要',finance.export_rows(self.conn,1,'vouchers','2026-01')[1][0][2])

    def test_additive_voucher_metadata_migration_preserves_legacy_rows(self):
        created=self.voucher(12345)
        line_ids=[r['id'] for r in created['lines']]
        with self.conn:
            self.conn.execute('ALTER TABLE vouchers DROP COLUMN attachment_count')
            self.conn.execute('ALTER TABLE voucher_lines DROP COLUMN summary')
        finance.init_schema(self.conn); self.conn.commit()
        finance.init_schema(self.conn); self.conn.commit()
        migrated=finance._voucher(self.conn,1,created['id'])
        self.assertEqual(0,migrated['attachment_count'])
        self.assertEqual(line_ids,[r['id'] for r in migrated['lines']])
        self.assertEqual(12345,migrated['lines'][0]['debit_fen'])
        self.assertEqual('合成销售收入',self.call(method='GET')['ledger'][0]['summary'])
        self.assertEqual([],list(self.conn.execute('PRAGMA foreign_key_check')))

    def test_balance_range_rollups_ytd_and_totals_do_not_double_count(self):
        for code,name in [('100201','一级明细'),('10020101','二级明细'),('100202','另一明细')]:
            self.call('accounts',{'code':code,'name':name,'category':'asset','direction':'debit'})
        self.call('opening',{'version':1,'balances':[finance._entry('10020101',10000),finance._entry('3001',credit=10000)]})
        self.voucher(1111,debit='10020101')
        self.voucher(222,date='2026-02-10',debit='5602',credit='10020101')
        self.voucher(333,date='2026-03-10',debit='10020101')
        self.voucher(444,date='2027-01-10',debit='10020101')
        void=self.voucher(9000,date='2026-02-11',debit='10020101')
        self.call(f'vouchers/{void["id"]}',{'version':1},method='DELETE')
        def balance(start,end,cid=1):
            return finance.handle(self.conn,'GET',f'/api/books/{cid}/balance',{},self.user,{'start':start,'end':end})
        result=balance('2026-02','2026-03')
        raw={r['account_code']:r for r in result['trial_balance']}
        rows={r['account_code']:r for r in result['trial_balance_rollup']}
        self.assertEqual(0,raw['1002']['closing_debit_fen'])
        self.assertEqual(11111,rows['1002']['opening_debit_fen'])
        self.assertEqual((333,222,11222),(rows['1002']['debit_fen'],rows['1002']['credit_fen'],rows['1002']['closing_debit_fen']))
        self.assertEqual((1444,222),(rows['1002']['ytd_debit_fen'],rows['1002']['ytd_credit_fen']))
        self.assertEqual(('100201',3,True),(rows['10020101']['parent_code'],rows['10020101']['level'],rows['10020101']['is_leaf']))
        self.assertEqual(555,result['totals']['debit_fen'])
        self.assertEqual(555,result['totals']['credit_fen'])
        self.assertEqual(4,len(result['ledger']))
        self.assertEqual(11222,[r['balance_fen'] for r in result['ledger'] if r['account_code']=='10020101'][-1])
        cross=balance('2026-03','2027-01')
        bank=next(r for r in cross['trial_balance_rollup'] if r['account_code']=='1002')
        self.assertEqual(777,bank['debit_fen']);self.assertEqual(444,bank['ytd_debit_fen'])
        self.assertTrue(all(r['debit_fen']==0 for r in balance('2026-02','2026-03',2)['trial_balance']))
        self.assertError(400,balance,'2026-03','2026-02')
        self.assertError(400,balance,'2025-12','2026-02')
        book=self.call(method='GET',period='2026-03')
        self.assertEqual(11222,next(r for r in book['trial_balance_rollup'] if r['account_code']=='1002')['closing_debit_fen'])
        self.assertTrue(book['reports']['balance_sheet']['balanced'])

    def test_company_book_and_balance_reject_periods_before_opening_month(self):
        with self.conn:
            self.conn.execute("UPDATE clients SET start_period='2026-09' WHERE id=1")
        self.call('opening',{'version':1,'balances':[finance._entry('1002',10000),finance._entry('3001',credit=10000)]})
        for period in ('2025-12','2026-08'):
            with self.subTest(period=period):
                self.assertError(400,self.call,method='GET',period=period)
                self.assertError(400,finance.handle,self.conn,'GET','/api/books/1/balance',{},self.user,{'start':period,'end':'2026-09'})
        book=self.call(method='GET',period='2026-09')
        self.assertEqual(10000,book['dashboard']['funds']['bank_fen'])
        self.assertEqual(0,book['dashboard']['voucher_count'])
        balance=finance.handle(self.conn,'GET','/api/books/1/balance',{},self.user,{'start':'2026-09','end':'2026-09'})
        bank=next(r for r in balance['trial_balance'] if r['account_code']=='1002')
        self.assertEqual((10000,0,0,10000),(bank['opening_debit_fen'],bank['debit_fen'],bank['credit_fen'],bank['closing_debit_fen']))
        self.assertEqual(2,len(book['opening_balances']))

    def test_company_dashboard_uses_current_real_records_and_leaf_balances(self):
        for code,name,category,direction in [('112201','往来明细','asset','debit'),('220201','应付明细','liability','credit')]:
            self.call('accounts',{'code':code,'name':name,'category':category,'direction':direction})
        payload={'date':'2026-01-10','summary':'真实账务统计测试','attachment_count':2,
                 'lines':[finance._entry('112201',1000),finance._entry('5001',credit=1000)]}
        self.call('vouchers',payload)
        self.call('vouchers',dict(payload,attachment_count=4,lines=[finance._entry('5602',2000),finance._entry('220201',credit=2000)]))
        void=self.call('vouchers',dict(payload,attachment_count=9))
        self.call(f'vouchers/{void["id"]}',{'version':1},method='DELETE')
        self.voucher(3000,date='2026-02-10')
        with self.conn:
            for cid,p,kind,number,total,tax in [(1,'2026-01','input','IN',1100,100),(1,'2026-01','output','OUT',2400,400),(1,'2026-02','output','LATER',9900,900),(2,'2026-01','input','OTHER',5500,500)]:
                self.conn.execute('INSERT INTO invoices(client_id,period,kind,number,date,amount_fen,tax_fen,total_fen,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',(cid,p,kind,number,p+'-01',total-tax,tax,total,db.now(),db.now()))
        dashboard=self.call(method='GET')['dashboard']
        self.assertEqual((2,6),(dashboard['voucher_count'],dashboard['attachment_count']))
        self.assertEqual({'count':1,'total_fen':1100,'tax_fen':100},dashboard['invoices']['input'])
        self.assertEqual(2400,dashboard['invoices']['output']['total_fen'])
        self.assertEqual((1000,2000),(dashboard['funds']['receivable_fen'],dashboard['funds']['payable_fen']))
        self.assertEqual((1,1),(dashboard['funds']['receivable_account_count'],dashboard['funds']['payable_account_count']))
        self.assertEqual(0,dashboard['funds']['bank_fen'])
        self.assertEqual(0,self.call(method='GET',cid=2)['dashboard']['voucher_count'])

    def test_standard_templates_are_distinct_and_isolated(self):
        s={x['code']:x for x in self.call(method='GET')['accounts']}
        e={x['code']:x for x in self.call(method='GET',cid=2)['accounts']}
        self.assertEqual(68,len(s))
        self.assertEqual('生产成本',s['4001']['name'])
        self.assertEqual('实收资本',e['4001']['name'])
        self.assertEqual('主营业务收入',s['5001']['name'])
        self.assertEqual('生产成本',e['5001']['name'])
        self.assertNotIn('1231',s)
        self.assertEqual('坏账准备',e['1231']['name'])
        self.assertEqual('短期投资',s['1101']['name'])
        self.assertEqual('交易性金融资产',e['1101']['name'])
        self.voucher(30000)
        self.assertEqual([],self.call(method='GET',cid=2)['vouchers'])

    def test_new_client_without_standard_defaults_to_small_template(self):
        data=business.client_data(self.conn,{'name':'默认制度公司','code':'DEFAULT-STD','start_period':'2026-01'})
        self.assertEqual('small2013',data['standard'])
        rows=finance._template(data['standard'])
        self.assertEqual(68,len(rows))
        self.assertIn('1133',{row[0] for row in rows})
        self.assertIn('5901',{row[0] for row in rows})

    def test_money_validation_and_balanced_transaction(self):
        for invalid in (True,1.2,'100',-1):
            self.assertError(400,self.voucher,invalid)
        bad={'date':'2026-01-20','summary':'不平衡','lines':[finance._entry('1002',100),finance._entry('5001',credit=99)]}
        self.assertError(400,self.call,'vouchers',bad)
        self.assertEqual(0,self.conn.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0])
        self.assertEqual(0,self.conn.execute('SELECT COUNT(*) FROM audit_logs').fetchone()[0])
        self.voucher(12345)
        b=self.call(method='GET')
        self.assertEqual(12345,b['reports']['profit_loss']['profit_fen'])
        self.assertTrue(b['reports']['balance_sheet']['balanced'])
        self.assertEqual(12345,b['reports']['balance_sheet']['assets_fen'])
        self.assertEqual(0,sum(x['closing_debit_fen']-x['closing_credit_fen'] for x in b['trial_balance']))
        self.assertEqual(12345,b['reports']['cash_flow']['net_fen'])

    def test_opening_balance_atomic_version_and_lock(self):
        self.assertError(400,self.call,'opening',{'version':1,'balances':[finance._entry('1002',1000),finance._entry('3001',credit=999)]})
        self.assertEqual([],self.call(method='GET')['opening_balances'])
        result=self.call('opening',{'version':1,'balances':[finance._entry('1002',1000),finance._entry('3001',credit=1000)]})
        self.assertEqual(2,result['version'])
        self.assertError(409,self.call,'opening',{'version':1,'balances':[]})
        b=self.call(method='GET')
        self.assertEqual(1000,b['reports']['balance_sheet']['assets_fen'])
        self.voucher()
        self.assertError(409,self.call,'opening',{'version':2,'balances':[]})

    def test_review_optimistic_versions_void_and_report_recalculation(self):
        v=self.voucher(900)
        self.assertError(409,self.call,f'vouchers/{v["id"]}/review',{'version':99,'reviewed':True})
        reviewed=self.call(f'vouchers/{v["id"]}/review',{'version':v['version'],'reviewed':True})
        self.assertError(409,self.call,f'vouchers/{v["id"]}',{'version':reviewed['version']},method='DELETE')
        unreview=self.call(f'vouchers/{v["id"]}/review',{'version':reviewed['version'],'reviewed':False})
        self.call(f'vouchers/{v["id"]}',{'version':unreview['version']},method='DELETE')
        self.assertEqual(0,self.call(method='GET')['reports']['profit_loss']['profit_fen'])
        self.assertEqual(1,self.conn.execute("SELECT COUNT(*) FROM audit_logs WHERE action='void'").fetchone()[0])

    def test_cashflow_requires_explicit_classification(self):
        v=self.voucher(category='unclassified')
        b=self.call(method='GET')
        self.assertFalse(b['reports']['cash_flow']['complete'])
        self.assertEqual(1,b['reports']['cash_flow']['unclassified_count'])
        cashline=next(x for x in v['lines'] if x['account_code']=='1002')
        self.call(f'vouchers/{v["id"]}/cashflow',{'version':v['version'],'classifications':[{'line_id':cashline['id'],'category':'operating'}]})
        self.assertTrue(self.call(method='GET')['reports']['cash_flow']['complete'])
        self.assertError(400,self.voucher,category='transfer')

    def test_close_creates_real_carry_forward_and_latest_first_reopen(self):
        self.voucher(5000)
        self.call('vouchers',{'date':'2026-01-20','summary':'费用','lines':[finance._entry('5602',1200),finance._entry('1002',credit=1200,category='operating')]})
        self.assertError(409,self.call,'close',{'period':'2026-01'})
        self.review_all()
        result=self.call('close',{'period':'2026-01'})
        self.assertTrue(result['closing_voucher_id'])
        b=self.call(method='GET')
        self.assertEqual(3800,b['reports']['profit_loss']['profit_fen'])
        self.assertEqual(0,b['reports']['balance_sheet']['unclosed_profit_fen'])
        self.assertEqual(3800,next(x for x in b['trial_balance'] if x['account_code']=='3103')['closing_credit_fen'])
        self.assertError(409,self.voucher)
        self.assertError(409,self.call,'close',{'period':'2026-01'})
        self.call('close',{'period':'2026-02'})
        self.assertError(409,self.call,'reopen',{'period':'2026-01'})
        self.call('reopen',{'period':'2026-02'})
        self.call('reopen',{'period':'2026-01'})
        self.assertEqual(3800,self.call(method='GET')['reports']['balance_sheet']['unclosed_profit_fen'])
        self.call('close',{'period':'2026-01'})
        self.assertEqual(1,self.conn.execute("SELECT COUNT(*) FROM vouchers WHERE source_type='closing' AND status='active'").fetchone()[0])

    def test_sequential_close_and_enterprise_profit_account(self):
        self.assertError(409,self.call,'close',{'period':'2026-03'})
        self.voucher(7700,cid=2)
        self.review_all(cid=2)
        self.call('close',{'period':'2026-01'},cid=2)
        b=self.call(method='GET',cid=2)
        self.assertEqual(7700,next(x for x in b['trial_balance'] if x['account_code']=='4103')['closing_credit_fen'])

    def test_invoice_post_dedupe_caller_transaction(self):
        inv={'id':44,'client_id':1,'status':'unprocessed','date':'2026-01-22','number':'SYNTHETIC-44','kind':'output','amount_fen':10000,'tax_fen':600,'total_fen':10600,'summary':'合成发票'}
        with self.conn:
            vid=finance.create_invoice_voucher(self.conn,inv,{'debit_account':'1122','credit_account':'5001','tax_account':'2221'},self.user)
        self.assertEqual(3,len(finance._voucher(self.conn,1,vid)['lines']))
        with self.conn:
            self.assertError(409,finance.create_invoice_voucher,self.conn,inv,{'debit_account':'1122','credit_account':'5001','tax_account':'2221'},self.user)
        self.assertEqual(1,self.conn.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0])

    def test_fixed_asset_rounding_depreciation_idempotency_and_disposal(self):
        a=self.call('assets',{'name':'合成设备','purchase_date':'2026-01-01','start_period':'2026-02','cost_fen':10001,'residual_fen':1000,'life_months':3,'expense_account':'5602','counter_account':'2202'})
        self.assertError(409,self.call,'assets/depreciate',{'period':'2026-03'})
        first=self.call('assets/depreciate',{'period':'2026-02'})
        self.assertEqual(3000,first['results'][0]['amount_fen'])
        twice=self.call('assets/depreciate',{'period':'2026-02'})
        self.assertTrue(twice['results'][0]['already_posted'])
        self.call('assets/depreciate',{'period':'2026-03'})
        self.call('assets/depreciate',{'period':'2026-04'})
        self.assertEqual(9001,self.conn.execute('SELECT SUM(amount_fen) FROM asset_depreciations').fetchone()[0])
        card=self.call(method='GET',period='2026-04')['assets'][0]
        self.assertEqual(1000,card['net_fen'])
        self.call(f'assets/{a["id"]}/dispose',{'date':'2026-04-30','proceeds_fen':1500,'version':card['version']})
        self.assertEqual([],self.call('assets/depreciate',{'period':'2026-05'})['results'])
        b=self.call(method='GET',period='2026-04')
        self.assertEqual(-2501,b['reports']['profit_loss']['profit_fen'])
        self.assertTrue(b['reports']['balance_sheet']['balanced'])

    def test_inventory_weighted_average_no_negative_no_backdate_stale_and_reconcile(self):
        item=self.call('inventory/items',{'sku':'S1','name':'合成商品','unit':'件'})
        first=self.call('inventory/movements',{'item_id':item['id'],'date':'2026-01-02','direction':'in','quantity':'10','amount_fen':10000,'version':1})
        second=self.call('inventory/movements',{'item_id':item['id'],'date':'2026-01-03','direction':'in','quantity':'10','amount_fen':20000,'version':first['version']})
        self.assertError(409,self.call,'inventory/movements',{'item_id':item['id'],'date':'2026-01-04','direction':'out','quantity':'1','version':1})
        self.assertError(409,self.call,'inventory/movements',{'item_id':item['id'],'date':'2026-01-04','direction':'out','quantity':'21','version':second['version']})
        self.assertError(409,self.call,'inventory/movements',{'item_id':item['id'],'date':'2026-01-01','direction':'out','quantity':'1','version':second['version']})
        third=self.call('inventory/movements',{'item_id':item['id'],'date':'2026-01-04','direction':'out','quantity':'4.5','version':second['version']})
        self.assertEqual(6750,third['amount_fen'])
        self.assertEqual(23250,third['value_fen'])
        self.assertEqual('15.5',third['quantity'])
        b=self.call(method='GET'); self.assertFalse(any(x['code']=='inventory' for x in b['checks']))
        self.assertEqual(-6750,b['reports']['profit_loss']['profit_fen'])
        self.assertEqual(23250,b['inventory_items'][0]['value_fen'])

    def test_payroll_manual_tax_math_accrual_payment_and_duplicates(self):
        row=self.call('payroll',{'period':'2026-01','employee_name':'合成员工','gross_fen':100000,'withheld_tax_fen':1000,'social_fen':2000,'other_deduction_fen':300,'expense_account':'5602'})
        self.assertEqual(96700,row['net_fen'])
        self.assertError(400,self.call,'payroll',{'period':'2026-01','employee_name':'错误员工','gross_fen':100,'withheld_tax_fen':101,'expense_account':'5602'})
        posted=self.call('payroll/post',{'period':'2026-01'})
        self.assertEqual(posted['voucher_id'],self.call('payroll/post',{'period':'2026-01'})['voucher_id'])
        self.assertError(409,self.call,'payroll',{'period':'2026-01','employee_name':'新增员工','gross_fen':100,'expense_account':'5602'})
        self.call('payroll/pay',{'period':'2026-01','date':'2026-01-31'})
        self.assertError(409,self.call,'payroll/pay',{'period':'2026-01','date':'2026-01-31'})
        b=self.call(method='GET')
        wages=next(x for x in b['trial_balance'] if x['account_code']=='2211')
        self.assertEqual(0,wages['closing_credit_fen'])
        self.assertEqual(1000,next(x for x in b['trial_balance'] if x['account_code']=='2221')['closing_credit_fen'])
        self.assertEqual(2300,next(x for x in b['trial_balance'] if x['account_code']=='2241')['closing_credit_fen'])
        self.assertEqual(-100000,b['reports']['profit_loss']['profit_fen'])

    def test_bank_import_atomic_rejection_and_post(self):
        row={'date':'2026-01-15','summary':'合成收款','bank_account':'1002','counter_account':'1122','direction':'income','amount_fen':25000,'cashflow_category':'operating'}
        try:
            with self.conn:
                finance.create_bank_journal(self.conn,1,row,self.user)
                finance.create_bank_journal(self.conn,1,dict(row,summary='第二行',amount_fen=-10),self.user)
        except db.ApiError:
            pass
        self.assertEqual(0,self.conn.execute('SELECT COUNT(*) FROM journals').fetchone()[0])
        journal=self.call('journals',row)
        self.assertError(409,self.call,'journals',row)
        result=self.call(f'journals/{journal["id"]}/post',{'version':1})
        self.assertTrue(result['voucher_id'])
        self.assertError(409,self.call,f'journals/{journal["id"]}/post',{'version':1})
        self.assertEqual(result['voucher_id'],self.call(f'journals/{journal["id"]}/post',{'version':2})['voucher_id'])
        self.assertEqual(25000,self.call(method='GET')['reports']['cash_flow']['net_fen'])

    def test_automatic_child_account_numbering(self):
        first=self.call('accounts',{'parent_code':'1002','name':'账户一'})
        second=self.call('accounts',{'parent_code':'1002','name':'账户二','code':'9999','category':'expense','direction':'credit'})
        self.assertEqual(('100201','100202'),(first['code'],second['code']))
        self.assertEqual(('asset','debit',first['report_key']),(second['category'],second['direction'],second['report_key']))
        nested=self.call('accounts',{'parent_code':'100201','name':'下级'})
        self.assertEqual('10020101',nested['code'])
        self.call('accounts',{'code':'100205','name':'手工编码','category':'asset','direction':'debit'})
        self.assertEqual('100206',self.call('accounts',{'parent_code':'1002','name':'不补缺号'})['code'])
        self.assertEqual('100201',self.call('accounts',{'parent_code':'1002','name':'另一账套'},cid=2)['code'])
        self.assertError(400,self.call,'accounts',{'parent_code':'9999','name':'不存在'})
        self.call('accounts',{'code':'100299','name':'末号','category':'asset','direction':'debit'})
        self.assertError(409,self.call,'accounts',{'parent_code':'1002','name':'超出范围'})

    def test_automatic_numbering_reserves_legacy_branches(self):
        self.call('accounts',{'code':'10021','name':'旧式编码','category':'asset','direction':'debit'})
        self.assertEqual('100220',self.call('accounts',{'parent_code':'1002','name':'新编码'})['code'])

    def test_accounts_hierarchy_and_generated_voucher_immutability(self):
        a=self.call('accounts',{'code':'100201','name':'基本户','direction':'debit','category':'asset'})
        self.assertEqual('cash',a['report_key'])
        self.assertError(400,self.voucher)
        v=self.voucher(debit='100201')
        self.assertError(409,self.call,'accounts',{'code':'10020101','name':'下级','direction':'debit','category':'asset'})
        self.assertError(400,self.call,'vouchers',{'date':'2026-01-01','summary':'伪来源','source_type':'closing','lines':v['lines']})

    def test_exports_real_ledger_values_and_audit(self):
        self.voucher(12345)
        headers,rows=finance.export_rows(self.conn,1,'vouchers','2026-01')
        self.assertEqual(2,len(rows)); self.assertIn('123.45',rows[0])
        headers,rows=finance.export_rows(self.conn,1,'trial-balance','2026-01')
        self.assertEqual(68,len(rows))
        self.assertGreater(self.conn.execute('SELECT COUNT(*) FROM audit_logs').fetchone()[0],0)

    def withdraw(self,vid,version=None):
        v=finance._voucher(self.conn,1,vid)
        return self.call(f'vouchers/{vid}/withdraw',{'version':version or v['version'],'reason':'纠正合成测试数据'})

    def test_invoice_withdraw_restores_editable_source_and_can_repost(self):
        with self.conn:
            cur=self.conn.execute("INSERT INTO invoices(client_id,period,kind,number,date,summary,amount_fen,tax_fen,total_fen,created_at,updated_at) VALUES(1,'2026-01','output','WITHDRAW-1','2026-01-01','合成票据',10000,0,10000,?,?)",(db.now(),db.now()))
            inv=dict(self.conn.execute('SELECT * FROM invoices WHERE id=?',(cur.lastrowid,)).fetchone())
            vid=finance.create_invoice_voucher(self.conn,inv,{'debit_account':'1122','credit_account':'5001'},self.user)
            self.conn.execute("UPDATE invoices SET status='posted',voucher_id=? WHERE id=?",(vid,inv['id']))
        self.withdraw(vid)
        restored=dict(self.conn.execute('SELECT * FROM invoices WHERE id=?',(inv['id'],)).fetchone())
        self.assertEqual('unprocessed',restored['status']); self.assertIsNone(restored['voucher_id'])
        self.assertEqual(2,restored['version'])
        self.assertEqual(0,self.call(method='GET')['reports']['profit_loss']['profit_fen'])
        with self.conn:
            replacement=finance.create_invoice_voucher(self.conn,restored,{'debit_account':'1002','credit_account':'5001','cashflow_category':'operating'},self.user)
        self.assertNotEqual(vid,replacement)
        self.assertEqual(10000,self.call(method='GET')['reports']['profit_loss']['profit_fen'])

    def test_inventory_withdraw_latest_first_restores_exact_subledger(self):
        item=self.call('inventory/items',{'sku':'RETURN','name':'合成商品','unit':'件'})
        one=self.call('inventory/movements',{'item_id':item['id'],'date':'2026-01-01','direction':'in','quantity':'3','amount_fen':10000,'version':1})
        two=self.call('inventory/movements',{'item_id':item['id'],'date':'2026-01-02','direction':'out','quantity':'1','version':2})
        self.assertError(409,self.withdraw,one['voucher_id'])
        self.withdraw(two['voucher_id'])
        current=self.call(method='GET')['inventory_items'][0]
        self.assertEqual(10000,current['value_fen']); self.assertEqual('3',current['quantity'])
        self.withdraw(one['voucher_id'])
        current=self.call(method='GET')['inventory_items'][0]
        self.assertEqual(0,current['value_fen']); self.assertEqual('0',current['quantity'])
        self.assertEqual(2,self.conn.execute("SELECT COUNT(*) FROM inventory_movements WHERE status='void'").fetchone()[0])

    def test_payroll_withdraw_payment_before_accrual_and_bank_withdraw(self):
        self.call('payroll',{'period':'2026-01','employee_name':'合成员工','gross_fen':50000,'withheld_tax_fen':500,'expense_account':'5602'})
        accrued=self.call('payroll/post',{'period':'2026-01'})
        paid=self.call('payroll/pay',{'period':'2026-01','date':'2026-01-31'})
        self.assertError(409,self.withdraw,accrued['voucher_id'])
        self.withdraw(paid['voucher_id']); self.withdraw(accrued['voucher_id'])
        wages=self.call(method='GET')['payroll'][0]
        self.assertIsNone(wages['voucher_id']); self.assertIsNone(wages['payment_voucher_id'])
        self.call(f'payroll/{wages["id"]}',{'version':wages['version']},method='DELETE')
        self.assertEqual(0,self.call(method='GET')['reports']['profit_loss']['profit_fen'])
        j=self.call('journals',{'date':'2026-01-01','summary':'纠错银行','bank_account':'1002','counter_account':'1122','direction':'income','amount_fen':500})
        posted=self.call(f'journals/{j["id"]}/post',{'version':1}); self.withdraw(posted['voucher_id'])
        journal=self.call(method='GET')['journals'][0]
        self.assertIsNone(journal['voucher_id'])
        self.call(f'journals/{j["id"]}',{'version':journal['version']},method='DELETE')

    def test_asset_withdraw_dependency_and_zero_cent_schedule(self):
        a=self.call('assets',{'name':'低值合成资产','purchase_date':'2026-01-01','start_period':'2026-02','cost_fen':1,'residual_fen':0,'life_months':3,'expense_account':'5602','counter_account':'2202'})
        feb=self.call('assets/depreciate',{'period':'2026-02'})
        self.assertEqual(0,feb['results'][0]['amount_fen'])
        self.assertError(409,self.withdraw,a['voucher_id'])
        self.call('assets/depreciate',{'period':'2026-03'})
        april=self.call('assets/depreciate',{'period':'2026-04'})
        self.assertEqual(1,april['results'][0]['amount_fen'])
        card=self.call(method='GET',period='2026-04')['assets'][0]
        disposal=self.call(f'assets/{a["id"]}/dispose',{'date':'2026-04-30','proceeds_fen':0,'version':card['version']})
        self.assertEqual(0,self.call(method='GET',period='2026-04')['assets'][0]['net_fen'])
        self.assertError(409,self.withdraw,april['results'][0]['voucher_id'])
        self.withdraw(disposal['voucher_id']); self.withdraw(april['results'][0]['voucher_id'])
        for p in ('2026-03','2026-02'):
            card=self.call(method='GET',period=p)['assets'][0]
            self.call(f'assets/{a["id"]}/depreciations/{p}/withdraw',{'version':card['version'],'reason':'重设合成资产'})
        self.withdraw(a['voucher_id'])
        card=self.call(method='GET')['assets'][0]
        self.assertEqual('cancelled',card['status']); self.assertEqual(0,card['net_fen'])
        self.assertEqual([],self.call('assets/depreciate',{'period':'2026-05'})['results'])

    def test_withdraw_rejects_reviewed_closed_and_cross_client(self):
        j=self.call('journals',{'date':'2026-01-01','summary':'合成银行','bank_account':'1002','counter_account':'1122','direction':'income','amount_fen':500})
        posted=self.call(f'journals/{j["id"]}/post',{'version':1})
        reviewed=self.call(f'vouchers/{posted["voucher_id"]}/review',{'version':1,'reviewed':True})
        self.assertError(409,self.withdraw,posted['voucher_id'])
        self.assertError(404,self.call,f'vouchers/{posted["voucher_id"]}/withdraw',{'version':reviewed['version'],'reason':'跨账套'},cid=2)
        self.call('close',{'period':'2026-01'})
        self.assertError(409,self.call,f'vouchers/{posted["voucher_id"]}/review',{'version':reviewed['version'],'reviewed':False})

    def test_december_closes_annual_profit_into_retained_earnings(self):
        self.voucher(12345)
        self.review_all(); self.call('close',{'period':'2026-01'})
        for month in range(2,13): self.call('close',{'period':f'2026-{month:02d}'})
        dec=self.call(method='GET',period='2026-12')
        profit=next(x for x in dec['trial_balance'] if x['account_code']=='3103')
        retained=next(x for x in dec['trial_balance'] if x['account_code']=='3104')
        self.assertEqual(0,profit['closing_credit_fen'])
        self.assertEqual(12345,retained['closing_credit_fen'])
        self.assertEqual(12345,dec['reports']['profit_loss']['ytd_profit_fen'])
        self.call('reopen',{'period':'2026-12'})
        dec=self.call(method='GET',period='2026-12')
        self.assertEqual(12345,next(x for x in dec['trial_balance'] if x['account_code']=='3103')['closing_credit_fen'])

    def test_two_editors_cannot_both_commit_same_version(self):
        voucher=self.voucher(500)
        barrier=threading.Barrier(2); results=[]
        def worker():
            conn=db.connect(self.path)
            try:
                barrier.wait()
                finance.handle(conn,'POST',f'/api/books/1/vouchers/{voucher["id"]}/review',{'version':1,'reviewed':True},self.user,{})
                results.append('ok')
            except db.ApiError as exc: results.append(exc.status)
            finally: conn.close()
        threads=[threading.Thread(target=worker) for _ in range(2)]
        for thread in threads: thread.start()
        for thread in threads: thread.join(15)
        self.assertCountEqual(['ok',409],results)

    def test_delete_unused_custom_account_checks_children_history_and_presets(self):
        first=self.call('accounts',{'code':'100201','name':'未用合成账户','category':'asset','direction':'debit'})
        self.assertError(409,self.call,f'accounts/{first["id"]}',{'version':99},method='DELETE')
        child=self.call('accounts',{'code':'10020101','name':'未用下级','category':'asset','direction':'debit'})
        self.assertError(409,self.call,f'accounts/{first["id"]}',{'version':1},method='DELETE')
        self.call(f'accounts/{child["id"]}',{'version':1,'reason':'合成删除'},method='DELETE')
        self.call(f'accounts/{first["id"]}',{'version':1,'reason':'合成删除'},method='DELETE')
        self.assertIsNone(self.conn.execute('SELECT * FROM accounts WHERE id=?',(first['id'],)).fetchone())
        preset=self.conn.execute("SELECT id FROM accounts WHERE client_id=1 AND code='1002'").fetchone()[0]
        self.assertError(409,self.call,f'accounts/{preset}',{'version':1},method='DELETE')
        used=self.call('accounts',{'code':'100202','name':'历史账户','category':'asset','direction':'debit'})
        v=self.voucher(debit='100202')
        self.call(f'vouchers/{v["id"]}',{'version':1},method='DELETE')
        self.assertError(409,self.call,f'accounts/{used["id"]}',{'version':1},method='DELETE')
        self.assertEqual(2,self.conn.execute("SELECT COUNT(*) FROM audit_logs WHERE action='delete' AND entity='account'").fetchone()[0])

    def test_delete_account_with_unposted_source_reference_is_blocked(self):
        a=self.call('accounts',{'code':'560201','name':'合成费用','category':'expense','direction':'debit'})
        payroll=self.call('payroll',{'period':'2026-01','employee_name':'未计提合成人员','gross_fen':5000,'expense_account':a['code']})
        self.assertError(409,self.call,f'accounts/{a["id"]}',{'version':1},method='DELETE')
        self.call(f'payroll/{payroll["id"]}',{'version':1},method='DELETE')
        self.call(f'accounts/{a["id"]}',{'version':1},method='DELETE')

    def test_delete_empty_inventory_item_and_reject_historical_item(self):
        empty=self.call('inventory/items',{'sku':'EMPTY','name':'未用合成商品','unit':'件'})
        self.assertError(404,self.call,f'inventory/items/{empty["id"]}',{'version':1},method='DELETE',cid=2)
        self.call(f'inventory/items/{empty["id"]}',{'version':1,'reason':'合成空商品删除'},method='DELETE')
        used=self.call('inventory/items',{'sku':'HISTORY','name':'有历史商品','unit':'件'})
        movement=self.call('inventory/movements',{'item_id':used['id'],'date':'2026-01-01','direction':'in','quantity':'1','amount_fen':1234,'version':1})
        self.assertError(409,self.call,f'inventory/items/{used["id"]}',{'version':2},method='DELETE')
        self.withdraw(movement['voucher_id'])
        current=self.call(method='GET')['inventory_items'][0]
        self.assertEqual(0,current['value_fen'])
        self.assertError(409,self.call,f'inventory/items/{used["id"]}',{'version':current['version']},method='DELETE')

    def test_asset_delete_withdraws_purchase_and_protects_review_and_depreciation(self):
        payload={'name':'合成删除设备','purchase_date':'2026-01-01','start_period':'2026-02','cost_fen':10000,'residual_fen':1000,'life_months':3,'expense_account':'5602','counter_account':'2202'}
        a=self.call('assets',payload)
        self.call(f'vouchers/{a["voucher_id"]}/review',{'version':1,'reviewed':True})
        self.assertError(409,self.call,f'assets/{a["id"]}',{'version':1,'reason':'合成删除'},method='DELETE')
        self.call(f'vouchers/{a["voucher_id"]}/review',{'version':2,'reviewed':False})
        result=self.call(f'assets/{a["id"]}',{'version':1,'reason':'合成删除'},method='DELETE')
        self.assertTrue(result['withdrawn']);self.assertFalse(result['deleted'])
        self.assertEqual('void',finance._voucher(self.conn,1,a['voucher_id'])['status'])
        self.assertEqual('cancelled',self.call(method='GET')['assets'][0]['status'])
        b=self.call('assets',dict(payload,name='合成折旧设备'))
        self.call('assets/depreciate',{'period':'2026-02'})
        card=next(c for c in self.call(method='GET',period='2026-02')['assets'] if c['id']==b['id'])
        self.assertError(409,self.call,f'assets/{b["id"]}',{'version':card['version'],'reason':'合成删除'},method='DELETE')
        self.assertTrue(self.call(method='GET',period='2026-02')['reports']['balance_sheet']['balanced'])


if __name__=='__main__': unittest.main()
