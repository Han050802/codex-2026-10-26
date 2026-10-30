"""Unique bank receipts can post legitimate transactions without a named party."""
from contextlib import closing
import copy
import json
import unittest

import db
import finance
import reconciliation
import reconciliation_batch as batch
from tests import test_match_driven_posting as posting_fixtures
from tests import test_reconciliation_http as http_fixtures


def screenshot_payload(cid, own):
    transactions = [
        {'date': '2026-09-21', 'amount': '4.20', 'counterparty': '', 'note': '利息'},
        {'date': '2026-08-27', 'amount': '-300.00', 'counterparty': '', 'note': '惠享服务'},
        {'date': '2026-08-27', 'amount': '-100.00', 'counterparty': '', 'note': '惠享服务'},
    ]
    receipts = [dict(t, number='BLANK-' + str(index), own_name=own) for index, t in enumerate(transactions)]
    return {'client_id': cid, 'account_name': own, 'transactions': transactions, 'invoices': [], 'receipts': receipts}


class BlankCounterpartyReceiptTests(unittest.TestCase):
    def setUp(self):
        self.fixture = posting_fixtures.MatchDrivenPostingTests('runTest')
        self.fixture.setUp()
        self.conn = self.fixture.conn
        self.user = self.fixture.user

    def tearDown(self):
        self.fixture.tearDown()

    def test_three_screenshot_receipts_post_balanced_once_with_original_blank_names(self):
        for cid, finance_code in ((1, '5603'), (2, '6603')):
            with self.subTest(cid=cid):
                payload = screenshot_payload(cid, '本方公司' + str(cid))
                original = copy.deepcopy(payload)
                matches = reconciliation.match_receipts(payload['transactions'], payload['receipts'])
                self.assertEqual([r['status'] for r in matches['matches']], ['matched'] * 3)
                rows = batch.post_receipts(self.conn, payload, self.user)['rows']
                self.assertEqual([r['status'] for r in rows], ['posted'] * 3, rows)
                self.assertTrue(rows[0]['account_code'].startswith(finance_code))
                self.assertEqual(rows[1]['account_code'], rows[2]['account_code'])
                self.assertTrue(rows[1]['account_code'].startswith('1221'))
                self.assertEqual(rows[1]['account_name'], '惠享服务')
                for row, amount, note in zip(rows, (420, 30000, 10000), ('利息', '惠享服务', '惠享服务')):
                    self.assertEqual(sum(line['debit_fen'] for line in row['posted_lines']), amount)
                    self.assertEqual(sum(line['credit_fen'] for line in row['posted_lines']), amount)
                    self.assertTrue(all(line['summary'] == note for line in row['posted_lines']))
                    self.assertTrue(row['automatic_posting']['counterparty_missing'])
                    voucher = self.conn.execute('SELECT * FROM vouchers WHERE id=?', (row['voucher_id'],)).fetchone()
                    self.assertEqual(voucher['counterparty'], '')
                    log = self.conn.execute("SELECT detail FROM audit_logs WHERE entity='vouchers' AND entity_id=? AND action='reconcile_receipt_post'", (str(row['voucher_id']),)).fetchone()
                    audit = json.loads(log['detail'])
                    self.assertEqual(audit['transaction']['counterparty'], '')
                    self.assertEqual(audit['matched_receipt']['counterparty'], '')
                    self.assertEqual(audit['transaction']['note'], note)
                    self.assertEqual(audit['transaction_key'], reconciliation._transaction_key(payload['transactions'][row['transaction_index']]))
                again = batch.post_receipts(self.conn, payload, self.user)['rows']
                self.assertEqual([r['voucher_id'] for r in again], [r['voucher_id'] for r in rows])
                self.assertTrue(all(r['already_posted'] for r in again))
                self.assertEqual(self.fixture.count(cid), 3)
                self.assertEqual(payload, original)

    def test_interest_recommendation_with_existing_children_keeps_finance_parent(self):
        with finance._write(self.conn):
            finance._create_account(self.conn, 1, {'parent_code': '5603', 'name': '现有银行费用'}, self.user)
        payload = screenshot_payload(1, '本方公司1')
        payload['transactions'] = payload['transactions'][:1]
        payload['receipts'] = payload['receipts'][:1]
        row = batch.post_receipts(self.conn, payload, self.user)['rows'][0]
        self.assertEqual(row['status'], 'posted', row)
        self.assertTrue(row['account_code'].startswith('5603'))
        self.assertEqual(row['account_name'], '利息')

    def test_fallback_uses_original_purpose_or_explicit_missing_party_label(self):
        for index, (transaction_note, receipt_note, incoming, expected_name, expected_source) in enumerate((
            ('原始流水用途', '回单用途', False, '原始流水用途', 'transaction_note'),
            ('', '回单用途', True, '回单用途', 'receipt_note'),
            ('', '', False, '回单付款（未提供交易对方）', 'missing_counterparty_label'),
        )):
            with self.subTest(index=index):
                tx = {'date': '2026-09-' + str(15 + index), 'amount': '25.00' if incoming else '-25.00', 'counterparty': '', 'note': transaction_note}
                receipt = dict(tx, number='PURPOSE-' + str(index), own_name='本方公司1', note=receipt_note)
                payload = {'client_id': 1, 'account_name': '本方公司1', 'transactions': [tx], 'invoices': [], 'receipts': [receipt]}
                row = batch.post_receipts(self.conn, payload, self.user)['rows'][0]
                self.assertEqual(row['status'], 'posted', row)
                self.assertEqual(row['account_name'], expected_name)
                self.assertTrue(row['account_code'].startswith('2241' if incoming else '1221'))
                self.assertEqual(row['automatic_posting']['detail_name_source'], expected_source)
                self.assertEqual(row['automatic_posting']['raw_transaction_note'], transaction_note)
                self.assertEqual(row['automatic_posting']['raw_receipt_note'], receipt_note)
                self.assertEqual(tx['counterparty'], '')
                self.assertEqual(receipt['counterparty'], '')
                again = batch.post_receipts(self.conn, payload, self.user)['rows'][0]
                self.assertEqual(again['voucher_id'], row['voucher_id'])
        self.assertEqual(self.fixture.count(1), 3)

    def test_ambiguous_or_different_counterparty_amount_and_direction_do_not_post(self):
        original = screenshot_payload(1, '本方公司1')
        for change in ('named_receipt', 'amount', 'direction', 'duplicate_receipt', 'duplicate_transaction'):
            with self.subTest(change=change):
                payload = dict(original, transactions=copy.deepcopy(original['transactions'][:1]), receipts=copy.deepcopy(original['receipts'][:1]))
                if change == 'named_receipt': payload['receipts'][0]['counterparty'] = '实际具名对方'
                elif change == 'amount': payload['receipts'][0]['amount'] = '4.21'
                elif change == 'direction': payload['receipts'][0]['amount'] = '-4.20'
                elif change == 'duplicate_receipt': payload['receipts'].append(dict(payload['receipts'][0], number='OTHER'))
                else: payload['transactions'].append(dict(payload['transactions'][0]))
                rows = batch.post_receipts(self.conn, payload, self.user)['rows']
                self.assertTrue(all(r['status'] == 'review' for r in rows), rows)
                self.assertEqual(self.fixture.count(1), 0)

    def test_blank_name_allowance_requires_an_actual_matching_receipt(self):
        tx = screenshot_payload(1, '本方公司1')['transactions'][0]
        for source, receipt in (('invoice', None), ('receipt', None), ('receipt', dict(tx, amount='4.21')), ('receipt', dict(tx, counterparty='具名方'))):
            with self.subTest(source=source, receipt=receipt):
                with self.assertRaises(db.ApiError):
                    batch._automatic_draft(self.conn, 1, tx, None, {}, {}, source, receipt)
        self.assertEqual(self.fixture.count(1), 0)

    def test_closed_period_with_blank_party_does_not_claim_posting(self):
        payload = screenshot_payload(1, '本方公司1')
        payload['transactions'] = payload['transactions'][:1]
        payload['receipts'] = payload['receipts'][:1]
        with self.conn:
            self.conn.execute("INSERT INTO book_periods(client_id,period,closed) VALUES(1,'2026-09',1)")
        row = batch.post_receipts(self.conn, payload, self.user)['rows'][0]
        self.assertEqual(row['status'], 'review')
        self.assertNotIn('voucher_id', row)
        self.assertEqual(self.fixture.count(1), 0)

    def test_real_http_match_and_receipt_post_for_three_blank_party_transactions(self):
        http = http_fixtures.ReconciliationHTTPTests('runTest')
        http.setUp()
        try:
            payload = screenshot_payload(http.cid, '合成客户公司')
            code, matched, _ = http.client.call('/api/reconcile/match', payload)
            self.assertEqual(code, 200, matched)
            self.assertEqual([r['status'] for r in matched['receipt_matches']['matches']], ['matched'] * 3)
            code, posted, _ = http.client.call('/api/reconcile/receipt-post', payload)
            self.assertEqual(code, 200, posted)
            self.assertEqual([r['status'] for r in posted['rows']], ['posted'] * 3)
            code, repeated, _ = http.client.call('/api/reconcile/receipt-post', payload)
            self.assertEqual(code, 200, repeated)
            self.assertEqual([r['voucher_id'] for r in posted['rows']], [r['voucher_id'] for r in repeated['rows']])
            self.assertTrue(all(r['already_posted'] for r in repeated['rows']))
            with closing(db.connect(http.app.db_path)) as conn:
                self.assertEqual(conn.execute("SELECT count(*) FROM vouchers WHERE status='active'").fetchone()[0], 3)
                self.assertEqual(conn.execute("SELECT count(*) FROM vouchers WHERE counterparty<>''").fetchone()[0], 0)
                balances = conn.execute('SELECT sum(debit_fen),sum(credit_fen) FROM voucher_lines GROUP BY voucher_id').fetchall()
                self.assertEqual(sorted(tuple(row) for row in balances), [(420, 420), (10000, 10000), (30000, 30000)])
        finally:
            http.tearDown()


if __name__ == '__main__':
    unittest.main()
