import os, tempfile, unittest
import db, finance, reconciliation


class ConfirmedVoucherTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.path=os.path.join(self.tmp.name,'book.sqlite3')
        db.initialize(self.path); self.conn=db.connect(self.path); self.user={'id':1,'username':'tester','name':'测试员'}
        with self.conn:
            self.conn.execute("INSERT INTO users(id,username,name,password_hash) VALUES(1,'tester','测试员','unused')")
            for cid in (1,2):
                self.conn.execute("INSERT INTO clients(id,name,code,taxpayer_type,standard,start_period,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",(cid,'合成企业'+str(cid),'T'+str(cid),'general','enterprise2007','2026-01',db.now(),db.now()))
                finance.ensure_book(self.conn,dict(self.conn.execute('SELECT * FROM clients WHERE id=?',(cid,)).fetchone()))
    def tearDown(self):
        self.conn.close(); self.tmp.cleanup()
    def payload(self):
        t={'date':'2026-09-01','amount':'-100.00','counterparty':'供应商','note':'','source':'bank'}
        i={'date':'2026-09-01','amount':'100.00','seller':'供应商','buyer':'合成企业1','number':'F1','source':'invoice'}
        return {'client_id':1,'account_name':'合成企业1','transaction':t,'invoice':i,'batch':{'transactions':[t],'invoices':[i],'transaction_index':0,'invoice_index':0}}
    def voucher(self):
        return {'date':'2026-09-01','summary':'经确认的采购付款','lines':[finance._entry('6602',10000),finance._entry('1002',credit=10000)]}
    def test_atomic_save_posts_confirmed_lines_to_balance(self):
        p=self.payload(); p['voucher']=self.voucher()
        result=reconciliation.save(self.conn,p,self.user)
        self.assertGreater(result['voucher_id'],0)
        lines=finance._voucher(self.conn,1,result['voucher_id'])['lines']
        self.assertEqual([(x['account_code'],x['debit_fen'],x['credit_fen']) for x in lines],[('6602',10000,0),('1002',0,10000)])
        trial={x['account_code']:x for x in finance.balance_bundle(self.conn,1,'2026-09','2026-09')['trial_balance']}
        self.assertEqual(trial['6602']['debit_fen'],10000); self.assertEqual(trial['1002']['credit_fen'],10000)
        self.assertEqual(reconciliation.records(self.conn,1)['records'][0]['posting_status'],'posted')
        with self.assertRaises(db.ApiError): reconciliation.save(self.conn,p,self.user)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM vouchers').fetchone()[0],1)
    def test_explicit_counterparty_subaccount_posts_to_balance_and_reuses(self):
        p=self.payload(); p['voucher']={'date':'2026-09-01','summary':'已确认预付款',
            'lines':[{'counterparty_parent_code':'1123','debit_fen':10000},finance._entry('1002',credit=10000)]}
        result=reconciliation.save(self.conn,p,self.user)
        detail=next(line for line in result['posted_lines'] if line['account_name']=='供应商')
        self.assertEqual(detail['account_code'],'112301')
        trial={x['account_code']:x for x in finance.balance_bundle(self.conn,1,'2026-09','2026-09')['trial_balance_rollup']}
        self.assertEqual(trial['112301']['debit_fen'],10000)
        self.assertEqual(trial['1123']['debit_fen'],10000)
        second=self.payload(); second['transaction']=dict(second['transaction'],note='另一笔',amount='-200.00')
        second['invoice']=dict(second['invoice'],number='F2',amount='200.00')
        second['batch']={'transactions':[second['transaction']],'invoices':[second['invoice']],'transaction_index':0,'invoice_index':0}
        second['voucher']={'date':'2026-09-01','summary':'另一笔预付款',
            'lines':[{'counterparty_parent_code':'1123','debit_fen':20000},finance._entry('1002',credit=20000)]}
        result2=reconciliation.save(self.conn,second,self.user)
        self.assertEqual(result2['posted_lines'][0]['account_code'],'112301')
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM accounts WHERE client_id=1 AND code LIKE '1123%' AND name='供应商'").fetchone()[0],1)

    def test_new_detail_rolls_back_when_voucher_invalid(self):
        p=self.payload(); p['voucher']={'date':'2026-09-01','summary':'预付款',
            'lines':[{'counterparty_parent_code':'1123','debit_fen':9000},finance._entry('1002',credit=10000)]}
        with self.assertRaises(db.ApiError): reconciliation.save(self.conn,p,self.user)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM accounts WHERE client_id=1 AND code LIKE '1123%' AND code<>'1123'").fetchone()[0],0)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM reconciliation_records').fetchone()[0],0)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0],0)

    def test_used_parent_is_rejected_without_partial_record(self):
        with finance._write(self.conn):
            finance._insert_voucher(self.conn,1,'2026-09-01','已有上级发生额',
                [finance._entry('1123',5000),finance._entry('1002',credit=5000)],self.user)
        p=self.payload(); p['voucher']={'date':'2026-09-02','summary':'预付款',
            'lines':[{'counterparty_parent_code':'1123','debit_fen':10000},finance._entry('1002',credit=10000)]}
        with self.assertRaises(db.ApiError) as caught: reconciliation.save(self.conn,p,self.user)
        self.assertIn('上级科目已使用',caught.exception.message)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM accounts WHERE client_id=1 AND code LIKE '1123%' AND code<>'1123'").fetchone()[0],0)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM reconciliation_records').fetchone()[0],0)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0],1)

    def test_reviewed_record_can_post_explicitly_confirmed_voucher(self):
        p=self.payload(); p.update(manual_pair=True,approved_review=True,review_note='已核对纸质原件')
        p['voucher']=self.voucher()
        result=reconciliation.save(self.conn,p,self.user)
        self.assertEqual(result['status'],'reviewed')
        self.assertGreater(result['voucher_id'],0)

    def test_invalid_voucher_and_closed_period_roll_back_record_and_audit(self):
        for changes in ({'lines':[finance._entry('6602',9999),finance._entry('1002',credit=10000)]},
                        {'lines':[finance._entry('6602',10000),finance._entry('1002',10000)]},
                        {'lines':[finance._entry('6602',9000),finance._entry('1002',credit=9000)]}):
            p=self.payload(); p['voucher']={**self.voucher(),**changes}
            with self.assertRaises(db.ApiError): reconciliation.save(self.conn,p,self.user)
            self.assertEqual(self.conn.execute('SELECT count(*) FROM reconciliation_records').fetchone()[0],0)
            self.assertEqual(self.conn.execute("SELECT count(*) FROM audit_logs WHERE action='reconcile_save'").fetchone()[0],0)
        with self.conn: self.conn.execute("INSERT INTO book_periods(client_id,period,closed) VALUES(1,'2026-09',1)")
        p=self.payload(); p['voucher']=self.voucher()
        with self.assertRaises(db.ApiError): reconciliation.save(self.conn,p,self.user)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM reconciliation_records').fetchone()[0],0)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM vouchers').fetchone()[0],0)
    def test_duplicate_confirmation_and_existing_record_post_idempotent(self):
        with finance._write(self.conn): finance._insert_voucher(self.conn,1,'2026-09-01','已有凭证',self.voucher()['lines'],self.user)
        p=self.payload(); p['voucher']=self.voucher()
        with self.assertRaises(db.ApiError) as e: reconciliation.save(self.conn,p,self.user)
        self.assertEqual(e.exception.details['code'],'possible_duplicate')
        self.assertEqual(len(e.exception.details['candidates']),1)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM reconciliation_records').fetchone()[0],0)
        saved=reconciliation.save(self.conn,self.payload(),self.user)
        with self.assertRaises(db.ApiError): reconciliation.post_confirmed(self.conn,saved['id'],{'client_id':1,'voucher':self.voucher()},self.user)
        v=self.voucher(); v['duplicate_review_note']='已核对为独立付款'
        result=reconciliation.post_confirmed(self.conn,saved['id'],{'client_id':1,'voucher':v},self.user)
        self.assertFalse(result['already_posted'])
        again=reconciliation.post_confirmed(self.conn,saved['id'],{'client_id':1,'voucher':v},self.user)
        self.assertTrue(again['already_posted']); self.assertEqual(result['voucher_id'],again['voucher_id'])
        with self.assertRaises(db.ApiError): reconciliation.post_confirmed(self.conn,saved['id'],{'client_id':2,'voucher':v},self.user)
        audit=self.conn.execute("SELECT detail FROM audit_logs WHERE action='reconcile_post'").fetchone()[0]
        self.assertIn('独立付款',audit)

if __name__=='__main__': unittest.main()
