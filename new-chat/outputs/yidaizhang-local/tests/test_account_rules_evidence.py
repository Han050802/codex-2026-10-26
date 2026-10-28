import sqlite3
import unittest

import account_rules


class AccountEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(':memory:')
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript('''
            CREATE TABLE clients(id INTEGER PRIMARY KEY, name TEXT, deleted INTEGER, standard TEXT);
            CREATE TABLE accounts(client_id INTEGER, code TEXT, name TEXT);
            INSERT INTO clients VALUES(1, '本方', 0, 'small2013');
            INSERT INTO accounts VALUES(1, '6602', '管理费用');
            INSERT INTO accounts VALUES(1, '6603', '财务费用');
            INSERT INTO accounts VALUES(1, '6601', '销售费用');
        ''')
        account_rules.init_schema(self.conn)

    def tearDown(self):
        self.conn.close()

    def classify(self, **fields):
        return account_rules.classify(self.conn, 1, fields, 'purchase')

    def test_classifies_without_a_separate_use_field_when_evidence_is_specific(self):
        result = self.classify(item_name='银行手续费')
        self.assertEqual((result['status'], result['account_code']), ('suggested', '6603'))
        self.assertIn('银行手续费', result['basis'])
        result = self.classify(item_name='服务费', transaction_note='行政管理用途')
        self.assertEqual((result['status'], result['account_code']), ('suggested', '6602'))
        self.assertIn('行政管理用途', result['basis'])

    def test_generic_uncertain_or_conflicting_descriptions_are_not_classified(self):
        for fields in (
            dict(item_name='服务费', transaction_note='转取 服务费'),
            dict(item_name='电脑', transaction_note='行政管理用途'),
            dict(item_name='服务费', transaction_note='可能是行政管理用途'),
            dict(item_name='服务费', transaction_note='不用于行政办公使用'),
            dict(item_name='服务费', transaction_note='非行政管理用途'),
            dict(item_name='服务费', transaction_note='未确认行政办公使用'),
            dict(item_name='服务费', transaction_note='行政管理用途或者销售推广用途'),
            dict(item_name='服务费', transaction_note='行政管理用途，实际为销售用途'),
            dict(item_name='服务费', business_purpose='行政管理用途', transaction_note='销售推广用途'),
            dict(item_name='服务费；其他服务', transaction_note='行政管理用途'),
        ):
            with self.subTest(fields=fields):
                self.assertEqual(self.classify(**fields)['status'], 'review')

    def test_detail_account_requires_unique_business_evidence(self):
        self.conn.execute("INSERT INTO accounts VALUES(1, '660201', '办公费')")
        self.conn.execute("INSERT INTO accounts VALUES(1, '660202', '差旅费')")
        result = self.classify(item_name='办公用品', transaction_note='行政办公使用')
        self.assertEqual((result['status'], result['account_code'], result['account_name']),
                         ('suggested', '660201', '办公费'))
        self.assertEqual(self.classify(item_name='服务费', transaction_note='行政管理用途')['status'], 'review')


if __name__ == '__main__':
    unittest.main()
