import assert from 'node:assert/strict';
import {createBalanceXlsx} from '../public/balance-xlsx.js';

const originalStorage=globalThis.localStorage;
const preferences=new Map();
globalThis.localStorage={getItem:key=>preferences.get(key)??null,setItem:(key,value)=>preferences.set(key,value)};
let generation=0;
const fresh=()=>import(`../public/company-balance.js?standard-basis-test=${++generation}`);
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const amounts=(debit=0,credit=0,closingDebit=0,closingCredit=0)=>({opening_debit_fen:0,opening_credit_fen:0,debit_fen:debit,credit_fen:credit,closing_debit_fen:closingDebit,closing_credit_fen:closingCredit});
const row=(code,name,category,values,extra={})=>({account_code:code,account_name:name,code,name,category,level:1,is_leaf:true,...values,...extra});
const standardRows=[
  row('1002','银行存款','asset',amounts(25520633,912400,24608233)),
  row('1221','其他应收款','asset',amounts(40000,0,40000)),
  row('2241','其他应付款','liability',amounts(0,213,0,213)),
  row('3001','实收资本','equity',amounts(0,10000000,0,10000000)),
  row('3103','本年利润','equity',amounts(0,14648020,0,14648020)),
  row('5001','主营业务收入','income',amounts(15520000,15520000),{is_leaf:false}),
  row('500101','服务收入','income',amounts(15520000,15520000),{level:2,parent_code:'5001',is_leaf:false}),
  row('50010101','业务公司（服务费）','income',amounts(15520000,15520000),{level:3,parent_code:'500101',is_category:true}),
  row('5602','管理费用','expense',amounts(872400,872400)),
  row('5603','财务费用','expense',amounts(),{is_leaf:false}),
  row('560301','利息','expense',amounts(),{level:2,parent_code:'5603',is_category:true}),
];
const actualSource={source_type:'bank_receipt',voucher_id:81,line_id:811,read_only:true,date:'2026-09-15',account_code:'500101',original_account_code:'500101',category_code:'50010101',account_name:'服务收入',counterparty:'业务公司',summary:'服务费',period_bucket:'current',...amounts(0,15520000,0,15520000)};
const closing={source_type:'report_closing',source_id:'projection-1',voucher_id:null,line_id:null,is_projection:true,read_only:true,date:'2026-09-30',account_code:'500101',original_account_code:'500101',category_code:'50010101',account_name:'服务收入',summary:'损益结转测算',period_bucket:'current',...amounts(15520000)};
const report={basis:'standard',scope:'range',has_projection:true,projection_note:'仅报表测算，未生成凭证、未审核、未锁定期间。',start_period:'2026-08',end_period:'2026-09',trial_balance:standardRows,trial_balance_rollup:standardRows,category_rows:standardRows,category_accounts:standardRows,balance_details:[actualSource,closing],ledger:[actualSource]};
const actualRows=standardRows.filter(item=>!['3103','560301'].includes(item.account_code)).map(item=>item.account_code==='5001'||item.account_code.startsWith('500101')?{...item,...amounts(0,15520000,0,15520000)}:item.account_code==='5602'?{...item,...amounts(872400,0,872400)}:item.account_code==='5603'?{...item,...amounts(0,420,0,420)}:item);
const editableSource={...actualSource,read_only:false};
const actual={...report,basis:'actual',has_projection:false,projection_note:'',trial_balance:actualRows,trial_balance_rollup:actualRows,category_rows:actualRows,category_accounts:actualRows,balance_details:[editableSource],ledger:[editableSource]};
const book={client:{id:2288,name:'口径测试公司',start_period:'2026-08'},period:'2026-09',accounts:actualRows.map(item=>({code:item.account_code,name:item.account_name,category:item.category})),trial_balance:actualRows,trial_balance_rollup:actualRows,periods:[{period:'2026-08',voucher_count:3},{period:'2026-09',voucher_count:3}]};
const host=()=>({matches:()=>true,parentNode:null,isConnected:false,querySelectorAll:()=>[],handlers:new Map(),addEventListener(event,handler){this.handlers.set(event,handler);}});
const changeBasis=(surface,enabled)=>surface.handlers.get('change')({target:{closest:()=>({dataset:{cobCheck:'standardBasis'},checked:enabled})}});

