import json
import os
import tempfile
import unittest

import db
import finance
import reconciliation
import reconciliation_batch as batch


class MatchDrivenPostingTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='match-driven-fixture-')
        path=os.path.join(self.temp.name,'fixture.sqlite3')
        db.initialize(path); self.conn=db.connect(path)
        self.user={'id':1,'username':'fixture','name':'合成测试员'}
        with self.conn:
            self.conn.execute("INSERT INTO users(id,username,name,password_hash) VALUES(1,'fixture','合成测试员','unused')")
            for cid,standard in ((1,'small2013'),(2,'enterprise2007')):
                self.conn.execute("INSERT INTO clients(id,name,code,taxpayer_type,standard,start_period,created_at,updated_at) VALUES(?,?,?,'general',?,'2026-01',?,?)",(cid,'本方公司'+str(cid),'FIX'+str(cid),standard,db.now(),db.now()))
                finance.ensure_book(self.conn,dict(self.conn.execute('SELECT * FROM clients WHERE id=?',(cid,)).fetchone()))

    def tearDown(self):
        self.conn.close(); self.temp.cleanup()

    def payload(self,cid=1,income=False,amount='100',number='F1'):
        own='本方公司'+str(cid); counter='合成客户' if income else '合成供应商'
        transaction={'date':'2026-09-15','amount':amount if income else '-'+amount,'counterparty':counter,'note':'收款' if income else '咨询服务费'}
        invoice={'date':'2026-09-14','amount':amount,'number':number,'seller':own if income else counter,'buyer':counter if income else own,'item_name':'服务费'}
        return {'client_id':cid,'account_name':own,'transactions':[transaction],'invoices':[invoice]}

    def count(self,cid):
        return self.conn.execute("SELECT count(*) FROM vouchers WHERE client_id=? AND status='active'",(cid,)).fetchone()[0]

    def assert_posted(self,row,amount,period='2026-09'):
        self.assertEqual(row['status'],'posted',row)
        self.assertTrue(row['voucher_ref'].startswith('记 '+period+'-'))
        self.assertEqual(row['period'],period); self.assertEqual(row['voucher_date'],'2026-09-15')
        self.assertEqual(sum(line['debit_fen'] for line in row['posted_lines']),amount)
        self.assertEqual(sum(line['credit_fen'] for line in row['posted_lines']),amount)

    def enterprise_profile(self,cid):
        alias='合成简称甲'
        full='合成企业甲科技有限公司'
        with self.conn:
            self.conn.execute('UPDATE clients SET name=?,profile_json=? WHERE id=?',
                              (alias,json.dumps({'enterprise_name':full},ensure_ascii=False),cid))
        client=finance._client(self.conn,cid)
        self.assertNotIn('profile_json',client)
        self.assertEqual(client['enterprise_name'],full)
        return alias,full

    def test_invoice_posts_with_enterprise_full_name_and_client_alias(self):
        for cid in (1,2):
            for name_index,own in enumerate(self.enterprise_profile(cid)):
                for income in (False,True):
                    with self.subTest(cid=cid,own=own,income=income):
                        payload=self.payload(cid,income,number=f'PROFILE-{name_index}-{income}')
                        counter=f'独立交易对方-{name_index}-{income}'
                        payload['account_name']=own
                        payload['transactions'][0]['counterparty']=counter
                        payload['invoices'][0].update(seller=own if income else counter,buyer=counter if income else own)
                        row=batch.auto_post(self.conn,payload,self.user)['rows'][0]
                        self.assert_posted(row,10000)
                        again=batch.auto_post(self.conn,payload,self.user)['rows'][0]
                        self.assertEqual(again['voucher_id'],row['voucher_id'])
                        self.assertTrue(again['already_posted'])
            self.assertEqual(self.count(cid),4)

    def test_receipt_posts_with_enterprise_full_name_and_client_alias(self):
        for cid in (1,2):
            names=self.enterprise_profile(cid)
            for name_index,own in enumerate(names):
                for income in (False,True):
                    with self.subTest(cid=cid,own=own,income=income):
                        payload=self.payload(cid,income)
                        payload['account_name']=own
                        payload['transactions'][0]['counterparty']=f'回单交易对方-{name_index}-{income}'
                        receipt=dict(payload['transactions'][0],number=f'PROFILE-R-{name_index}-{income}',own_name=names[1])
                        payload.update(invoices=[],receipts=[receipt])
                        row=batch.post_receipts(self.conn,payload,self.user)['rows'][0]
                        self.assert_posted(row,10000)
                        again=batch.post_receipts(self.conn,payload,self.user)['rows'][0]
                        self.assertEqual(again['voucher_id'],row['voucher_id'])
                        self.assertTrue(again['already_posted'])
            self.assertEqual(self.count(cid),4)

    def test_profile_enterprise_name_does_not_allow_unrelated_own_name(self):
        _,full=self.enterprise_profile(1)
        for own in ('','其他公司的全称'):
            for receipt_only in (False,True):
                with self.subTest(own=own,receipt_only=receipt_only):
                    payload=self.payload()
                    payload['account_name']=own
                    payload['invoices'][0]['buyer']=own
                    post=batch.auto_post
                    if receipt_only:
                        payload.update(invoices=[],receipts=[dict(payload['transactions'][0],number='WRONG-OWN',own_name=full)])
                        post=batch.post_receipts
                    with self.assertRaises(db.ApiError) as error:
                        post(self.conn,payload,self.user)
                    self.assertEqual(error.exception.status,400)
                    self.assertIn('本方名称必须',error.exception.message)
                    self.assertEqual(self.count(1),0)

    def test_receipt_unrelated_holder_still_rejected_with_valid_enterprise_name(self):
        _,full=self.enterprise_profile(1)
        payload=self.payload()
        payload.update(account_name=full,invoices=[],receipts=[dict(payload['transactions'][0],number='WRONG-HOLDER',own_name='其他公司的全称')])
        row=batch.post_receipts(self.conn,payload,self.user)['rows'][0]
        self.assertEqual(row['status'],'review')
        self.assertIn('回单本方名称与账套不一致',row['reason'])
        self.assertEqual(self.count(1),0)

    def test_155200_income_missing_tax_posts_gross_once_for_both_standards(self):
        for cid,revenue in ((1,'5001'),(2,'6001')):
            with self.subTest(cid=cid):
                payload=self.payload(cid,True,'155200')
                preview=batch.preview(self.conn,payload)['rows'][0]
                self.assertEqual(preview['status'],'ready',preview)
                self.assertEqual(self.count(cid),0,'Preview never creates accounts or vouchers.')
                row=batch.auto_post(self.conn,payload,self.user)['rows'][0]
                self.assert_posted(row,15520000)
                self.assertEqual(len(row['posted_lines']),2)
                self.assertTrue(row['posted_lines'][1]['account_code'].startswith(revenue))
                self.assertEqual(row['automatic_posting']['tax_mode'],'gross_unreliable_or_missing_tax')
                self.assertIsNone(row['automatic_posting']['source_net_amount'])
                self.assertIsNone(row['automatic_posting']['source_tax_amount'])
                saved=self.conn.execute('SELECT * FROM reconciliation_records WHERE id=?',(row['id'],)).fetchone()
                self.assertEqual(json.loads(saved['invoice_json'])['net_amount'],'')
                self.assertEqual(json.loads(saved['invoice_json'])['tax_amount'],'')
                again=batch.auto_post(self.conn,payload,self.user)['rows'][0]
                self.assert_posted(again,15520000)
                self.assertTrue(again['already_posted'])
                self.assertEqual(again['voucher_id'],row['voucher_id'])
                self.assertEqual(again['posted_lines'],row['posted_lines'])
                self.assertEqual(self.count(cid),1)

    def test_expense_without_funding_or_tax_uses_default_bank_and_gross(self):
        for cid,expense in ((1,'5602'),(2,'6602')):
            payload=self.payload(cid)
            payload['invoices'][0].update(net_amount='90',tax_amount='99')
            row=batch.auto_post(self.conn,payload,self.user)['rows'][0]
            self.assert_posted(row,10000)
            self.assertEqual([(line['account_code'],line['debit_fen'],line['credit_fen']) for line in row['posted_lines']],[(expense,10000,0),('1002',0,10000)])
            policy=row['automatic_posting']
            self.assertEqual(policy['funding_source'],'automatic_default')
            self.assertEqual((policy['source_net_amount'],policy['source_tax_amount']),('90','99'))
            self.assertNotIn('tax_fen',policy)
            invoice=json.loads(self.conn.execute('SELECT invoice_json FROM reconciliation_records WHERE id=?',(row['id'],)).fetchone()[0])
            self.assertEqual((invoice['net_amount'],invoice['tax_amount']),('90','99'))

    def test_reliable_tax_splits_without_manual_tax_or_use_gates(self):
        payload=self.payload(); payload['invoices'][0].update(net_amount='90',tax_amount='10')
        row=batch.auto_post(self.conn,payload,self.user)['rows'][0]
        self.assert_posted(row,10000)
        self.assertEqual([(line['account_code'],line['debit_fen'],line['credit_fen']) for line in row['posted_lines']],[('5602',9000,0),('2221',1000,0),('1002',0,10000)])
        self.assertEqual(row['automatic_posting']['tax_mode'],'split')

    def test_unknown_receipt_subject_uses_named_other_receivable_or_payable(self):
        for cid in (1,2):
            for incoming,parent in ((False,'1221'),(True,'2241')):
                payload=self.payload(cid,incoming,number='R'+str(incoming))
                payload['transactions'][0]['note']='未识别事项'
                receipt=dict(payload['transactions'][0],number='R'+str(incoming),own_name=payload['account_name'])
                payload.update(invoices=[],receipts=[receipt])
                row=batch.post_receipts(self.conn,payload,self.user)['rows'][0]
                self.assert_posted(row,10000)
                self.assertTrue(row['account_code'].startswith(parent))
                self.assertEqual(row['account_name'],payload['transactions'][0]['counterparty'])
                self.assertIn('fallback',row['automatic_posting']['subject_source'])
                again=batch.post_receipts(self.conn,payload,self.user)['rows'][0]
                self.assertEqual(again['voucher_id'],row['voucher_id'])
                self.assertEqual(again['posted_lines'],row['posted_lines'])

    def test_overlap_receipt_first_then_invoice_reuses_actual_voucher(self):
        payload=self.payload(); receipt=dict(payload['transactions'][0],number='R-OVERLAP',own_name=payload['account_name'])
        first=batch.post_receipts(self.conn,dict(payload,invoices=[],receipts=[receipt]),self.user)['rows'][0]
        self.assert_posted(first,10000)
        # No receipt needs to be resent: the stored fingerprint identifies it.
        second=batch.auto_post(self.conn,payload,self.user)['rows'][0]
        self.assert_posted(second,10000)
        self.assertEqual(second['voucher_id'],first['voucher_id'])
        history=reconciliation.records(self.conn,1)['records'][0]
        self.assertEqual(history['posting_status'],'posted')
        self.assertEqual(history['voucher_id'],first['voucher_id'])
        self.assertEqual(batch.retry_saved(self.conn,1,self.user)['rows'],[])
        self.assertEqual(self.count(1),1)

    def test_overlap_both_in_one_payload_or_invoice_first_never_defer(self):
        payload=self.payload(); payload['receipts']=[dict(payload['transactions'][0],number='R-BOTH',own_name=payload['account_name'])]
        first=batch.post_receipts(self.conn,payload,self.user)['rows'][0]
        self.assert_posted(first,10000)
        second=batch.auto_post(self.conn,payload,self.user)['rows'][0]
        self.assertEqual(second['voucher_id'],first['voucher_id'])
        third=batch.post_receipts(self.conn,dict(payload,invoices=[]),self.user)['rows'][0]
        self.assertEqual(third['voucher_id'],first['voucher_id'])
        self.assertEqual(self.count(1),1)

    def test_changed_receipt_does_not_report_unrelated_old_voucher_as_posted(self):
        payload=self.payload(); payload['invoices']=[]; payload['receipts']=[dict(payload['transactions'][0],number='R-SAME')]
        first=batch.post_receipts(self.conn,payload,self.user)['rows'][0]
        self.assert_posted(first,10000)
        payload['transactions'][0]['amount']='-200'; payload['receipts'][0]['amount']='-200'
        second=batch.post_receipts(self.conn,payload,self.user)['rows'][0]
        self.assertEqual(second['status'],'review')
        self.assertNotIn('voucher_id',second)
        self.assertEqual(self.count(1),1)

    def test_legacy_classification_retries_into_real_posting_and_is_idempotent(self):
        payload=self.payload()
        saved=reconciliation.save(self.conn,{'client_id':1,'account_name':payload['account_name'],'transaction':payload['transactions'][0],'invoice':payload['invoices'][0],
                                            'batch':dict(transactions=payload['transactions'],invoices=payload['invoices'],transaction_index=0,invoice_index=0)},self.user)
        metadata={'classification':{'status':'suggested','account_code':'5602','account_name':'管理费用'},
                  'classification_inputs':batch._classification_inputs(payload['invoices'][0]),
                  'expense_classification':{'account_code':'5602','amount_fen':10000,'date':'2026-09-15'}}
        with self.conn: self.conn.execute('UPDATE reconciliation_records SET batch_metadata_json=? WHERE id=?',(json.dumps(metadata,ensure_ascii=False),saved['id']))
        row=batch.retry_saved(self.conn,1,self.user)['rows'][0]
        self.assert_posted(row,10000)
        self.assertEqual(row['id'],saved['id'])
        self.assertEqual(batch.retry_saved(self.conn,1,self.user)['rows'],[])
        self.assertEqual(self.count(1),1)

    def test_closed_book_or_unmatched_records_never_claim_posting(self):
        payload=self.payload()
        with self.conn: self.conn.execute("INSERT INTO book_periods(client_id,period,closed) VALUES(1,'2026-09',1)")
        row=batch.auto_post(self.conn,payload,self.user)['rows'][0]
        self.assertNotEqual(row['status'],'posted'); self.assertNotIn('voucher_id',row)
        self.assertEqual(self.count(1),0)
        payload['invoices']=[]
        row=batch.auto_post(self.conn,payload,self.user)['rows'][0]
        self.assertEqual(row['status'],'review'); self.assertEqual(self.count(1),0)

    def test_bank_default_is_deterministic_and_valid_explicit_cash_is_retained(self):
        with finance._write(self.conn):
            first=finance._create_account(self.conn,1,{'parent_code':'1002','name':'首个银行'},self.user)
            finance._create_account(self.conn,1,{'parent_code':'1002','name':'第二银行'},self.user)
        payload=self.payload(); row=batch.auto_post(self.conn,payload,self.user)['rows'][0]
        self.assertEqual(row['automatic_posting']['funding_account_code'],first['code'])
        payload=self.payload(number='F2'); payload['transactions'][0]['date']='2026-09-16'; payload['evidence']=[{'bank_account_code':'1001'}]
        row=batch.auto_post(self.conn,payload,self.user)['rows'][0]
        self.assertEqual(row['status'],'posted',row)
        self.assertEqual(row['automatic_posting']['funding_account_code'],'1001')
        self.assertEqual(row['automatic_posting']['funding_source'],'explicit')

    def test_unusable_recommendation_falls_back_and_independent_same_amount_posts(self):
        payload=self.payload(); payload['evidence']=[{'business_account_code':'1002','bank_account_code':'2241'}]
        row=batch.auto_post(self.conn,payload,self.user)['rows'][0]
        self.assert_posted(row,10000)
        self.assertEqual(row['automatic_posting']['subject_source'],'other_receivable_fallback')
        self.assertEqual(row['automatic_posting']['funding_account_code'],'1002')
        other=self.payload(number='F2'); other['transactions'][0]['note']='另一笔咨询'; other['transactions'][0]['counterparty']='另一供应商'; other['invoices'][0]['seller']='另一供应商'
        result=batch.auto_post(self.conn,other,self.user)['rows'][0]
        self.assert_posted(result,10000)
        self.assertEqual(result['automatic_posting']['duplicate_policy'],'automatic_distinct_matched_source')
        self.assertEqual(self.count(1),2)
        self.assertEqual(batch.auto_post(self.conn,other,self.user)['rows'][0]['voucher_id'],result['voucher_id'])
        self.assertEqual(batch.auto_post(self.conn,payload,self.user)['rows'][0]['voucher_id'],row['voucher_id'])
        self.assertEqual(self.count(1),2)

    def test_two_unique_invoices_same_date_amount_post_two_and_repeat_same_two(self):
        payload=self.payload(); second=self.payload(number='F2')
        second['transactions'][0]['counterparty']='不同供应商'; second['invoices'][0]['seller']='不同供应商'
        payload['transactions'].extend(second['transactions']); payload['invoices'].extend(second['invoices'])
        rows=batch.auto_post(self.conn,payload,self.user)['rows']
        self.assertEqual([row['status'] for row in rows],['posted','posted'])
        self.assertNotEqual(rows[0]['voucher_id'],rows[1]['voucher_id'])
        again=batch.auto_post(self.conn,payload,self.user)['rows']
        self.assertEqual([row['voucher_id'] for row in again],[row['voucher_id'] for row in rows])
        self.assertTrue(all(row['already_posted'] for row in again))
        self.assertEqual(self.count(1),2)

    def test_same_transaction_cannot_post_again_under_a_new_invoice_identity(self):
        payload=self.payload(); first=batch.auto_post(self.conn,payload,self.user)['rows'][0]
        payload['invoices'][0]['number']='DIFFERENT-NUMBER'
        second=batch.auto_post(self.conn,payload,self.user)['rows'][0]
        self.assertEqual(second['status'],'review')
        self.assertNotIn('voucher_id',second)
        self.assertEqual(self.count(1),1)


if __name__=='__main__': unittest.main()
