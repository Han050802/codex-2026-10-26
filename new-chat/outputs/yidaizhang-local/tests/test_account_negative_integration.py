import unittest

import reconciliation_batch
import tests.test_reconciliation_batch as fixtures


class NegativeEvidenceIntegrationTests(unittest.TestCase):
    def test_matched_negative_or_conflicting_notes_never_post(self):
        fixture = fixtures.BatchTests('runTest')
        fixture.setUp()
        try:
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
                    self.assertEqual(preview['classification']['status'], 'review')
                    result = reconciliation_batch.auto_post(fixture.c, payload, fixture.user)['rows'][0]
                    self.assertNotEqual(result['status'], 'posted')
            self.assertEqual(fixture.c.execute('SELECT count(*) FROM vouchers').fetchone()[0], 0)
        finally:
            fixture.tearDown()


if __name__ == '__main__':
    unittest.main()
