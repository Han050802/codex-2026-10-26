import assert from 'node:assert/strict';
import {renderReconcile, fundingMarkup, changeEvidence, submittedEvidence} from '../public/reconcile.js';
import {focusCompanyBalance, companyBalanceTest} from '../public/company-balance.js';

const page=renderReconcile();
assert.match(page, /已分类的支出不生成凭证/);
assert.doesNotMatch(page, /资金科目|付款方式/);
const destination=focusCompanyBalance({clientId:18,postings:[],classifications:[{period:'2026-09',record_id:5}]});
assert.deepEqual(destination,{clientId:18,period:'2026-09'});
const classifiedData={expense_classifications:[
 {record_id:5,date:'2026-09-09',account_code:'5401',account_name:'主营业务成本',direction:'expense',amount_fen:11200000},
 {record_id:6,date:'2026-09-17',account_code:'5401',account_name:'主营业务成本',direction:'expense',amount_fen:10300000},
 {record_id:7,date:'2026-09-18',account_code:'560201',account_name:'办公费',direction:'expense',amount_fen:20000},
]};
const accounts=[{code:'5401',name:'主营业务成本',category:'cost'},{code:'5602',name:'管理费用',category:'expense'},{code:'560201',name:'办公费',category:'expense'}];
classifiedData.trial_balance=accounts.map(a=>({account_code:a.code,account_name:a.name,debit_fen:0,credit_fen:0}));
classifiedData.trial_balance_rollup=companyBalanceTest.rollupTrial(classifiedData.trial_balance,accounts);
const current={showZero:false,showActivityZero:true,showAuxiliary:false,showDisabled:true,levelFrom:'1',levelTo:'6',start:'2026-09',end:'2026-09',collapsed:new Set(),expanded:true};
const rows=companyBalanceTest.filteredRows(classifiedData,current,accounts);
assert.deepEqual(rows.map(r=>r.account_code),['5401','5602','560201']);
assert.equal(companyBalanceTest.reportTotals(classifiedData,rows).debit_fen,0);
const table=companyBalanceTest.tableMarkup(classifiedData,current,{accounts},{});
assert.match(table,/核对支出<br>（未记账）/);
assert.match(table,/215,000\.00/);
assert.doesNotMatch(table,/核对记录 #5|核对记录 #6|2026-09-09|2026-09-17/);
const collapsed=companyBalanceTest.tableMarkup(classifiedData,{...current,collapsed:new Set(['5602'])},{accounts},{});
assert.match(collapsed,/200\.00/);
const onlyCost=companyBalanceTest.filteredRows(classifiedData,{...current,category:'cost'},accounts);
assert.equal(companyBalanceTest.classificationTotal(classifiedData,onlyCost),21500000);
const csv=companyBalanceTest.balanceCsvLines({client:{name:'公司'}},current,classifiedData,rows,companyBalanceTest.reportTotals(classifiedData,rows));
assert.equal(csv.find(row => row[0]==='5401').at(-1),'215000.00');
assert.equal(csv.at(-1).at(-1),'215200.00');
assert.equal(csv.length,rows.length+3);
console.log('classifications appear within the balance table without contaminating posted totals');

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
