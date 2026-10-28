import unittest
from unittest.mock import Mock
from reconciliation_ocr import parse_bank
import reconciliation


def box(text, x, y):
    return {'text':text, 'x':x, 'y':y}


class BankDirectionTests(unittest.TestCase):
    def row(self, heading, value):
        items=[box('20260901',70,200), box(value,380,200), box('某供应商有限公司',650,200)]
        if heading:
            items.append(box(heading,380,100))
        return parse_bank(items,1000,1000)['transactions'][0]

    def test_labelled_debit_and_credit_columns(self):
        out=self.row('支出金额','100.00')
        self.assertEqual(out['amount'],'-100.00')
        self.assertFalse(out['direction_needs_review'])
        incoming=self.row('收入金额','100.00')
        self.assertEqual(incoming['amount'],'100.00')
        self.assertFalse(incoming['direction_needs_review'])

    def test_generic_unsigned_requires_confirmation(self):
        row=self.row('交易金额','100.00')
        self.assertEqual(row['amount'],'100.00')
        self.assertTrue(row['direction_needs_review'])

    def test_sign_is_used_but_conflicting_sign_requires_confirmation(self):
        row=self.row('交易金额','-100.00')
        self.assertEqual(row['amount'],'-100.00')
        self.assertFalse(row['direction_needs_review'])
        self.assertTrue(self.row('支出金额','+100.00')['direction_needs_review'])

    def test_multiple_nonzero_direction_columns_need_confirmation(self):
        items=[box('20260901',70,200),box('支出金额',380,100),box('收入金额',490,100),
               box('100.00',380,200),box('20.00',490,200),box('某供应商有限公司',650,200)]
        self.assertTrue(parse_bank(items,1000,1000)['transactions'][0]['direction_needs_review'])

    def test_uncertain_direction_survives_the_ocr_import(self):
        worker=Mock()
        worker.run.return_value=({'fields':{'account_name':'本方公司','transactions':[
            {'date':'2026-09-01','amount':'100.00','counterparty':'供应商',
             'direction_needs_review':True}]}},'')
        rows,error,accounts=reconciliation.ocr_file(b'image','.png','statement','流水.png',worker)
        self.assertFalse(error)
        self.assertTrue(rows[0]['direction_needs_review'])
        self.assertEqual(accounts,['本方公司'])


if __name__=='__main__': unittest.main()
