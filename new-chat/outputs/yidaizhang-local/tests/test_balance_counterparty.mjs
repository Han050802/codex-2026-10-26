import assert from 'node:assert/strict';
import {companyBalanceTest, focusCompanyBalance} from '../public/company-balance.js';

const clientId=9191;
focusCompanyBalance({clientId, classifications:[{period:'2026-09'}]});
const book={client:{id:clientId,name:'本方公司'},period:'2026-10'};
const data={
  trial_balance_rollup:[{account_code:'5401',account_name:'主营业务成本',debit_fen:0,credit_fen:0}],
  ledger:[],
  expense_classifications:[
    {record_id:1,date:'2026-09-09',counterparty:'甲公司 <测试>',account_code:'5401',account_name:'主营业务成本',direction:'expense',amount_fen:11200000},
    {record_id:2,date:'2026-09-17',counterparty:'乙公司',account_code:'5401',account_name:'主营业务成本',direction:'expense',amount_fen:10300000},
    {record_id:3,date:'2026-09-18',counterparty:'  ',account_code:'5401',account_name:'主营业务成本',direction:'expense',amount_fen:100},
    {record_id:4,date:'2026-09-19',counterparty:'其他科目',account_code:'5602',account_name:'管理费用',direction:'expense',amount_fen:200},
  ],
};
let dialog;
await companyBalanceTest.showLedger('5401',book,{api:async()=>data,modal:(title,html)=>{dialog={title,html};}});
assert.match(dialog.html, /<th>对方公司名称<\/th>/);
assert.doesNotMatch(dialog.html, /<th>核对记录<\/th>|#1|#2/);
assert.match(dialog.html, /2026-09-09<\/td><td>甲公司 &lt;测试&gt;<\/td>/);
assert.match(dialog.html, /2026-09-17<\/td><td>乙公司<\/td>/);
assert.match(dialog.html, /2026-09-18<\/td><td>未提供<\/td>/);
assert.doesNotMatch(dialog.html, /其他科目/);
assert.match(dialog.html, /112,000\.00/);
assert.match(dialog.html, /103,000\.00/);
assert.match(dialog.html, /本期合计/);
console.log('ledger shows escaped counterparties and an explicit missing-name placeholder');
