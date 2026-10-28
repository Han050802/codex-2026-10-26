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
    def tearDown(self): self.c.close(); self.tmp.cleanup()
    def test_no_invoice_preview_and_autopost_remain_pending(self):
        p={'client_id':1,'account_name':'本方公司','transactions':[{'date':'2026-09-01','amount':'-9','note':'银行手续费','counterparty':'银行'}],'invoices':[]}
        row=reconciliation_batch.preview(self.c,p)['rows'][0]
        self.assertEqual(row['classification']['rule_suggestion']['account_code'],'5603')
        self.assertEqual(row['status'],'review'); self.assertIsNone(row['voucher'])
        result=reconciliation_batch.auto_post(self.c,p,{'id':1,'username':'tester','name':'测试员'})['rows'][0]
        self.assertEqual(result['classification']['rule_suggestion']['account_code'],'5603')
        self.assertEqual(result['status'],'review')
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0],0)
    def test_matched_generic_suggestion_does_not_post(self):
        p={'client_id':1,'account_name':'本方公司','transactions':[{'date':'2026-09-01','amount':'-100','note':'服务费','counterparty':'供应商'}],
           'invoices':[{'date':'2026-09-01','amount':'100','seller':'供应商','buyer':'本方公司','number':'1','item_name':'服务费','net_amount':'90','tax_amount':'10'}]}
        row=reconciliation_batch.preview(self.c,p)['rows'][0]
        self.assertEqual(row['classification']['rule_suggestion']['account_code'],'5602')
        self.assertEqual(row['status'],'expense_classified'); self.assertIsNone(row['voucher'])
        self.assertIn('未自动拆税',row['classification']['rule_suggestion']['review'])

    def test_recommended_cost_is_classified_in_period_without_posting(self):
        p={'client_id':1,'account_name':'本方公司','transactions':[
            {'date':'2026-09-01','amount':'100000','note':'收款','counterparty':'客户'},
            {'date':'2026-09-02','amount':'-20000','note':'服务费','counterparty':'供应商'}],
           'invoices':[{'date':'2026-09-02','amount':'20000','seller':'供应商','buyer':'本方公司',
                        'number':'COST-1','item_name':'服务费','net_amount':'20000','tax_amount':'0'}]}
        result=reconciliation_batch.auto_post(self.c,p,{'id':1,'username':'tester','name':'测试员'})
        row=result['rows'][1]
        self.assertEqual(row['status'],'expense_classified')
        self.assertEqual(row['classification']['account_code'],'5401')
        self.assertEqual(row['classification_evidence']['source'],'accepted_rule_suggestion')
        rows=finance.balance_bundle(self.c,1,'2026-09','2026-09')['expense_classifications']
        self.assertEqual([(x['account_code'],x['amount_fen']) for x in rows],[('5401',2000000)])
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0],0)
        self.assertEqual(result['rows'][0]['status'],'review')

    def test_clear_business_purpose_takes_precedence_over_provisional_suggestion(self):
        p={'client_id':1,'account_name':'本方公司','transactions':[
            {'date':'2026-09-01','amount':'100000','note':'收款','counterparty':'客户'},
            {'date':'2026-09-02','amount':'-20000','note':'服务费','counterparty':'供应商'}],
           'invoices':[{'date':'2026-09-02','amount':'20000','seller':'供应商','buyer':'本方公司',
                        'number':'CLEAR-1','item_name':'咨询','business_purpose':'行政管理用途',
                        'net_amount':'20000','tax_amount':'0'}]}
        row=reconciliation_batch.auto_post(self.c,p,{'id':1,'username':'tester','name':'测试员'})['rows'][1]
        self.assertEqual(row['status'],'expense_classified')
        self.assertEqual(row['classification']['rule_suggestion']['account_code'],'5401')
        self.assertEqual(row['classification']['account_code'],'5602')
        self.assertEqual(row['expense_classification']['account_code'],'5602')

    def test_recommended_account_does_not_invent_missing_tax(self):
        p={'client_id':1,'account_name':'本方公司','transactions':[{'date':'2026-09-01','amount':'-100','note':'服务费','counterparty':'供应商'}],
           'invoices':[{'date':'2026-09-01','amount':'100','seller':'供应商','buyer':'本方公司','number':'2','item_name':'服务费'}]}
        row=reconciliation_batch.auto_post(self.c,p,{'id':1,'username':'tester','name':'测试员'})['rows'][0]
        self.assertEqual(row['classification']['account_code'],'5602')
        self.assertEqual(row['status'],'expense_classified')
        self.assertEqual(row['expense_classification']['amount_fen'],10000)
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0],0)

    def test_retry_saved_preserves_batch_recommendation_and_is_idempotent(self):
        user={'id':1,'username':'tester','name':'测试员'}
        p={'client_id':1,'account_name':'本方公司','transactions':[
            {'date':'2026-09-01','amount':'100000','note':'收款','counterparty':'客户'},
            {'date':'2026-09-02','amount':'-20000','note':'服务费','counterparty':'供应商'}],
           'invoices':[{'date':'2026-09-02','amount':'20000','seller':'供应商','buyer':'本方公司',
                        'number':'COST-2','item_name':'服务费'}]}
        saved=reconciliation_batch.auto_post(self.c,p,user)['rows'][1]
        self.assertEqual(saved['status'],'expense_classified')
        self.assertEqual(saved['classification']['rule_suggestion']['account_code'],'5401')
        result=reconciliation_batch.retry_saved(self.c,1,user)
        self.assertEqual(result['rows'][0]['status'],'expense_classified')
        self.assertEqual(result['rows'][0]['expense_classification']['account_code'],'5401')
        self.assertEqual(reconciliation_batch.retry_saved(self.c,1,user)['rows'][0]['id'],saved['id'])
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM reconciliation_records').fetchone()[0],1)
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0],0)

    def test_retry_saved_includes_rule_classification_without_provisional_suggestion(self):
        user={'id':1,'username':'tester','name':'测试员'}
        p={'client_id':1,'account_name':'本方公司','transactions':[
            {'date':'2026-09-01','amount':'-100','note':'采购','counterparty':'供应商'}],
           'invoices':[{'date':'2026-09-01','amount':'100','seller':'供应商','buyer':'本方公司',
                        'number':'COST-3','item_name':'咨询','business_purpose':'行政管理用途','net_amount':'90','tax_amount':'99'}]}
        saved=reconciliation_batch.auto_post(self.c,p,user)['rows'][0]
        self.assertEqual(saved['status'],'saved_pending')
        self.assertEqual(saved['classification']['status'],'suggested')
        invoice=dict(p['invoices'][0],net_amount='100',tax_amount='0')
        metadata=json.loads(self.c.execute('SELECT batch_metadata_json FROM reconciliation_records WHERE id=?',(saved['id'],)).fetchone()[0])
        metadata['classification'].pop('rule_suggestion',None)
        with self.c:
            self.c.execute('UPDATE reconciliation_records SET invoice_json=?,batch_metadata_json=? WHERE id=?',(json.dumps(invoice,ensure_ascii=False),json.dumps(metadata,ensure_ascii=False),saved['id']))
        result=reconciliation_batch.retry_saved(self.c,1,user)['rows'][0]
        self.assertEqual(result['status'],'expense_classified')
        rows=finance.balance_bundle(self.c,1,'2026-09','2026-09')['expense_classifications']
        self.assertEqual([(r['account_code'],r['amount_fen']) for r in rows],[('5602',10000)])
        self.assertEqual(reconciliation_batch.retry_saved(self.c,1,user)['rows'][0]['id'],saved['id'])

    def test_small_taxpayer_ordinary_purchase_classifies_gross_once(self):
        user={'id':1,'username':'tester','name':'测试员'}
        with self.c: self.c.execute("UPDATE clients SET taxpayer_type='small' WHERE id=1")
        p={'client_id':1,'account_name':'本方公司','transactions':[
            {'date':'2026-09-09','amount':'-112000','note':'服务费','counterparty':'供应商'}],
           'invoices':[{'date':'2026-09-08','amount':'112000','seller':'供应商','buyer':'本方公司',
                        'number':'GROSS-1','item_name':'服务费','invoice_type':'ordinary',
                        'net_amount':'110891.09','tax_amount':'1108.91'}]}
        row=reconciliation_batch.auto_post(self.c,p,user)['rows'][0]
        self.assertEqual(row['status'],'expense_classified')
        self.assertEqual((row['expense_classification']['account_code'],row['expense_classification']['amount_fen']),('5602',11200000))
        self.assertEqual(reconciliation_batch.auto_post(self.c,p,user)['rows'][0]['id'],row['id'])
        self.assertEqual(len(finance.balance_bundle(self.c,1,'2026-09','2026-09')['expense_classifications']),1)
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0],0)

    def test_classification_checks_amounts_for_any_taxpayer_and_invoice_type(self):
        user={'id':1,'username':'tester','name':'测试员'}
        p={'client_id':1,'account_name':'本方公司','transactions':[
            {'date':'2026-09-09','amount':'-100','note':'服务费','counterparty':'供应商'}],
           'invoices':[{'date':'2026-09-08','amount':'100','seller':'供应商','buyer':'本方公司',
                        'number':'GROSS-2','item_name':'服务费','invoice_type':'ordinary','net_amount':'90','tax_amount':'10'}]}
        self.assertEqual(reconciliation_batch.preview(self.c,p)['rows'][0]['status'],'expense_classified')
        with self.c: self.c.execute("UPDATE clients SET taxpayer_type='small' WHERE id=1")
        for kind in ('', 'special'):
            p['invoices'][0]['invoice_type']=kind
            self.assertEqual(reconciliation_batch.preview(self.c,p)['rows'][0]['status'],'expense_classified')
        p['invoices'][0].update(invoice_type='ordinary',net_amount='89')
        self.assertEqual(reconciliation_batch.auto_post(self.c,p,user)['rows'][0]['status'],'saved_pending')
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0],0)

if __name__=='__main__': unittest.main()
