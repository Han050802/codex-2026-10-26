"""Serve the company workspace with disposable synthetic accounting records.

Run this file directly, then sign in at http://127.0.0.1:8877 using
demo1 / DemoOnly123!. Press Ctrl+C to stop and remove the temporary data.
The production and existing demo data directories are never opened.
"""

from contextlib import closing
from pathlib import Path
import sys
import tempfile


PROJECT_ROOT = Path(__file__).resolve().parents[2] / 'outputs' / 'yidaizhang-local'
if not (PROJECT_ROOT / 'server.py').is_file():
    raise RuntimeError(f'Local application source was not found: {PROJECT_ROOT}')
sys.path.insert(0, str(PROJECT_ROOT))

import business
import db
import finance
import server


HOST = '127.0.0.1'
PORT = 8877
PERIOD = '2026-09'


def prepare_fixture(app):
    """Create every business record through the existing validated APIs."""
    with closing(db.connect(app.db_path)) as conn:
        # Application(demo=True) initializes only the three demo operators.
        # This is a read of that existing operator, never a direct business write.
        row = conn.execute(
            'SELECT id,username,name FROM users WHERE username=?', ('demo1',)
        ).fetchone()
        if row is None:
            raise RuntimeError('The temporary demo operator was not initialized')
        user = dict(row)

        def agency(method, path, payload=None, query=None):
            result = business.handle(
                conn, method, path, payload or {}, user, query or {}, demo=True
            )
            if result is None:
                raise RuntimeError(f'Unrecognized business API: {method} {path}')
            return result

        def book_api(cid, route='', payload=None, method='POST', query=None):
            path = f'/api/books/{cid}' + (f'/{route}' if route else '')
            result = finance.handle(
                conn, method, path, payload or {}, user, query or {'period': PERIOD}
            )
            if result is None:
                raise RuntimeError(f'Unrecognized finance API: {method} {path}')
            return result

        def create_company(name, code):
            return agency('POST', '/api/clients', {
                'name': name,
                'code': code,
                'taxpayer_type': 'small',
                'standard': 'small2013',
                'start_period': '2026-01',
                'industry': '合成视觉验收',
                'region': '北京',
                'accountant_id': user['id'],
                'enabled': True,
                'labels': ['合成数据'],
                'note': '仅用于公司工作区视觉核对，退出预览后自动清除。',
            })

        company = create_company('合成账务核对有限公司', 'PREVIEW-001')
        empty_company = create_company('合成空账套有限公司', 'PREVIEW-002')
        cid = company['id']

        for code, name, category, direction in (
            ('112206', '合成往来客户有限公司', 'asset', 'debit'),
            ('112301', '合成预付客户有限公司', 'asset', 'debit'),
            ('560217', '管理费用_通讯费', 'expense', 'debit'),
            ('220201', '应付账款_合成通信服务公司', 'liability', 'credit'),
        ):
            book_api(cid, 'accounts', {
                'code': code, 'name': name,
                'category': category, 'direction': direction,
            })

        opening = [
            {'account_code': '1002', 'debit_fen': 9510507, 'credit_fen': 0},
            {'account_code': '112206', 'debit_fen': 189110304, 'credit_fen': 0},
            {'account_code': '112301', 'debit_fen': 25574400, 'credit_fen': 0},
            {'account_code': '3001', 'debit_fen': 0, 'credit_fen': 224195211},
        ]
        initial_book = book_api(cid, method='GET')
        book_api(cid, 'opening', {
            'version': initial_book['opening_version'], 'balances': opening,
        })

        debit_amounts = (15640, 15770, 15670, 15750, 15630)
        lines = [
            {'account_code': '560217', 'debit_fen': amount, 'credit_fen': 0,
             'summary': '成本支出', 'cashflow_category': 'unclassified'}
            for amount in debit_amounts
        ]
        lines.append({
            'account_code': '220201', 'debit_fen': 0,
            'credit_fen': sum(debit_amounts),
            'summary': '成本支出', 'cashflow_category': 'unclassified',
        })
        voucher = book_api(cid, 'vouchers', {
            'date': '2026-09-15', 'summary': '成本支出',
            'attachment_count': 0, 'lines': lines,
        })

        # Verify through the same read APIs used by the workspace before serving.
        populated = book_api(cid, method='GET')
        isolated = book_api(empty_company['id'], method='GET')
        bootstrap = agency('GET', '/api/bootstrap', query={'period': PERIOD})
        if len(bootstrap['clients']) != 2:
            raise RuntimeError('Preview must contain exactly two synthetic companies')
        if len(populated['vouchers']) != 1 or len(voucher['lines']) != 6:
            raise RuntimeError('Preview voucher fixture is incomplete')
        if sum(line['debit_fen'] for line in voucher['lines']) != 78460:
            raise RuntimeError('Preview voucher debit total must be 784.60')
        if sum(line['credit_fen'] for line in voucher['lines']) != 78460:
            raise RuntimeError('Preview voucher must balance')
        if isolated['vouchers'] or isolated['opening_balances']:
            raise RuntimeError('The second company must retain an empty isolated book')
        if not populated['reports']['balance_sheet']['balanced']:
            raise RuntimeError('Preview opening and voucher balances did not reconcile')
        return company, empty_company


def main():
    with tempfile.TemporaryDirectory(prefix='ydz-company-preview-') as directory:
        app = server.Application(directory, demo=True)
        company, empty_company = prepare_fixture(app)
        http = server.make_server(HOST, PORT, app)
        # Wait for any in-flight request to close before removing SQLite/files.
        http.daemon_threads = False
        print(f'Company workspace preview ready: http://{HOST}:{PORT}', flush=True)
        print('Sign in: demo1 / DemoOnly123!', flush=True)
        print(f'Company {company["id"]}: {company["name"]} (2026-09 voucher; 2026-08 balance)', flush=True)
        print(f'Company {empty_company["id"]}: {empty_company["name"]} (empty book)', flush=True)
        print('Synthetic data lives only in a TemporaryDirectory. Press Ctrl+C to stop and clean up.', flush=True)
        try:
            http.serve_forever(poll_interval=0.3)
        except KeyboardInterrupt:
            pass
        finally:
            http.server_close()
    print('Preview stopped; temporary accounting data removed.', flush=True)


if __name__ == '__main__':
    main()
