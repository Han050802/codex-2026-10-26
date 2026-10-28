"""Independent account-name checks. Every write uses a disposable database."""
from contextlib import closing
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

PROJECT = Path(__file__).resolve().parents[2] / 'outputs' / 'yidaizhang-local'
sys.path.insert(0, str(PROJECT))

import business
import db
import finance
import server


def main():
    expected = [('demo1', '吕'), ('demo2', '会计1'), ('demo3', '会计2')]
    checks = []
    with TemporaryDirectory(prefix='ydz-account-names-check-') as directory:
        app = server.Application(directory, demo=True)
        assert app.data_dir == Path(directory).resolve(), 'Application must stay in temporary directory'
        with closing(db.connect(app.db_path)) as conn:
            users = [dict(row) for row in conn.execute('SELECT id,username,name,password_hash FROM users ORDER BY id')]
            assert [(row['username'], row['name']) for row in users] == expected, 'Initial account names do not match requested names'
            assert all(server.password_verify('DemoOnly123!', row['password_hash']) for row in users), 'Existing demo login credentials changed'
            identity = {row['id']: (row['username'], row['password_hash']) for row in users}
            checks.extend(['fresh names match requested names', 'demo usernames and login credentials preserved'])

            first_user = {key: users[0][key] for key in ('id', 'username', 'name')}
            client = business.handle(conn, 'POST', '/api/clients', {
                'name': '临时姓名联动验证', 'code': 'TEMP-NAME-CHECK',
                'start_period': '2026-09', 'accountant_id': users[0]['id'],
            }, first_user, {})
            sessions = {}
            vouchers = {}
            for index, row in enumerate(users, 1):
                user = {key: row[key] for key in ('id', 'username', 'name')}
                with conn:
                    token, csrf = app.new_session(conn, user)
                sessions[user['id']] = (token, csrf)
                session_user, actual_csrf = app.session(conn, f'ydz_session={token}')
                assert session_user == user and actual_csrf == csrf, 'Session must read the current user name'
                voucher = finance.handle(conn, 'POST', f"/api/books/{client['id']}/vouchers", {
                    'date': f'2026-09-{index:02}', 'summary': '临时制单人验证',
                    'lines': [
                        {'account_code': '1002', 'debit_fen': 10000, 'credit_fen': 0, 'cashflow_category': 'financing'},
                        {'account_code': '3001', 'debit_fen': 0, 'credit_fen': 10000},
                    ],
                }, user, {})
                assert (voucher['created_by'], voucher['created_by_name']) == (user['id'], user['name']), 'Voucher maker must use user-name JOIN'
                vouchers[user['id']] = voucher['id']
            checks.extend(['all three sessions display current account names', 'all three voucher makers use current joined account names'])

            custom_name = '保留的自定义姓名'
            with conn:
                conn.execute('UPDATE users SET name=? WHERE id=?', (custom_name, users[0]['id']))
            first_id = users[0]['id']
            custom_user, actual_csrf = app.session(conn, f'ydz_session={sessions[first_id][0]}')
            assert custom_user['name'] == custom_name, 'Existing session must read changed name via JOIN'
            assert finance._voucher(conn, client['id'], vouchers[first_id])['created_by_name'] == custom_name, 'Historical voucher must read changed name via JOIN'
            checks.append('existing session and historical voucher reflect custom name through JOIN')

        restarted = server.Application(directory, demo=True)
        with closing(db.connect(restarted.db_path)) as conn:
            repeated = [dict(row) for row in conn.execute('SELECT id,username,name,password_hash FROM users ORDER BY id')]
            assert repeated[0]['name'] == custom_name, 'Second initialization must preserve custom name'
            assert [row['name'] for row in repeated[1:]] == ['会计1', '会计2'], 'Second initialization changed other names'
            assert all(identity[row['id']] == (row['username'], row['password_hash']) for row in repeated), 'Second initialization must preserve identity and login credentials'
            token, csrf = sessions[first_id]
            user, actual_csrf = restarted.session(conn, f'ydz_session={token}')
            assert user['name'] == custom_name and actual_csrf == csrf, 'Restart must preserve session and custom name'
            assert finance._voucher(conn, client['id'], vouchers[first_id])['created_by_name'] == custom_name, 'Restart must preserve joined voucher maker name'
            assert conn.execute('PRAGMA foreign_key_check').fetchall() == [], 'Foreign-key checks failed'
            checks.extend(['reinitialization preserves custom names, account IDs and login credentials', 'restart preserves sessions and voucher-user links', 'foreign-key integrity passes'])
    print(json.dumps({'status': 'PASS', 'checks': checks, 'storage': 'TemporaryDirectory only'}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
