"""Bind the two corrected suggestions to the invoice fields they were based on."""
import json
import sys
from pathlib import Path

app = Path(__file__).resolve().parents[1] / 'outputs' / 'yidaizhang-local'
sys.path.insert(0, str(app))
from db import connect, audit
from reconciliation_batch import _classification_inputs

conn = connect(Path(sys.argv[1]).resolve())
try:
    conn.execute('BEGIN IMMEDIATE')
    for record_id in (1, 2):
        row = conn.execute('SELECT * FROM reconciliation_records WHERE id=? AND client_id=2', (record_id,)).fetchone()
        assert row
        before = json.loads(row['batch_metadata_json'])
        assert before['expense_classification']['account_code'] == '5401'
        assert before['expense_classification']['source'] == 'accepted_rule_suggestion'
        assert not conn.execute("SELECT 1 FROM vouchers WHERE client_id=2 AND source_type='reconciliation' AND source_id=? AND status='active'", (str(record_id),)).fetchone()
        after = dict(before)
        after['classification_inputs'] = _classification_inputs(json.loads(row['invoice_json']))
        conn.execute('UPDATE reconciliation_records SET batch_metadata_json=? WHERE id=?', (json.dumps(after, ensure_ascii=False), record_id))
        audit(conn, {'username':'system'}, 'reconcile_bind_classification_inputs', 'reconciliation_records', record_id, {'before':before, 'after':after})
    conn.commit()
    print('Bound invoice fields for records 1 and 2.')
except BaseException:
    conn.rollback()
    raise
finally:
    conn.close()
