"""Batch matching, real postings, manual drafts and durable evidence."""
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
        t,i=self.item(); return {'client_id':1,'account_name':'本方公司','transactions':[t],'invoices':[i],'evidence':[{'bank_account_code':'1002'}]}
    def auto(self,p): return batch.auto_post(self.c,p,self.user)['rows'][0]
    def posted(self,row,amount=10000,account='5602',incoming=False,tax=0):
        self.assertEqual('posted',row['status'],row)
        lines=finance._voucher(self.c,1,row['voucher_id'])['lines']
        self.assertEqual((amount,amount),(sum(x['debit_fen'] for x in lines),sum(x['credit_fen'] for x in lines)))
        self.assertEqual(amount if incoming else -amount,sum(x['debit_fen']-x['credit_fen'] for x in lines if x['account_code'].startswith(('1001','1002'))))
        if account: self.assertEqual(amount-tax,sum(x['credit_fen'] if incoming else x['debit_fen'] for x in lines if x['account_code'].startswith(account)))
        self.assertEqual(tax,sum(x['credit_fen'] if incoming else x['debit_fen'] for x in lines if x['account_code'].startswith('2221')))
        return lines
    def count(self,table): return self.c.execute('SELECT COUNT(*) FROM '+table).fetchone()[0]
    def report(self,start='2026-09',end='2026-09'):
        return finance.balance_bundle(self.c,1,start,end)
    def strict(self,p,classification=None):
        return batch._draft(self.c,1,p['transactions'][0],p['invoices'][0],classification or {'status':'suggested','account_code':'5602'},p.get('evidence',[{}])[0])
    def confirmed(self,p,indices=None):
        out=batch.preview(self.c,p)
        return batch.save_batch(self.c,{**p,'confirmed':True,'preview_token':out['preview_token'],**({'selected_indices':indices} if indices is not None else {})},self.user)
    def ratio(self):
        p=self.payload(); p['transactions'][0].update(date='2026-09-02',amount='-20000',note='服务费')
        p['invoices'][0].update(date='2026-09-02',amount='20000',item_name='服务费',business_purpose='',net_amount='20000')
        p['transactions'].insert(0,{'date':'2026-09-01','amount':'100000','note':'收款','counterparty':'客户'})
        p['evidence']=[{},{}]; return p
    def seed(self,p,index=0):
        row=batch.preview(self.c,p)['rows'][index]; t=p['transactions'][index]; i=p['invoices'][row['invoice_index']]
        metadata={'classification':row['classification'],'classification_inputs':batch._classification_inputs(i),'suggestion_context':p['transactions'],'evidence':p.get('evidence',[{}])[index]}
        with self.c:
            cur=self.c.execute("INSERT INTO reconciliation_records(client_id,invoice_number,transaction_json,invoice_json,account_name,status,review_note,user_id,created_at,transaction_key,batch_metadata_json) VALUES(?,?,?,?,?,'matched','',1,?,?,?)",(1,i['number'],json.dumps(t,ensure_ascii=False),json.dumps(i,ensure_ascii=False),'本方公司',db.now(),reconciliation._transaction_key(t),json.dumps(metadata,ensure_ascii=False)))
        return cur.lastrowid
    def payable(self,value=10000):
        with finance._write(self.c):
            a=finance._create_account(self.c,1,{'parent_code':'2202','name':'供应商'},self.user)
            finance._insert_voucher(self.c,1,'2026-08-01','原应付款',[finance._entry('5602',value),finance._entry(a['code'],credit=value)],self.user)
        return a

    def test_default_funding_posts_real_voucher(self):
        p=self.payload(); p['evidence']=[]; preview=batch.preview(self.c,p)['rows'][0]
        self.assertEqual('ready',preview['status']); self.assertEqual(0,self.count('vouchers'))
        row=self.auto(p); self.posted(row)
        self.assertEqual('automatic_default',row['automatic_posting']['funding_source'])
        self.assertEqual([],self.report()['expense_classifications'])

    def test_repeated_submission_never_changes_existing_bank(self):
        p=self.payload(); first=self.auto(p); p['evidence']=[{'bank_account_code':'1001'}]; second=self.auto(p)
        self.assertEqual(first['voucher_id'],second['voucher_id']); self.assertTrue(second['already_posted'])
        self.assertEqual(1,self.count('vouchers')); self.posted(second)

    def test_retry_skips_active_voucher(self):
        row=self.auto(self.payload()); self.assertEqual([],batch.retry_saved(self.c,1,self.user)['rows'])
        self.assertEqual(1,self.count('vouchers')); self.posted(row)

    def test_non_cash_funding_choice_uses_default_bank(self):
        p=self.payload(); p['evidence']=[{'bank_account_code':'2241'}]; row=self.auto(p); self.posted(row)
        self.assertEqual('1002',row['automatic_posting']['funding_account_code'])

    def test_balance_uses_posted_period_and_isolates_books(self):
        self.posted(self.auto(self.payload()))
        rows={x['account_code']:x for x in self.report()['trial_balance_rollup']}
        self.assertEqual(10000,rows['5602']['debit_fen'])
        october={x['account_code']:x for x in self.report('2026-10','2026-10')['trial_balance_rollup']}
        self.assertEqual((10000,0),(october['5602']['opening_debit_fen'],october['5602']['debit_fen']))
        with self.c:
            self.c.execute("INSERT INTO clients(id,name,code,taxpayer_type,standard,start_period,created_at,updated_at) VALUES(2,'另一公司','T2','general','small2013','2026-01',?,?)",(db.now(),db.now()))
            finance.ensure_book(self.c,dict(self.c.execute('SELECT * FROM clients WHERE id=2').fetchone()))
        self.assertEqual(0,finance.balance_bundle(self.c,2,'2026-09','2026-09')['totals']['debit_fen'])

    def test_balance_preserves_each_transaction_counterparty(self):
        p=self.payload(); t,i=self.item(2,'10'); t['counterparty']='另一供应商'; i['seller']='另一供应商'
        p['transactions'].append(t); p['invoices'].append(i); p['evidence'].append({})
        saved=batch.auto_post(self.c,p,self.user)['rows']
        entries=[x for x in self.report('2026-09','2026-10')['balance_details'] if x['account_code'].startswith('5602')]
        self.assertEqual({x['id'] for x in saved},{x['record_id'] for x in entries})
        self.assertEqual({'供应商','另一供应商'},{x['counterparty'] for x in entries})
        with self.c: self.c.execute('UPDATE reconciliation_records SET transaction_json=? WHERE id=?',('invalid json',saved[0]['id']))
        entries=self.report('2026-09','2026-10')['balance_details']
        self.assertIn('供应商',{x['counterparty'] for x in entries})

    def test_confirmed_batch_posts_and_reports_periods(self):
        result=self.confirmed(self.payload()); self.assertEqual(['2026-09'],result['periods'])
        self.assertEqual(1,self.count('vouchers')); self.assertEqual([],self.report()['expense_classifications'])

    def test_manual_prepayment_draft_still_requires_actual_funding(self):
        p=self.payload(); p['evidence']=[{'treatment':'contract_prepayment','evidence_note':'已核实合同预付款'}]
        lines,reasons,_=self.strict(p); self.assertEqual([],lines); self.assertTrue(reasons)
        p['evidence'][0]['bank_account_code']='1002'; lines,reasons,_=self.strict(p)
        self.assertEqual([],reasons); self.assertEqual('1123',lines[0]['counterparty_parent_code'])

    def test_manual_payable_draft_checks_outstanding(self):
        a=self.payable(); p=self.payload(); p['evidence']=[{'treatment':'settle_payable','bank_account_code':'1002','settlement_account_code':a['code'],'evidence_note':'核对原凭证'}]
        lines,reasons,_=self.strict(p); self.assertEqual([],reasons); self.assertEqual(a['code'],lines[0]['account_code'])

    def test_income_posts_cash_and_revenue(self):
        p=self.payload(); p['transactions'][0].update(amount='100',counterparty='客户',note='主营业务服务')
        p['invoices'][0].update(seller='本方公司',buyer='客户',business_purpose='主营业务服务')
        self.posted(self.auto(p),account='5001',incoming=True)

    def test_business_note_does_not_block_unique_matched_payment(self):
        for index,note in enumerate(('合同预付款','结清应付账款','偿还欠款')):
            p=self.payload(); p['transactions'][0].update(note=note,date=f'2026-09-0{index+1}')
            p['invoices'][0].update(number='NOTE'+str(index),date=f'2026-09-0{index+1}')
            self.posted(self.auto(p))
        self.assertEqual(3,self.count('vouchers'))

    def test_ratio_suggestion_posts_cost(self):
        row=batch.auto_post(self.c,self.ratio(),self.user)['rows'][1]
        self.assertEqual('5401',row['classification']['account_code']); self.posted(row,2000000,'5401')
        self.assertEqual([],batch.retry_saved(self.c,1,self.user)['rows'])

    def test_posted_invoice_purpose_change_does_not_rewrite_accounting(self):
        p=self.ratio(); first=batch.auto_post(self.c,p,self.user)['rows'][1]
        p['invoices'][0].update(item_name='咨询',business_purpose='行政管理用途')
        second=batch.auto_post(self.c,p,self.user)['rows'][1]
        self.assertEqual(first['voucher_id'],second['voucher_id']); self.posted(second,2000000,'5401')
        self.assertEqual(1,self.count('vouchers'))

    def test_posted_batch_ratio_change_does_not_rewrite_accounting(self):
        p=self.ratio(); first=batch.auto_post(self.c,p,self.user)['rows'][1]; p['transactions'][0]['amount']='1000000'
        second=batch.auto_post(self.c,p,self.user)['rows'][1]
        self.assertEqual(first['voucher_id'],second['voucher_id']); self.posted(second,2000000,'5401')

    def test_invalid_net_tax_posts_gross_and_keeps_original_values(self):
        for index,(net,tax) in enumerate((('90','99'),('not-a-number','10'))):
            p=self.payload(); p['transactions'][0]['date']=f'2026-09-0{index+1}'
            p['invoices'][0].update(number='TAX'+str(index),date=f'2026-09-0{index+1}',net_amount=net,tax_amount=tax)
            row=self.auto(p); self.posted(row)
            stored=json.loads(self.c.execute('SELECT invoice_json FROM reconciliation_records WHERE id=?',(row['id'],)).fetchone()[0])
            self.assertEqual((net,tax),(stored['net_amount'],stored['tax_amount']))

    def test_selected_asset_account_receives_real_posting(self):
        p=self.payload(); p['evidence']=[{'business_account_code':'1601'}]
        self.posted(self.auto(p),account='1601')

    def test_multi_period_confirmed_subset_posts_only_selected_matches(self):
        p=self.payload(); t,i=self.item(2,'10'); t['amount']='-120'; i.update(amount='120',net_amount='120')
        p['transactions'].extend([t,dict(t,date='2026-10-02',amount='-300',note='待配对')]); p['invoices'].append(i); p['evidence'].extend([{},{}])
        preview=batch.preview(self.c,p); self.assertEqual(['ready','ready','review'],[x['status'] for x in preview['rows']])
        result=self.confirmed(p,[0,1]); self.assertEqual(['2026-09','2026-10'],result['periods'])
        self.assertEqual(2,self.count('vouchers')); self.assertEqual(22000,self.report('2026-09','2026-10')['totals']['debit_fen'])

    def test_second_item_failure_rolls_back_entire_confirmed_batch(self):
        p=self.payload(); t,i=self.item(2,'10'); p['transactions'].append(t); p['invoices'].append(i); p['evidence'].append({})
        store=batch._store_match
        def fail_second(conn,payload,draft,row,user):
            if row['transaction_index']==1: raise db.ApiError(409,'模拟保存失败')
            return store(conn,payload,draft,row,user)
        with patch.object(batch,'_store_match',side_effect=fail_second):
            with self.assertRaises(db.ApiError): self.confirmed(p)
        self.assertEqual((0,0),(self.count('vouchers'),self.count('reconciliation_records')))

    def test_manual_prepayments_resolve_same_company_detail(self):
        code=None
        for index,month in enumerate(('09','10'),1):
            t,i=self.item(index,month); p={'transactions':[t],'invoices':[i],'evidence':[{'treatment':'contract_prepayment','bank_account_code':'1002','evidence_note':'核对合同'}]}
            lines,reasons,_=self.strict(p); self.assertEqual([],reasons)
            with finance._write(self.c):
                resolved=reconciliation._resolve_voucher_lines(self.c,1,lines,t,self.user)
                finance._insert_voucher(self.c,1,t['date'],'合同预付款',resolved,self.user)
            self.assertTrue(resolved[0]['account_code'].startswith('1123'))
            if code: self.assertEqual(code,resolved[0]['account_code'])
            code=resolved[0]['account_code']

    def test_history_uses_only_reviewed_prior_voucher(self):
        row=self.auto(self.payload()); t,i=self.item(2,'10'); t['note']='采购1'; bank=batch._leaf(self.c,1,'1002')
        self.assertIsNone(batch._history(self.c,1,t,i,bank,t['date']))
        with self.c: self.c.execute('UPDATE vouchers SET reviewed=1 WHERE id=?',(row['voucher_id'],))
        self.assertIsNotNone(batch._history(self.c,1,t,i,bank,t['date']))

    def test_manual_settlement_rejects_insufficient_actual_balance(self):
        a=self.payable(5000); p=self.payload(); p['evidence']=[{'treatment':'settle_payable','bank_account_code':'1002','settlement_account_code':a['code'],'evidence_note':'核对原凭证'}]
        lines,reasons,_=self.strict(p); self.assertEqual([],lines); self.assertTrue(any('余额不足' in x for x in reasons))

    def test_manual_settlement_posts_against_existing_payable(self):
        a=self.payable(); p=self.payload(); p['evidence']=[{'treatment':'settle_payable','bank_account_code':'1002','settlement_account_code':a['code'],'evidence_note':'核对原凭证'}]
        lines,reasons,_=self.strict(p); self.assertEqual([],reasons)
        saved=reconciliation.save(self.c,{'client_id':1,'account_name':'本方公司','transaction':p['transactions'][0],'invoice':p['invoices'][0],
            'batch':{'transactions':p['transactions'],'invoices':p['invoices'],'transaction_index':0,'invoice_index':0},
            'voucher':{'date':p['transactions'][0]['date'],'summary':'明确冲销应付','lines':lines}},self.user)
        self.assertTrue(saved['voucher_id'])
        row=next(x for x in self.report()['trial_balance'] if x['account_code']==a['code'])
        self.assertEqual(0,row['closing_credit_fen'])

    def test_manual_recognition_rejects_unsubstantiated_liabilities(self):
        t,i=self.item()
        for code in ('1122','1123','2202','2211','2241'):
            lines,reasons,_=batch._draft(self.c,1,t,i,{'status':'suggested','account_code':code},{'bank_account_code':'1002'})
            self.assertEqual([],lines); self.assertTrue(any('往来或负债' in x for x in reasons))

    def test_reliable_tax_creates_actual_tax_line(self):
        p=self.payload(); p['invoices'][0].update(net_amount='90',tax_amount='10')
        row=self.auto(p); self.posted(row,tax=1000); self.assertEqual('split',row['automatic_posting']['tax_mode'])

    def test_stale_preview_is_rejected_without_writes(self):
        p=self.payload(); preview=batch.preview(self.c,p); p['transactions'][0]['note']='修改后'
        with self.assertRaises(db.ApiError): batch.save_batch(self.c,{**p,'confirmed':True,'preview_token':preview['preview_token']},self.user)
        self.assertEqual(0,self.count('vouchers'))

    def test_unique_ocr_match_posts_with_direction_and_review_flags(self):
        p=self.payload(); p['account_needs_review']=True; p['transactions'][0].update(needs_review=True,direction_needs_review=True); p['invoices'][0]['needs_review']=True
        row=self.auto(p); self.posted(row)
        self.assertEqual(1,self.count('vouchers'))

    def test_distinct_transaction_identity_posts_same_date_amount_and_repeats_once(self):
        p=self.payload(); t,i=self.item(2); t['counterparty']='另一公司'; i['seller']='另一公司'; p['transactions'].append(t); p['invoices'].append(i); p['evidence'].append({})
        result=batch.auto_post(self.c,p,self.user)['rows']; self.posted(result[0])
        self.posted(result[1]); self.assertEqual(2,self.count('vouchers'))
        self.assertNotEqual(result[0]['voucher_id'],result[1]['voucher_id'])
        repeated=batch.auto_post(self.c,p,self.user)['rows']
        self.assertEqual([row['voucher_id'] for row in result],[row['voucher_id'] for row in repeated])
        self.assertTrue(all(row['already_posted'] for row in repeated))
        self.assertEqual((2,2),(self.count('vouchers'),self.count('reconciliation_records')))

    def test_ambiguous_invoice_never_posts(self):
        p=self.payload(); p['invoices'].append(dict(p['invoices'][0],number='OTHER'))
        self.assertEqual('review',self.auto(p)['status']); self.assertEqual(0,self.count('vouchers'))

    def test_ocr_note_evidence_survives_actual_posting(self):
        items=[{'text':s,'x':x,'y':y} for s,x,y in [('发票号码:12345678',10,10),('开票日期:2026-09-01',10,20),('名称:本方公司',10,30),('名称:供应商',70,30),('*咨询服务*咨询',10,40),('不含税金额:100.00',10,50),('税额合计:0.00',10,60),('小写:100.00',10,70)]]
        fields=reconciliation_ocr.parse_invoice(items,100,100); self.assertEqual('',fields['business_purpose'])
        bank={'account_name':'本方公司','transactions':[{'date':'2026-09-01','amount':'-100.00','counterparty':'供应商','description':'咨询费，行政管理用途','direction_needs_review':False}]}
        img={'name':'bank.png','content_base64':base64.b64encode(b'image').decode()}
        with patch.object(reconciliation.OCRWorker,'run',side_effect=[({'ok':True,'fields':bank},''),({'ok':True,'fields':fields,'orientation_confident':True},'')]):
            parsed=reconciliation.parse({'statement':img,'invoices':[dict(img,name='invoice.png')]})
        p={'client_id':1,'account_name':parsed['account_name'],'transactions':parsed['transactions'],'invoices':parsed['invoices'],'evidence':[{}]}
        self.posted(self.auto(p)); stored=self.c.execute('SELECT transaction_json,invoice_json FROM reconciliation_records').fetchone()
        self.assertEqual('咨询费，行政管理用途',json.loads(stored['transaction_json'])['note']); self.assertEqual('',json.loads(stored['invoice_json'])['business_purpose'])
        evidence=json.loads(self.c.execute("SELECT detail FROM audit_logs WHERE action='reconcile_auto_classification'").fetchone()[0])
        self.assertEqual('咨询费，行政管理用途',evidence['raw_note']); self.assertIn('purchase_admin',evidence['rule_ids'])

    def test_uncertain_note_does_not_supply_explicit_use_evidence(self):
        p=self.payload(); p['invoices'][0]['business_purpose']=''
        for note in ('不属于行政管理用途','可能，行政管理用途','行政管理用途，销售推广用途','行政管理用途，实际为销售用途'):
            p['transactions'][0]['note']=note
            self.assertIsNone(batch._note_classification(self.c,1,p['transactions'][0],p['invoices'][0]))
            self.assertEqual('ready',batch.preview(self.c,p)['rows'][0]['status'])
        self.assertEqual(0,self.count('vouchers'))

    def test_advertising_note_selects_selling_cost_and_retains_evidence(self):
        p=self.payload(); p['invoices'][0].update(item_name='*广告服务*广告费',business_purpose=''); p['transactions'][0]['note']='广告费'
        classes=reconciliation.match(p['transactions'],p['invoices'],'本方公司',conn=self.c,client_id=1)['classification_invoices'][0]
        self.assertEqual('review',classes['status']); self.assertEqual({'管理费用','销售费用'},{x['account_name'] for x in classes['candidates']})
        p['transactions'][0]['note']='销售广告费'; row=self.auto(p); self.posted(row,account='5601')
        evidence=json.loads(self.c.execute("SELECT detail FROM audit_logs WHERE action='reconcile_auto_classification'").fetchone()[0])
        self.assertEqual('销售广告费',evidence['raw_note'])

    def test_legacy_matched_record_retries_once(self):
        p=self.payload(); p['invoices'][0].update(net_amount='90',tax_amount='99'); rid=self.seed(p)
        row=batch.retry_saved(self.c,1,self.user)['rows'][0]; self.assertEqual(rid,row['id']); self.posted(row)
        self.assertEqual([],batch.retry_saved(self.c,1,self.user)['rows']); self.assertEqual(1,self.count('vouchers'))

    def test_changed_core_cannot_reuse_posted_invoice(self):
        p=self.payload(); first=self.auto(p); p['transactions'][0]['note']='不同的交易摘要'
        self.assertEqual('review',self.auto(p)['status']); self.assertEqual(1,self.count('vouchers')); self.posted(first)

    def test_selected_business_leaf_and_invalid_cash_selection(self):
        p=self.payload(); p['evidence']=[{'business_account_code':'5601'}]; self.posted(self.auto(p),account='5601')
        p=self.payload(); p['transactions'][0]['date']='2026-10-01'; p['invoices'][0].update(number='F2',date='2026-10-01'); p['evidence']=[{'business_account_code':'1002'}]
        row=self.auto(p); self.posted(row,account='1221'); self.assertEqual('other_receivable_fallback',row['automatic_posting']['subject_source'])

    def test_classification_uses_only_the_matched_transaction_note(self):
        p=self.payload(); p['invoices'][0].update(item_name='咨询服务',business_purpose=''); p['transactions'][0]['note']='行政管理用途'
        result=reconciliation.match(p['transactions'],p['invoices'],'本方公司',conn=self.c,client_id=1)
        self.assertEqual('5602',result['classification_transactions'][0]['account_code']); self.assertEqual('review',result['classification_invoices'][0]['status'])
        self.posted(self.auto(p))

    def test_posting_evidence_survives_database_reopen(self):
        p=self.payload(); evidence={'business_account_code':'5602','evidence_note':'管理部门咨询服务'}; p['evidence']=[evidence]; row=self.auto(p)
        self.c.close(); self.c=db.connect(self.path); stored=reconciliation.records(self.c,1)['records'][0]
        self.assertEqual(evidence,stored['evidence']); self.assertEqual(row['voucher_id'],stored['voucher_id']); self.assertEqual('posted',stored['posting_status'])
        self.assertEqual(1,self.count('vouchers'))

    def test_posted_evidence_does_not_change_on_repeated_request(self):
        p=self.payload(); p['evidence']=[{'business_account_code':'5602','evidence_note':'原始依据'}]; first=self.auto(p)
        p['evidence']=[{}]; p['invoices'][0]['item_name']='广告服务'; second=self.auto(p)
        self.assertEqual(first['voucher_id'],second['voucher_id'])
        stored=reconciliation.records(self.c,1)['records'][0]; self.assertEqual('原始依据',stored['evidence']['evidence_note'])

    def test_enterprise_standard_posts_to_correct_actual_chart(self):
        with self.c:
            self.c.execute('DELETE FROM accounts WHERE client_id=1'); self.c.execute("UPDATE clients SET standard='enterprise2007' WHERE id=1")
            finance.ensure_book(self.c,dict(self.c.execute('SELECT * FROM clients WHERE id=1').fetchone()))
        row=self.auto(self.payload()); self.posted(row,account='6602')
        self.assertEqual('enterprise2007',self.c.execute('SELECT standard FROM clients WHERE id=1').fetchone()[0])

    def test_strict_manual_helper_still_requires_evidence_for_tax(self):
        p=self.payload(); p['invoices'][0].update(net_amount='90',tax_amount='10')
        lines,reasons,_=self.strict(p); self.assertEqual([],lines); self.assertTrue(any('税' in reason for reason in reasons))
        p['evidence'][0].update(tax_account_code='2221',tax_treatment='deductible_input')
        lines,reasons,_=self.strict(p); self.assertEqual([],reasons); self.assertEqual(3,len(lines))


if __name__=='__main__': unittest.main()
