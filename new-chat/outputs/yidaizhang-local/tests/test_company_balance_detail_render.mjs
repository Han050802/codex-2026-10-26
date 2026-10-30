import assert from 'node:assert/strict';
import {companyBalanceTest as balance} from '../public/company-balance.js';

// Real detail rows exercise the same render path as a completed balance query.
// Empty reports cannot catch a missing detail-label import.
const accounts=[{code:'1002',name:'银行存款',category:'asset'}];
const row={account_code:'1002',account_name:'银行存款',category:'asset',level:1,is_leaf:true,debit_fen:10000,credit_fen:0,closing_debit_fen:10000};
const data={start_period:'2026-08',end_period:'2026-09',trial_balance:[row],trial_balance_rollup:[row],balance_details:[
  {source_type:'voucher',line_id:1,account_code:'1002',counterparty:'测试客户 <甲>',summary:'转取：服务费',debit_fen:10000,closing_debit_fen:10000},
  {source_type:'opening_balance',id:2,account_code:'1002',counterparty:'',summary:''},
]};
const current={start:'2026-08',end:'2026-09',levelFrom:'1',levelTo:'6',showDisabled:true,showAuxiliary:true,showZero:false,showActivityZero:true,expanded:true,collapsed:new Set(),data,loading:false,error:''};
const html=balance.tableMarkup(data,current,{client:{name:'测试公司'},accounts},{});
assert.match(html,/科目及逐笔款项/,'Keep the restored report layout.');
assert.match(html,/data-cob-detail="1"/);
assert.match(html,/测试客户 &lt;甲&gt;/);
assert.match(html,/<div>服务费<\/div>/);
assert.match(html,/未提供对方名称/);
assert.match(html,/未提供费用名称/);
assert.doesNotMatch(html,/正在读取余额表|<甲>/);
assert.equal((html.match(/class="cob-detail /g)||[]).length,2);
console.log('balance with nonempty detail rows renders names, fallbacks and escaped content without a missing-symbol error');
