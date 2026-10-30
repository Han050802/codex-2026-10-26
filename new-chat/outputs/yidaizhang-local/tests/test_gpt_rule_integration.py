"""Rule evidence drives real, idempotent postings after a unique match."""
import json, os, tempfile, unittest
import db, finance, reconciliation, reconciliation_batch


class SuggestionIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); path=os.path.join(self.tmp.name,'app.db')
        db.initialize(path); self.c=db.connect(path)
        with self.c:
            self.c.execute("INSERT INTO users(id,username,name,password_hash) VALUES(1,'tester','测试员','unused')")
            self.c.execute("INSERT INTO clients(id,name,code,taxpayer_type,standard,start_period,created_at,updated_at) VALUES(1,'本方公司','T1','general','small2013','2026-01',?,?)",(db.now(),db.now()))
            finance.ensure_book(self.c,dict(self.c.execute('SELECT * FROM clients WHERE id=1').fetchone()))
        self.user={'id':1,'username':'tester','name':'测试员'}

    def tearDown(self): self.c.close(); self.tmp.cleanup()

    def purchase(self,number='RULE-1',amount='100',**invoice_fields):
        invoice={'date':'2026-09-01','amount':amount,'seller':'供应商','buyer':'本方公司','number':number,'item_name':'服务费'}
        invoice.update(invoice_fields)
        return {'client_id':1,'account_name':'本方公司',
            'transactions':[{'date':'2026-09-01','amount':'-'+amount,'note':'服务费','counterparty':'供应商'}],
            'invoices':[invoice]}

    def assert_posted(self,row,amount,account='5602',tax=0):
        self.assertEqual('posted',row['status'],row)
        voucher=finance._voucher(self.c,1,row['voucher_id']); lines=voucher['lines']
        self.assertEqual((amount,amount),(sum(line['debit_fen'] for line in lines),sum(line['credit_fen'] for line in lines)))
        self.assertEqual(amount,sum(line['credit_fen']-line['debit_fen'] for line in lines if line['account_code'].startswith('1002')))
        self.assertEqual(amount-tax,sum(line['debit_fen'] for line in lines if line['account_code'].startswith(account)))
        self.assertEqual(tax,sum(line['debit_fen'] for line in lines if line['account_code'].startswith('2221')))
        self.assertEqual([],finance.balance_bundle(self.c,1,'2026-09','2026-09')['expense_classifications'])
        return voucher

    def seed_legacy_match(self,p,index=0,drop_suggestion=False):
        """Represent an old matched record that predates automatic posting."""
        draft=reconciliation_batch.preview(self.c,p)['rows'][index]
        transaction=p['transactions'][index]; invoice=p['invoices'][draft['invoice_index']]
        classification=dict(draft['classification'])
        if drop_suggestion: classification.pop('rule_suggestion',None)
        metadata={'classification':classification,'classification_inputs':reconciliation_batch._classification_inputs(invoice),
                  'suggestion_context':p['transactions']}
        with self.c:
            cur=self.c.execute("INSERT INTO reconciliation_records(client_id,invoice_number,transaction_json,invoice_json,account_name,status,review_note,user_id,created_at,transaction_key,batch_metadata_json) VALUES(?,?,?,?,?,'matched','',1,?,?,?)",
                (1,invoice['number'],json.dumps(transaction,ensure_ascii=False),json.dumps(invoice,ensure_ascii=False),
                 '本方公司',db.now(),reconciliation._transaction_key(transaction),json.dumps(metadata,ensure_ascii=False)))
        return cur.lastrowid

    def test_unmatched_invoice_preview_and_autopost_remain_pending(self):
        p={'client_id':1,'account_name':'本方公司','transactions':[{'date':'2026-09-01','amount':'-9','note':'银行手续费','counterparty':'银行'}],'invoices':[]}
        row=reconciliation_batch.preview(self.c,p)['rows'][0]
        self.assertEqual('5603',row['classification']['rule_suggestion']['account_code'])
        self.assertEqual('review',row['status']); self.assertIsNone(row['voucher'])
        result=reconciliation_batch.auto_post(self.c,p,self.user)['rows'][0]
        self.assertEqual('review',result['status'])
        self.assertEqual(0,self.c.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0])

    def test_matched_generic_suggestion_builds_real_draft_and_posts_with_reliable_tax(self):
        p=self.purchase(net_amount='90',tax_amount='10')
        row=reconciliation_batch.preview(self.c,p)['rows'][0]
        self.assertEqual('5602',row['classification']['rule_suggestion']['account_code'])
        self.assertEqual('ready',row['status']); self.assertIsInstance(row['voucher'],dict)
        self.assertEqual(0,self.c.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0],'preview is read-only')
        posted=reconciliation_batch.auto_post(self.c,p,self.user)['rows'][0]
        self.assert_posted(posted,10000,tax=1000)
        self.assertEqual('automatic_default',posted['automatic_posting']['funding_source'])
        self.assertEqual('split',posted['automatic_posting']['tax_mode'])

    def test_recommended_cost_posts_in_period_and_unmatched_income_stays_pending(self):
        p=self.purchase(number='COST-1',amount='20000',net_amount='20000',tax_amount='0')
        p['transactions'].insert(0,{'date':'2026-09-01','amount':'100000','note':'收款','counterparty':'客户'})
        p['transactions'][1]['date']='2026-09-02'; p['invoices'][0]['date']='2026-09-02'
        result=reconciliation_batch.auto_post(self.c,p,self.user); row=result['rows'][1]
        self.assertEqual('5401',row['classification']['account_code'])
        self.assertEqual('accepted_rule_suggestion',row['classification_evidence']['source'])
        self.assert_posted(row,2000000,'5401')
        report=finance.balance_bundle(self.c,1,'2026-09','2026-09')
        self.assertEqual(2000000,next(line for line in report['trial_balance_rollup'] if line['account_code']=='5401')['debit_fen'])
        self.assertEqual('review',result['rows'][0]['status'])
        self.assertEqual(1,self.c.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0])

    def test_clear_business_purpose_takes_precedence_over_provisional_suggestion(self):
        p=self.purchase(number='CLEAR-1',amount='20000',item_name='咨询',business_purpose='行政管理用途',net_amount='20000',tax_amount='0')
        p['transactions'].insert(0,{'date':'2026-09-01','amount':'100000','note':'收款','counterparty':'客户'})
        row=reconciliation_batch.auto_post(self.c,p,self.user)['rows'][1]
        self.assertEqual('5401',row['classification']['rule_suggestion']['account_code'])
        self.assertEqual('5602',row['classification']['account_code'])
        self.assert_posted(row,2000000)

    def test_matched_account_posts_gross_without_inventing_missing_tax(self):
        p=self.purchase(number='MISSING-TAX')
        row=reconciliation_batch.auto_post(self.c,p,self.user)['rows'][0]
        self.assert_posted(row,10000)
        self.assertEqual('gross_unreliable_or_missing_tax',row['automatic_posting']['tax_mode'])
        stored=json.loads(self.c.execute('SELECT invoice_json FROM reconciliation_records WHERE id=?',(row['id'],)).fetchone()[0])
        self.assertFalse(stored.get('net_amount')); self.assertFalse(stored.get('tax_amount'))
        self.assertEqual(10000,next(line for line in finance.balance_bundle(self.c,1,'2026-09','2026-09')['trial_balance_rollup'] if line['account_code']=='5602')['debit_fen'])

    def test_retry_saved_preserves_batch_recommendation_and_is_idempotent(self):
        p=self.purchase(number='COST-2',amount='20000')
        p['transactions'].insert(0,{'date':'2026-09-01','amount':'100000','note':'收款','counterparty':'客户'})
        rid=self.seed_legacy_match(p,1)
        result=reconciliation_batch.retry_saved(self.c,1,self.user)
        self.assertEqual(1,len(result['rows'])); row=result['rows'][0]
        self.assertEqual(rid,row['id']); self.assertEqual('5401',row['classification']['account_code'])
        self.assert_posted(row,2000000,'5401')
        self.assertEqual([],reconciliation_batch.retry_saved(self.c,1,self.user)['rows'])
        repeated=reconciliation_batch.auto_post(self.c,p,self.user)['rows'][1]
        self.assertTrue(repeated['already_posted']); self.assertEqual(row['voucher_id'],repeated['voucher_id'])
        self.assertEqual(1,self.c.execute('SELECT COUNT(*) FROM reconciliation_records').fetchone()[0])
        self.assertEqual(1,self.c.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0])

    def test_retry_saved_posts_explicit_business_purpose_without_provisional_suggestion(self):
        p=self.purchase(number='COST-3',item_name='咨询',business_purpose='行政管理用途',net_amount='90',tax_amount='99')
        p['transactions'][0]['note']='采购'
        rid=self.seed_legacy_match(p,drop_suggestion=True)
        row=reconciliation_batch.retry_saved(self.c,1,self.user)['rows'][0]
        self.assertEqual(rid,row['id']); self.assert_posted(row,10000)
        stored=json.loads(self.c.execute('SELECT invoice_json FROM reconciliation_records WHERE id=?',(rid,)).fetchone()[0])
        self.assertEqual(('90','99'),(stored['net_amount'],stored['tax_amount']))
        self.assertEqual([],reconciliation_batch.retry_saved(self.c,1,self.user)['rows'])

    def test_small_taxpayer_ordinary_purchase_posts_gross_once(self):
        with self.c: self.c.execute("UPDATE clients SET taxpayer_type='small' WHERE id=1")
        p=self.purchase(number='GROSS-1',amount='112000',invoice_type='ordinary',net_amount='110891.09',tax_amount='1108.91')
        row=reconciliation_batch.auto_post(self.c,p,self.user)['rows'][0]
        self.assert_posted(row,11200000)
        self.assertEqual('gross_small_ordinary',row['automatic_posting']['tax_mode'])
        retry=reconciliation_batch.auto_post(self.c,p,self.user)['rows'][0]
        self.assertEqual(row['id'],retry['id']); self.assertEqual(row['voucher_id'],retry['voucher_id'])
        self.assertEqual(1,self.c.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0])

    def test_inconsistent_tax_does_not_block_a_verified_gross_match(self):
        p=self.purchase(number='GROSS-2',invoice_type='ordinary',net_amount='90',tax_amount='10')
        self.assertEqual('ready',reconciliation_batch.preview(self.c,p)['rows'][0]['status'])
        with self.c: self.c.execute("UPDATE clients SET taxpayer_type='small' WHERE id=1")
        for kind in ('','special'):
            p['invoices'][0]['invoice_type']=kind
            self.assertEqual('ready',reconciliation_batch.preview(self.c,p)['rows'][0]['status'])
        p['invoices'][0].update(invoice_type='ordinary',net_amount='89')
        row=reconciliation_batch.auto_post(self.c,p,self.user)['rows'][0]
        self.assert_posted(row,10000)
        stored=json.loads(self.c.execute('SELECT invoice_json FROM reconciliation_records WHERE id=?',(row['id'],)).fetchone()[0])
        self.assertEqual(('89','10'),(stored['net_amount'],stored['tax_amount']))


if __name__=='__main__': unittest.main()
