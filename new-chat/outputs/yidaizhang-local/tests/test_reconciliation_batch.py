import base64, json, os, tempfile, unittest
from unittest.mock import patch
import db, finance, reconciliation_batch as batch
import reconciliation, reconciliation_ocr

class BatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.path=os.path.join(self.tmp.name,'test.sqlite3')
        db.initialize(self.path); self.c=db.connect(self.path); self.user={'id':1,'username':'tester','name':'测试员'}
        with self.c:
            self.c.execute("INSERT INTO users(id,username,name,password_hash) VALUES(1,'tester','测试员','unused')")
            self.c.execute("INSERT INTO clients(id,name,code,taxpayer_type,standard,start_period,created_at,updated_at) VALUES(1,'本方公司','T1','general','small2013','2026-01',?,?)",(db.now(),db.now()))
            finance.ensure_book(self.c,dict(self.c.execute('SELECT * FROM clients WHERE id=1').fetchone()))
    def tearDown(self): self.c.close(); self.tmp.cleanup()
    def item(self,n=1,month='09'):
        t={'date':f'2026-{month}-01','amount':'-100.00','counterparty':'供应商','note':f'采购{n}','source':'bank'}
        i={'date':f'2026-{month}-01','amount':'100.00','seller':'供应商','buyer':'本方公司','number':'F'+str(n),'source':'invoice','item_name':'咨询','business_purpose':'行政管理用途','net_amount':'100.00','tax_amount':'0.00'}
        return t,i
    def payload(self):
        t,i=self.item(); return {'client_id':1,'account_name':'本方公司','transactions':[t],'invoices':[i], 'evidence':[{'bank_account_code':'1002'}]}
    def test_expense_without_funding_is_classified_without_voucher(self):
        p=self.payload(); p['evidence']=[]
        row=batch.preview(self.c,p)['rows'][0]
        self.assertEqual(row['status'],'expense_classified')
        self.assertEqual(row['classification']['account_code'],'5602')
        self.assertIsNone(row['voucher'])
        saved=batch.auto_post(self.c,p,self.user)['rows'][0]
        self.assertEqual(saved['status'],'expense_classified')
        self.assertEqual(self.c.execute('SELECT count(*) FROM vouchers').fetchone()[0],0)
        record=self.c.execute('SELECT batch_metadata_json FROM reconciliation_records WHERE id=?',(saved['id'],)).fetchone()
        self.assertEqual(json.loads(record['batch_metadata_json'])['classification']['account_code'],'5602')

    def test_expense_repeated_submission_does_not_generate_voucher(self):
        p=self.payload(); p['evidence']=[]
        saved=batch.auto_post(self.c,p,self.user)['rows'][0]
        p['evidence']=[{'bank_account_code':'1001'}]
        result=batch.auto_post(self.c,p,self.user)['rows'][0]
        self.assertEqual(result['status'],'expense_classified')
        self.assertEqual(result['id'],saved['id'])
        self.assertEqual(result['expense_classification'],saved['expense_classification'])
        self.assertEqual(self.c.execute('SELECT count(*) FROM vouchers').fetchone()[0],0)
        self.assertEqual(len(finance.balance_bundle(self.c,1,'2026-09','2026-09')['expense_classifications']),1)

    def test_retry_cannot_recreate_implicit_bank_payment(self):
        p=self.payload(); p['evidence']=[]
        saved=batch.auto_post(self.c,p,self.user)['rows'][0]
        result=batch.retry_saved(self.c,1,self.user)['rows'][0]
        self.assertEqual(result['id'],saved['id'])
        self.assertEqual(result['status'],'expense_classified')
        self.assertEqual(self.c.execute('SELECT count(*) FROM vouchers').fetchone()[0],0)

    def test_expense_funding_choice_never_creates_voucher(self):
        p=self.payload(); p['evidence']=[{'bank_account_code':'2241'}]
        row=batch.auto_post(self.c,p,self.user)['rows'][0]
        self.assertEqual(row['status'],'expense_classified')
        self.assertEqual(self.c.execute('SELECT count(*) FROM vouchers').fetchone()[0],0)

    def test_balance_classification_filters_period_book_and_active_voucher(self):
        p=self.payload(); p['evidence']=[]
        saved=batch.auto_post(self.c,p,self.user)['rows'][0]
        rows=finance.balance_bundle(self.c,1,'2026-09','2026-09')['expense_classifications']
        self.assertEqual([(r['record_id'],r['amount_fen'],r['direction']) for r in rows],[(saved['id'],10000,'expense')])
        self.assertEqual(rows[0]['counterparty'],'供应商')
        self.assertEqual(finance.balance_bundle(self.c,1,'2026-10','2026-10')['expense_classifications'],[])
        with self.c:
            self.c.execute("INSERT INTO clients(id,name,code,taxpayer_type,standard,start_period,created_at,updated_at) VALUES(2,'另一公司','T2','general','small2013','2026-01',?,?)",(db.now(),db.now()))
            finance.ensure_book(self.c,dict(self.c.execute('SELECT * FROM clients WHERE id=2').fetchone()))
        self.assertEqual(finance.balance_bundle(self.c,2,'2026-09','2026-09')['expense_classifications'],[])
        with finance._write(self.c):
            finance._insert_voucher(self.c,1,'2026-09-01','已正式制证',[finance._entry('5602',10000),finance._entry('1001',credit=10000)],self.user,'reconciliation',saved['id'])
        self.assertEqual(finance.balance_bundle(self.c,1,'2026-09','2026-09')['expense_classifications'],[])

    def test_balance_classification_reads_each_saved_transaction_counterparty(self):
        p=self.payload(); p['evidence']=[]
        t,i=self.item(2); t['counterparty']='另一供应商'; i['seller']='另一供应商'
        p['transactions'].append(t); p['invoices'].append(i)
        saved=batch.auto_post(self.c,p,self.user)['rows']
        rows=finance.balance_bundle(self.c,1,'2026-09','2026-09')['expense_classifications']
        self.assertEqual({r['record_id']:r['counterparty'] for r in rows},
                         {saved[0]['id']:'供应商',saved[1]['id']:'另一供应商'})
        # Older or damaged transaction data must not hide the classification or
        # substitute our company / the invoice seller as the counterparty.
        with self.c:
            self.c.execute('UPDATE reconciliation_records SET transaction_json=? WHERE id=?',
                           (json.dumps({'counterparty':''}),saved[0]['id']))
            self.c.execute('UPDATE reconciliation_records SET transaction_json=? WHERE id=?',
                           ('invalid json',saved[1]['id']))
        rows=finance.balance_bundle(self.c,1,'2026-09','2026-09')['expense_classifications']
        self.assertEqual({r['record_id']:r['counterparty'] for r in rows},
                         {saved[0]['id']:'',saved[1]['id']:''})

    def test_confirmed_batch_saves_classification_without_a_voucher(self):
        p=self.payload(); p['evidence']=[]
        preview=batch.preview(self.c,p)
        self.assertEqual(preview['rows'][0]['status'],'expense_classified')
        saved=batch.save_batch(self.c,{**p,'confirmed':True,'preview_token':preview['preview_token']},self.user)
        self.assertEqual(saved['periods'],['2026-09'])
        self.assertEqual(len(finance.balance_bundle(self.c,1,'2026-09','2026-09')['expense_classifications']),1)
        self.assertEqual(self.c.execute('SELECT count(*) FROM vouchers').fetchone()[0],0)

    def test_explicit_prepayment_retains_accounting_workflow(self):
        p=self.payload(); p['evidence']=[{'treatment':'contract_prepayment','evidence_note':'已核实合同预付款'}]
        self.assertEqual(batch.preview(self.c,p)['rows'][0]['status'],'review')
        self.assertEqual(self.c.execute('SELECT count(*) FROM vouchers').fetchone()[0],0)
        p['evidence'][0]['bank_account_code']='1002'
        row=batch.auto_post(self.c,p,self.user)['rows'][0]
        self.assertEqual(row['status'],'posted')
        self.assertEqual(row['posted_lines'][0]['account_code'],'112301')
        self.assertEqual(row['posted_lines'][1]['account_code'],'1002')
        self.assertEqual(finance.balance_bundle(self.c,1,'2026-09','2026-09')['expense_classifications'],[])

    def test_explicit_payable_settlement_retains_balance_checks(self):
        with finance._write(self.c):
            account=finance._create_account(self.c,1,{'parent_code':'2202','name':'供应商'},self.user)
            finance._insert_voucher(self.c,1,'2026-08-01','原应付款',[finance._entry('5602',10000),finance._entry(account['code'],credit=10000)],self.user)
        p=self.payload(); p['evidence']=[{'treatment':'settle_payable','bank_account_code':'1002','settlement_account_code':account['code'],'evidence_note':'核对原凭证'}]
        row=batch.auto_post(self.c,p,self.user)['rows'][0]
        self.assertEqual(row['status'],'posted')
        self.assertEqual(row['posted_lines'][0]['account_code'],account['code'])
        self.assertEqual(finance.balance_bundle(self.c,1,'2026-09','2026-09')['expense_classifications'],[])

    def test_income_uses_existing_voucher_flow(self):
        p={'client_id':1,'account_name':'本方公司','transactions':[{'date':'2026-09-01','amount':'100','counterparty':'客户','note':'主营业务服务'}],
           'invoices':[{'date':'2026-09-01','amount':'100','seller':'本方公司','buyer':'客户','number':'SALE-1','item_name':'咨询','business_purpose':'主营业务服务','net_amount':'100','tax_amount':'0'}]}
        result=batch.auto_post(self.c,p,self.user)['rows'][0]
        self.assertEqual(result['status'],'posted')
        self.assertEqual(result['posted_lines'][0]['account_code'],'1002')
        self.assertEqual(finance.balance_bundle(self.c,1,'2026-09','2026-09')['expense_classifications'],[])

    def test_implicit_prepayment_and_settlement_are_not_classified_as_expenses(self):
        for number,note in enumerate(('合同预付款','结清应付账款','偿还欠款')):
            p=self.payload(); p['evidence']=[]; p['transactions'][0]['note']=note
            p['invoices'][0]['number']='AMBIGUOUS-'+str(number)
            result=batch.auto_post(self.c,p,self.user)['rows'][0]
            self.assertEqual(result['status'],'saved_pending')
            self.assertIn('预付款或往来结算',result['reason'])
        self.assertEqual(finance.balance_bundle(self.c,1,'2026-09','2026-09')['expense_classifications'],[])
        self.assertEqual(self.c.execute('SELECT count(*) FROM vouchers').fetchone()[0],0)

    def test_provisional_ratio_suggestion_is_saved_as_classification(self):
        p={'client_id':1,'account_name':'本方公司','transactions':[
            {'date':'2026-09-01','amount':'100000','note':'收款','counterparty':'客户'},
            {'date':'2026-09-02','amount':'-20000','note':'服务费','counterparty':'供应商'}],
           'invoices':[{'date':'2026-09-02','amount':'20000','seller':'供应商','buyer':'本方公司',
                        'number':'COST-1','item_name':'服务费','net_amount':'20000','tax_amount':'0'}],
           'evidence':[{}, {'bank_account_code':'1002'}]}
        row=batch.auto_post(self.c,p,self.user)['rows'][1]
        self.assertEqual(row['classification']['rule_suggestion']['account_code'],'5401')
        self.assertEqual(row['status'],'expense_classified')
        self.assertEqual(row['classification']['account_code'],'5401')
        retried=batch.retry_saved(self.c,1,self.user)['rows'][0]
        self.assertEqual(retried['status'],'expense_classified')
        self.assertEqual(self.c.execute('SELECT count(*) FROM vouchers').fetchone()[0],0)

    def test_changed_invoice_purpose_replaces_old_ratio_suggestion(self):
        p={'client_id':1,'account_name':'本方公司','transactions':[
            {'date':'2026-09-01','amount':'100000','note':'收款','counterparty':'客户'},
            {'date':'2026-09-02','amount':'-20000','note':'服务费','counterparty':'供应商'}],
           'invoices':[{'date':'2026-09-02','amount':'20000','seller':'供应商','buyer':'本方公司',
                        'number':'CHANGED','item_name':'服务费','net_amount':'20000','tax_amount':'0'}]}
        first=batch.auto_post(self.c,p,self.user)['rows'][1]
        self.assertEqual(first['expense_classification']['account_code'],'5401')
        p['invoices'][0].update(item_name='咨询',business_purpose='行政管理用途')
        corrected=batch.auto_post(self.c,p,self.user)['rows'][1]
        self.assertEqual(corrected['id'],first['id'])
        self.assertEqual(corrected['expense_classification']['account_code'],'5602')
        row=finance.balance_bundle(self.c,1,'2026-09','2026-09')['expense_classifications'][0]
        self.assertEqual(row['account_code'],'5602')

    def test_changed_batch_ratio_recomputes_suggestion(self):
        p={'client_id':1,'account_name':'本方公司','transactions':[
            {'date':'2026-09-01','amount':'100000','note':'收款','counterparty':'客户'},
            {'date':'2026-09-02','amount':'-20000','note':'服务费','counterparty':'供应商'}],
           'invoices':[{'date':'2026-09-02','amount':'20000','seller':'供应商','buyer':'本方公司',
                        'number':'CHANGED-RATIO','item_name':'服务费','net_amount':'20000','tax_amount':'0'}]}
        first=batch.auto_post(self.c,p,self.user)['rows'][1]
        self.assertEqual(first['expense_classification']['account_code'],'5401')
        p['transactions'][0]['amount']='1000000'
        corrected=batch.auto_post(self.c,p,self.user)['rows'][1]
        self.assertEqual(corrected['id'],first['id'])
        self.assertEqual(corrected['expense_classification']['account_code'],'5602')

    def test_invalid_invoice_amounts_and_liabilities_stay_pending(self):
        for number, net, tax in [('bad-sum','90','99'),('invalid','not-a-number','10')]:
            p=self.payload(); p['invoices'][0].update(number=number,net_amount=net,tax_amount=tax)
            p['transactions'][0]['note']=number
            result=batch.auto_post(self.c,p,self.user)['rows'][0]
            self.assertEqual(result['status'],'saved_pending')
            self.assertIn('不一致',result['reason'])
        p=self.payload(); p['invoices'][0]['number']='liability'; p['transactions'][0]['note']='liability'
        p['evidence']=[{'treatment':'recognize_invoice','business_account_code':'2202','evidence_note':'用户选择应付'}]
        self.assertEqual(batch.auto_post(self.c,p,self.user)['rows'][0]['status'],'saved_pending')
        self.assertEqual(finance.balance_bundle(self.c,1,'2026-09','2026-09')['expense_classifications'],[])

    def test_asset_purchase_is_allowed_as_business_classification(self):
        p=self.payload(); p['evidence']=[{'treatment':'recognize_invoice','business_account_code':'1601','evidence_note':'核实购入固定资产'}]
        row=batch.auto_post(self.c,p,self.user)['rows'][0]
        self.assertEqual(row['status'],'expense_classified')
        self.assertEqual(row['expense_classification']['account_code'],'1601')

    def test_automatic_proposal_and_multi_period_subset(self):
        p=self.payload(); t,i=self.item(2,'10'); p['transactions'].append(dict(t,amount='-120.00')); p['invoices'].append(dict(i,amount='120.00',net_amount='120.00'))
        p['evidence'].append({'bank_account_code':'1002'})
        p['transactions'].append(dict(t,date='2026-10-02',amount='-300.00',note='待配对')); p['invoices'].append(dict(i,number='extra',amount='200.00',seller='其他供应商'))
        out=batch.preview(self.c,p)
        self.assertEqual([x['status'] for x in out['rows']],['expense_classified','expense_classified','review'])
        self.assertTrue(out['unmatched_invoices'])
        result=batch.save_batch(self.c,{**p,'confirmed':True,'preview_token':out['preview_token'],'selected_indices':[0,1]},self.user)
        self.assertEqual(result['periods'],['2026-09','2026-10']); self.assertEqual(len(result['results']),2)
        rows=finance.balance_bundle(self.c,1,'2026-09','2026-10')['expense_classifications']
        self.assertEqual([(x['account_code'],x['amount_fen']) for x in rows],[('5602',10000),('5602',12000)])
        self.assertEqual(self.c.execute('SELECT count(*) FROM vouchers').fetchone()[0],0)
    def test_contract_prepayment_and_atomic_failure(self):
        p=self.payload();p['transactions'][0]['note']='合同约定预付服务款';p['evidence']=[{'treatment':'contract_prepayment','bank_account_code':'1002','evidence_note':'核对合同'}]
        out=batch.preview(self.c,p); self.assertEqual(out['rows'][0]['status'],'ready');self.assertEqual(out['rows'][0]['voucher']['lines'][0]['counterparty_parent_code'],'1123')
        with finance._write(self.c):
            finance._insert_voucher(self.c,1,'2026-08-01','已用上级',[finance._entry('1123',5000),finance._entry('1002',credit=5000)],self.user)
        # Existing parent is rejected by account creation with no partial save.
        out=batch.preview(self.c,p)
        self.assertEqual(out['rows'][0]['status'],'review')
        with self.assertRaises(db.ApiError): batch.save_batch(self.c,{**p,'confirmed':True,'preview_token':out['preview_token']},self.user)
        self.assertEqual(self.c.execute('SELECT count(*) FROM reconciliation_records').fetchone()[0],0)
        self.assertEqual(self.c.execute('SELECT count(*) FROM vouchers').fetchone()[0],1)
    def test_multiple_prepayments_create_company_details(self):
        p=self.payload(); p['transactions'][0]['note']='合同预付第一笔'; p['evidence']=[{'treatment':'contract_prepayment','bank_account_code':'1002','evidence_note':'核对合同'}]
        t,i=self.item(2,'10'); t['note']='合同预付第二笔'; t['amount']='-120.00'; i['amount']='120.00'; i['net_amount']='120.00'
        p['transactions'].append(t); p['invoices'].append(i)
        p['evidence'].append({'treatment':'contract_prepayment','bank_account_code':'1002','evidence_note':'核对合同'})
        out=batch.preview(self.c,p); self.assertEqual([r['status'] for r in out['rows']],['ready','ready'])
        result=batch.save_batch(self.c,{**p,'confirmed':True,'preview_token':out['preview_token']},self.user)
        self.assertEqual([r['posted_lines'][0]['account_code'] for r in result['results']],['112301','112301'])

    def test_history_requires_matching_business_and_checks_outstanding(self):
        with finance._write(self.c):
            a=finance._create_account(self.c,1,{'parent_code':'2202','name':'供应商'},self.user)
            finance._insert_voucher(self.c,1,'2026-08-01','原应付款',[finance._entry('5602',10000),finance._entry(a['code'],credit=10000)],self.user)
        p=self.payload(); p['evidence']=[{'treatment':'settle_payable','bank_account_code':'1002','evidence_note':'核对原凭证','settlement_account_code':a['code']}]
        out=batch.preview(self.c,p);saved=batch.save_batch(self.c,{**p,'confirmed':True,'preview_token':out['preview_token']},self.user)
        with self.c: self.c.execute('UPDATE vouchers SET reviewed=1 WHERE id=?',(saved['results'][0]['voucher_id'],))
        t,i=self.item(2,'10'); t['note']='采购1'
        later={'client_id':1,'account_name':'本方公司','transactions':[t],'invoices':[i],
               'evidence':[{'treatment':'settle_payable','bank_account_code':'1002','settlement_account_code':a['code'],'evidence_note':'核对原凭证'}]}
        result=batch.preview(self.c,later)['rows'][0]
        self.assertEqual(result['status'],'review'); self.assertIn('余额不足',result['reason'])

    def test_history_requires_a_reviewed_voucher(self):
        p=self.payload(); result=batch.auto_post(self.c,p,self.user)
        record_id=result['rows'][0]['id']
        with finance._write(self.c):
            vid=finance._insert_voucher(self.c,1,'2026-09-01','采购',[finance._entry('5602',10000),finance._entry('1002',credit=10000)],self.user,'reconciliation',record_id)
        t,i=self.item(2,'10'); t['note']='采购1'
        bank=batch._leaf(self.c,1,'1002')
        self.assertIsNone(batch._history(self.c,1,t,i,bank,t['date']))
        with self.c: self.c.execute('UPDATE vouchers SET reviewed=1 WHERE id=?',(vid,))
        self.assertIsNotNone(batch._history(self.c,1,t,i,bank,t['date']))

    def test_payable_settlement_checks_actual_outstanding(self):
        with finance._write(self.c):
            a=finance._create_account(self.c,1,{'parent_code':'2202','name':'供应商'},self.user)
            finance._insert_voucher(self.c,1,'2026-08-01','原应付款',[finance._entry('5602',10000),finance._entry(a['code'],credit=10000)],self.user)
        p=self.payload()
        self.assertEqual(batch.preview(self.c,p)['rows'][0]['status'],'expense_classified')
        p['evidence']=[{'treatment':'settle_payable','bank_account_code':'1002','evidence_note':'核对原凭证及发票','settlement_account_code':a['code']}]
        out=batch.preview(self.c,p); self.assertEqual(out['rows'][0]['status'],'ready')
        result=batch.save_batch(self.c,{**p,'confirmed':True,'preview_token':out['preview_token']},self.user)
        trial={x['account_code']:x for x in finance.balance_bundle(self.c,1,'2026-09','2026-09')['trial_balance']}
        self.assertEqual(trial[a['code']]['closing_credit_fen'],0)
        self.assertEqual(result['results'][0]['posted_lines'][0]['account_code'],a['code'])

    def test_invoice_recognition_rejects_unsubstantiated_receivable_payable_and_payroll_accounts(self):
        t,i=self.item()
        for code in ('1122','1123','2202','2211','2241'):
            lines,reasons,_=batch._draft(self.c,1,t,i,{'status':'suggested','account_code':code}, {'bank_account_code':'1002'})
            self.assertEqual(lines,[],code)
            self.assertTrue(any('往来或负债' in reason for reason in reasons),code)

    def test_nonzero_tax_is_classified_as_gross_without_creating_tax_lines(self):
        p=self.payload(); p['invoices'][0]['net_amount']='90.00'; p['invoices'][0]['tax_amount']='10.00'
        self.assertEqual(batch.preview(self.c,p)['rows'][0]['status'],'expense_classified')
        p['evidence']=[{'treatment':'recognize_invoice','evidence_note':'核对用于行政管理并可抵扣','tax_account_code':'2221','tax_treatment':'deductible_input'}]
        out=batch.preview(self.c,p); self.assertEqual(out['rows'][0]['status'],'expense_classified')
        result=batch.save_batch(self.c,{**p,'confirmed':True,'preview_token':out['preview_token']},self.user)
        self.assertEqual(len(result['results']),1)
        self.assertEqual(finance.balance_bundle(self.c,1,'2026-09','2026-09')['expense_classifications'][0]['amount_fen'],10000)
        self.assertEqual(self.c.execute('SELECT count(*) FROM voucher_lines').fetchone()[0],0)

    def test_second_item_failure_rolls_back_entire_batch(self):
        p=self.payload(); t,i=self.item(2); p['transactions'].append(dict(t,counterparty='另一公司')); p['invoices'].append(dict(i,seller='另一公司'))
        p['evidence'].append({'bank_account_code':'1002'})
        out=batch.preview(self.c,p); self.assertEqual([r['status'] for r in out['rows']],['expense_classified','expense_classified'])
        store=batch._store_match
        def fail_second(conn,payload,draft,row,user):
            if row['transaction_index']==1: raise db.ApiError(409,'模拟保存失败')
            return store(conn,payload,draft,row,user)
        with patch.object(batch,'_store_match',side_effect=fail_second):
            with self.assertRaises(db.ApiError): batch.save_batch(self.c,{**p,'confirmed':True,'preview_token':out['preview_token']},self.user)
        self.assertEqual(self.c.execute('SELECT count(*) FROM vouchers').fetchone()[0],0)
        self.assertEqual(self.c.execute('SELECT count(*) FROM reconciliation_records').fetchone()[0],0)

    def test_review_tax_direction_and_stale_preview(self):
        p=self.payload(); p['invoices'][0]['tax_amount']=''; self.assertEqual(batch.preview(self.c,p)['rows'][0]['status'],'expense_classified')
        p=self.payload(); p['transactions'][0]['direction_needs_review']=True; self.assertEqual(batch.preview(self.c,p)['rows'][0]['status'],'review')
        p=self.payload(); out=batch.preview(self.c,p); p['transactions'][0]['note']='修改后'
        with self.assertRaises(db.ApiError): batch.save_batch(self.c,{**p,'confirmed':True,'preview_token':out['preview_token']},self.user)
        self.assertEqual(self.c.execute('SELECT count(*) FROM vouchers').fetchone()[0],0)

    def test_auto_posts_supported_ocr_and_leaves_uncertain_unposted(self):
        p=self.payload(); p['account_needs_review']=True
        p['transactions'][0]['needs_review']=True; p['invoices'][0]['needs_review']=True
        t,i=self.item(2,'10'); t['direction_needs_review']=True
        t['amount']='-120.00'; i['amount']='120.00'; i['net_amount']='120.00'
        p['transactions'].append(t); p['invoices'].append(i)
        p['evidence'].append({'bank_account_code':'1002'})
        result=batch.auto_post(self.c,p,self.user)
        self.assertEqual([r['status'] for r in result['rows']],['expense_classified','review'])
        self.assertIn('方向',result['rows'][1]['reason'])
        self.assertEqual(result['invoice_verification'],'not_checked')
        self.assertEqual(result['human_review'],'not_performed')
        rows=finance.balance_bundle(self.c,1,'2026-09','2026-09')['expense_classifications']
        self.assertEqual(rows[0]['amount_fen'],10000)
        again=batch.auto_post(self.c,p,self.user)
        self.assertEqual(again['rows'][0]['status'],'expense_classified')
        self.assertEqual(again['rows'][0]['id'],result['rows'][0]['id'])
        self.assertEqual(self.c.execute('SELECT count(*) FROM reconciliation_records').fetchone()[0],1)
        self.assertEqual(self.c.execute('SELECT count(*) FROM vouchers').fetchone()[0],0)

    def test_auto_rechecks_each_row_after_previous_post(self):
        p=self.payload(); t,i=self.item(2); t['counterparty']='另一公司'; i['seller']='另一公司'
        p['transactions'].append(t); p['invoices'].append(i)
        p['evidence'].append({'bank_account_code':'1002'})
        result=batch.auto_post(self.c,p,self.user)
        self.assertEqual([r['status'] for r in result['rows']],['expense_classified','expense_classified'])
        again=batch.auto_post(self.c,p,self.user)
        self.assertEqual([r['id'] for r in again['rows']],[r['id'] for r in result['rows']])
        self.assertEqual(self.c.execute('SELECT count(*) FROM reconciliation_records').fetchone()[0],2)
        self.assertEqual(self.c.execute('SELECT count(*) FROM vouchers').fetchone()[0],0)

    def test_auto_does_not_post_ambiguous_or_tax_without_basis(self):
        p=self.payload(); p['invoices'].append(dict(p['invoices'][0],number='other'))
        self.assertEqual(batch.auto_post(self.c,p,self.user)['rows'][0]['status'],'review')
        p=self.payload(); p['invoices'][0].update(net_amount='90.00',tax_amount='10.00')
        self.assertEqual(batch.auto_post(self.c,p,self.user)['rows'][0]['status'],'expense_classified')
        self.assertEqual(self.c.execute('SELECT count(*) FROM vouchers').fetchone()[0],0)

    def test_ocr_without_invoice_purpose_uses_explicit_note_and_keeps_evidence(self):
        items=[{'text':s,'x':x,'y':y} for s,x,y in [
            ('发票号码:12345678',10,10),('开票日期:2026-09-01',10,20),
            ('名称:本方公司',10,30),('名称:供应商',70,30),
            ('*咨询服务*咨询',10,40),('不含税金额:100.00',10,50),
            ('税额合计:0.00',10,60),('小写:100.00',10,70)]]
        fields=reconciliation_ocr.parse_invoice(items,100,100)
        self.assertEqual(fields['business_purpose'],'')
        bank={'account_name':'本方公司','transactions':[{'date':'2026-09-01','amount':'-100.00',
              'counterparty':'供应商','description':'咨询费，行政管理用途','direction_needs_review':False}]}
        img={'name':'bank.png','content_base64':base64.b64encode(b'image').decode()}
        inv=dict(img,name='invoice.png')
        side=[({'ok':True,'fields':bank},''),({'ok':True,'fields':fields,'orientation_confident':True},'')]
        with patch.object(reconciliation.OCRWorker,'run',side_effect=side):
            parsed=reconciliation.parse({'statement':img,'invoices':[inv]})
        p={'client_id':1,'account_name':parsed['account_name'],'transactions':parsed['transactions'],'invoices':parsed['invoices'],'evidence':[{'bank_account_code':'1002'}]}
        self.assertEqual(p['invoices'][0]['business_purpose'],'')
        result=batch.auto_post(self.c,p,self.user)
        self.assertEqual(result['rows'][0]['status'],'expense_classified')
        stored=self.c.execute('SELECT transaction_json,invoice_json FROM reconciliation_records').fetchone()
        self.assertEqual(json.loads(stored['transaction_json'])['note'],'咨询费，行政管理用途')
        self.assertEqual(json.loads(stored['invoice_json'])['business_purpose'],'')
        detail=json.loads(self.c.execute("SELECT detail FROM audit_logs WHERE action='reconcile_auto_classification'").fetchone()[0])
        self.assertEqual(detail['raw_note'],'咨询费，行政管理用途')
        self.assertIn('purchase_admin',detail['rule_ids'])
        classified=finance.balance_bundle(self.c,1,'2026-09','2026-09')['expense_classifications']
        self.assertEqual([(x['account_code'],x['amount_fen']) for x in classified],[('5602',10000)])

    def test_note_use_requires_explicit_positive_consistent_evidence(self):
        p=self.payload(); p['invoices'][0]['business_purpose']=''
        for note in ('不属于行政管理用途','可能，行政管理用途','行政管理用途，销售推广用途','行政管理用途，实际为销售用途'):
            p['transactions'][0]['note']=note
            self.assertEqual(batch.preview(self.c,p)['rows'][0]['status'],'review',note)
        self.assertEqual(self.c.execute('SELECT count(*) FROM vouchers').fetchone()[0],0)

    def test_advertising_is_candidate_until_use_is_explicit(self):
        p=self.payload(); p['invoices'][0].update(item_name='*广告服务*广告费',business_purpose='')
        p['transactions'][0]['note']='广告费'
        classes=reconciliation.match(p['transactions'],p['invoices'],'本方公司',conn=self.c,client_id=1)['classification_invoices'][0]
        self.assertEqual(classes['status'],'review')
        self.assertEqual({x['account_name'] for x in classes['candidates']},{'管理费用','销售费用'})
        self.assertEqual(batch.preview(self.c,p)['rows'][0]['status'],'expense_classified')
        p['transactions'][0]['note']='销售广告费'
        draft=batch.preview(self.c,p)['rows'][0]
        self.assertEqual(draft['classification']['account_name'],'销售费用')
        result=batch.auto_post(self.c,p,self.user)
        self.assertEqual(result['rows'][0]['status'],'expense_classified')
        self.assertEqual(result['rows'][0]['classification']['account_name'],'销售费用')
        self.assertEqual(result['rows'][0]['expense_classification']['account_code'],'5601')
        evidence=json.loads(self.c.execute("SELECT detail FROM audit_logs WHERE action='reconcile_auto_classification'").fetchone()[0])
        self.assertEqual(evidence['raw_note'],'销售广告费')
        self.assertEqual(evidence['source_urls'],[__import__('account_rules').SOURCE])

    def test_pending_match_reused_after_supplement_without_duplicate_post(self):
        p=self.payload(); p['invoices'][0].update(item_name='服务费',business_purpose='',net_amount='90.00',tax_amount='99.00')
        first=batch.auto_post(self.c,p,self.user)['rows'][0]
        self.assertEqual(first['status'],'saved_pending')
        self.assertEqual(self.c.execute('SELECT count(*) FROM vouchers').fetchone()[0],0)
        p['invoices'][0].update(net_amount='100.00',tax_amount='0.00')
        p['evidence']=[{'treatment':'recognize_invoice','business_account_code':'5602','evidence_note':'核实管理部门咨询服务'}]
        second=batch.auto_post(self.c,p,self.user)['rows'][0]
        self.assertEqual(second['status'],'expense_classified'); self.assertEqual(second['id'],first['id'])
        self.assertEqual(second['expense_classification']['account_code'],'5602')
        self.assertEqual(batch.auto_post(self.c,p,self.user)['rows'][0]['id'],first['id'])
        self.assertEqual(self.c.execute('SELECT count(*) FROM reconciliation_records').fetchone()[0],1)
        self.assertEqual(self.c.execute('SELECT count(*) FROM vouchers').fetchone()[0],0)
        self.assertIn('user_selected_account',self.c.execute("SELECT detail FROM audit_logs WHERE action='reconcile_auto_classification'").fetchone()[0])

    def test_existing_record_with_changed_core_cannot_be_reused(self):
        p=self.payload(); p['invoices'][0]['net_amount']=''
        self.assertEqual(batch.auto_post(self.c,p,self.user)['rows'][0]['status'],'expense_classified')
        p['transactions'][0]['note']='不同的交易摘要'
        self.assertEqual(batch.auto_post(self.c,p,self.user)['rows'][0]['status'],'review')
        self.assertEqual(self.c.execute('SELECT count(*) FROM vouchers').fetchone()[0],0)

    def test_manual_account_requires_evidence_and_valid_business_leaf(self):
        p=self.payload(); p['invoices'][0].update(item_name='服务费',business_purpose='')
        for choice in ({'treatment':'recognize_invoice','business_account_code':'1002','evidence_note':'管理用途'},
                       {'treatment':'recognize_invoice','business_account_code':'5602','evidence_note':''},
                       {'business_account_code':'5602','evidence_note':'管理用途'}):
            p['evidence']=[choice]
            self.assertEqual(batch.preview(self.c,p)['rows'][0]['status'],'review')
        self.assertEqual(self.c.execute('SELECT count(*) FROM vouchers').fetchone()[0],0)

    def test_classification_uses_only_matched_transaction_note(self):
        p=self.payload(); p['invoices'][0].update(item_name='咨询服务',business_purpose='')
        p['transactions'][0]['note']='行政管理用途'
        result=reconciliation.match(p['transactions'],p['invoices'],'本方公司',conn=self.c,client_id=1)
        self.assertEqual(result['classification_transactions'][0]['account_code'],'5602')
        self.assertEqual(result['classification_invoices'][0]['status'],'review')
        posted=batch.auto_post(self.c,p,self.user)['rows'][0]
        self.assertEqual(posted['status'],'expense_classified')
        self.assertEqual(posted['expense_classification']['account_code'],'5602')

    def test_pending_evidence_and_reason_survive_reopen_and_can_resume(self):
        p=self.payload(); p['invoices'][0].update(item_name='服务费',business_purpose='',net_amount='90.00',tax_amount='99.00')
        evidence={'treatment':'recognize_invoice','business_account_code':'5602','evidence_note':'管理部门咨询服务'}
        p['evidence']=[evidence]
        first=batch.auto_post(self.c,p,self.user)['rows'][0]
        self.assertEqual(first['status'],'saved_pending')
        self.c.close(); self.c=db.connect(self.path)
        stored=reconciliation.records(self.c,1)['records'][0]
        self.assertEqual(stored['id'],first['id']); self.assertEqual(stored['evidence'],evidence)
        self.assertEqual(stored['batch_metadata']['classification']['account_code'],'5602')
        self.assertIn('不含税金额',stored['batch_metadata']['reason'])
        self.assertIsNone(stored['voucher_id'])
        p['invoices'][0].update(net_amount='100.00',tax_amount='0.00')
        p['evidence']=[stored['evidence']]
        posted=batch.auto_post(self.c,p,self.user)['rows'][0]
        self.assertEqual(posted['status'],'expense_classified'); self.assertEqual(posted['id'],first['id'])
        self.assertEqual(self.c.execute('SELECT count(*) FROM vouchers').fetchone()[0],0)

    def test_cleared_evidence_does_not_reappear_after_invoice_change(self):
        p=self.payload(); p['invoices'][0].update(item_name='服务费',business_purpose='',net_amount='90.00',tax_amount='99.00')
        p['evidence']=[{'treatment':'recognize_invoice','business_account_code':'5602','evidence_note':'管理部门咨询'}]
        self.assertEqual(batch.auto_post(self.c,p,self.user)['rows'][0]['status'],'saved_pending')
        p['invoices'][0]['item_name']='广告服务'; p['evidence']=[{}]
        self.assertEqual(batch.auto_post(self.c,p,self.user)['rows'][0]['status'],'saved_pending')
        self.c.close(); self.c=db.connect(self.path)
        record=reconciliation.records(self.c,1)['records'][0]
        self.assertEqual(record['evidence'],{})
        self.assertIsNone(record['voucher_id'])

    def test_incompatible_standard_does_not_auto_post(self):
        with self.c: self.c.execute("UPDATE clients SET standard='enterprise2007' WHERE id=1")
        result=batch.auto_post(self.c,self.payload(),self.user)
        self.assertEqual(result['rows'][0]['status'],'review')
        self.assertIn('小企业会计准则',result['rows'][0]['reason'])
        self.assertEqual(self.c.execute('SELECT count(*) FROM vouchers').fetchone()[0],0)
        self.assertEqual(self.c.execute('SELECT standard FROM clients WHERE id=1').fetchone()[0],'enterprise2007')
if __name__=='__main__': unittest.main()

