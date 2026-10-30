"""All company, person and monetary fixtures below are synthetic."""
import unittest
import reconciliation, reconciliation_rules

class GptRulesTests(unittest.TestCase):
    def suggest(self, rows, invoices=(), matches=()):
        return reconciliation_rules.suggest(rows, list(invoices), list(matches), '', reconciliation.fen)
    def test_priority_and_direction(self):
        rows=[{'amount':'-15','note':'银行手续费 服务费'}, {'amount':'5','note':'结息'},
              {'amount':'-1000','note':'代发工资'}, {'amount':'3000','note':'投资款 服务费'}]
        out=self.suggest(rows)
        self.assertEqual([x['account_code'] for x in out],['5603','5603','2211','3001'])
        self.assertIn('贷记财务费用',out[1]['basis'])
        self.assertTrue(all(x['status']=='provisional' for x in out))
    def test_matched_gross_service_and_unmatched_person(self):
        rows=[{'date':'2026-09-01','amount':'100000','note':'服务费'},
              {'date':'2026-09-02','amount':'-20000','note':'服务费','counterparty':'科技公司'},
              {'amount':'-100','note':'报销','counterparty':'张三'}]
        inv=[{'item_name':'服务费','tax_amount':'100'}]
        out=self.suggest(rows,inv,[{'transaction_index':1,'invoice_index':0,'status':'matched'}])
        self.assertEqual([x['account_code'] for x in out],['1122','5401','1221'])
        self.assertIn('不能证明',out[1]['review'])
        self.assertIn('未自动拆税',out[1]['review'])
        self.assertIn('不能单独证明',out[2]['review'])
        # Candidate invoice must never be treated as a matched invoice.
        out=self.suggest([rows[2]],inv,[{'transaction_index':0,'invoice_index':0,'status':'review'}])
        self.assertEqual(out[0]['account_code'],'1221')
    def test_unknown_direction_and_capitalization(self):
        out=self.suggest([{'amount':'-1','note':'无具体用途'}, {'amount':'-5','note':'手续费','direction_needs_review':True},
                          {'amount':'-6000','note':'电脑'}])
        self.assertIsNone(out[0]['account_code']); self.assertIsNone(out[1]['account_code'])
        self.assertEqual(out[2]['account_code'],'1601')
        self.assertIn('单价',out[2]['review'])
    def test_counterparty_and_small_book_rules(self):
        rows=[{'amount':'-600.00','note':'委托收款','counterparty':'合成住房公积金中心'},
              {'amount':'1.25','note':'利息'},
              {'amount':'-200.00','note':'惠享服务'},
              {'amount':'0.25','note':'企业认证','counterparty':'合成认证甲有限公司'},
              {'amount':'0.50','note':'企业认证测试转账','counterparty':'合成支付乙有限公司'},
              {'amount':'10000.00','note':'入资款','counterparty':'合成出资人甲'},
              {'amount':'2000.00','note':'服务费','counterparty':'合成购买方丙有限公司'},
              {'amount':'500.00','note':'企业认证'}]
        inv=[{'item_name':'*现代服务*服务费'}]
        out=self.suggest(rows,inv,[{'transaction_index':6,'invoice_index':0,'status':'matched'}])
        self.assertEqual([x['account_code'] for x in out],['5602','5603','1221','2241','2241','3001','5001',None])
        self.assertEqual(out[0]['sub_account'],'住房公积金（支出）')
        self.assertIn('避免重复入账',out[0]['review'])
        self.assertEqual(out[5]['sub_account'],'合成出资人甲')
        self.assertEqual(out[6]['sub_account'],'合成购买方丙有限公司')

if __name__=='__main__': unittest.main()
