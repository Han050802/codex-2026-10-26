import json
import unittest

import reconciliation_batch
import tests.test_reconciliation_batch as fixtures


class NegativeEvidenceIntegrationTests(unittest.TestCase):
    def test_matched_negative_or_conflicting_notes_post_gross_to_named_receivable(self):
        fixture = fixtures.BatchTests('runTest')
        fixture.setUp()
        try:
            postings=[]
            for index, note in enumerate((
                '不用于行政办公使用',
                '并非行政管理用途',
                '未确认行政办公使用',
                '行政管理用途或者销售推广用途',
                '行政管理用途，实际为销售用途',
            )):
                with self.subTest(note=note):
                    payload = fixture.payload()
                    payload['transactions'][0]['note'] = note
                    payload['invoices'][0].update(number='negative-'+str(index), item_name='服务费', business_purpose='')
                    preview = reconciliation_batch.preview(fixture.c, payload)['rows'][0]
                    self.assertEqual(preview['status'], 'ready')
                    self.assertEqual(preview['classification']['status'], 'review')
                    self.assertIsNone(preview['classification']['account_code'])
                    self.assertNotIn('rule_suggestion', preview['classification'])
                    result = reconciliation_batch.auto_post(fixture.c, payload, fixture.user)['rows'][0]
                    self.assertEqual(result['status'], 'posted', result)
                    business, bank = result['posted_lines']
                    self.assertTrue(business['account_code'].startswith('1221'))
                    self.assertEqual(business['account_name'], payload['transactions'][0]['counterparty'])
                    self.assertEqual((business['debit_fen'],business['credit_fen']), (10000,0))
                    self.assertEqual((bank['account_code'],bank['debit_fen'],bank['credit_fen']), ('1002',0,10000))
                    self.assertEqual(business['summary'], note)
                    self.assertEqual(result['classification']['status'], 'review')
                    self.assertEqual(result['automatic_posting']['subject_source'], 'other_receivable_fallback')
                    self.assertEqual(result['automatic_posting']['classification_source'], 'uncertain_transaction_note')
                    stored = fixture.c.execute('SELECT transaction_json,batch_metadata_json FROM reconciliation_records WHERE id=?',(result['id'],)).fetchone()
                    self.assertEqual(json.loads(stored['transaction_json'])['note'], note)
                    self.assertEqual(json.loads(stored['batch_metadata_json'])['classification']['status'], 'review')
                    again = reconciliation_batch.auto_post(fixture.c, payload, fixture.user)['rows'][0]
                    self.assertEqual((again['id'],again['voucher_id']), (result['id'],result['voucher_id']))
                    self.assertTrue(again['already_posted'])
                    self.assertEqual(again['posted_lines'], result['posted_lines'])
                    postings.append(result)
            self.assertEqual(len({row['posted_lines'][0]['account_code'] for row in postings}), 1)
            self.assertEqual(fixture.c.execute('SELECT count(*) FROM vouchers').fetchone()[0], 5)
            self.assertEqual(fixture.c.execute('SELECT count(*) FROM reconciliation_records').fetchone()[0], 5)
        finally:
            fixture.tearDown()


if __name__ == '__main__':
    unittest.main()
