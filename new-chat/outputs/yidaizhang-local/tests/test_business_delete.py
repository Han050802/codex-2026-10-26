"""Disposable-only tests for local removal, historical protection and startup."""
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import business
import db
import finance
import server


class BusinessDeleteTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'app.sqlite3'
        db.initialize(self.path);self.conn=db.connect(self.path)
        with self.conn:self.conn.execute("INSERT INTO users(username,name,password_hash) VALUES('synthetic','合成删除测试员','not-a-live-login')")
        self.user=dict(self.conn.execute('SELECT id,username,name FROM users').fetchone())
        self.client=self.call('POST','/api/clients',{'name':'合成删除测试客户','code':'DELETE-QA','start_period':'2026-01'})

    def tearDown(self):self.conn.close();self.tmp.cleanup()
    def call(self,method,path,payload):return business.handle(self.conn,method,path,payload,self.user,{})
    def tax(self):return self.call('POST','/api/tax-records',dict(client_id=self.client['id'],period='2026-01',tax_type='增值税',status='submitted',payment_status='paid',confirmation_status='confirmed',amount_fen=10000,paid_fen=10000,reference='SYNTHETIC-ACK',note='合成本地登记'))
    def invoice(self,number='DELETE-INV'):return self.call('POST','/api/invoices',dict(client_id=self.client['id'],period='2026-01',kind='expense',number=number,date='2026-01-10',amount_fen=10000,tax_fen=0,total_fen=10000))
    def recycled(self):return self.call('DELETE',f"/api/clients/{self.client['id']}",{'version':self.client['version']})

    def test_demo_startup_and_restart_do_not_seed_companies(self):
        directory=Path(self.tmp.name)/'empty-demo';demo=server.Application(directory,demo=True)
        for _ in range(2):
            conn=db.connect(demo.db_path)
            try:
                self.assertEqual(conn.execute('SELECT COUNT(*) FROM users').fetchone()[0],3)
                for table in ('clients','invoices','contracts','projects','tax_records'):
                    self.assertEqual(conn.execute('SELECT COUNT(*) FROM '+table).fetchone()[0],0)
                self.assertIsNone(conn.execute("SELECT value FROM meta WHERE key='synthetic_seeded'").fetchone())
            finally:conn.close()
            demo=server.Application(directory,demo=True)

    def test_tax_soft_delete_keeps_evidence_and_allows_same_key_again(self):
        old=self.tax()
        with self.assertRaises(db.ApiError) as result:self.call('DELETE',f"/api/tax-records/{old['id']}",{'version':0})
        self.assertEqual(result.exception.status,409)
        removed=self.call('DELETE',f"/api/tax-records/{old['id']}",{'version':old['version']})
        self.assertEqual(removed['external_action'],'none');self.assertEqual(removed['deleted'],1)
        self.assertEqual(business.bootstrap(self.conn,'2026-01',False)['tax_records'],[])
        stored=self.conn.execute('SELECT * FROM tax_records WHERE id=?',(old['id'],)).fetchone()
        self.assertEqual(stored['status'],'submitted');self.assertEqual(stored['payment_status'],'paid')
        self.assertEqual(stored['reference'],'SYNTHETIC-ACK');self.assertEqual(stored['paid_fen'],10000)
        self.assertTrue(stored['deleted_at']);replacement=self.tax();self.assertNotEqual(replacement['id'],old['id'])
        self.assertEqual(len(business.bootstrap(self.conn,'2026-01',False)['tax_records']),1)
        with self.assertRaises(sqlite3.IntegrityError):self.tax()
        exported=business.export_csv(self.conn,'tax-records',{'period':'2026-01'}).decode('utf-8-sig')
        self.assertEqual(exported.count('SYNTHETIC-ACK'),1)

    def test_notes_projects_are_versioned_soft_deletes(self):
        note=self.call('POST','/api/notes',{'client_id':self.client['id'],'text':'合成跟进历史'})
        project=self.call('POST','/api/projects',dict(client_id=self.client['id'],name='合成项目',due_date='2026-02-01',steps=[{'title':'合成已完成步骤','done':True}]))
        for kind,item in [('notes',note),('projects',project)]:
            removed=self.call('DELETE',f"/api/{kind}/{item['id']}",{'version':item['version']})
            self.assertEqual(removed['version'],item['version']+1)
            self.assertEqual(removed['deleted'],1)
            self.assertEqual(business.bootstrap(self.conn,'2026-01',False)[kind],[])
            self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM '+kind).fetchone()[0],1)
            self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM audit_logs WHERE entity=? AND action='delete'",(kind,)).fetchone()[0],1)

    def test_contract_with_receipt_or_reversal_is_blocked(self):
        payload=dict(client_id=self.client['id'],service='合成服务',start_period='2026-01',end_period='2026-12',monthly_fee_fen=10000)
        empty=self.call('POST','/api/contracts',payload)
        self.call('DELETE',f"/api/contracts/{empty['id']}",{'version':empty['version']})
        with self.assertRaises(db.ApiError):self.call('POST','/api/receipts',{'contract_id':empty['id'],'date':'2026-01-01','amount_fen':10000})
        contract=self.call('POST','/api/contracts',payload)
        receipt=self.call('POST','/api/receipts',{'contract_id':contract['id'],'date':'2026-01-01','amount_fen':10000})
        for reversed_already in (False,True):
            with self.assertRaises(db.ApiError) as result:self.call('DELETE',f"/api/contracts/{contract['id']}",{'version':contract['version']})
            self.assertEqual(result.exception.status,409);self.assertTrue(result.exception.details['blocked'])
            if not reversed_already:self.call('POST',f"/api/receipts/{receipt['id']}/reverse",{'version':receipt['version'],'date':'2026-01-02','note':'合成冲销'})
        with self.assertRaises(db.ApiError) as result:self.call('DELETE',f"/api/receipts/{receipt['id']}",{'version':2})
        self.assertEqual(result.exception.details['reason'],'receipt_immutable')

    def test_posted_invoice_must_withdraw_before_delete_and_ledger_stays(self):
        invoice=self.invoice();posted=self.call('POST',f"/api/invoices/{invoice['id']}/post",{'version':invoice['version'],'debit_account':'5602','credit_account':'1002'})
        with self.assertRaises(db.ApiError) as result:self.call('DELETE',f"/api/invoices/{invoice['id']}",{'version':posted['version']})
        self.assertEqual(result.exception.status,409);self.assertEqual(result.exception.details['next_action'],'withdraw_source')
        voucher=self.conn.execute('SELECT * FROM vouchers WHERE id=?',(posted['voucher_id'],)).fetchone()
        with self.conn:finance.withdraw_source(self.conn,self.client['id'],voucher['id'],self.user,'合成来源纠错',voucher['version'])
        reverted=business.fetched(self.conn,'invoices',invoice['id'])
        self.call('DELETE',f"/api/invoices/{invoice['id']}",{'version':reverted['version']})
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM invoices').fetchone()[0],0)
        self.assertEqual(self.conn.execute('SELECT status FROM vouchers WHERE id=?',(voucher['id'],)).fetchone()[0],'void')

    def test_legacy_tax_unique_migration_preserves_rows_and_foreign_keys(self):
        record=self.tax();columns=[r['name'] for r in self.conn.execute('PRAGMA table_info(tax_records)') if r['name'] not in ('deleted','deleted_at')]
        values=list(self.conn.execute('SELECT '+','.join(columns)+' FROM tax_records').fetchone())
        with self.conn:
            self.conn.execute('DROP TABLE tax_records')
            self.conn.execute("CREATE TABLE tax_records(id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES clients(id),period TEXT NOT NULL,tax_type TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',payment_status TEXT NOT NULL DEFAULT 'unpaid',confirmation_status TEXT NOT NULL DEFAULT 'pending',amount_fen INTEGER NOT NULL DEFAULT 0,paid_fen INTEGER NOT NULL DEFAULT 0,reference TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT 'manual',attachment_id INTEGER REFERENCES files(id),note TEXT NOT NULL DEFAULT '',user_id INTEGER REFERENCES users(id),recorded_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,UNIQUE(client_id,period,tax_type))")
            self.conn.execute('INSERT INTO tax_records('+','.join(columns)+') VALUES('+','.join('?' for _ in columns)+')',values)
        self.conn.close();db.initialize(self.path);db.initialize(self.path);self.conn=db.connect(self.path)
        migrated=business.fetched(self.conn,'tax_records',record['id']);self.assertEqual(migrated['reference'],record['reference']);self.assertEqual(migrated['deleted'],0)
        self.call('DELETE',f"/api/tax-records/{record['id']}",{'version':record['version']});self.tax()
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM tax_records').fetchone()[0],2)
        self.assertIsNone(self.conn.execute('PRAGMA foreign_key_check').fetchone())

    def test_purge_requires_recycle_and_removes_only_untouched_empty_book(self):
        with self.assertRaises(db.ApiError) as result:self.call('POST',f"/api/clients/{self.client['id']}/purge",{'version':self.client['version']})
        self.assertEqual(result.exception.details['reason'],'client_not_recycled')
        recycled=self.recycled();result=self.call('POST',f"/api/clients/{self.client['id']}/purge",{'version':recycled['version']})
        self.assertTrue(result['purged'])
        for table,key in [('clients','id'),('accounts','client_id'),('book_settings','client_id')]:self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM '+table+' WHERE '+key+'=?',(self.client['id'],)).fetchone()[0],0)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM audit_logs WHERE action='purge'").fetchone()[0],1)

    def test_purge_blocks_soft_deleted_records_and_hard_deleted_history(self):
        invoice=self.invoice();self.call('DELETE',f"/api/invoices/{invoice['id']}",{'version':invoice['version']})
        recycled=self.recycled()
        with self.assertRaises(db.ApiError) as result:self.call('POST',f"/api/clients/{self.client['id']}/purge",{'version':recycled['version']})
        self.assertEqual(result.exception.details['reason'],'client_has_audit_history')
        restored=self.call('POST',f"/api/clients/{self.client['id']}/restore",{'version':recycled['version']});self.client=restored
        tax=self.tax();self.call('DELETE',f"/api/tax-records/{tax['id']}",{'version':tax['version']});recycled=self.recycled()
        with self.assertRaises(db.ApiError) as result:self.call('POST',f"/api/clients/{self.client['id']}/purge",{'version':recycled['version']})
        self.assertEqual(result.exception.details['reason'],'client_has_records');self.assertEqual(result.exception.details['counts']['tax_records'],1)


if __name__=='__main__':unittest.main()
