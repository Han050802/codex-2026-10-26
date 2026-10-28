"""Synthetic customer assignment metadata; it never grants/restricts access."""
import base64
import concurrent.futures
import csv
import io
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import business
import db
import finance


class ClientAssignmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'assignments.sqlite3'
        db.initialize(self.path);self.conn=db.connect(self.path)
        with self.conn:self.conn.executemany('INSERT INTO users(username,name,password_hash) VALUES(?,?,?)',[(f'assign{i}',f'合成操作员{i}','not-a-live-login') for i in range(1,4)])
        self.user=dict(self.conn.execute('SELECT id,username,name FROM users WHERE id=1').fetchone())

    def tearDown(self):self.conn.close();self.tmp.cleanup()
    def create(self,**values):return business.handle(self.conn,'POST','/api/clients',{'name':'合成分工测试','code':'ASSIGN-001','start_period':'2026-01',**values},self.user,{})
    def patch(self,item,**values):return business.handle(self.conn,'PATCH',f"/api/clients/{item['id']}",{'version':item['version'],**values},self.user,{})

    def test_assignment_roundtrip_dedup_safe_expansion_and_csv_export(self):
        item=self.create(authorized_user_ids=[3,1,3],enterprise_name='合成完整企业')
        self.assertEqual(item['authorized_user_ids'],[3,1])
        self.assertEqual(item['service_status'],'unset')
        self.assertEqual(business.bootstrap(self.conn,'2026-01',False)['clients'][0]['authorized_user_ids'],[3,1])
        self.assertEqual(finance.bundle(self.conn,item['id'],'2026-01')['client']['authorized_user_ids'],[3,1])
        self.assertNotIn('profile_json',item);self.assertNotIn('sensitive_json',item)
        stored=json.loads(self.conn.execute('SELECT profile_json FROM clients WHERE id=?',(item['id'],)).fetchone()[0])
        self.assertEqual(stored['authorized_user_ids'],[3,1])
        exported=next(csv.DictReader(io.StringIO(business.export_csv(self.conn,'clients',{}).decode('utf-8-sig'))))
        self.assertEqual(json.loads(exported['authorized_user_ids']),[3,1])

    def test_omitted_assignments_preserve_and_empty_array_clears(self):
        item=self.create(authorized_user_ids=[1,2],service_status='paused',registered_address='合成原地址')
        updated=self.patch(item,note='仅改备注')
        self.assertEqual(updated['authorized_user_ids'],[1,2]);self.assertEqual(updated['service_status'],'paused')
        cleared=self.patch(updated,authorized_user_ids=[])
        self.assertEqual(cleared['authorized_user_ids'],[]);self.assertEqual(cleared['registered_address'],'合成原地址')
        self.assertEqual(cleared['version'],item['version']+2)

    def test_assignments_validate_array_ids_count_and_enabled_user(self):
        for bad in (None,'1,2',[True],[0],[-1],[1.0],[999]):
            with self.subTest(value_type=type(bad).__name__),self.assertRaises(db.ApiError):self.create(authorized_user_ids=bad)
        with self.conn:
            self.conn.execute("INSERT INTO users(username,name,password_hash) VALUES('assign4','合成额外用户','not-a-live-login')")
        with self.assertRaises(db.ApiError):self.create(authorized_user_ids=[1,2,3,4])
        with self.conn:self.conn.execute('UPDATE users SET enabled=0 WHERE id=3')
        with self.assertRaises(db.ApiError):self.create(authorized_user_ids=[1,3])
        item=self.create(authorized_user_ids=[1,2,1]);self.assertEqual(item['authorized_user_ids'],[1,2])

    def test_assignments_do_not_restrict_third_user_edit_or_book_access(self):
        item=self.create(authorized_user_ids=[1])
        third=dict(self.conn.execute('SELECT id,username,name FROM users WHERE id=3').fetchone())
        changed=business.handle(self.conn,'PATCH',f"/api/clients/{item['id']}",{'version':item['version'],'note':'未列分工的第三用户仍可编辑'},third,{})
        self.assertEqual(changed['authorized_user_ids'],[1])
        voucher=finance.handle(self.conn,'POST',f"/api/books/{item['id']}/vouchers",{'date':'2026-01-01','summary':'合成第三操作员记账','lines':[{'account_code':'1002','debit_fen':10000,'credit_fen':0},{'account_code':'3001','debit_fen':0,'credit_fen':10000}]},third,{})
        self.assertEqual(voucher['created_by'],third['id'])
        read=finance.handle(self.conn,'GET',f"/api/books/{item['id']}",{},third,{'period':'2026-01'})
        self.assertTrue(read['reports']['balance_sheet']['balanced'])

    def test_concurrent_assignment_edits_keep_optimistic_version(self):
        item=self.create();barrier=threading.Barrier(2)
        def update(uid):
            conn=db.connect(self.path)
            try:
                barrier.wait(timeout=3)
                try:
                    result=business.handle(conn,'PATCH',f"/api/clients/{item['id']}",{'version':item['version'],'authorized_user_ids':[uid]},self.user,{})
                    return 200,result['authorized_user_ids']
                except db.ApiError as error:return error.status,None
            finally:conn.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(update,[1,2]))
        self.assertEqual(sorted(status for status,_ in results),[200,409])
        saved=business.fetched(self.conn,'clients',item['id']);self.assertEqual(saved['version'],item['version']+1)
        self.assertEqual(saved['authorized_user_ids'],next(ids for status,ids in results if status==200))

    def test_legacy_csv_and_optional_assignment_column(self):
        columns=business.TEMPLATES['clients']+['authorized_user_ids','service_status']
        out=io.StringIO(newline='');writer=csv.DictWriter(out,fieldnames=columns);writer.writeheader()
        row={k:'' for k in columns};row.update(name='合成CSV分工客户',code='ASSIGN-CSV',taxpayer_type='small',standard='small2013',start_period='2026-01',authorized_user_ids='[1,2,2]',service_status='active');writer.writerow(row)
        imported=business.import_csv(self.conn,'clients',{'filename':'assignments.csv','content_base64':base64.b64encode(out.getvalue().encode('utf-8-sig')).decode()},self.user)
        self.assertEqual(imported['imported'],1)
        saved=business.bootstrap(self.conn,'2026-01',False)['clients'][0]
        self.assertEqual(saved['authorized_user_ids'],[1,2]);self.assertEqual(saved['service_status'],'active')

    def test_service_status_enum_and_reinitialize_preserve_existing_state(self):
        item=self.create(service_status='active')
        for value in ('unset','paused','terminated','active'):
            item=self.patch(item,service_status=value);self.assertEqual(item['service_status'],value)
        with self.assertRaises(db.ApiError):self.patch(item,service_status='unknown')
        self.conn.close();db.initialize(self.path);self.conn=db.connect(self.path)
        old=business.fetched(self.conn,'clients',item['id']);self.assertEqual(old['service_status'],'active')
        new=self.create(code='ASSIGN-002');self.assertEqual(new['service_status'],'unset')


if __name__=='__main__':unittest.main()
