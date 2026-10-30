"""Reconciliation transport tests against a temporary production database."""
from contextlib import closing
from pathlib import Path
import sys
import base64
import time
from unittest.mock import patch
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import db
import server
from test_http import Client


class ReconciliationHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ydz-reconcile-http-')
        self.app = server.Application(self.temp.name)
        self.http = server.make_server('127.0.0.1', 0, self.app)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.client = Client(f'http://127.0.0.1:{self.http.server_address[1]}')
        users = [{'username': f'reconcile{i}', 'name': f'合成操作员{i}', 'password': f'ReconcileOnly-{i}-Strong!'} for i in range(1, 4)]
        code, body, _ = self.client.call('/api/setup', {'company_name': '合成测试机构', 'users': users}, headers={'X-Setup-Token': self.app.setup_token})
        self.assertEqual(code, 200, body)
        code, body, _ = self.client.call('/api/clients', {'name': '合成客户公司', 'code': 'RECON-1', 'taxpayer_type': 'general', 'standard': 'small2013', 'start_period': '2026-01', 'industry': '商务服务', 'region': '本地', 'accountant_id': 1, 'enabled': True})
        self.assertEqual(code, 200, body)
        self.cid = body['id']

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=3)
        self.temp.cleanup()

    def test_progress_http_authentication_and_result(self):
        import reconciliation
        entry={'name':'invoice.jpg','content_base64':base64.b64encode(b'image').decode()}
        result={'ok':True,'orientation_candidates_tried':2,'orientation_confident':True,'fields':{'invoice_number':'123'}}
        with patch.object(reconciliation.OCRWorker,'run',return_value=(result,'')):
            code,started,_=self.client.call('/api/reconcile/parse/start',{'client_id':self.cid,'invoices':[entry]})
            self.assertEqual(code,200,started)
            for _ in range(100):
                code,status,_=self.client.call('/api/reconcile/parse/progress?job_id='+started['job_id'])
                if status.get('status')!='running': break
                time.sleep(.01)
            self.assertEqual(code,200,status)
            self.assertEqual(status['status'],'completed')
            self.assertEqual(status['files'][0]['pages'][0]['orientation_passes'],2)
            self.assertEqual(status['result']['invoices'][0]['number'],'123')
            other=Client(self.client.base)
            self.assertEqual(other.call('/api/reconcile/parse/progress?job_id='+started['job_id'])[0],401)
            code,_,_=other.call('/api/login',{'username':'reconcile2','password':'ReconcileOnly-2-Strong!'})
            self.assertEqual(code,200)
            self.assertEqual(other.call('/api/reconcile/parse/progress?job_id='+started['job_id'])[0],404)

    def test_rules_query_is_authenticated_and_uses_book_accounts(self):
        other=Client(self.client.base)
        self.assertEqual(other.call('/api/reconcile/account-rules?q=')[0],401)
        code,out,_=self.client.call(f'/api/reconcile/account-rules?client_id={self.cid}&q=5602')
        self.assertEqual(code,200,out)
        self.assertEqual([(r['account_code'],r['account_name']) for r in out['rules']],[('5602','管理费用')])
        self.assertIn('kjs.mof.gov.cn',out['rules'][0]['source_url'])
        code,out,_=self.client.call('/api/reconcile/account-rules?q='+'x'*101)
        self.assertEqual(code,400,out)
        self.assertEqual(self.client.call('/api/reconcile/account-rules?client_id=999999')[0],404)

    def test_ocr_batch_match_save_and_duplicate(self):
        txs = [
            {'date':'2026-09-09','amount':'-112000.00','counterparty':'合成供应商','note':'服务费','source':'流水.png','needs_review':True},
            {'date':'2026-09-17','amount':'-103000.00','counterparty':'合成供应商','note':'服务费','source':'流水.png','needs_review':True},
        ]
        ivs = [
            {'date':'2026-09-08','amount':'112000.00','seller':'合成供应商','buyer':'合成客户公司','number':'SYNTH-001','source':'票1.png','needs_review':True},
            {'date':'2026-09-17','amount':'103000.00','seller':'合成供应商','buyer':'合成客户公司','number':'SYNTH-002','source':'票2.png','needs_review':True},
        ]
        batch = {'transactions':txs, 'invoices':ivs, 'account_name':'合成客户公司', 'account_needs_review':True}
        code, out, _ = self.client.call('/api/reconcile/match', batch)
        self.assertEqual(code, 200, out)
        self.assertEqual([(m['transaction_index'],m['invoice_index'],m['status']) for m in out['matches']], [(0,0,'matched'),(1,1,'matched')])
        payloads = []
        for n in range(2):
            payload = {'client_id':self.cid, 'account_name':batch['account_name'], 'account_needs_review':True,
                       'transaction':txs[n], 'invoice':ivs[n],
                       'batch':{'transactions':txs,'invoices':ivs,'transaction_index':n,'invoice_index':n}}
            payloads.append(payload)
            code, saved, _ = self.client.call('/api/reconcile/save', payload)
            self.assertEqual(code, 200, saved)
            self.assertEqual(saved['status'], 'matched')
            self.assertNotIn('voucher_id', saved)
        code, records, _ = self.client.call(f'/api/reconcile/records?client_id={self.cid}')
        self.assertEqual(code, 200, records)
        self.assertEqual({row['invoice']['number'] for row in records['records']}, {'SYNTH-001','SYNTH-002'})
        self.assertEqual(self.client.call('/api/reconcile/save', payloads[0])[0], 409)
        with closing(db.connect(self.app.db_path)) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM reconciliation_records').fetchone()[0], 2)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0], 0)
        ambiguous = dict(batch, invoices=[ivs[0], dict(ivs[0], number='SYNTH-003')])
        result = self.client.call('/api/reconcile/match', ambiguous)[1]['matches'][0]
        self.assertEqual(result['status'], 'review')
        self.assertIsNone(result['invoice_index'])
        difference = dict(batch, transactions=[txs[0]], invoices=[dict(ivs[0], amount='112000.01')])
        result = self.client.call('/api/reconcile/match', difference)[1]['matches'][0]
        self.assertEqual(result['status'], 'review')
        self.assertIn('金额不一致', result['reasons'])

    def test_confirmed_voucher_http_requires_lines_and_posts_once(self):
        t={'date':'2026-09-09','amount':'-100.00','counterparty':'合成供应商','note':'付款','source':'流水.png'}
        i={'date':'2026-09-08','amount':'100.00','seller':'合成供应商','buyer':'合成客户公司','number':'HTTP-POST-1','source':'发票.png'}
        p={'client_id':self.cid,'account_name':'合成客户公司','transaction':t,'invoice':i,'batch':{'transactions':[t],'invoices':[i],'transaction_index':0,'invoice_index':0}}
        code,saved,_=self.client.call('/api/reconcile/save',p); self.assertEqual(code,200,saved)
        rid=saved['id']; path=f'/api/reconcile/records/{rid}/post'
        code,_,_=self.client.call(path,{'client_id':self.cid,'bank_account':'1002'},csrf=False); self.assertEqual(code,403)
        code,posted,_=self.client.call(path,{'client_id':self.cid,'bank_account':'1002'}); self.assertEqual(code,400,posted)
        self.assertIn('完整凭证分录',posted['error'])
        v={'date':'2026-09-09','summary':'确认的付款','lines':[{'account_code':'5602','debit_fen':10000,'credit_fen':0},{'account_code':'1002','debit_fen':0,'credit_fen':10000}]}
        code,posted,_=self.client.call(path,{'client_id':self.cid,'voucher':v}); self.assertEqual(code,200,posted)
        code,retry,_=self.client.call(path,{'client_id':self.cid,'voucher':v}); self.assertEqual(code,200,retry)
        self.assertTrue(retry['already_posted']); self.assertEqual(retry['voucher_id'],posted['voucher_id'])
        code,history,_=self.client.call(f'/api/reconcile/records?client_id={self.cid}'); self.assertEqual(code,200,history)
        self.assertEqual(history['records'][0]['voucher_id'],posted['voucher_id']); self.assertEqual(history['records'][0]['posting_status'],'posted')
        with closing(db.connect(self.app.db_path)) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0],1)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM voucher_lines').fetchone()[0],2)

    def test_auto_match_http_posts_once_and_updates_numbered_all_book_balance(self):
        t={'date':'2026-09-09','amount':'-100.00','counterparty':'合成供应商','note':'采购','source':'流水.png','needs_review':True}
        i={'date':'2026-09-08','amount':'100.00','seller':'合成供应商','buyer':'合成客户公司','number':'AUTO-1','source':'发票.png','needs_review':True,'item_name':'咨询','business_purpose':'行政管理用途','net_amount':'100.00','tax_amount':'0.00'}
        p={'client_id':self.cid,'account_name':'合成客户公司','account_needs_review':True,'transactions':[t],'invoices':[i]}
        self.assertEqual(self.client.call('/api/reconcile/batch-auto',p,csrf=False)[0],403)
        code,out,_=self.client.call('/api/reconcile/batch-auto',p)
        self.assertEqual(code,200,out); self.assertEqual(out['rows'][0]['status'],'posted')
        record_id=out['rows'][0]['id']
        voucher_id=out['rows'][0]['voucher_id']
        self.assertEqual('2026-09',out['rows'][0]['period'])
        self.assertEqual('automatic_default',out['rows'][0]['automatic_posting']['funding_source'])
        self.assertEqual((10000,10000),(sum(line['debit_fen'] for line in out['rows'][0]['posted_lines']),sum(line['credit_fen'] for line in out['rows'][0]['posted_lines'])))
        self.assertEqual(out['invoice_verification'],'not_checked')
        code,retry,_=self.client.call('/api/reconcile/batch-auto',p)
        self.assertEqual(code,200,retry); self.assertEqual(retry['rows'][0]['status'],'posted')
        self.assertEqual(retry['rows'][0]['id'],record_id)
        self.assertEqual(retry['rows'][0]['voucher_id'],voucher_id)
        self.assertTrue(retry['rows'][0]['already_posted'])
        with closing(db.connect(self.app.db_path)) as conn:
            import finance
            bundle=finance.balance_bundle(conn,self.cid,'2026-09','2026-09')
            trial={x['account_code']:x for x in bundle['trial_balance_rollup']}
            self.assertEqual(trial['5602']['debit_fen'],10000)
            self.assertEqual(trial['1002']['credit_fen'],10000)
            self.assertEqual([],bundle['expense_classifications'])
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0],1)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM reconciliation_records').fetchone()[0],1)
        code,total,_=self.client.call(f'/api/books/{self.cid}/balance?scope=all&start=2026-01&end=2026-01')
        self.assertEqual(code,200,total)
        self.assertEqual(('all',True,'2026-01','2026-09'),(total['scope'],total['all_book'],total['start_period'],total['end_period']))
        categories=[row for row in total['category_rows'] if row.get('is_category') and row['original_account_code'].startswith('5602')]
        self.assertEqual(10000,sum(row['debit_fen'] for row in categories if row['is_leaf']))
        self.assertTrue(all(row['account_code'].startswith(row['parent_code']) and len(row['account_code'])==len(row['parent_code'])+2 for row in categories))
        self.assertEqual({'debit_fen':10000,'credit_fen':10000},{key:total['totals'][key] for key in ('debit_fen','credit_fen')})

if __name__ == '__main__':
    unittest.main()
