"""Customer editor transport checks using isolated HTTP and SQLite fixtures."""
import json
from contextlib import closing
from pathlib import Path
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import db
import server
from test_http import Client


class ClientProfileHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ydz-profile-http-')
        self.app = server.Application(self.temp.name)
        self.http = server.make_server('127.0.0.1', 0, self.app)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.client = Client(f'http://127.0.0.1:{self.http.server_address[1]}')
        users = [{'username': f'profile{i}', 'name': f'合成操作员{i}', 'password': f'ProfileOnly-{i}-Strong!'} for i in range(1, 4)]
        status, body, _ = self.client.call('/api/setup', {'company_name': '合成客户资料测试', 'users': users}, headers={'X-Setup-Token': self.app.setup_token})
        self.assertEqual(status, 200, body)

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=3)
        self.temp.cleanup()

    def payload(self):
        return dict(profile_mode=True, name='合成客户简称', enterprise_name='合成企业完整名称',
                    tax_no='TESTPROFILE2026001', enterprise_form='合伙企业', industry='其他专业咨询',
                    region='北京', filing_type='normal', business_status='存续', established_date='2026-01-02',
                    legal_representative='合成法人', legal_id_number='990101199001010010', legal_phone='13800000000',
                    contact_name='合成联系人', contact_id_number='990101199001010029', contact_phone='13900000000',
                    annual_report_password='Profile-Secret-Synthetic!', mnemonic='HCQY', registered_address='合成注册地址',
                    business_address='合成经营地址', business_scope='合成业务范围', accountant_id=1, start_period='2026-01',
                    standard='enterprise2007', taxpayer_type='small', bookkeeper='合成记账人', cashier='合成出纳',
                    labels=['资料验收'], boss_name='合成老板联系人', boss_phone='13700000000', boss_note='本地资料')

    def create(self):
        status, body, _ = self.client.call('/api/clients', self.payload())
        self.assertEqual(status, 200, body)
        return body

    def assert_no_private_values(self, response):
        serialized = json.dumps(response, ensure_ascii=False) if not isinstance(response, bytes) else response.decode('utf-8-sig')
        for key in ('legal_id_number', 'contact_id_number', 'annual_report_password'):
            self.assertNotIn(self.payload()[key], serialized)
        self.assertNotIn('sensitive_json', serialized)
        self.assertNotIn('profile_json', serialized)
        self.assertNotIn('dpapi-current-user-v1:', serialized)

    def test_editor_create_reopen_and_safe_book_boundary(self):
        customer = self.create()
        self.assertTrue(customer['code'].startswith('KH'))
        self.assertNotEqual(customer['code'], customer['tax_no'])
        for key in ('name', 'enterprise_name', 'tax_no', 'enterprise_form', 'registered_address', 'business_scope', 'bookkeeper', 'boss_note'):
            self.assertEqual(customer[key], self.payload()[key])
        self.assertEqual(customer['standard'], 'enterprise2007')
        self.assertEqual(customer['taxpayer_type'], 'small')
        self.assertTrue(customer['has_annual_report_password'])
        self.assert_no_private_values(customer)
        bootstrap = self.client.call('/api/bootstrap')[1]
        self.assertEqual(bootstrap['clients'][0]['mnemonic'], 'HCQY')
        self.assert_no_private_values(bootstrap)
        status, book, _ = self.client.call(f'/api/books/{customer["id"]}?period=2026-01')
        self.assertEqual(status, 200, book)
        self.assertEqual(book['client']['enterprise_name'], self.payload()['enterprise_name'])
        self.assert_no_private_values(book)
        export = self.client.call('/api/export/clients.csv')[1]
        self.assert_no_private_values(export)
        with closing(db.connect(self.app.db_path)) as conn:
            stored = dict(conn.execute('SELECT profile_json,sensitive_json FROM clients WHERE id=?', (customer['id'],)).fetchone())
            self.assertIn('dpapi-current-user-v1:', stored['sensitive_json'])
            for key in ('legal_id_number', 'contact_id_number', 'annual_report_password'):
                self.assertNotIn(self.payload()[key], json.dumps(stored))
            self.assertNotIn(self.payload()['annual_report_password'], ''.join(row[0] for row in conn.execute('SELECT detail FROM audit_logs')))

    def test_legacy_patch_retains_profile_and_explicit_clear_uses_version(self):
        customer = self.create()
        path = f'/api/clients/{customer["id"]}'
        status, changed, _ = self.client.call(path, {'version': customer['version'], 'note': '从列表编辑备注'}, 'PATCH')
        self.assertEqual(status, 200, changed)
        self.assertEqual(changed['enterprise_name'], customer['enterprise_name'])
        self.assertTrue(changed['has_legal_id_number'])
        status, kept, _ = self.client.call(path, {'version': changed['version'], 'annual_report_password': '', 'contact_name': '调整后的联系人'}, 'PATCH')
        self.assertEqual(status, 200, kept)
        self.assertTrue(kept['has_annual_report_password'])
        status, cleared, _ = self.client.call(path, {'version': kept['version'], 'clear_sensitive': ['annual_report_password']}, 'PATCH')
        self.assertEqual(status, 200, cleared)
        self.assertFalse(cleared['has_annual_report_password'])
        self.assertTrue(cleared['has_contact_id_number'])
        self.assertEqual(self.client.call(path, {'version': kept['version'], 'contact_name': '过期修改'}, 'PATCH')[0], 409)
        self.assertEqual(self.client.call(path, {'version': cleared['version'], 'standard': 'small2013'}, 'PATCH')[0], 400)
        self.assertEqual(self.client.call('/api/bootstrap')[1]['clients'][0]['contact_name'], '调整后的联系人')
        self.assert_no_private_values(self.client.call('/api/bootstrap')[1])


if __name__ == '__main__':
    unittest.main()
