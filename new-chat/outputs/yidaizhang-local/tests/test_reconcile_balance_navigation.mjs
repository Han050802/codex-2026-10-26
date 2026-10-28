import assert from 'node:assert/strict';
import {focusCompanyBalance, renderCompanyBalance} from '../public/company-balance.js';

const book={client:{id:18,name:'测试公司',start_period:'2025-01'},period:'2026-08',accounts:[
  {code:'1002',name:'银行存款',category:'asset'},
  {code:'2202',name:'应付账款',category:'liability'},
  {code:'220201',name:'供应商',category:'liability'},
  {code:'5601',name:'销售费用',category:'expense'},
],trial_balance:[{account_code:'1002',credit_fen:10000},{account_code:'220201',debit_fen:10000}]};
assert.throws(()=>focusCompanyBalance({clientId:18,postings:[]}),/缺少/);
const destination=focusCompanyBalance({clientId:18,postings:[
  {period:'2026-10',voucher_id:12,posted_lines:[{account_code:'220201',account_name:'供应商',debit_fen:10000,credit_fen:0},{account_code:'1002',account_name:'银行存款',debit_fen:0,credit_fen:10000}]},
  {period:'2026-08',voucher_id:11,posted_lines:[{account_code:'220201',account_name:'供应商',debit_fen:20000,credit_fen:0}]},
]});
assert.deepEqual(destination,{clientId:18,period:'2026-08'});
const html=renderCompanyBalance(book,{});
assert.match(html,/测试公司 · 本次保存的分录/);
assert.match(html,/2026-10 · 凭证 #12 · 220201 供应商 · 借 100\.00/);
assert.match(html,/2026-08 · 凭证 #11 · 220201 供应商 · 借 200\.00/);
assert.match(html,/所选期间全部凭证/);
assert.match(html,/name="start" type="month" value="2026-08"/);
assert.match(html,/name="end" type="month" value="2026-10"/);
assert.match(html,/data-cob-check="expanded" checked/);
// A one-month report shows actual rows and highlights the saved account.
focusCompanyBalance({clientId:18,postings:[{period:'2026-08',voucher_id:11,posted_lines:[{account_code:'220201',account_name:'供应商',debit_fen:20000,credit_fen:0}]}]});
const single=renderCompanyBalance(book,{});
assert.match(single,/class="cob-posted" data-cob-account="220201"/);
assert.match(single,/data-cob-check="showZero"\s*>/);
assert.doesNotMatch(single,/data-cob-account="5601"/);
const other=renderCompanyBalance({...book,client:{id:19,name:'另一公司',start_period:'2025-01'}},{});
assert.doesNotMatch(other,/本次保存的分录/);
console.log('reconciliation balance navigation, period range, entry amounts and company isolation passed');
