"""Atomic batch deletion of balance-table sources using temporary books only."""
import json
import os
import tempfile
import threading
import unittest

import db
import finance
import server


class BalanceBatchDeleteTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.path=os.path.join(self.tmp.name,'balance-delete.sqlite3')
        db.initialize(self.path)
        self.conn=db.connect(self.path)
        self.user={'id':1,'username':'tester','name':'测试员'}
        with self.conn:
            self.conn.execute("INSERT INTO users(id,username,name,password_hash) VALUES(1,'tester','测试员','unused')")
            for cid in (1,2):
                self.conn.execute("INSERT INTO clients(id,name,code,taxpayer_type,standard,start_period,created_at,updated_at) VALUES(?,?,?,'small','small2013','2026-01',?,?)",
                                  (cid,f'合成账套{cid}',f'BATCH{cid}',db.now(),db.now()))
                finance.ensure_book(self.conn,dict(self.conn.execute('SELECT * FROM clients WHERE id=?',(cid,)).fetchone()))
        self.record_number=0

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def call(self,route,payload,cid=1):
        return finance.handle(self.conn,'POST',f'/api/books/{cid}/{route}',payload,self.user,{})

    def delete(self,entries,reason='保存错误，删除',cid=1):
        if isinstance(entries,list):
            tokens={}; prepared=[]
            for entry in entries:
                if isinstance(entry,dict) and set(entry) in ({'voucher_id'},{'record_id'}):
                    key=next(iter(entry)); value=entry[key]
                    if type(value) is int and 0<value<=9223372036854775807:
                        cache_key=(key,value)
                        if cache_key not in tokens:
                            table='vouchers' if key=='voucher_id' else 'reconciliation_records'
                            row=self.conn.execute('SELECT * FROM '+table+' WHERE id=?',(value,)).fetchone()
                            tokens[cache_key]=finance._balance_delete_token('voucher' if key=='voucher_id' else 'record',row) if row else '0'*64
                        entry={**entry,'delete_token':tokens[cache_key]}
                prepared.append(entry)
            entries=prepared
        return self.call('balance-entries/delete-batch',{'entries':entries,'reason':reason},cid)

    def actual_balance(self):
        return finance.handle(self.conn,'GET','/api/books/1/balance',{},self.user,
                              {'start':'2026-09','end':'2026-09','basis':'actual'})

    def voucher(self,cid=1,date='2026-09-10',source='manual',sid=None):
        with finance._write(self.conn):
            return finance._insert_voucher(self.conn,cid,date,'合成测试凭证',
                                          [finance._entry('1002',10000),finance._entry('5001',credit=10000)],
                                          self.user,source,sid)

    def record(self,cid=1,date='2026-09-10',status='matched'):
        self.record_number+=1
        transaction={'date':date,'amount':'-100.00','counterparty':'合成供应商'}
        invoice={'date':date,'number':f'DEL-{self.record_number}'}
        metadata={'expense_classification':{'direction':'expense','account_code':'5602','amount_fen':10000,'date':date}}
        with self.conn:
            cur=self.conn.execute("INSERT INTO reconciliation_records(client_id,invoice_number,transaction_json,invoice_json,account_name,status,review_note,user_id,created_at,transaction_key,batch_metadata_json) VALUES(?,?,?,?,?,?,'',1,?,?,?)",
                                  (cid,invoice['number'],json.dumps(transaction),json.dumps(invoice),'合成公司',status,
                                   db.now(),f'delete-test-{self.record_number}',json.dumps(metadata)))
        return cur.lastrowid

    def snapshot(self):
        tables=('vouchers','voucher_lines','reconciliation_records','journals','inventory_items',
                'inventory_movements','assets','asset_depreciations','payroll','audit_logs')
        return {table:[tuple(row) for row in self.conn.execute('SELECT * FROM '+table+' ORDER BY id')] for table in tables}

    def assertRejected(self,status,entries,message=None,reason='保存错误，删除'):
        before=self.snapshot()
        with self.assertRaises(db.ApiError) as error:
            self.delete(entries,reason)
        self.assertEqual(status,error.exception.status,error.exception.message)
        if message: self.assertIn(message,error.exception.message)
        self.assertEqual(before,self.snapshot(),'Failed batches must preserve sources, versions and audit history.')

    def assertRawRejected(self,status,entries,message=None):
        before=self.snapshot()
        with self.assertRaises(db.ApiError) as error:
            self.call('balance-entries/delete-batch',{'entries':entries,'reason':'保存错误，删除'})
        self.assertEqual(status,error.exception.status,error.exception.message)
        if message: self.assertIn(message,error.exception.message)
        self.assertEqual(before,self.snapshot())

    def test_mixed_sources_deduplicate_and_keep_voucher_lines_and_audit(self):
        manual=self.voucher()
        journal=self.call('journals',{'date':'2026-09-11','summary':'合成收款','bank_account':'1002',
                                     'counter_account':'1122','direction':'income','amount_fen':25000,'cashflow_category':'operating'})
        bank=self.call(f'journals/{journal["id"]}/post',{'version':1})['voucher_id']
        record=self.record(status='reviewed')
        old_lines=[tuple(row) for row in self.conn.execute('SELECT * FROM voucher_lines ORDER BY id')]
        old_audits=self.conn.execute('SELECT COUNT(*) FROM audit_logs').fetchone()[0]
        result=self.delete([{'voucher_id':manual},{'voucher_id':bank},{'voucher_id':manual},
                            {'record_id':record},{'record_id':record}])
        self.assertEqual((3,2,1,5),(result['deleted_count'],result['voucher_count'],result['record_count'],result['requested_count']))
        self.assertEqual(3,len(result['results']))
        self.assertEqual(['void','void'],[row['status'] for row in self.conn.execute('SELECT status FROM vouchers ORDER BY id')])
        self.assertEqual(old_lines,[tuple(row) for row in self.conn.execute('SELECT * FROM voucher_lines ORDER BY id')])
        self.assertIsNone(self.conn.execute('SELECT voucher_id FROM journals WHERE id=?',(journal['id'],)).fetchone()[0])
        self.assertIsNone(self.conn.execute('SELECT id FROM reconciliation_records WHERE id=?',(record,)).fetchone())
        self.assertGreater(self.conn.execute('SELECT COUNT(*) FROM audit_logs').fetchone()[0],old_audits)
        self.assertFalse(finance.balance_bundle(self.conn,1,'2026-09','2026-09')['balance_details'])

    def test_linked_record_and_multiple_lines_remove_one_voucher(self):
        record=self.record()
        vid=self.voucher(source='reconciliation',sid=record)
        result=self.delete([{'record_id':record},{'voucher_id':vid},{'voucher_id':vid},{'record_id':record}])
        self.assertEqual((1,1,0),(result['deleted_count'],result['voucher_count'],result['record_count']))
        self.assertEqual([{'voucher_id':vid,'status':'void'}],result['results'])
        self.assertIsNone(self.conn.execute('SELECT id FROM reconciliation_records WHERE id=?',(record,)).fetchone())
        self.assertEqual(2,self.conn.execute('SELECT COUNT(*) FROM voucher_lines WHERE voucher_id=?',(vid,)).fetchone()[0])

    def test_reviewed_voucher_rejects_the_whole_selection(self):
        blocked=self.voucher()
        valid=self.voucher()
        with self.conn: self.conn.execute('UPDATE vouchers SET reviewed=1 WHERE id=?',(blocked,))
        self.assertRejected(409,[{'voucher_id':valid},{'voucher_id':blocked}],'审核')

    def test_closed_period_protects_vouchers_and_unposted_classifications(self):
        blocked=self.voucher(date='2026-08-10')
        record=self.record(date='2026-08-10')
        valid=self.voucher(date='2026-10-10')
        with self.conn: self.conn.execute("INSERT INTO book_periods(client_id,period,closed) VALUES(1,'2026-09',1)")
        self.assertRejected(409,[{'voucher_id':valid},{'voucher_id':blocked}],'已结账')
        self.assertRejected(409,[{'voucher_id':valid},{'record_id':record}],'已结账')

    def test_cross_book_and_missing_ids_do_not_change_either_book(self):
        valid=self.voucher()
        other=self.voucher(cid=2)
        other_record=self.record(cid=2)
        for target in ({'voucher_id':other},{'record_id':other_record},{'voucher_id':999999},{'record_id':999999}):
            with self.subTest(target=target):
                self.assertRejected(404,[{'voucher_id':valid},target])

    def test_closing_and_already_void_vouchers_are_protected(self):
        closing=self.voucher(source='closing',sid='2026-09')
        valid=self.voucher()
        self.assertRejected(409,[{'voucher_id':valid},{'voucher_id':closing}],'反结账')
        void=self.voucher()
        self.call('balance-entries/delete',{'voucher_id':void,'reason':'测试作废'})
        self.assertRejected(409,[{'voucher_id':valid},{'voucher_id':void}],'作废')

    def test_active_record_requires_its_voucher_to_be_selected(self):
        record=self.record()
        self.voucher(source='reconciliation',sid=record)
        valid=self.voucher()
        self.assertRejected(409,[{'voucher_id':valid},{'record_id':record}],'同时选择')

    def test_invalid_payloads_and_reasons_are_rejected_before_deletion(self):
        valid=self.voucher()
        invalid_entries=(None,{},[],[None],[{}],[{'line_id':1}],[{'voucher_id':valid,'record_id':1}],
                         [{'voucher_id':valid,'extra':True}],[{'voucher_id':True}],[{'voucher_id':'1'}],
                         [{'voucher_id':0}],[{'record_id':-1}],[{'voucher_id':2**63}],
                         [{'voucher_id':valid}]*5001)
        for entries in invalid_entries:
            with self.subTest(entries=str(entries)[:100]): self.assertRejected(400,entries)
        for reason in (None,42,'','  ','字'*501):
            with self.subTest(reason=str(reason)[:20]): self.assertRejected(400,[{'voucher_id':valid}],reason=reason)
        before=self.snapshot()
        with self.assertRaises(db.ApiError) as error:
            self.call('balance-entries/delete-batch',['invalid'])
        self.assertEqual(400,error.exception.status)
        self.assertEqual(before,self.snapshot())

    def test_missing_record_date_is_rejected_only_for_batch(self):
        record=self.record(date='')
        self.assertRejected(409,[{'record_id':record}],'日期缺失')
        # Preserve the established single-record endpoint's behavior.
        self.assertEqual('deleted',self.call('balance-entries/delete',{'record_id':record,'reason':'删除错误记录'})['status'])

    def test_maximum_selection_size_is_accepted_and_deduplicated(self):
        vid=self.voucher()
        result=self.delete([{'voucher_id':vid}]*5000)
        self.assertEqual((1,5000),(result['deleted_count'],result['requested_count']))

    def test_actual_balance_exposes_stable_tokens_for_persisted_sources(self):
        self.call('opening',{'version':1,'balances':[{'account_code':'1002','debit_fen':1000},
                                                   {'account_code':'3001','credit_fen':1000}]})
        vid=self.voucher()
        rid=self.record()
        details=self.actual_balance()['balance_details']
        vouchers=[row for row in details if row.get('voucher_id')==vid]
        records=[row for row in details if row.get('record_id')==rid]
        self.assertEqual(2,len(vouchers))
        self.assertEqual(1,len({row['delete_token'] for row in vouchers}))
        self.assertEqual(1,len(records))
        for row in vouchers+records: self.assertRegex(row['delete_token'],r'^[0-9a-f]{64}$')
        for row in details:
            if row['source_type']=='opening_balance': self.assertNotIn('delete_token',row)
        second=self.actual_balance()['balance_details']
        self.assertEqual([row.get('delete_token') for row in details],[row.get('delete_token') for row in second])
        # Standard reports retain their read-only contract after adding source tokens.
        standard=finance.handle(self.conn,'GET','/api/books/1/balance',{},self.user,
                                {'start':'2026-09','end':'2026-09','basis':'standard'})
        self.assertTrue(all(row['read_only'] for row in standard['balance_details']))
        for row in standard['balance_details']:
            if row.get('is_projection'): self.assertNotIn('delete_token',row)

    def test_raw_missing_invalid_and_conflicting_tokens_reject_the_whole_batch(self):
        vid=self.voucher()
        row=next(row for row in self.actual_balance()['balance_details'] if row.get('voucher_id')==vid)
        self.assertRawRejected(400,[{'voucher_id':vid}],'删除校验')
        for token in (None,True,1,'','a'*63,'A'*64,'g'*64,'a'*65):
            with self.subTest(token=token):
                self.assertRawRejected(400,[{'voucher_id':vid,'delete_token':token}],'校验标记')
        self.assertRawRejected(409,[{'voucher_id':vid,'delete_token':'0'*64}],'刷新')
        self.assertRawRejected(409,[{'voucher_id':vid,'delete_token':row['delete_token']},
                                    {'voucher_id':vid,'delete_token':'0'*64}],'刷新')

    def test_voucher_edited_after_actual_balance_preview_rejects_whole_batch(self):
        changed=self.voucher()
        untouched=self.voucher()
        details=self.actual_balance()['balance_details']
        entries=[{'voucher_id':vid,'delete_token':next(row['delete_token'] for row in details if row.get('voucher_id')==vid)}
                 for vid in (untouched,changed)]
        voucher=finance._voucher(self.conn,1,changed)
        finance.handle(self.conn,'PATCH',f'/api/books/1/vouchers/{changed}',
                       {'version':voucher['version'],'date':voucher['date'],'summary':'另一人已修改',
                        'lines':voucher['lines']},self.user,{})
        self.assertRejected(409,entries,'刷新')
        fresh=next(row for row in self.actual_balance()['balance_details'] if row.get('voucher_id')==changed)
        self.assertNotEqual(entries[1]['delete_token'],fresh['delete_token'])

    def test_record_edited_after_actual_balance_preview_rejects_whole_batch(self):
        vid=self.voucher()
        rid=self.record()
        details=self.actual_balance()['balance_details']
        voucher=next(row for row in details if row.get('voucher_id')==vid)
        record=next(row for row in details if row.get('record_id')==rid)
        entries=[{'voucher_id':vid,'delete_token':voucher['delete_token']},
                 {'record_id':rid,'delete_token':record['delete_token']}]
        # Even a non-presentation source field invalidates the persisted-row token.
        with self.conn: self.conn.execute('UPDATE reconciliation_records SET review_note=? WHERE id=?',('另一人已补充核对说明',rid))
        self.assertRejected(409,entries,'刷新')
        fresh=next(row for row in self.actual_balance()['balance_details'] if row.get('record_id')==rid)
        self.assertNotEqual(record['delete_token'],fresh['delete_token'])

    def test_unknown_source_after_a_valid_deletion_rolls_back_everything(self):
        blocked=self.voucher(source='unknown',sid='test-unknown')
        valid=self.voucher()
        # The newer valid voucher is processed first; source failure must undo it.
        self.assertRejected(409,[{'voucher_id':blocked},{'voucher_id':valid}],'该来源不能')

    def test_source_withdrawal_and_audit_are_rolled_back_on_later_dependency(self):
        item=self.call('inventory/items',{'sku':'BATCH-ROLLBACK','name':'合成商品','unit':'件'})
        older=self.call('inventory/movements',{'item_id':item['id'],'date':'2026-09-01','direction':'in','quantity':'3','amount_fen':10000,'version':1})
        self.call('inventory/movements',{'item_id':item['id'],'date':'2026-09-02','direction':'out','quantity':'1','version':2})
        journal=self.call('journals',{'date':'2026-09-11','summary':'合成收款','bank_account':'1002',
                                     'counter_account':'1122','direction':'income','amount_fen':25000,'cashflow_category':'operating'})
        bank=self.call(f'journals/{journal["id"]}/post',{'version':1})['voucher_id']
        self.assertRejected(409,[{'voucher_id':older['voucher_id']},{'voucher_id':bank}],'最近流水')

    def test_inventory_dependencies_are_withdrawn_newest_first(self):
        item=self.call('inventory/items',{'sku':'BATCH-INVENTORY','name':'合成商品','unit':'件'})
        older=self.call('inventory/movements',{'item_id':item['id'],'date':'2026-09-10','direction':'in','quantity':'3','amount_fen':10000,'version':1})
        # Same-day dependencies still follow posting IDs, regardless of UI order.
        newer=self.call('inventory/movements',{'item_id':item['id'],'date':'2026-09-10','direction':'out','quantity':'1','version':2})
        result=self.delete([{'voucher_id':older['voucher_id']},{'voucher_id':newer['voucher_id']}])
        self.assertEqual(2,result['deleted_count'])
        current=self.conn.execute('SELECT quantity,value_fen FROM inventory_items WHERE id=?',(item['id'],)).fetchone()
        self.assertEqual(('0',0),tuple(current))
        self.assertEqual(2,self.conn.execute("SELECT COUNT(*) FROM inventory_movements WHERE status='void'").fetchone()[0])

    def test_payroll_payment_is_withdrawn_before_accrual(self):
        self.call('payroll',{'period':'2026-09','employee_name':'合成员工','gross_fen':100000,'expense_account':'5602'})
        accrued=self.call('payroll/post',{'period':'2026-09'})['voucher_id']
        paid=self.call('payroll/pay',{'period':'2026-09','date':'2026-09-30'})['voucher_id']
        self.assertEqual(2,self.delete([{'voucher_id':accrued},{'voucher_id':paid}])['deleted_count'])
        row=self.conn.execute('SELECT voucher_id,payment_voucher_id FROM payroll').fetchone()
        self.assertEqual((None,None),tuple(row))


