import os, tempfile, threading, unittest
import db, finance, reconciliation

class ReconciliationPostingTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.path=os.path.join(self.tmp.name,'test.sqlite3')
        db.initialize(self.path); self.conn=db.connect(self.path); self.user={'id':1,'username':'tester','name':'测试员'}
        with self.conn:
            self.conn.execute("INSERT INTO users(id,username,name,password_hash) VALUES(1,'tester','测试员','unused')")
            for cid in (1,2):
                self.conn.execute("INSERT INTO clients(id,name,code,taxpayer_type,standard,start_period,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",(cid,'合成企业'+str(cid),'T'+str(cid),'general','enterprise2007','2026-01',db.now(),db.now()))
                finance.ensure_book(self.conn,dict(self.conn.execute('SELECT * FROM clients WHERE id=?',(cid,)).fetchone()))
    def tearDown(self): self.conn.close(); self.tmp.cleanup()
    def save(self,n,direction='expense',counter='合成供应商',amount='100.00',tx_amount=None,date='2026-09-01',manual=False,cid=1):
        income=direction=='income'; company='合成企业'+str(cid)
        t={'date':date,'amount':tx_amount if tx_amount is not None else ('' if income else '-')+amount,'counterparty':counter,'note':'业务'+str(n),'source':'bank'}
        i={'date':date,'amount':amount,'seller':company if income else counter,'buyer':counter if income else company,'number':'F'+str(n),'source':'invoice'}
        p={'client_id':cid,'account_name':company,'transaction':t,'invoice':i,'batch':{'transactions':[t],'invoices':[i],'transaction_index':0,'invoice_index':0}}
        if manual: p.update(manual_pair=True,approved_review=True,review_note='人工核实')
        return reconciliation.save(self.conn,p,self.user)['id']
    def post(self,rid,**kwargs): return reconciliation.post_record(self.conn,rid,dict(client_id=1,bank_account='1002',**kwargs),self.user)
    def voucher(self,vid): return finance._voucher(self.conn,1,vid)
    def test_post_receipts_payments_rollup_reuse_and_withdraw(self):
        one=self.save(1); a=self.post(one); self.assertEqual(a['counterparty_account_code'],'220201')
        lines=self.voucher(a['voucher_id'])['lines']; self.assertEqual([(l['account_code'],l['debit_fen'],l['credit_fen']) for l in lines],[('220201',10000,0),('1002',0,10000)])
        same=self.save(2,amount='120.00'); self.assertEqual(self.post(same)['counterparty_account_code'],'220201')
        different=self.save(3,counter='另一供应商',amount='130.00'); self.assertEqual(self.post(different)['counterparty_account_code'],'220202')
        receipt=self.save(4,'income','合成客户',amount='150.00'); r=self.post(receipt); self.assertEqual(r['counterparty_account_code'],'112201')
        lines=self.voucher(r['voucher_id'])['lines']; self.assertEqual([(l['account_code'],l['debit_fen'],l['credit_fen']) for l in lines],[('1002',15000,0),('112201',0,15000)])
        self.assertTrue(self.post(receipt)['already_posted']); self.assertEqual(len(self.conn.execute("SELECT * FROM vouchers WHERE source_type='reconciliation' AND source_id=? AND status='active'",(str(receipt),)).fetchall()),1)
        trial=finance.balance_bundle(self.conn,1,'2026-09','2026-09')['trial_balance_rollup']; by={x['account_code']:x for x in trial}
        self.assertEqual(by['2202']['debit_fen'],35000); self.assertEqual(by['1122']['credit_fen'],15000)
        v=self.voucher(r['voucher_id']); finance.handle(self.conn,'POST',f'/api/books/1/vouchers/{v["id"]}/withdraw',{'reason':'重新核对','version':v['version']},self.user,{})
        history={x['id']:x for x in reconciliation.records(self.conn,1)['records']}; self.assertEqual(history[receipt]['posting_status'],'unposted'); self.assertIsNone(history[receipt]['voucher_id'])
        repost=self.post(receipt); self.assertEqual(repost['counterparty_account_code'],'112201'); self.assertNotEqual(repost['voucher_id'],r['voucher_id'])
    def test_possible_duplicate_explicit_explanation_and_audit(self):
        rid=self.save(1)
        finance.handle(self.conn,'POST','/api/books/1/vouchers',{'date':'2026-09-01','summary':'其他流水','lines':[finance._entry('6602',10000),finance._entry('1002',credit=10000)]},self.user,{})
        with self.assertRaises(db.ApiError) as got: self.post(rid)
        self.assertEqual(got.exception.details['code'],'possible_duplicate'); self.assertEqual(len(got.exception.details['candidates']),1)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM accounts WHERE code LIKE '2202%' AND code<>'2202'").fetchone()[0],0)
        result=self.post(rid,duplicate_review_note='已核对，为另一笔独立流水')
        row=self.conn.execute("SELECT detail FROM audit_logs WHERE action='reconcile_post' AND entity_id=?",(str(rid),)).fetchone()
        self.assertIn('已核对',row['detail']); self.assertGreater(result['voucher_id'],0)
    def test_mismatch_bank_closed_and_cross_client_no_mutation(self):
        bad=self.save(1,tx_amount='-99.00',manual=True)
        with self.assertRaises(db.ApiError): self.post(bad)
        good=self.save(2,amount='200.00')
        with self.assertRaises(db.ApiError): reconciliation.post_record(self.conn,good,{'client_id':2,'bank_account':'1002'},self.user)
        with self.assertRaises(db.ApiError): reconciliation.post_record(self.conn,good,{'client_id':1,'bank_account':'6602'},self.user)
        with self.conn: self.conn.execute("INSERT INTO book_periods(client_id,period,closed) VALUES(1,'2026-09',1)")
        with self.assertRaises(db.ApiError): self.post(good)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0],0)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM accounts WHERE code LIKE '2202%' AND code<>'2202'").fetchone()[0],0)
    def test_reviewed_party_mismatch_cannot_be_posted(self):
        t={'date':'2026-09-01','amount':'-100.00','counterparty':'付款对手甲','note':'','source':'bank'}
        i={'date':'2026-09-01','amount':'100.00','seller':'发票销售方乙','buyer':'合成企业1','number':'MISMATCH','source':'invoice'}
        p={'client_id':1,'account_name':'合成企业1','transaction':t,'invoice':i,'manual_pair':True,'approved_review':True,'review_note':'人工核对待处理'}
        rid=reconciliation.save(self.conn,p,self.user)['id']
        with self.assertRaises(db.ApiError) as got: self.post(rid)
        self.assertIn('买卖方不一致',got.exception.message)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0],0)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM accounts WHERE client_id=1 AND code LIKE '2202%' AND code<>'2202'").fetchone()[0],0)

    def test_invoice_posting_does_not_block_distinct_settlement(self):
        rid=self.save(1)
        with finance._write(self.conn): finance._insert_voucher(self.conn,1,'2026-09-01','发票确认',[finance._entry('6602',10000),finance._entry('1123',credit=10000)],self.user,'invoice','test-invoice')
        self.assertFalse(self.post(rid)['already_posted'])
    def test_reverse_duplicate_check_when_posting_existing_journal(self):
        journal=finance.handle(self.conn,'POST','/api/books/1/journals',{'date':'2026-09-01','summary':'其他付款','bank_account':'1002','counter_account':'6602','direction':'expense','amount_fen':10000},self.user,{})
        rid=self.save(1); self.post(rid)
        path=f'/api/books/1/journals/{journal["id"]}/post'
        with self.assertRaises(db.ApiError) as got: finance.handle(self.conn,'POST',path,{'version':journal['version']},self.user,{})
        self.assertEqual(got.exception.details['code'],'possible_duplicate')
        item=got.exception.details['candidates'][0]; self.assertIn('付款',item['summary']); self.assertIn('220201',item['counter_accounts'])
        result=finance.handle(self.conn,'POST',path,{'version':journal['version'],'duplicate_review_note':'经核对为不同流水'},self.user,{})
        self.assertGreater(result['voucher_id'],0)
        audit=self.conn.execute("SELECT detail FROM audit_logs WHERE action='post' AND entity='journal' AND entity_id=?",(str(journal['id']),)).fetchone()
        self.assertIn('经核对',audit['detail'])

    def test_concurrent_post_is_idempotent(self):
        rid=self.save(1); barrier=threading.Barrier(2); results=[]; errors=[]
        def run():
            c=db.connect(self.path)
            try:
                barrier.wait(); results.append(reconciliation.post_record(c,rid,{'client_id':1,'bank_account':'1002'},self.user))
            except Exception as e: errors.append(e)
            finally: c.close()
        threads=[threading.Thread(target=run) for _ in range(2)]
        for t in threads:t.start()
        for t in threads:t.join()
        self.assertFalse(errors,errors); self.assertEqual(len(results),2); self.assertEqual(len({x['voucher_id'] for x in results}),1)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM accounts WHERE client_id=1 AND code LIKE '2202%' AND code<>'2202'").fetchone()[0],1)

if __name__=='__main__': unittest.main()
