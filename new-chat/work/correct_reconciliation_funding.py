"""Withdraw two unsupported source postings, preserving matching records and audit."""
import json
import sqlite3
import sys
from pathlib import Path

app = Path(__file__).resolve().parents[1] / 'outputs' / 'yidaizhang-local'
sys.path.insert(0, str(app))
from db import connect, audit
import finance

path = Path(sys.argv[1]).resolve()
conn = connect(path)
expected = [(1, 1, '26112000003789636136', '-112000.00', 11200000),
            (2, 2, '26112000003941516416', '-103000.00', 10300000)]
reason = '撤回未经证实的银行付款凭证；按用户要求保留已推荐科目与支出方向，作为独立分类记录。'
try:
    conn.execute('BEGIN IMMEDIATE')
    for record_id, voucher_id, number, amount, fen in expected:
        rec = conn.execute('SELECT * FROM reconciliation_records WHERE id=? AND client_id=2', (record_id,)).fetchone()
        v = finance._voucher(conn, 2, voucher_id)
        assert rec and rec['invoice_number'] == number
        assert json.loads(rec['transaction_json'])['amount'] == amount
        assert v['status'] == 'active' and not v['reviewed'] and v['source_type'] == 'reconciliation' and str(v['source_id']) == str(record_id)
        assert sorted((l['account_code'], l['debit_fen'], l['credit_fen']) for l in v['lines']) == [('1002', 0, fen), ('5401', fen, 0)]
    for record_id, voucher_id, _, _, fen in expected:
        v = finance._voucher(conn, 2, voucher_id)
        finance.withdraw_source(conn, 2, voucher_id, {'username': 'system'}, reason, v['version'])
        row = conn.execute('SELECT batch_metadata_json,transaction_json FROM reconciliation_records WHERE id=?', (record_id,)).fetchone()
        before = json.loads(row['batch_metadata_json'] or '{}')
        after = dict(before)
        classification = before['classification']
        assert classification['account_code'] == '5401'
        after['expense_classification'] = {'account_code': classification['account_code'], 'account_name': classification['account_name'],
            'amount_fen': fen, 'direction': 'expense', 'date': json.loads(row['transaction_json'])['date'], 'source': 'accepted_rule_suggestion'}
        after['reason'] = ''
        conn.execute('UPDATE reconciliation_records SET batch_metadata_json=? WHERE id=?', (json.dumps(after, ensure_ascii=False), record_id))
        audit(conn, {'username': 'system'}, 'reconcile_correction', 'reconciliation_records', record_id, {'before': before, 'after': after})
    conn.commit()
    print('Withdrawn vouchers 1 and 2; matching records 1 and 2 retained.')
except BaseException:
    conn.rollback()
    raise
finally:
    conn.close()
