"""Synthetic-only profile migration, validation and non-disclosure tests."""
import base64
import concurrent.futures
import csv
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import business
import client_profile
import db


class ClientProfileTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.path=Path(self.tmp.name)/'synthetic.sqlite3'
        db.initialize(self.path);self.conn=db.connect(self.path)
        with self.conn:self.conn.execute('INSERT INTO users(username,name,password_hash) VALUES(?,?,?)',('synthetic-user','合成测试员','not-a-live-login'))
        self.user=dict(self.conn.execute('SELECT id,username,name FROM users').fetchone())

    def tearDown(self):
        self.conn.close();self.tmp.cleanup()

    def payload(self,**kwargs):
        p=dict(profile_mode=True,name='合成客户简称',enterprise_name='合成测试企业有限公司',tax_no='SYNTHETIC0000000001',
            industry='合成服务业',region='合成地区',enterprise_form='公司',filing_type='normal',accountant_id=self.user['id'],
            start_period='2026-01',standard='small2013',taxpayer_type='small',mnemonic='HC001',business_status='存续',
            established_date='2020-02-29',legal_representative='合成法人',legal_phone='13800000001',contact_name='合成联系人',
            contact_phone='13800000002',registered_address='合成注册地址',business_address='合成经营地址',business_scope='合成测试服务',
            bookkeeper='合成记账人',cashier='合成出纳',boss_name='合成老板',boss_phone='13800000003',boss_note='合成测试备注')
        p.update(kwargs);return p

    def create(self,**kwargs):return business.handle(self.conn,'POST','/api/clients',self.payload(**kwargs),self.user,{})
    def patch(self,item,**kwargs):return business.handle(self.conn,'PATCH',f"/api/clients/{item['id']}",{'version':item['version'],**kwargs},self.user,{})

    def test_public_roundtrip_partial_edit_and_book_creation(self):
        item=self.create()
        self.assertEqual(item['code'],'KH000001')
        self.assertEqual(item['enterprise_name'],'合成测试企业有限公司')
        self.assertEqual(item['mnemonic'],'HC001')
        self.assertEqual(item['filing_type'],'normal')
        self.assertGreater(self.conn.execute('SELECT COUNT(*) FROM accounts WHERE client_id=?',(item['id'],)).fetchone()[0],0)
        edited=self.patch(item,profile_mode=True,business_address='修改后的合成地址')
        self.assertEqual(edited['business_address'],'修改后的合成地址')
        self.assertEqual(edited['registered_address'],item['registered_address'])
        self.assertEqual(edited['boss_note'],item['boss_note'])
        fetched=business.fetched(self.conn,'clients',item['id'])
        self.assertNotIn('profile_json',fetched);self.assertNotIn('sensitive_json',fetched)

    def test_profile_mandatory_enum_dates_lengths_and_version(self):
        for field in ('name','enterprise_name','tax_no','industry','region','enterprise_form','filing_type','accountant_id','start_period','standard','taxpayer_type'):
            with self.subTest(field=field),self.assertRaises(db.ApiError):self.create(**{field:''})
        for changes in ({'enterprise_form':'错误类型'},{'filing_type':'tax'},{'business_status':'错误状态'},
                        {'established_date':'2025-02-29'},{'registered_address':'字'*101},{'business_address':'字'*101},
                        {'business_scope':'字'*1001},{'boss_phone':'not-a-phone'}):
            with self.subTest(fields=list(changes)),self.assertRaises(db.ApiError):self.create(**changes)
        item=self.create();edited=self.patch(item,note='合成新版')
        with self.assertRaises(db.ApiError) as result:self.patch(item,note='合成旧版')
        self.assertEqual(result.exception.status,409)
        with self.assertRaises(db.ApiError):self.patch(edited,standard='enterprise2007')
        with self.assertRaises(db.ApiError):self.patch(edited,start_period='2026-02')

    @unittest.skipUnless(os.name=='nt','Actual Windows DPAPI requires Windows')
    def test_real_dpapi_roundtrip_preserve_clear_and_no_disclosure(self):
        synthetic={'legal_id_number':'000000000000000000','contact_id_number':'111111111111111111','annual_report_password':'SyntheticOnly_Profile_Private_71!'}
        for field,value in synthetic.items():
            protected=client_profile.protect(value,field)
            self.assertTrue(client_profile._unprotect(protected,field)==value,'DPAPI roundtrip failed')
        item=self.create(**synthetic)
        for field in synthetic:
            self.assertTrue(item['private_fields'][field]['set'])
            self.assertTrue(item['private_fields'][field]['available'])
            self.assertEqual(item['private_fields'][field]['masked'],'********')
            self.assertNotIn(field,item)
        before=self.conn.execute('SELECT sensitive_json FROM clients WHERE id=?',(item['id'],)).fetchone()[0]
        edited=self.patch(item,legal_id_number='',contact_id_number='',annual_report_password='',boss_note='保留加密内容')
        after=self.conn.execute('SELECT sensitive_json FROM clients WHERE id=?',(item['id'],)).fetchone()[0]
        self.assertTrue(before==after,'Blank inputs must preserve encrypted fields')
        api=json.dumps(business.bootstrap(self.conn,'2026-01',False),ensure_ascii=False)
        exported=business.export_csv(self.conn,'clients',{}).decode('utf-8-sig')
        self.assertTrue('sensitive_json' not in api and 'profile_json' not in api,'API exposed internal JSON columns')
        self.assertTrue('dpapi-current-user-v1:' not in api,'API exposed encrypted storage')
        self.assertTrue('private_fields' not in exported and 'sensitive_json' not in exported and 'profile_json' not in exported,'CSV exposed private storage')
        for secret in synthetic.values():
            self.assertTrue(secret not in api and secret not in exported,'API/export leaked synthetic private content')
        logs=''.join(r[0] for r in self.conn.execute('SELECT detail FROM audit_logs'))
        for secret in synthetic.values():self.assertTrue(secret not in logs,'Audit leaked synthetic private content')
        self.conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        database=self.path.read_bytes()
        for secret in synthetic.values():self.assertTrue(secret.encode('utf-8') not in database,'Database contains plaintext private content')
        cleared=self.patch(edited,clear_sensitive=['legal_id_number','contact_id_number','annual_report_password'])
        self.assertTrue(all(not x['set'] for x in cleared['private_fields'].values()))

    def test_private_failure_never_falls_back_to_plaintext(self):
        with mock.patch.object(client_profile,'_libraries',side_effect=db.ApiError(503,'DPAPI unavailable')):
            with self.assertRaises(db.ApiError) as result:self.create(annual_report_password='SyntheticOnly_Unavailable!')
        self.assertEqual(result.exception.status,503)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM clients').fetchone()[0],0)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM audit_logs').fetchone()[0],0)
        self.assertEqual(self.create()['code'],'KH000001')

    @unittest.skipUnless(os.name=='nt','Actual Windows DPAPI requires Windows')
    def test_unreadable_backup_private_fields_are_visible_and_fail_closed(self):
        item=self.create(annual_report_password='SyntheticOnly_Protected!')
        with mock.patch.object(client_profile,'_unprotect',side_effect=db.ApiError(400,'Original service account required')):
            unavailable=business.fetched(self.conn,'clients',item['id'])
            self.assertTrue(unavailable['private_fields']['annual_report_password']['set'])
            self.assertFalse(unavailable['private_fields']['annual_report_password']['available'])
            self.assertIn('private_fields_notice',unavailable)
            with self.assertRaises(db.ApiError):self.patch(item,boss_note='不可静默保存不可读资料')
            cleared=self.patch(item,clear_sensitive=['annual_report_password'])
            self.assertFalse(cleared['private_fields']['annual_report_password']['set'])

    def test_legacy_crud_csv_and_old_client_profile_edit_compatible(self):
        legacy=business.handle(self.conn,'POST','/api/clients',{'name':'合成旧客户','code':'OLD-001','start_period':'2026-01'},self.user,{})
        self.assertEqual(legacy['enterprise_name'],'合成旧客户')
        edited=self.patch(legacy,profile_mode=True,boss_note='旧资料可增补，无新建必填要求')
        self.assertEqual(edited['boss_note'],'旧资料可增补，无新建必填要求')
        buffer=io.StringIO(newline='');writer=csv.DictWriter(buffer,fieldnames=business.TEMPLATES['clients'])
        writer.writeheader();writer.writerow(dict(name='合成旧模板客户',code='OLD-CSV',taxpayer_type='general',standard='enterprise2007',industry='',region='',start_period='2026-01',accountant_id='',labels='',note=''))
        result=business.import_csv(self.conn,'clients',{'filename':'old.csv','content_base64':base64.b64encode(buffer.getvalue().encode('utf-8-sig')).decode()},self.user)
        self.assertEqual(result['imported'],1)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM clients').fetchone()[0],2)

    def test_auto_code_concurrent_requests_are_unique(self):
        def create_one(index):
            conn=db.connect(self.path)
            try:
                result=business.handle(conn,'POST','/api/clients',self.payload(name='合成并发'+str(index)),self.user,{})
                return result['code']
            finally:conn.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:codes=list(pool.map(create_one,range(16)))
        self.assertEqual(len(codes),len(set(codes)))
        self.assertEqual(set(codes),{'KH'+str(x).zfill(6) for x in range(1,17)})

    def test_migration_preserves_existing_rows_and_repeats_safely(self):
        path=Path(self.tmp.name)/'pre-profile.sqlite3';conn=sqlite3.connect(path)
        conn.execute("CREATE TABLE clients(id INTEGER PRIMARY KEY,name TEXT NOT NULL,code TEXT NOT NULL UNIQUE,taxpayer_type TEXT NOT NULL,standard TEXT NOT NULL,industry TEXT NOT NULL DEFAULT '',region TEXT NOT NULL DEFAULT '',start_period TEXT NOT NULL,accountant_id INTEGER,enabled INTEGER NOT NULL DEFAULT 1,labels TEXT NOT NULL DEFAULT '[]',service_status TEXT NOT NULL DEFAULT 'active',note TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)")
        conn.execute("INSERT INTO clients(name,code,taxpayer_type,standard,start_period,created_at,updated_at) VALUES('合成迁移客户','MIG-001','small','small2013','2026-01','test','test')")
        conn.commit();conn.close()
        db.initialize(path);db.initialize(path);conn=db.connect(path)
        try:
            row=conn.execute('SELECT * FROM clients').fetchone()
            self.assertEqual(row['name'],'合成迁移客户');self.assertEqual(row['code'],'MIG-001')
            self.assertEqual(row['profile_json'],'{}');self.assertEqual(row['sensitive_json'],'{}')
        finally:conn.close()

    def test_global_audit_scrubber_rejects_nested_raw_private_fields(self):
        synthetic='SyntheticOnly_Audit_Sentinel!'
        with self.conn:db.audit(self.conn,self.user,'test','clients','synthetic',{'before':{'annual_report_password':synthetic,'sensitive_json':synthetic,'legal_id_number':synthetic},'after':[{'contact_id_number':synthetic}],'public':'visible'})
        output=self.conn.execute('SELECT detail FROM audit_logs ORDER BY id DESC LIMIT 1').fetchone()[0]
        self.assertTrue(synthetic not in output,'Nested audit private value was not removed')
        self.assertIn('visible',output)


if __name__=='__main__':unittest.main()
