"""Standard presentation is source linked, balanced, and never writes the book."""
import hashlib
import json
import unittest
from contextlib import closing

import db
import finance
from tests import test_finance as fixtures
from tests import test_reconciliation_http as http_fixtures


class StandardBalanceBasisTests(unittest.TestCase):
    def setUp(self):
        self.fixture=fixtures.FinanceTest('runTest')
        self.fixture.setUp()
        self.conn=self.fixture.conn
        self.user=self.fixture.user

    def tearDown(self):
        self.fixture.tearDown()

    def codes(self,cid):
        return ('5001','5602','5603','3103','3104','3001') if cid==1 else ('6001','6602','6603','4103','4104','4001')

    def post(self,cid,date,debit,credit,amount,summary='合成业务',source='manual'):
        with self.conn:
            return finance._insert_voucher(self.conn,cid,date,summary,
                [finance._entry(debit,amount),finance._entry(credit,credit=amount)],self.user,source_type=source)

    def report(self,cid=1,start=None,end=None,basis='standard'):
        query={'basis':basis,'scope':'all'} if start is None else {'basis':basis,'start':start,'end':end or start}
        return finance.handle(self.conn,'GET',f'/api/books/{cid}/balance',{},self.user,query)

    def snapshot(self):
        return hashlib.sha256('\n'.join(self.conn.iterdump()).encode()).hexdigest()

    def rows(self,report):
        return {row['account_code']:row for row in report['trial_balance_rollup']}

    def reference_business(self,cid):
        revenue,admin,financial,_,_,capital=self.codes(cid)
        self.post(cid,'2026-08-27','1002',capital,4999900,'入资款')
        self.post(cid,'2026-08-27','1002',capital,100,'入资款')
        for amount in (91,48,2,36,36): self.post(cid,'2026-08-26','1002','2241',amount,'账号验证款')
        self.post(cid,'2026-08-27','1221','1002',30000,'惠享服务')
        self.post(cid,'2026-08-27','1221','1002',10000,'惠享服务')
        self.post(cid,'2026-09-04','1002',capital,5000000,'入资款')
        self.post(cid,'2026-09-15','1002',revenue,15520000,'服务费')
        interest=self.post(cid,'2026-09-21','1002',financial,420,'利息')
        self.post(cid,'2026-09-28',admin,'1002',872400,'住房公积金')
        return interest

    def test_reference_amounts_both_standards_and_unchanged_real_sources(self):
        for cid in (1,2):
            with self.subTest(cid=cid):
                interest=self.reference_business(cid)
                before=self.snapshot()
                standard=self.report(cid)
                raw=self.report(cid,basis='raw')
                rows=self.rows(standard); revenue,admin,financial,profit,_,_=self.codes(cid)
                self.assertEqual(standard['basis'],'standard')
                self.assertTrue(standard['has_projection'])
                self.assertEqual((standard['totals']['debit_fen'],standard['totals']['credit_fen']),(41953033,41953033))
                self.assertEqual((standard['totals']['closing_debit_fen'],standard['totals']['closing_credit_fen']),(24648233,24648233))
                self.assertEqual(rows['1002']['closing_debit_fen'],24608233)
                self.assertEqual(rows[profit]['closing_credit_fen'],14648020)
                self.assertEqual((rows[revenue]['debit_fen'],rows[revenue]['credit_fen']),(15520000,15520000))
                self.assertEqual((rows[admin]['debit_fen'],rows[admin]['credit_fen']),(872400,872400))
                self.assertTrue(all(not row[key] for row in standard['category_rows'] if row['account_code'].startswith(financial) for key in finance._BALANCE_AMOUNT_KEYS))
                self.assertEqual(raw['totals']['debit_fen'],26433033)
                self.assertEqual(raw['totals']['credit_fen'],26433033)
                self.assertEqual(len(standard['normalized_source_refs']),1)
                self.assertEqual(standard['normalized_source_refs'][0]['voucher_id'],interest)
                self.assertEqual(standard['normalized_source_refs'][0]['amount_fen'],420)
                self.assertTrue(all(item['voucher_id'] is None and item['source_type']=='report_closing' and item['read_only'] for item in standard['projection_entries']))
                self.assertTrue(all(item['read_only'] for item in standard['balance_details']))
                self.assertTrue(all(item['related_source_refs'] for item in standard['projection_entries']))
                self.assertEqual(self.snapshot(),before)

    def test_actual_closing_matches_projection_and_is_not_projected_again(self):
        for cid in (1,2):
            with self.subTest(cid=cid):
                revenue,admin,financial,_,_,_=self.codes(cid)
                self.post(cid,'2026-01-03','1002',revenue,10000,'收入')
                self.post(cid,'2026-01-04',admin,'1002',1000,'费用')
                self.post(cid,'2026-01-05','1002',financial,420,'利息')
                projected=self.report(cid)
                with self.conn:
                    self.conn.execute("UPDATE vouchers SET reviewed=1 WHERE client_id=?",(cid,))
                    closing=finance._close(self.conn,cid,{'period':'2026-01'},self.user)
                before=self.snapshot(); actual=self.report(cid)
                self.assertFalse(actual['has_projection'])
                self.assertEqual(actual['projection_entries'],[])
                self.assertEqual(actual['totals'],projected['totals'])
                self.assertEqual(self.rows(actual),self.rows(projected))
                self.assertTrue(any(item['voucher_id']==closing['closing_voucher_id'] and not item['is_projection'] for item in actual['balance_details']))
                self.assertTrue(all(item['source_type']!='closing' for item in actual['normalized_source_refs']))
                self.assertEqual(before,self.snapshot())

    def test_finance_expense_closing_credit_is_never_normalized_as_interest(self):
        for cid in (1,2):
            _,_,financial,_,_,_=self.codes(cid)
            self.post(cid,'2026-01-03',financial,'1002',1000,'银行手续费')
            interest=self.post(cid,'2026-01-04','1002',financial,420,'利息')
            projected=self.report(cid)
            with self.conn:
                self.conn.execute('UPDATE vouchers SET reviewed=1 WHERE client_id=?',(cid,))
                closing=finance._close(self.conn,cid,{'period':'2026-01'},self.user)
            actual=self.report(cid); row=self.rows(actual)[financial]
            self.assertEqual((row['debit_fen'],row['credit_fen']),(580,580))
            self.assertEqual(actual['totals'],projected['totals'])
            self.assertFalse(actual['has_projection'])
            self.assertEqual({ref['voucher_id'] for ref in actual['normalized_source_refs']},{interest})
            real_finance=[entry for entry in actual['balance_details'] if entry['voucher_id']==closing['closing_voucher_id'] and entry['account_code']==financial]
            self.assertEqual(sum(entry['credit_fen'] for entry in real_finance),580)
            self.assertTrue(all(not entry.get('report_adjustment') for entry in real_finance))

    def test_partial_real_closing_only_projects_missing_amount_when_period_is_open(self):
        self.post(1,'2026-01-03','1002','5001',10000,'收入')
        real=self.post(1,'2026-01-31','5001','3103',6000,'部分损益结转','closing')
        before=self.snapshot(); result=self.report()
        self.assertTrue(result['has_projection'])
        self.assertEqual(sorted((entry['account_code'],entry['report_debit_fen'],entry['report_credit_fen']) for entry in result['projection_entries']),[('3103',0,4000),('5001',4000,0)])
        self.assertTrue(any(entry['voucher_id']==real and entry['debit_fen']==6000 for entry in result['balance_details']))
        self.assertEqual(self.rows(result)['5001']['debit_fen'],10000)
        self.assertEqual(self.rows(result)['3103']['credit_fen'],10000)
        self.assertEqual(self.conn.execute("SELECT count(*) FROM book_periods WHERE client_id=1 AND closed=1").fetchone()[0],0)
        self.assertEqual(before,self.snapshot())

    def test_zero_profit_still_closes_both_revenue_and_expense(self):
        self.post(1,'2026-01-03','1002','5001',10000,'收入')
        self.post(1,'2026-01-04','5602','1002',10000,'费用')
        result=self.report(); rows=self.rows(result)
        self.assertEqual(len(result['projection_entries']),2)
        self.assertEqual(rows['5001']['debit_fen'],10000)
        self.assertEqual(rows['5602']['credit_fen'],10000)
        self.assertEqual(rows['3103']['closing_credit_fen'],0)
        self.assertEqual(result['totals']['debit_fen'],result['totals']['credit_fen'])

    def test_cross_year_with_empty_december_transfers_profit_and_loss_for_both_standards(self):
        for cid in (1,2):
            revenue,admin,_,profit,retained,_=self.codes(cid)
            with self.subTest(cid=cid):
                self.post(cid,'2026-11-03','1002',revenue,10000,'往年收入')
                self.post(cid,'2026-11-04',admin,'1002',2000,'往年费用')
                self.post(cid,'2027-01-03','1002',revenue,3000,'本年收入')
                self.post(cid,'2027-01-04',admin,'1002',500,'本年费用')
                result=self.report(cid); rows=self.rows(result)
                self.assertEqual(rows[retained]['closing_credit_fen'],8000)
                self.assertEqual(rows[profit]['closing_credit_fen'],2500)
                annual=[entry for entry in result['projection_entries'] if entry['projection_phase']=='annual']
                self.assertEqual({entry['period'] for entry in annual},{'2026-12'})
                self.assertTrue(all(entry['related_source_refs'] for entry in annual))
                january=self.report(cid,'2027-01'); jan_rows=self.rows(january)
                self.assertEqual(jan_rows[retained]['opening_credit_fen'],8000)
                self.assertEqual(jan_rows[profit]['opening_credit_fen'],0)
                self.assertEqual(jan_rows[revenue]['ytd_credit_fen'],3000)
                self.assertEqual(january['totals']['debit_fen'],6500)
                self.assertEqual(january['totals']['credit_fen'],6500)
                self.assertEqual(self.rows(self.report(cid,'2026-12'))[retained]['closing_credit_fen'],8000)
        # A separate loss year must carry a debit retained balance, not a credit.
        with self.conn:
            self.conn.execute("UPDATE vouchers SET status='void' WHERE client_id=1")
        self.post(1,'2026-11-03','5602','1002',10000,'往年亏损')
        self.post(1,'2027-01-03','1002','5001',3000,'本年收入')
        rows=self.rows(self.report())
        self.assertEqual(rows['3104']['closing_debit_fen'],10000)
        self.assertEqual(rows['3103']['closing_credit_fen'],3000)

    def test_actual_year_closing_and_next_open_month_reuse_without_duplicates(self):
        for cid in (1,2):
            revenue,_,_,profit,retained,_=self.codes(cid)
            self.post(cid,'2026-11-03','1002',revenue,10000,'往年收入')
            self.post(cid,'2027-01-03','1002',revenue,3000,'本年收入')
            projected=self.report(cid)
            with self.conn:
                self.conn.execute('UPDATE vouchers SET reviewed=1 WHERE client_id=?',(cid,))
                for month in range(1,13): finance._close(self.conn,cid,{'period':f'2026-{month:02d}'},self.user)
            before=self.snapshot(); result=self.report(cid)
            self.assertEqual(result['totals'],projected['totals'])
            self.assertEqual(self.rows(result)[retained]['closing_credit_fen'],10000)
            self.assertEqual(self.rows(result)[profit]['closing_credit_fen'],3000)
            self.assertEqual({entry['period'] for entry in result['projection_entries']},{'2027-01'})
            self.assertFalse(self.report(cid,'2026-12')['has_projection'])
            self.assertEqual(self.snapshot(),before)

    def test_stable_categories_and_source_ids_across_ranges_and_actual_close(self):
        self.post(1,'2026-01-03','1002','5001',10000,'同类收入')
        self.post(1,'2026-02-03','1002','5001',20000,'同类收入')
        all_book=self.report(); january=self.report(start='2026-01'); february=self.report(start='2026-02')
        category_map=lambda report:{(row['original_account_code'],row['account_name']):row['account_code'] for row in report['category_rows'] if row['is_category']}
        self.assertEqual(category_map(all_book),category_map(january))
        self.assertEqual(category_map(all_book),category_map(february))
        self.assertEqual(all_book['projection_entries'],self.report()['projection_entries'])
        self.assertTrue(set(entry['source_id'] for entry in january['projection_entries']).issubset(set(entry['source_id'] for entry in all_book['projection_entries'])))
        with self.conn:
            self.conn.execute('UPDATE vouchers SET reviewed=1 WHERE client_id=1')
            finance._close(self.conn,1,{'period':'2026-01'},self.user)
        after=self.report()
        self.assertEqual(category_map(all_book),category_map(after))
        self.assertEqual(all_book['totals'],after['totals'])
        self.assertEqual({entry['period'] for entry in after['projection_entries']},{'2026-02'})

    def test_actual_closing_with_cash_or_unrepresentable_amount_never_drops_real_money(self):
        self.post(1,'2026-01-03','1002','5001',10000,'收入')
        self.post(1,'2026-01-31','1002','3103',5000,'异常结转含银行','closing')
        before=self.snapshot()
        self.assertEqual(self.rows(self.report(basis='raw'))['1002']['closing_debit_fen'],15000)
        with self.assertRaises(db.ApiError) as error: self.report()
        self.assertEqual(error.exception.status,409)
        self.assertTrue(any(item['account_code']=='1002' for item in error.exception.details))
        self.assertEqual(before,self.snapshot())

    def test_ambiguous_cumulative_legacy_close_is_explicitly_rejected(self):
        self.post(1,'2026-01-03','1002','5001',10000,'一月收入')
        self.post(1,'2026-02-03','1002','5001',10000,'二月收入')
        self.post(1,'2026-02-28','5001','3103',20000,'跨月累计结转','closing')
        with self.assertRaises(db.ApiError) as error: self.report()
        self.assertEqual(error.exception.status,409)
        self.assertEqual(self.rows(self.report(basis='actual'))['1002']['closing_debit_fen'],20000)

    def test_empty_book_and_raw_actual_aliases_do_not_project_or_write(self):
        before=self.snapshot()
        empty=self.report()
        self.assertFalse(empty['has_projection'])
        self.assertEqual(empty['projection_entries'],[])
        self.assertTrue(all(value==0 for value in empty['totals'].values()))
        self.post(1,'2026-01-03','1002','5001',10000,'收入')
        before=self.snapshot(); raw=self.report(basis='raw'); actual=self.report(basis='actual')
        self.assertEqual(raw['basis'],'raw'); self.assertEqual(actual['basis'],'actual')
        self.assertEqual(raw['totals'],actual['totals'])
        self.assertEqual(raw['trial_balance_rollup'],actual['trial_balance_rollup'])
        with self.assertRaises(db.ApiError): self.report(basis='unknown')
        self.assertEqual(before,self.snapshot())

    def test_unposted_expense_classification_is_not_invented_as_a_closing_journal(self):
        with self.conn:
            self.conn.execute("""INSERT INTO reconciliation_records(client_id,invoice_number,transaction_json,invoice_json,account_name,status,review_note,user_id,created_at,transaction_key,batch_metadata_json)
                VALUES(1,'UNPOSTED',?,?,?,'matched','',1,?,'UNPOSTED',?)""",
                (json.dumps({'date':'2026-01-03','counterparty':'供应商','note':'未入账费用'}),json.dumps({'date':'2026-01-03'}),
                 '合成企业1',db.now(),json.dumps({'expense_classification':{'direction':'expense','account_code':'5602','amount_fen':10000,'date':'2026-01-03'}})))
        raw=self.report(basis='raw'); before=self.snapshot(); standard=self.report()
        self.assertEqual(self.rows(raw)['5602']['debit_fen'],10000)
        self.assertEqual(standard['expense_classifications'],[])
        self.assertEqual(len(standard['unposted_expense_classifications']),1)
        self.assertFalse(standard['has_projection'])
        self.assertTrue(all(value==0 for value in standard['totals'].values()))
        self.assertEqual(self.snapshot(),before)

    def test_real_http_standard_raw_and_actual_are_explicit_and_read_only(self):
        http=http_fixtures.ReconciliationHTTPTests('runTest'); http.setUp()
        try:
            with closing(db.connect(http.app.db_path)) as conn,conn:
                finance._insert_voucher(conn,http.cid,'2026-01-03','收入',[finance._entry('1002',10000),finance._entry('5001',credit=10000)],self.user)
            responses={}
            for basis in ('standard','raw','actual'):
                code,body,_=http.client.call(f'/api/books/{http.cid}/balance?scope=all&basis={basis}')
                self.assertEqual(code,200,body); self.assertEqual(body['basis'],basis)
                responses[basis]=body
            self.assertEqual(responses['raw']['totals'],responses['actual']['totals'])
            self.assertEqual(responses['standard']['totals']['debit_fen'],20000)
            self.assertEqual(responses['raw']['totals']['debit_fen'],10000)
            with closing(db.connect(http.app.db_path)) as conn:
                self.assertEqual(conn.execute('SELECT count(*) FROM vouchers').fetchone()[0],1)
                self.assertEqual(conn.execute('SELECT reviewed FROM vouchers').fetchone()[0],0)
                self.assertEqual(conn.execute('SELECT count(*) FROM book_periods WHERE closed=1').fetchone()[0],0)
        finally: http.tearDown()


if __name__=='__main__': unittest.main()