class BalanceBatchDeleteHTTPTests(unittest.TestCase):
    def setUp(self):
        from test_http import Client
        self.tmp=tempfile.TemporaryDirectory(prefix='ydz-balance-batch-http-')
        self.app=server.Application(self.tmp.name)
        self.http=server.make_server('127.0.0.1',0,self.app)
        self.thread=threading.Thread(target=self.http.serve_forever,daemon=True)
        self.thread.start()
        self.client=Client(f'http://127.0.0.1:{self.http.server_address[1]}')
        users=[{'username':f'batch{i}','name':f'合成操作员{i}','password':f'BatchOnly-{i}-Strong!'} for i in range(1,4)]
        code,body,_=self.client.call('/api/setup',{'company_name':'合成测试机构','users':users},
                                     headers={'X-Setup-Token':self.app.setup_token})
        self.assertEqual(200,code,body)
        code,body,_=self.client.call('/api/clients',{'name':'批量删除合成客户','code':'BATCH-HTTP',
                                                    'taxpayer_type':'small','standard':'small2013','start_period':'2026-01',
                                                    'industry':'商务服务','region':'本地','accountant_id':1,'enabled':True})
        self.assertEqual(200,code,body)
        self.cid=body['id']

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=3)
        self.tmp.cleanup()

    def test_authenticated_http_batch_requires_current_tokens_and_is_atomic(self):
        from test_http import Client
        root=f'/api/books/{self.cid}'
        payload={'date':'2026-09-10','summary':'合成HTTP凭证',
                 'lines':[{'account_code':'1002','debit_fen':10000},{'account_code':'5001','credit_fen':10000}]}
        vouchers=[]
        for _ in range(2):
            code,voucher,_=self.client.call(root+'/vouchers',payload)
            self.assertEqual(200,code,voucher)
            vouchers.append(voucher)
        report_url=root+'/balance?start=2026-09&end=2026-09&basis=actual'
        code,report,_=self.client.call(report_url)
        self.assertEqual(200,code,report)
        entries=[{'voucher_id':voucher['id'],'delete_token':next(row['delete_token'] for row in report['balance_details']
                                                               if row.get('voucher_id')==voucher['id'])} for voucher in vouchers]
        endpoint=root+'/balance-entries/delete-batch'
        body={'entries':entries,'reason':'HTTP合成删除测试'}
        self.assertEqual(401,Client(self.client.base).call(endpoint,body)[0])
        self.assertEqual(403,self.client.call(endpoint,body,csrf=False)[0])
        self.assertEqual(400,self.client.call(endpoint,{'entries':[{'voucher_id':vouchers[0]['id']}],'reason':body['reason']})[0])
        code,edited,_=self.client.call(root+f'/vouchers/{vouchers[1]["id"]}',
                                       {**payload,'version':vouchers[1]['version'],'summary':'另一操作员的新版本'},method='PATCH')
        self.assertEqual(200,code,edited)
        code,error,_=self.client.call(endpoint,body)
        self.assertEqual(409,code,error)
        self.assertIn('刷新',error['error'])
        code,book,_=self.client.call(root+'?period=2026-09')
        self.assertEqual(200,code,book)
        self.assertEqual(2,len([voucher for voucher in book['vouchers'] if voucher['status']=='active']))
        code,fresh,_=self.client.call(report_url)
        self.assertEqual(200,code,fresh)
        current={row['voucher_id']:row['delete_token'] for row in fresh['balance_details'] if row.get('voucher_id')}
        selected=[{'voucher_id':vid,'delete_token':token} for vid,token in current.items()]
        code,result,_=self.client.call(endpoint,{'entries':selected+[selected[0]],'reason':body['reason']})
        self.assertEqual(200,code,result)
        self.assertEqual((2,2,3),(result['deleted_count'],result['voucher_count'],result['requested_count']))
        code,empty,_=self.client.call(report_url)
        self.assertEqual(200,code,empty)
        self.assertEqual([],empty['balance_details'])


if __name__=='__main__':
    unittest.main()
