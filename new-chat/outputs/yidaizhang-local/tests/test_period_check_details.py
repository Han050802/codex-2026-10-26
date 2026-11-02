"""Hover evidence is derived from isolated temporary accounting books."""
import os
import tempfile
import unittest

import db
import finance


class PeriodCheckDetailsTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.path=os.path.join(self.tmp.name,'period-check-details.sqlite3')
        db.initialize(self.path)
        self.conn=db.connect(self.path)
        self.user={'id':1,'username':'tester','name':'测试员'}
        with self.conn:
            self.conn.execute("INSERT INTO users(id,username,name,password_hash) VALUES(1,'tester','测试员','unused')")
            for cid in (1,2):
                self.conn.execute("INSERT INTO clients(id,name,code,taxpayer_type,standard,start_period,created_at,updated_at) VALUES(?,?,?,'small','small2013','2026-01',?,?)",
                                  (cid,f'合成账套{cid}',f'HOVER{cid}',db.now(),db.now()))
                finance.ensure_book(self.conn,dict(self.conn.execute('SELECT * FROM clients WHERE id=?',(cid,)).fetchone()))

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def call(self,route='',payload=None,method='POST',cid=1,period='2026-01'):
        return finance.handle(self.conn,method,f'/api/books/{cid}'+('/'+route if route else ''),
                              payload or {},self.user,{'period':period})

    def voucher(self,value=12345,date='2026-01-10',cid=1,summary='合成凭证',lines=None):
        return self.call('vouchers',{'date':date,'summary':summary,
                                    'lines':lines or [finance._entry('1002',value),finance._entry('5001',credit=value)]},cid=cid)

    def checks(self,cid=1,period='2026-01'):
        return self.call(method='GET',cid=cid,period=period)['checks']

    def detail(self,code,cid=1,period='2026-01'):
        return next(c['details'] for c in self.checks(cid,period) if c['code']==code)

    def test_review_and_cashflow_identify_actual_voucher_lines_and_isolate_book_period_status(self):
        active=self.voucher(lines=[dict(finance._entry('1002',2345),summary='逐笔收款'),
                                   finance._entry('1001',10000),finance._entry('5001',credit=12345)])
        reviewed=self.voucher(value=300)
        self.call(f'vouchers/{reviewed["id"]}/review',{'version':reviewed['version'],'reviewed':True})
        void=self.voucher(value=900)
        self.call(f'vouchers/{void["id"]}',{'version':void['version']},method='DELETE')
        self.voucher(value=777,cid=2)
        self.voucher(value=888,date='2026-02-01')
        review=self.detail('review')
        self.assertEqual((1,False),(review['total'],review['truncated']))
        self.assertEqual((active['id'],'记-001','2026-01-10','合成凭证',12345),
                         tuple(review['rows'][0][key] for key in ('voucher_id','voucher_number','date','summary','amount_fen')))
        self.assertIn('1002 银行存款',review['rows'][0]['accounts'])
        cash=self.detail('cashflow')
        self.assertEqual(3,cash['total'])
        self.assertEqual({active['id'],reviewed['id']},{r['voucher_id'] for r in cash['rows']})
        line=next(r for r in cash['rows'] if r['voucher_id']==active['id'] and r['account_code']=='1002')
        self.assertEqual(('逐笔收款','银行存款',2345,0),tuple(line[k] for k in ('summary','account_name','debit_fen','credit_fen')))
        fallback=next(r for r in cash['rows'] if r['voucher_id']==active['id'] and r['account_code']=='1001')
        self.assertEqual('合成凭证',fallback['summary'])
        self.assertEqual(1,self.detail('review',cid=2)['total'])
        self.assertEqual(1,self.detail('review',period='2026-02')['total'])

    def test_large_evidence_is_capped_and_keeps_full_total(self):
        for index in range(103):
            self.voucher(value=index+1,summary=f'合成批量{index+1}')
        for code in ('review','cashflow'):
            evidence=self.detail(code)
            self.assertEqual(103,evidence['total'])
            self.assertEqual(100,len(evidence['rows']))
            self.assertTrue(evidence['truncated'])
            self.assertEqual(list(range(1,101)),[r['number'] for r in evidence['rows']])

    def test_journal_and_payroll_only_show_pending_records_for_selected_period_and_book(self):
        journal={'date':'2026-01-15','summary':'合成银行收款','bank_account':'1002','counter_account':'1122',
                 'direction':'income','amount_fen':25000,'cashflow_category':'operating'}
        pending=self.call('journals',journal)
        posted=self.call('journals',dict(journal,summary='已生成凭证'))
        self.call(f'journals/{posted["id"]}/post',{'version':1})
        self.call('journals',journal,cid=2)
        self.call('journals',dict(journal,date='2026-02-15'))
        payroll={'period':'2026-01','employee_name':'合成员工','gross_fen':100000,'withheld_tax_fen':1000,'expense_account':'5602'}
        employee=self.call('payroll',payroll)
        self.call('payroll',payroll,cid=2)
        self.call('payroll',dict(payroll,period='2026-02'))
        journals=self.detail('journal')
        self.assertEqual(1,journals['total'])
        self.assertEqual((pending['id'],'收入',25000),tuple(journals['rows'][0][k] for k in ('journal_id','direction','amount_fen')))
        payroll_details=self.detail('payroll')
        self.assertEqual(1,payroll_details['total'])
        self.assertEqual((employee['id'],'合成员工',100000,99000),
                         tuple(payroll_details['rows'][0][k] for k in ('payroll_id','employee_name','gross_fen','net_fen')))
        self.call('payroll/post',{'period':'2026-01'})
        self.assertNotIn('payroll',[c['code'] for c in self.checks()])

    def test_depreciation_uses_selected_period_cards_and_disappears_after_posting(self):
        asset={'name':'合成设备','purchase_date':'2026-01-01','start_period':'2026-02','cost_fen':10000,
               'residual_fen':1000,'life_months':3,'expense_account':'5602','counter_account':'2202'}
        actual=self.call('assets',asset)
        self.call('assets',dict(asset,name='其他账套资产'),cid=2)
        self.call('assets',dict(asset,name='未来资产',purchase_date='2026-03-01',start_period='2026-04'))
        self.assertNotIn('depreciation',[c['code'] for c in self.checks()])
        evidence=self.detail('depreciation',period='2026-02')
        self.assertEqual(1,evidence['total'])
        self.assertEqual((actual['id'],'合成设备','2026-02',10000,0,10000),
                         tuple(evidence['rows'][0][k] for k in ('asset_id','name','start_period','cost_fen','accumulated_fen','net_fen')))
        self.call('assets/depreciate',{'period':'2026-02'})
        self.assertNotIn('depreciation',[c['code'] for c in self.checks(period='2026-02')])

    def test_inventory_and_asset_mismatch_evidence_agrees_with_as_of_period_controls(self):
        item=self.call('inventory/items',{'sku':'H1','name':'合成存货','unit':'件'})
        first=self.call('inventory/movements',{'item_id':item['id'],'date':'2026-01-02','direction':'in','quantity':'10','amount_fen':10000,'version':1})
        self.call('inventory/movements',{'item_id':item['id'],'date':'2026-03-02','direction':'in','quantity':'10','amount_fen':5000,'version':first['version']})
        self.voucher(lines=[finance._entry('1405',500),finance._entry('2202',credit=500)])
        self.call('assets',{'name':'合成设备','purchase_date':'2026-01-01','start_period':'2026-02','cost_fen':10000,
                            'residual_fen':1000,'life_months':3,'expense_account':'5602','counter_account':'2202'})
        self.voucher(lines=[finance._entry('1601',250),finance._entry('2202',credit=250)])
        self.voucher(lines=[finance._entry('5602',100),finance._entry('1602',credit=100)])
        controls={c['account_code']:c['details'] for c in self.checks(period='2026-02') if c['code'] in ('inventory','asset_balance')}
        expected={'1405':(10500,10000,500),'1601':(10250,10000,250),'1602':(-100,0,-100)}
        self.assertEqual(set(expected),set(controls))
        for account,values in expected.items():
            self.assertEqual(1,controls[account]['total'])
            self.assertEqual(values,tuple(controls[account]['rows'][0][k] for k in ('ledger_fen','subledger_fen','difference_fen')))

    def test_trial_and_ok_explain_result_and_detail_reads_do_not_mutate_accounting(self):
        ok=self.detail('ok')
        self.assertEqual(([],[],0,False),(ok['rows'],ok['columns'],ok['total'],ok['truncated']))
        with self.conn:
            self.conn.execute("INSERT INTO opening_balances(client_id,account_code,debit_fen,credit_fen) VALUES(1,'1002',1234,0)")
        before='\n'.join(self.conn.iterdump())
        evidence=self.detail('trial')
        self.assertIn('12.34元',evidence['reason'])
        self.assertEqual([('1002',1234,0)],[(r['account_code'],r['closing_debit_fen'],r['closing_credit_fen']) for r in evidence['rows']])
        self.checks()
        self.assertEqual(before,'\n'.join(self.conn.iterdump()))

    def test_close_checks_and_audit_records_keep_compact_shape(self):
        self.voucher(lines=[finance._entry('1002',10000,category='operating'),finance._entry('5001',credit=10000)])
        self.assertTrue(all('details' not in c for c in finance._checks(self.conn,1,'2026-01')))
        voucher=self.call(method='GET')['vouchers'][0]
        self.call(f'vouchers/{voucher["id"]}/review',{'version':voucher['version'],'reviewed':True})
        result=self.call('close',{'period':'2026-01'})
        self.assertTrue(result['closed'])
        self.assertTrue(all('details' not in c for c in result['checks']))
        self.assertNotIn('"details"',self.conn.execute("SELECT detail FROM audit_logs WHERE action='close'").fetchone()[0])


if __name__=='__main__':
    unittest.main()
