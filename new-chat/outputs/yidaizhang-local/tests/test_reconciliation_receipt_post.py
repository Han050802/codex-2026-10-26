"""Receipt posting regression fixtures are synthetic and use disposable books."""
import os, tempfile, unittest
import db, finance, reconciliation_batch as batch


class ReceiptPostTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.path=os.path.join(self.tmp.name,'test.sqlite3')
        db.initialize(self.path); self.c=db.connect(self.path); self.user={'id':1,'username':'tester','name':'测试员'}
        with self.c:
            self.c.execute("INSERT INTO users(id,username,name,password_hash) VALUES(1,'tester','测试员','unused')")
            self.c.execute("INSERT INTO clients(id,name,code,taxpayer_type,standard,start_period,created_at,updated_at) VALUES(1,'本方公司','T1','small','small2013','2026-08',?,?)",(db.now(),db.now()))
            finance.ensure_book(self.c,dict(self.c.execute('SELECT * FROM clients WHERE id=1').fetchone()))
    def tearDown(self): self.c.close(); self.tmp.cleanup()

    def payload(self):
        txs=[{'date':'2026-09-21','amount':'-600.00','counterparty':'合成住房公积金中心','note':'委托收款','source':'s'},
             {'date':'2026-08-18','amount':'0.25','counterparty':'甲科技有限公司','note':'企业认证','source':'s'},
             {'date':'2026-08-18','amount':'0.25','counterparty':'乙支付有限公司','note':'实名验证','source':'s'},
             {'date':'2026-09-01','amount':'-50.00','counterparty':'某某','note':'无回单','source':'s'}]
        receipts=[dict(t,number='R%d'%i) for i,t in enumerate(txs[:3])]
        return {'client_id':1,'account_name':'本方公司','transactions':txs,'receipts':receipts,'invoices':[]}

    def test_posts_receipt_rows_to_suggested_subaccounts_once(self):
        out=batch.post_receipts(self.c,self.payload(),self.user)
        self.assertEqual([r['status'] for r in out['rows']],['posted','posted','posted','review'])
        self.assertEqual(out['rows'][0]['account_name'],'住房公积金（支出）')
        self.assertTrue(out['rows'][0]['account_code'].startswith('5602'))
        self.assertEqual(out['rows'][1]['account_code'],out['rows'][2]['account_code'])
        trial={r['account_code']:r for r in finance.balance_bundle(self.c,1,'2026-08','2026-09')['trial_balance_rollup']}
        self.assertEqual(trial['5602']['debit_fen'],60000)
        self.assertEqual(trial['2241']['credit_fen'],50)
        self.assertEqual(trial['1002']['credit_fen'],60000)
        again=batch.post_receipts(self.c,self.payload(),self.user)
        self.assertEqual(again['rows'][0]['reason'],'该回单已生成凭证')
        self.assertEqual(self.c.execute("SELECT count(*) FROM vouchers WHERE source_type='bank_receipt'").fetchone()[0],3)

    def test_balance_entry_delete_voids_receipt_voucher_and_allows_repost(self):
        out=batch.post_receipts(self.c,self.payload(),self.user)
        vid=self.c.execute("SELECT id FROM vouchers WHERE source_type='bank_receipt' ORDER BY id LIMIT 1").fetchone()[0]
        details=finance.balance_bundle(self.c,1,'2026-08','2026-09')['balance_details']
        self.assertTrue(any(d['voucher_id']==vid and d['reviewed'] is False for d in details))
        finance.handle(self.c,'POST','/api/books/1/balance-entries/delete',{'voucher_id':vid,'reason':'保存错误'},self.user,{})
        self.assertEqual(self.c.execute('SELECT status FROM vouchers WHERE id=?',(vid,)).fetchone()[0],'void')
        details=finance.balance_bundle(self.c,1,'2026-08','2026-09')['balance_details']
        self.assertFalse(any(d['voucher_id']==vid for d in details))
        again=batch.post_receipts(self.c,self.payload(),self.user)
        self.assertEqual(sum(r['reason']!='该回单已生成凭证' and r['status']=='posted' for r in again['rows']),1)

    def test_balance_entry_delete_rejects_reviewed_voucher(self):
        batch.post_receipts(self.c,self.payload(),self.user)
        vid=self.c.execute("SELECT id FROM vouchers WHERE source_type='bank_receipt' ORDER BY id LIMIT 1").fetchone()[0]
        with self.c: self.c.execute('UPDATE vouchers SET reviewed=1 WHERE id=?',(vid,))
        with self.assertRaises(db.ApiError):
            finance.handle(self.c,'POST','/api/books/1/balance-entries/delete',{'voucher_id':vid,'reason':'保存错误'},self.user,{})

if __name__=='__main__': unittest.main()
