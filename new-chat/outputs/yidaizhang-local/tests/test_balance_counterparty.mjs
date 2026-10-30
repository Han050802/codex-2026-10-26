import assert from 'node:assert/strict';
import {companyBalanceTest, focusCompanyBalance} from '../public/company-balance.js';

const clientId=9191;
focusCompanyBalance({clientId, classifications:[{period:'2026-09'}]});
const book={client:{id:clientId,name:'本方公司'},period:'2026-10'};
const amounts=amount=>({opening_debit_fen:0,opening_credit_fen:0,debit_fen:amount,credit_fen:0,closing_debit_fen:amount,closing_credit_fen:0});
const rawSources=[
  {source_type:'expense_classification',record_id:1,reference:'发票 EXPENSE-1',date:'2026-09-09',counterparty:'甲公司 <测试>',account_code:'5401',category_code:'540101',summary:'办公耗材 <甲>',amount_fen:11200000},
  {source_type:'voucher',voucher_id:12,line_id:102,reference:'记-012',date:'2026-09-17',counterparty:'乙公司',account_code:'5401',category_code:'540102',summary:'已入账服务费',amount_fen:10300000},
  {source_type:'expense_classification',record_id:3,reference:'发票 EXPENSE-3',date:'2026-09-18',counterparty:'  ',account_code:'5401',category_code:'540103',summary:'未标注供应商费用',amount_fen:100},
  {source_type:'expense_classification',record_id:4,reference:'发票 EXPENSE-4',date:'2026-09-19',counterparty:'其他科目',account_code:'5602',category_code:'560201',summary:'管理费用',amount_fen:200},
];
const details=rawSources.map(item=>({...item,...amounts(item.amount_fen),original_account_code:item.account_code,account_name:item.account_code==='5401'?'主营业务成本':'管理费用',period_bucket:'current',direction:'expense',date_source:'invoice',reviewed:false}));
const total=21500100;
const categoryRows=[
  {account_code:'5401',account_name:'主营业务成本',level:1,is_leaf:false,is_category:false,category:'expense',...amounts(total)},
  ...details.filter(item=>item.account_code==='5401').map(item=>({account_code:item.category_code,account_name:`${item.counterparty.trim()||'未提供对方名称'}（${item.summary}）`,original_account_code:item.account_code,parent_code:'5401',level:2,is_leaf:true,is_category:true,category:'expense',source_refs:[{source_type:item.source_type,record_id:item.record_id,voucher_id:item.voucher_id,line_id:item.line_id,original_account_code:item.account_code}],...amounts(item.amount_fen)})),
  {account_code:'5602',account_name:'管理费用',level:1,is_leaf:false,is_category:false,category:'expense',...amounts(200)},
  {account_code:'560201',account_name:'其他科目（管理费用）',original_account_code:'5602',parent_code:'5602',level:2,is_leaf:true,is_category:true,category:'expense',...amounts(200)},
];
const data={start_period:'2026-09',end_period:'2026-09',category_rows:categoryRows,category_accounts:categoryRows.map(item=>({...item,code:item.account_code,name:item.account_name})),trial_balance_rollup:categoryRows.filter(item=>!item.is_category),ledger:details.filter(item=>item.source_type==='voucher'),expense_classifications:details.filter(item=>item.source_type==='expense_classification'),balance_details:details};
let dialog;
const context={api:async()=>({...data,basis:'standard'}),modal:(title,html)=>{dialog={title,html};}};
await companyBalanceTest.showLedger('5401',book,context);
assert.match(dialog.html, /<th>对方公司名称<\/th>/);
assert.doesNotMatch(dialog.html, /<th>核对记录<\/th>/);
assert.match(dialog.html, /<td>2026-09-09<\/td><td>发票 EXPENSE-1<\/td><td>5401 主营业务成本<\/td><td>甲公司 &lt;测试&gt;<\/td><td>办公耗材 &lt;甲&gt;<\/td>/);
assert.match(dialog.html, /<td>2026-09-17<\/td><td>记-012<\/td><td>5401 主营业务成本<\/td><td>乙公司<\/td>/);
assert.match(dialog.html, /<td>2026-09-18<\/td><td>发票 EXPENSE-3<\/td><td>5401 主营业务成本<\/td><td>未提供<\/td>/);
assert.doesNotMatch(dialog.html, /其他科目|<测试>|<甲>/,'Other accounts and unescaped source text must stay outside this ledger.');
assert.match(dialog.html, /112,000\.00/);
assert.match(dialog.html, /103,000\.00/);
assert.match(dialog.html, /215,001\.00/,'Source rows sum to the parent report total.');
assert.match(dialog.html, /本期合计/);
assert.match(dialog.html, /data-cob-delete="\{&quot;record_id&quot;:1\}"/);
assert.match(dialog.html, /data-cob-delete="\{&quot;voucher_id&quot;:12\}"/);
assert.match(dialog.html, /data-cob-delete-reviewed="0"/);

await companyBalanceTest.showLedger('540101',book,context);
assert.match(dialog.title,/^540101 甲公司 <测试>/,'The selected category retains its report code in the title.');
assert.match(dialog.html, /<td>5401 主营业务成本<\/td>/,'Source ledger rows retain actual journal account codes.');
assert.match(dialog.html, /甲公司 &lt;测试&gt;/);
assert.match(dialog.html, /112,000\.00/);
assert.doesNotMatch(dialog.html, /乙公司|103,000\.00|EXPENSE-3|其他科目/,'A category ledger excludes sibling categories and other source accounts.');
assert.deepEqual(companyBalanceTest.balanceDetailRows(data,[categoryRows[1]]).map(item=>({record_id:item.record_id,account_code:item.account_code,category_code:item.category_code})),[{record_id:1,account_code:'5401',category_code:'540101'}]);
console.log('category ledgers show escaped counterparties, missing-name fallbacks, exact source IDs, original journal accounts, and nonduplicated totals');
