"""Balance report categories and all-book export, on disposable databases only."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import db
import finance


class BalanceCategoriesTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.path=Path(self.tmp.name)/'categories.sqlite3'
        db.initialize(self.path); self.conn=db.connect(self.path)
        with self.conn:
            self.conn.execute("INSERT INTO users(id,username,name,password_hash) VALUES(1,'qa','合成测试','unused')")
            for cid in (1,2):
                self.conn.execute("INSERT INTO clients(id,name,code,taxpayer_type,standard,start_period,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                    (cid,'合成账套'+str(cid),'CAT'+str(cid),'general','small2013','2026-08',db.now(),db.now()))
                finance.ensure_book(self.conn,dict(self.conn.execute('SELECT * FROM clients WHERE id=?',(cid,)).fetchone()))
            self.conn.execute("INSERT INTO accounts(client_id,code,name,direction,category,report_key) VALUES(1,'224101','账号验证款','credit','liability','other_liability')")
        self.user={'id':1,'username':'qa','name':'合成测试'}

    def tearDown(self):
        self.conn.close(); self.tmp.cleanup()

    def post(self,date,amount=100,account='224101',counterparty='合成支付甲有限公司',purpose='企业认证测试转账',outgoing=False,cid=1):
        debit,credit=(account,'1002') if outgoing else ('1002',account)
        with self.conn:
            vid=finance._insert_voucher(self.conn,cid,date,purpose,
                    [finance._entry(debit,amount),finance._entry(credit,credit=amount)],self.user,counterparty=counterparty)
        return vid

    def balance(self,start='2026-08',end='2026-08',scope=None,cid=1):
        query={'start':start,'end':end}
        if scope: query['scope']=scope
        return finance.handle(self.conn,'GET',f'/api/books/{cid}/balance',{},self.user,query)

    def rows(self,data):
        return {row['account_code']:row for row in data['category_rows']}

    def classify(self,date,amount=300,code='5602',status='reviewed',number='EXPENSE-1'):
        entry={'direction':'expense','account_code':code,'amount_fen':amount,'summary':'办公耗材','date':date}
        with self.conn:
            cur=self.conn.execute("INSERT INTO reconciliation_records(client_id,invoice_number,transaction_json,invoice_json,account_name,status,review_note,user_id,created_at,transaction_key,batch_metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (1,number,json.dumps({'date':date,'counterparty':'合成供应商','note':'办公耗材'}),json.dumps({'date':date}),
                 '管理费用',status,'',1,db.now(),number,json.dumps({'expense_classification':entry})))
        return cur.lastrowid

    def test_all_details_get_numbered_categories_and_repeat_company_purpose_is_grouped(self):
        first=self.post('2026-08-03',50)
        self.post('2026-08-04',25,counterparty='合成支付乙有限公司',purpose='平台小额鉴权支付')
        self.post('2026-09-05',10,counterparty=' 合成支付甲有限公司 ',purpose=' 企业认证测试转账 ')
        self.post('2026-09-07',75,account='3001',counterparty='合成出资人甲',purpose='入资款')
        august=self.balance(); september=self.balance('2026-09','2026-09'); all_book=self.balance(scope='all')
        aug=self.rows(august); sep=self.rows(september); total=self.rows(all_book)
        self.assertEqual(('224101',3,True),(aug['22410101']['parent_code'],aug['22410101']['level'],aug['22410101']['is_leaf']))
        self.assertEqual('合成支付乙有限公司（平台小额鉴权支付）',aug['22410102']['account_name'])
        self.assertEqual((50,10,60),(sep['22410101']['opening_credit_fen'],sep['22410101']['credit_fen'],sep['22410101']['closing_credit_fen']))
        self.assertEqual(60,total['22410101']['credit_fen'])
        self.assertEqual(2,len([row for row in total.values() if row.get('is_category') and row['original_account_code']=='224101']))
        self.assertTrue(all(entry.get('category_code') and entry.get('original_account_code') for entry in all_book['balance_details']))
        self.assertTrue(all(any(category['account_code']==entry['category_code'] for category in all_book['category_rows']) for entry in all_book['balance_details']))
        self.assertEqual(first,aug['22410101']['source_refs'][0]['voucher_id'])
        self.assertEqual('224101',aug['22410101']['source_refs'][0]['original_account_code'])
        self.assertFalse(total['224101']['is_leaf'])
        self.assertEqual({'22410101','22410102'},set(row['account_code'] for row in aug.values() if row.get('is_category') and row['original_account_code']=='224101'))
        self.assertEqual({'22410101','22410102'},set(row['account_code'] for row in sep.values() if row.get('is_category') and row['original_account_code']=='224101'))
        self.assertIn('300101',total)
        self.assertEqual((2,'3001'),(total['300101']['level'],total['300101']['parent_code']))

    def test_parent_rollups_and_leaf_totals_conserve_money_without_counting_categories_twice(self):
        with self.conn:
            finance._opening(self.conn,1,{'version':1,'balances':[finance._entry('1002',1000),finance._entry('3001',credit=1000)]},self.user)
        self.post('2026-08-03',200)
        self.post('2026-08-04',75,outgoing=True)
        self.classify('2026-08-06',300)
        before=self.conn.total_changes
        data=self.balance(scope='all'); rows=self.rows(data)
        self.assertEqual(before,self.conn.total_changes,'report reads must not modify accounts or vouchers')
        self.assertEqual((200,75,125),(rows['224101']['credit_fen'],rows['224101']['debit_fen'],rows['224101']['closing_credit_fen']))
        self.assertEqual((200,75,125),(rows['22410101']['credit_fen'],rows['22410101']['debit_fen'],rows['22410101']['closing_credit_fen']))
        for key in finance._BALANCE_AMOUNT_KEYS:
            if key.startswith(('opening_','closing_')): continue
            self.assertEqual(data['totals'][key],sum(row[key] for row in rows.values() if row['is_leaf']),key)
        for prefix in ('opening','closing'):
            self.assertEqual(data['totals'][prefix+'_debit_fen']-data['totals'][prefix+'_credit_fen'],
                sum(row[prefix+'_debit_fen']-row[prefix+'_credit_fen'] for row in rows.values() if row['is_leaf']))
        for code in ('1002','2241','224101','3001','5602'):
            children=[row for row in rows.values() if row['parent_code']==code]
            for key in ('debit_fen','credit_fen'):
                self.assertEqual(rows[code][key],sum(row[key] for row in children),code+' '+key)
        self.assertEqual(300,rows['560201']['debit_fen'])
        self.assertEqual('5602',rows['560201']['original_account_code'])
        self.assertEqual(1,len(rows['560201']['source_refs']))

    def test_collision_with_existing_actual_children_does_not_reuse_their_codes(self):
        self.post('2026-08-03',50)
        self.post('2026-08-04',25,counterparty='第二公司')
        # A legacy tree can contain a used parent plus a later actual child.
        # The report must not alter that tree or hide the actual child.
        with self.conn:
            self.conn.execute("INSERT INTO accounts(client_id,code,name,direction,category,report_key) VALUES(1,'22410101','已有科目','credit','liability','other_liability')")
        rows=self.rows(self.balance(scope='all'))
        self.assertFalse(rows['22410101']['is_category'])
        self.assertEqual('已有科目',rows['22410101']['account_name'])
        self.assertTrue(rows['22410102']['is_category']); self.assertTrue(rows['22410103']['is_category'])
        self.assertEqual(75,sum(row['credit_fen'] for row in rows.values() if row['parent_code']=='224101'))

    def test_overflow_uses_two_digit_levels_and_preserves_parent_total(self):
        for index in range(103):
            self.post('2026-08-03',1,counterparty='公司'+str(index),purpose='验证')
        rows=self.rows(self.balance(scope='all'))
        categories=[row for row in rows.values() if row.get('is_category') and row['original_account_code']=='224101']
        self.assertEqual(103,sum(row['credit_fen'] for row in categories if row['is_leaf']))
        self.assertEqual(103,rows['224101']['credit_fen'])
        self.assertEqual('更多明细',rows['22410199']['account_name'])
        self.assertEqual((4,'22410199'),(rows['2241019901']['level'],rows['2241019901']['parent_code']))
        self.assertTrue(all(len(row['account_code'])-len(row['parent_code'])==2 for row in categories))

    def test_total_scope_spans_all_years_and_actual_classification_sources(self):
        self.post('2026-08-03',100)
        self.post('2027-01-02',200)
        self.classify('2028-02-03',300)
        self.classify('2030-03-04',900,status='deleted',number='IGNORE-DELETED')
        void=self.post('2029-05-06',700)
        with self.conn:
            self.conn.execute("UPDATE vouchers SET status='void' WHERE id=?",(void,))
        # Neither a selected month nor another book may narrow/extend the total.
        self.post('2031-01-03',800,account='3001',cid=2)
        data=self.balance('2026-08','2026-08',scope='all'); rows=self.rows(data)
        self.assertEqual(('all',True,'2026-08','2028-02'),(data['scope'],data['all_book'],data['start_period'],data['end_period']))
        self.assertEqual(300,rows['224101']['credit_fen'])
        self.assertEqual(300,rows['5602']['debit_fen'])
        self.assertEqual(0,rows['224101']['ytd_credit_fen'])
        self.assertEqual(600,data['totals']['debit_fen'])
        self.assertEqual({'2241','224101'},{row['code'] for row in data['source_accounts'] if row['code'].startswith('2241')})
        alias=finance.handle(self.conn,'GET','/api/books/1/balance-total',{},self.user,{})
        self.assertEqual((data['start_period'],data['end_period'],data['totals']),(alias['start_period'],alias['end_period'],alias['totals']))
        monthly=self.balance()
        self.assertEqual(('range',False,'2026-08'),(monthly['scope'],monthly['all_book'],monthly['end_period']))
        self.assertEqual(100,self.rows(monthly)['224101']['credit_fen'])
        other=self.balance(scope='all',cid=2)
        self.assertEqual('2031-01',other['end_period'])

    def test_empty_and_opening_only_books_use_book_start_as_total_end(self):
        self.assertEqual(('2026-08','2026-08'),(self.balance(scope='all')['start_period'],self.balance(scope='all')['end_period']))
        with self.conn:
            finance._opening(self.conn,1,{'version':1,'balances':[finance._entry('1002',1000),finance._entry('3001',credit=1000)]},self.user)
        data=self.balance(scope='all'); rows=self.rows(data)
        self.assertEqual(('2026-08','2026-08'),(data['start_period'],data['end_period']))
        self.assertEqual((1000,0,1000),(rows['100201']['opening_debit_fen'],rows['100201']['debit_fen'],rows['100201']['closing_debit_fen']))


if __name__=='__main__': unittest.main()
