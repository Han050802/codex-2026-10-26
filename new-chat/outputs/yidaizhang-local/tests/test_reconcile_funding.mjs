import assert from 'node:assert/strict';
import {renderReconcile, fundingMarkup, changeEvidence, submittedEvidence} from '../public/reconcile.js';
import {focusCompanyBalance, companyBalanceTest} from '../public/company-balance.js';

const page=renderReconcile();
assert.match(page,/发票或回单与流水匹配成功后直接生成凭证入账/);
assert.doesNotMatch(page,/已分类的支出不生成凭证/);
const destination=focusCompanyBalance({clientId:18,postings:[{period:'2026-09',voucher_id:7,posted_lines:[{account_code:'1002',debit_fen:10000,credit_fen:0}]}]});
assert.deepEqual(destination,{clientId:18,period:'2026-09'});
console.log('matched records use actual posting and balance navigation');

const fundingAccounts=[{code:'1001',name:'库存现金',report_key:'cash'}, {code:'1002',name:'银行存款',report_key:'cash'}, {code:'100201',name:'银行账户',report_key:'cash'}, {code:'5401',name:'主营业务成本',report_key:'cost'}];
for (const treatment of ['contract_prepayment','settle_payable','settle_receivable']) {
 const special=fundingMarkup(0,{treatment},fundingAccounts);
 assert.match(special,/data-rc-evidence="bank_account_code"/);
 assert.match(special,/1001 库存现金/);
 assert.match(special,/100201 银行账户/);
 assert.doesNotMatch(special,/1002 银行存款|5401 主营业务成本|selected/);
}
const evidence={treatment:'contract_prepayment',bank_account_code:'1001',evidence_note:'合同'};
assert.match(fundingMarkup(0,evidence,fundingAccounts),/value="1001" selected/);
changeEvidence(evidence,'treatment','recognize_invoice');
assert.equal(fundingMarkup(0,evidence,fundingAccounts),'');
assert.equal(evidence.bank_account_code,undefined);
assert.equal(evidence.evidence_note,'合同');
assert.equal(submittedEvidence({treatment:'recognize_invoice',bank_account_code:'1001'}).bank_account_code,undefined);
changeEvidence(evidence,'treatment','settle_payable');
assert.match(fundingMarkup(0,evidence,fundingAccounts),/资金科目/);
assert.doesNotMatch(fundingMarkup(0,evidence,fundingAccounts),/selected/);
changeEvidence(evidence,'bank_account_code','100201');
assert.equal(submittedEvidence(evidence).bank_account_code,'100201');
changeEvidence(evidence,'treatment','settle_receivable');
assert.equal(evidence.bank_account_code,undefined);
console.log('special-treatment funding selection and switching passed');
