"""Reusable customer industries, using isolated synthetic SQLite databases."""
import base64
import csv
import io
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import business
import db


class ClientIndustryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'industries.sqlite3'
        db.initialize(self.path)
        self.conn = db.connect(self.path)
        with self.conn:
            self.conn.execute("INSERT INTO users(username,name,password_hash) VALUES('industry-test','合成操作员','not-a-live-login')")
        self.user = dict(self.conn.execute('SELECT id,username,name FROM users').fetchone())

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def create(self, code='INDUSTRY-1', **values):
        return business.handle(self.conn, 'POST', '/api/clients',
                               dict(name='合成行业客户', code=code, start_period='2026-01', **values), self.user, {})

    def patch(self, item, **values):
        return business.handle(self.conn, 'PATCH', f"/api/clients/{item['id']}",
                               dict(version=item['version'], **values), self.user, {})

    def industries(self):
        return business.bootstrap(self.conn, '2026-01', False)['industries']

    def csv_payload(self, rows):
        out = io.StringIO(newline='')
        writer = csv.DictWriter(out, fieldnames=business.TEMPLATES['clients'])
        writer.writeheader()
        for code, industry in rows:
            row = dict.fromkeys(business.TEMPLATES['clients'], '')
            row.update(name='合成CSV客户', code=code, industry=industry, taxpayer_type='small',
                       standard='small2013', start_period='2026-01')
            writer.writerow(row)
        return dict(filename='synthetic-industries.csv',
                    content_base64=base64.b64encode(out.getvalue().encode('utf-8-sig')).decode())

    def test_create_trim_restart_edit_and_purge_preserve_history(self):
        item = self.create(industry='  人工智能咨询  ')
        self.assertEqual(item['industry'], '人工智能咨询')
        self.assertEqual(self.industries(), ['人工智能咨询'])
        changed = self.patch(item, industry='智能设备制造')
        self.assertCountEqual(self.industries(), ['人工智能咨询', '智能设备制造'])
        recycled = business.handle(self.conn, 'DELETE', f"/api/clients/{item['id']}",
                                  {'version': changed['version']}, self.user, {})
        business.handle(self.conn, 'POST', f"/api/clients/{item['id']}/purge",
                        {'version': recycled['version']}, self.user, {})
        self.conn.close()
        db.initialize(self.path)
        self.conn = db.connect(self.path)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM clients').fetchone()[0], 0)
        self.assertCountEqual(self.industries(), ['人工智能咨询', '智能设备制造'])

    def test_casefold_duplicates_and_empty_legacy_industry(self):
        self.create(industry='  Straße Consulting  ')
        self.create(code='INDUSTRY-2', industry='STRASSE CONSULTING')
        self.create(code='INDUSTRY-3', industry=' ')
        self.assertEqual(self.industries(), ['Straße Consulting'])
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM client_industries').fetchone()[0], 1)

    def test_failed_validation_conflict_and_book_creation_do_not_record(self):
        item = self.create(industry='已有行业')
        with self.assertRaises(db.ApiError):
            self.create(code='INDUSTRY-INVALID', industry='待丢弃行业', taxpayer_type='invalid')
        with self.assertRaises(db.ApiError):
            self.patch(item, industry='界' * 81)
        with self.assertRaises(sqlite3.IntegrityError):
            self.create(industry='重复客户失败行业')
        changed = self.patch(item, note='更新版本')
        with self.assertRaises(db.ApiError) as conflict:
            self.patch(item, industry='版本冲突失败行业')
        self.assertEqual(conflict.exception.status, 409)
        with mock.patch('finance.ensure_book', side_effect=db.ApiError(400, '合成账套失败')):
            with self.assertRaises(db.ApiError):
                self.create(code='INDUSTRY-BOOK-FAIL', industry='账套失败行业')
        self.assertEqual(self.industries(), ['已有行业'])
        self.assertEqual(business.fetched(self.conn, 'clients', item['id'])['version'], changed['version'])
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM clients').fetchone()[0], 1)

    def test_csv_success_deduplicates_and_all_failure_paths_are_atomic(self):
        result = business.import_csv(self.conn, 'clients',
                                     self.csv_payload([('CSV-1', ' 新能源服务 '), ('CSV-2', '新能源服务')]), self.user)
        self.assertEqual(result['imported'], 2)
        self.assertEqual(self.industries(), ['新能源服务'])
        with self.assertRaises(db.ApiError):
            business.import_csv(self.conn, 'clients',
                                self.csv_payload([('CSV-3', '整批校验失败行业'), ('CSV-1', '重复编码行业')]), self.user)
        with mock.patch('finance.ensure_book', side_effect=[None, db.ApiError(400, '合成第二行账套失败')]):
            with self.assertRaises(db.ApiError):
                business.import_csv(self.conn, 'clients',
                                    self.csv_payload([('CSV-4', '整批事务回滚行业'), ('CSV-5', '第二行回滚行业')]), self.user)
        self.assertEqual(self.industries(), ['新能源服务'])
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM clients').fetchone()[0], 2)

    def test_reinitialize_backfills_legacy_dedup_filters_and_is_idempotent(self):
        # Simulate a pre-feature database with both active and recycled customers.
        with self.conn:
            self.conn.execute('DROP TABLE client_industries')
            for index, industry in enumerate(['  历史专业服务  ', '历史专业服务', ' Software ', 'SOFTWARE',
                                              ' ', '界' * 81, 'invalid\x00industry'], 1):
                self.conn.execute('''INSERT INTO clients(name,code,taxpayer_type,standard,industry,start_period,
                                     deleted,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)''',
                                  ('合成历史客户', f'LEGACY-{index}', 'small', 'small2013', industry,
                                   '2026-01', int(index == 1), 'old-created', 'old-updated'))
        before = [tuple(row) for row in self.conn.execute('SELECT * FROM clients ORDER BY id')]
        self.conn.close()
        db.initialize(self.path)
        db.initialize(self.path)
        self.conn = db.connect(self.path)
        self.assertEqual([tuple(row) for row in self.conn.execute('SELECT * FROM clients ORDER BY id')], before)
        self.assertCountEqual(self.industries(), ['历史专业服务', 'Software'])
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM client_industries').fetchone()[0], 2)

    def test_bootstrap_includes_valid_direct_legacy_values_without_writing(self):
        item = self.create(industry='已有行业')
        with self.conn:
            self.conn.execute('UPDATE clients SET industry=? WHERE id=?', ('  新增历史行业  ', item['id']))
        changes = self.conn.total_changes
        self.assertCountEqual(self.industries(), ['已有行业', '新增历史行业'])
        self.assertEqual(business.handle(self.conn, 'GET', '/api/industries', {}, self.user, {}),
                         {'industries': self.industries()})
        self.assertEqual(self.conn.total_changes, changes)
        self.assertFalse(self.conn.in_transaction)


if __name__ == '__main__':
    unittest.main()