try {
  const mod=await fresh();
  mod.restoreCompanyBalanceRange({clientId:book.client.id,start:'2026-08',end:'2026-09'});
  let html=mod.renderCompanyBalance(book,{});
  assert.match(html,/data-cob-check="standardBasis" checked/);
  assert.doesNotMatch(html,/data-cob-account="1002"/,'An unprojected book cannot masquerade as standard data while loading.');
  const calls=[];
  const context={api:async url=>{calls.push(url);return url.endsWith('basis=actual')?actual:report;},toast(){}};
  const surface=host();mod.bindCompanyBalance(surface,book,context);await tick();
  html=mod.renderCompanyBalance(book,context);
  assert.equal(calls[0],'/api/books/2288/balance?start=2026-08&end=2026-09&basis=standard');
  assert.match(html,/含未结转损益测算/);
  assert.match(html,/data-cob-account="3103"/);
  assert.match(html,/419,530\.33/);
  assert.match(html,/246,482\.33/);
  assert.doesNotMatch(html,/data-cob-account="5603(?:01)?"/,'Fully zero financial expense branches are omitted.');
  assert.match(html,/data-cob-account="5001"/,'Zero closing balance does not hide genuine revenue activity.');
  assert.match(html,/data-cob-account="5602"/,'Zero closing balance does not hide genuine expense activity.');
  let ledger;
  await mod.companyBalanceTest.showLedger('50010101',book,{...context,modal:(title,content)=>{ledger={title,content};}});
  assert.match(ledger.content,/损益结转测算/);
  assert.match(ledger.content,/含未结转损益测算/);
  assert.match(ledger.content,/凭证 #81/,'Standard details retain the real source voucher reference.');
  assert.equal(mod.companyBalanceTest.balanceDetailRows(report,[standardRows[7]])[0].voucher_id,81,'The source voucher ID survives standard report projection.');
  assert.doesNotMatch(ledger.content,/data-cob-delete/,'All standard-basis details are read-only, including actual business sources.');
  const projectedRow=[...ledger.content.matchAll(/<tr>(.*?)<\/tr>/gs)].map(match=>match[1]).find(item=>item.includes('损益结转测算'));
  assert.ok(projectedRow);
  assert.doesNotMatch(projectedRow,/data-cob-delete|凭证 #(?:undefined|0|null)/,'Projected closing is a read-only report source, never a voucher.');
  const mislabeled=mod.companyBalanceTest.balanceDetailRows({...report,balance_details:[{...closing,voucher_id:999,read_only:false}]},[standardRows[7]]);
  assert.equal(mislabeled[0].source_label,'损益结转测算');
  const zeroBranch={...report,category_rows:standardRows.map(item=>item.account_code==='560301'?{...item,...amounts(-420)}:item)};
  const filters={levelFrom:'1',levelTo:'6',showDisabled:true,showAuxiliary:true,showZero:false,showActivityZero:true};
  assert.ok(!mod.companyBalanceTest.filteredRows(zeroBranch,filters,book.accounts).some(item=>item.account_code.startsWith('5603')),'Zero root branches cannot leave offset category fragments in standard totals.');
  changeBasis(surface,false);await tick();
  html=mod.renderCompanyBalance(book,context);
  assert.match(calls.at(-1),/&basis=actual$/);
  assert.doesNotMatch(html,/data-cob-check="standardBasis" checked/);
  assert.doesNotMatch(html,/含未结转损益测算/);
  assert.match(html,/data-cob-account="5603"/);
  await mod.companyBalanceTest.showLedger('50010101',book,{...context,modal:(title,content)=>{ledger={title,content};}});
  assert.match(ledger.content,/凭证 #81/);
  assert.match(ledger.content,/&quot;voucher_id&quot;:81/,'Actual-ledger mode retains the real voucher deletion control.');
  assert.equal(preferences.get('company-balance:standard-basis'),'actual');
  const reloaded=await fresh();
  assert.doesNotMatch(reloaded.renderCompanyBalance(book,{}),/data-cob-check="standardBasis" checked/,'Actual-ledger preference survives a module reload.');
  changeBasis(surface,true);await tick();
  assert.match(calls.at(-1),/&basis=standard$/);
  assert.match(mod.renderCompanyBalance(book,context),/419,530\.33/);

  const rejected=await fresh();
  const errors=[];const rejectionContext={api:async()=>({...actual,start_period:'2026-09',end_period:'2026-09'}),toast:message=>errors.push(message)};
  rejected.renderCompanyBalance(book,rejectionContext);rejected.bindCompanyBalance(host(),book,rejectionContext);await tick();
  assert.match(rejected.renderCompanyBalance(book,rejectionContext),/余额表数据格式错误/);
  assert.equal(errors.length,1,'Wrong-basis responses terminate with a visible error instead of reloading indefinitely.');
  assert.doesNotMatch(rejected.renderCompanyBalance(book,rejectionContext),/data-cob-account="5603"/);

  const racing=await fresh();let finishStandard;
  const raceContext={api:url=>url.endsWith('basis=standard')?new Promise(resolve=>{finishStandard=resolve;}):Promise.resolve({...actual,start_period:'2026-09',end_period:'2026-09'}),toast(){}};
  racing.renderCompanyBalance(book,raceContext);const raceHost=host();racing.bindCompanyBalance(raceHost,book,raceContext);
  changeBasis(raceHost,false);await tick();
  finishStandard({...report,start_period:'2026-09',end_period:'2026-09'});await tick();
  const afterRace=racing.renderCompanyBalance(book,raceContext);
  assert.doesNotMatch(afterRace,/含未结转损益测算/,'A late standard response cannot overwrite actual-ledger mode.');
  assert.match(afterRace,/data-cob-account="5603"/);

  const bytes=createBalanceXlsx({scope:'all',basis:'standard',hasProjection:true,startPeriod:'2026-08',endPeriod:'2026-09',rows:[]});
  const xml=new TextDecoder().decode(bytes);
  assert.match(xml,/202608至202609（全账套）/);
  assert.match(xml,/损益结转口径；含未结转测算/);
  const closed=new TextDecoder().decode(createBalanceXlsx({scope:'all',basis:'standard',hasProjection:false,rows:[]}));
  assert.match(closed,/损益结转口径/);
  assert.doesNotMatch(closed,/含未结转测算/);
  console.log('standard basis queries, exact totals, safe projection provenance, actual-mode persistence, race isolation and XLSX labels passed');
} finally {
  if(originalStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=originalStorage;
}
