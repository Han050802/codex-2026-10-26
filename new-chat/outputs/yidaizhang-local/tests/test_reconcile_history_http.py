"""Persistent reconciliation history, tested only against a synthetic temp DB."""
from contextlib import closing
from pathlib import Path
import sys
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
sys.path.insert(0,str(Path(__file__).resolve().parent))
import db
import finance
from test_http import Client
import test_source_archive_http as archive_fixtures


class ReconcileHistoryHTTPTests(unittest.TestCase):
    def setUp(self):
        self.fixture=archive_fixtures.SourceArchiveHTTPTests('runTest')
        self.fixture.setUp()
        self.client,self.app,self.cid,self.other_cid=(self.fixture.client,self.fixture.app,self.fixture.cid,self.fixture.other_cid)

    def tearDown(self): self.fixture.tearDown()

    def history(self,cid=None):
        code,result,_=self.client.call('/api/reconcile/records?client_id='+str(cid or self.cid))
        self.assertEqual(code,200,result)
        return result

    def receipt(self,number='HISTORY-1',date='2026-09-09',cid=None):
        cid=cid or self.cid
        own=archive_fixtures.OWN if cid==self.cid else '另一归档合成客户'
        transaction={'date':date,'amount':'-100.00','counterparty':archive_fixtures.SUPPLIER,'note':'咨询服务费','source':'历史流水.pdf'}
        receipt=dict(transaction,number=number,own_name=own,source='历史回单.pdf')
        payload={'client_id':cid,'account_name':own,'transactions':[transaction],'invoices':[],'receipts':[receipt]}
        code,result,_=self.client.call('/api/reconcile/receipt-post',payload)
        self.assertEqual(code,200,result)
        self.assertEqual(result['rows'][0]['status'],'posted',result)
        return payload,result['rows'][0]

    def insert_voucher(self,conn,cid,date,source='bank_receipt',amount=10000):
        self.synthetic_sequence=getattr(self,'synthetic_sequence',0)+1
        return finance._insert_voucher(conn,cid,date,'合成历史凭证',[
            {'account_code':'5602','debit_fen':amount,'credit_fen':0},
            {'account_code':'1002','debit_fen':0,'credit_fen':amount}],
            {'id':1,'username':'archive1'},source,'synthetic-history-'+str(self.synthetic_sequence),counterparty='合成历史对方')

    def test_receipt_only_legacy_history_is_persistent_and_read_only(self):
        payload,posted=self.receipt()
        code,repeated,_=self.client.call('/api/reconcile/receipt-post',payload)
        self.assertEqual(code,200,repeated)
        self.assertEqual(repeated['rows'][0]['voucher_id'],posted['voucher_id'])
        with closing(db.connect(self.app.db_path)) as conn:
            before=(conn.execute('SELECT COUNT(*) FROM audit_logs').fetchone()[0],conn.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0])
        first=self.history();second=self.history()
        self.assertEqual(first,second)
        self.assertEqual(first['records'],[])
        self.assertEqual(first['postings_total'],1)
        self.assertFalse(first['postings_truncated'])
        item=first['postings'][0]
        self.assertNotIn('id',item)
        self.assertEqual(item['voucher_id'],posted['voucher_id'])
        self.assertEqual((item['source_type'],item['period'],item['transaction_source']),('bank_receipt','2026-09','audit'))
        self.assertEqual(item['transaction'],payload['transactions'][0])
        self.assertEqual(item['receipt']['number'],'HISTORY-1')
        self.assertEqual(item['archive_ids'],[])
        self.assertIsNone(item['archive_id'])
        self.assertIsNone(item['record_id'])
        self.assertIsNone(item['invoice'])
        self.assertTrue(item['username'])
        self.assertEqual(sum(line['debit_fen'] for line in item['posted_lines']),10000)
        with closing(db.connect(self.app.db_path)) as conn:
            after=(conn.execute('SELECT COUNT(*) FROM audit_logs').fetchone()[0],conn.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0])
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM reconciliation_records').fetchone()[0],0)
        self.assertEqual(before,after)

    def test_receipt_then_archived_invoice_share_one_real_posting(self):
        _,receipt=self.receipt()
        parsed,_=self.fixture.parse_batch()
        invoice=self.fixture.post_batch(parsed)
        self.assertEqual(invoice['voucher_id'],receipt['voucher_id'])
        result=self.history()
        self.assertEqual(len(result['records']),1)
        self.assertEqual(len(result['postings']),1)
        item=result['postings'][0]
        self.assertEqual(item['voucher_id'],result['records'][0]['voucher_id'])
        self.assertEqual(item['record_id'],result['records'][0]['id'])
        self.assertEqual(item['archive_ids'],[parsed['archive_id']])
        self.assertEqual(item['transaction_source'],'archive')
        self.assertEqual(item['invoice']['number'],parsed['invoices'][0]['number'])
        self.assertEqual(item['receipt']['number'],'HISTORY-1')

    def test_invoice_history_keeps_original_records_and_fields(self):
        parsed,_=self.fixture.parse_batch()
        posted=self.fixture.post_batch(parsed)
        result=self.history()
        self.assertEqual(len(result['records']),1)
        self.assertEqual(len(result['postings']),1)
        item=result['postings'][0]
        self.assertEqual(item['source_type'],'reconciliation')
        self.assertEqual(item['source_id'],str(result['records'][0]['id']))
        self.assertEqual(item['voucher_id'],posted['voucher_id'])
        self.assertEqual(item['transaction'],parsed['transactions'][0])
        self.assertEqual(item['invoice']['number'],parsed['invoices'][0]['number'])
        self.assertEqual(item['archive_id'],parsed['archive_id'])
        self.assertEqual(result['records'][0]['posting_status'],'posted')
        self.assertIn('batch_metadata',result['records'][0])

    def test_history_is_cross_period_scoped_and_ignores_manual_or_void(self):
        _,august=self.receipt('AUGUST','2026-08-01')
        _,september=self.receipt('SEPTEMBER','2026-09-01')
        _,foreign=self.receipt('FOREIGN','2026-07-01',self.other_cid)
        with closing(db.connect(self.app.db_path)) as conn,finance._write(conn):
            future=self.insert_voucher(conn,self.cid,'2027-01-02')
            manual=self.insert_voucher(conn,self.cid,'2026-09-02','manual')
            withdrawn=self.insert_voucher(conn,self.cid,'2026-09-03')
            conn.execute("UPDATE vouchers SET status='void' WHERE id=?",(withdrawn,))
        result=self.history()
        self.assertEqual({item['voucher_id'] for item in result['postings']},{august['voucher_id'],september['voucher_id'],future})
        self.assertEqual({item['period'] for item in result['postings']},{'2026-08','2026-09','2027-01'})
        fallback=next(item for item in result['postings'] if item['voucher_id']==future)
        self.assertEqual(fallback['transaction_source'],'voucher')
        self.assertEqual(fallback['transaction']['amount'],'-100.00')
        self.assertEqual(fallback['archive_ids'],[])
        self.assertIsNone(fallback['receipt'])
        self.assertEqual(self.history(self.other_cid)['postings'][0]['voucher_id'],foreign['voucher_id'])
        self.assertEqual(Client(self.client.base).call('/api/reconcile/records?client_id='+str(self.cid))[0],401)
        self.assertNotIn(manual,{item['voucher_id'] for item in result['postings']})

    def test_broken_legacy_audit_falls_back_to_actual_voucher(self):
        _,posted=self.receipt()
        with closing(db.connect(self.app.db_path)) as conn,conn:
            conn.execute("UPDATE audit_logs SET detail='invalid legacy JSON' WHERE action='reconcile_receipt_post' AND entity_id=?",(str(posted['voucher_id']),))
        item=self.history()['postings'][0]
        self.assertEqual(item['transaction_source'],'voucher')
        self.assertEqual(item['transaction']['date'],'2026-09-09')
        self.assertEqual(item['transaction']['amount'],'-100.00')
        self.assertIsNone(item['receipt'])
        self.assertEqual(item['archive_ids'],[])

    def test_large_history_reports_truncation_without_duplicate_postings(self):
        with closing(db.connect(self.app.db_path)) as conn,finance._write(conn):
            for index in range(501): self.insert_voucher(conn,self.cid,'2026-09-01',amount=index+1)
        result=self.history()
        self.assertEqual(result['postings_total'],501)
        self.assertEqual(result['postings_limit'],500)
        self.assertTrue(result['postings_truncated'])
        self.assertEqual(len(result['postings']),500)
        self.assertEqual(len({item['voucher_id'] for item in result['postings']}),500)
        self.assertEqual(result['postings'][0]['voucher_id'],501)


if __name__=='__main__': unittest.main()
