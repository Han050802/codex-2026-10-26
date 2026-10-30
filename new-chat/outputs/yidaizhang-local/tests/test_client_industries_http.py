"""Industry vocabulary API checks against an isolated HTTP server and database."""
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


class ClientIndustryHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ydz-industry-http-')
        self.app = server.Application(self.temp.name)
        self.http = server.make_server('127.0.0.1', 0, self.app)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.http.server_address[1]}'
        self.client = Client(self.base)
        self.users = [{'username': f'industry{i}', 'name': f'合成操作员{i}',
                       'password': f'IndustryOnly-{i}-Strong!'} for i in range(1, 4)]
        status, body, _ = self.client.call('/api/setup', {'company_name': '合成行业测试', 'users': self.users},
                                          headers={'X-Setup-Token': self.app.setup_token})
        self.assertEqual(status, 200, body)

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=3)
        self.temp.cleanup()

    def create(self, code, industry, client=None):
        status, body, _ = (client or self.client).call('/api/clients',
            dict(name='合成行业客户', code=code, start_period='2026-01', industry=industry))
        self.assertEqual(status, 200, body)
        return body

    def industries(self, client=None):
        status, body, _ = (client or self.client).call('/api/industries')
        self.assertEqual(status, 200, body)
        self.assertEqual(set(body), {'industries'})
        self.assertTrue(all(isinstance(name, str) for name in body['industries']))
        return body['industries']

    def test_authentication_and_trim_casefold_deduplication(self):
        unauthenticated = Client(self.base)
        self.assertEqual(unauthenticated.call('/api/industries')[0], 401)
        self.assertEqual(self.industries(), [])
        first = self.create('INDUSTRY-HTTP-1', '  Energy Consulting  ')
        self.assertEqual(first['industry'], 'Energy Consulting')
        self.create('INDUSTRY-HTTP-2', 'ENERGY CONSULTING')
        self.assertEqual(self.industries(), ['Energy Consulting'])
        status, bootstrap, _ = self.client.call('/api/bootstrap')
        self.assertEqual(status, 200, bootstrap)
        self.assertEqual(bootstrap['industries'], ['Energy Consulting'])
        with closing(db.connect(self.app.db_path)) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM client_industries').fetchone()[0], 1)

    def test_other_session_reuses_industry_and_history_survives_reinitialize(self):
        first = self.create('INDUSTRY-HTTP-1', '  低空经济咨询  ')
        other = Client(self.base)
        status, login, _ = other.call('/api/login',
                                     {'username': self.users[1]['username'], 'password': self.users[1]['password']})
        self.assertEqual(status, 200, login)
        options = self.industries(other)
        self.assertEqual(options, ['低空经济咨询'])
        second = self.create('INDUSTRY-HTTP-2', options[0], other)
        self.assertEqual(second['industry'], first['industry'])
        status, updated, _ = self.client.call(f'/api/clients/{first["id"]}',
            {'version': first['version'], 'industry': '  智能设备制造  '}, 'PATCH')
        self.assertEqual(status, 200, updated)
        self.assertEqual(updated['industry'], '智能设备制造')
        status, recycled, _ = other.call(f'/api/clients/{second["id"]}',
            {'version': second['version']}, 'DELETE')
        self.assertEqual(status, 200, recycled)
        self.assertEqual(recycled['deleted'], 1)
        self.assertCountEqual(self.industries(other), ['低空经济咨询', '智能设备制造'])
        db.initialize(self.app.db_path)
        self.assertCountEqual(self.industries(), ['低空经济咨询', '智能设备制造'])
        self.assertCountEqual(self.industries(other), ['低空经济咨询', '智能设备制造'])
        with closing(db.connect(self.app.db_path)) as conn:
            self.assertCountEqual([row['name'] for row in conn.execute('SELECT name FROM client_industries')],
                                  ['低空经济咨询', '智能设备制造'])

    def test_failed_validation_and_stale_version_do_not_add_industries(self):
        item = self.create('INDUSTRY-HTTP-1', '已有有效行业')
        status, error, _ = self.client.call('/api/clients',
            dict(name='合成失败客户', code='INDUSTRY-HTTP-INVALID', start_period='2026-01',
                 industry='保存失败行业', taxpayer_type='invalid'))
        self.assertEqual(status, 400, error)
        status, error, _ = self.client.call('/api/clients',
            dict(name='合成过长行业客户', code='INDUSTRY-HTTP-LONG', start_period='2026-01', industry='界' * 81))
        self.assertEqual(status, 400, error)
        path = f'/api/clients/{item["id"]}'
        status, updated, _ = self.client.call(path, {'version': item['version'], 'note': '合成版本更新'}, 'PATCH')
        self.assertEqual(status, 200, updated)
        status, error, _ = self.client.call(path,
            {'version': item['version'], 'industry': '过期版本失败行业'}, 'PATCH')
        self.assertEqual(status, 409, error)
        self.assertEqual(self.industries(), ['已有有效行业'])
        status, bootstrap, _ = self.client.call('/api/bootstrap')
        self.assertEqual(status, 200, bootstrap)
        self.assertEqual(len(bootstrap['clients']), 1)
        self.assertEqual(bootstrap['clients'][0]['industry'], '已有有效行业')
        self.assertEqual(bootstrap['clients'][0]['version'], updated['version'])


if __name__ == '__main__':
    unittest.main()
