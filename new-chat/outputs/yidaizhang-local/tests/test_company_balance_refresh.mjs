import assert from 'node:assert/strict';

let instance = 0;
const freshModule = () => import(`../public/company-balance.js?refresh-test=${++instance}`);
const originalWindow = globalThis.window;
let location = new URL('http://test.invalid:8765/?keep=1');
const historyCalls = [];
globalThis.window = {
  get location() { return location; },
  history: {state:{keep:true}, replaceState(state, _, url) { historyCalls.push({state,url}); location = new URL(url,location); }},
};
const setHash = hash => { location = new URL(`http://test.invalid:8765/?keep=1${hash}`); };
const tick = () => new Promise(resolve => setTimeout(resolve,0));
const account = {code:'5401',name:'主营业务成本',category:'expense'};
const row = {account_code:'5401',account_name:account.name,category:'expense',level:1,is_leaf:true,opening_debit_fen:0,opening_credit_fen:0,debit_fen:0,credit_fen:0,closing_debit_fen:0,closing_credit_fen:0};
const classification = {record_id:21,source_type:'expense_classification',direction:'expense',account_code:'5401',date:'2026-09-18',counterparty:'分类供应商',summary:'办公耗材',amount_fen:99999};
const postedRow = {...row,debit_fen:12345,closing_debit_fen:12345};
const postedDetail = {source_type:'voucher',voucher_id:10,line_id:11,date:'2026-09-10',counterparty:'凭证供应商',summary:'已入账成本',account_code:'5401',account_name:account.name,original_account_code:'5401',category_code:'540101',period_bucket:'current',debit_fen:12345,credit_fen:0,closing_debit_fen:12345,closing_credit_fen:0};
const makeBook = period => ({client:{id:2,name:'模拟客户',start_period:'2026-01'},period,accounts:[account],trial_balance:[row],trial_balance_rollup:[row],ledger:[]});
const makeReport = (start,end,classified=[classification]) => {
  const classifiedFen=classified.reduce((total,item)=>total+item.amount_fen,0);
  const reportRow={...postedRow,is_leaf:false,debit_fen:postedRow.debit_fen+classifiedFen,closing_debit_fen:postedRow.closing_debit_fen+classifiedFen};
  const categories=[
    {...reportRow,is_category:false,code:'5401',name:account.name},
    {...postedRow,account_code:'540101',account_name:'凭证供应商（已入账成本）',code:'540101',name:'凭证供应商（已入账成本）',is_category:true,original_account_code:'5401',parent_code:'5401',level:2,source_refs:[{source_type:'voucher',voucher_id:10,line_id:11,original_account_code:'5401'}]},
    ...(classified.length?[{...row,account_code:'540102',account_name:'分类供应商（办公耗材）',code:'540102',name:'分类供应商（办公耗材）',is_category:true,original_account_code:'5401',parent_code:'5401',level:2,debit_fen:classifiedFen,closing_debit_fen:classifiedFen,source_refs:classified.map(item=>({source_type:'expense_classification',record_id:item.record_id,original_account_code:'5401'}))}]:[]),
  ];
  return {basis:'standard',start_period:start,end_period:end,report_basis:'vouchers_and_invoice_classifications',trial_balance:[reportRow],trial_balance_rollup:[reportRow],category_rows:categories,category_accounts:categories,ledger:[postedDetail],expense_classifications:classified,balance_details:[postedDetail,...classified.map(item=>({...row,...item,original_account_code:'5401',category_code:'540102',period_bucket:'current',debit_fen:item.amount_fen,closing_debit_fen:item.amount_fen}))]};
};

function makeHost() {
  return {matches:()=>true,parentNode:null,isConnected:false,querySelectorAll:()=>[],handlers:new Map(),addEventListener(event,handler){this.handlers.set(event,handler);}};
}
async function loadReport(mod,book,api) {
  const context = {api,toast(){}};
  mod.renderCompanyBalance(book,context);
  mod.bindCompanyBalance(makeHost(),book,context);
  await tick();
  const host = makeHost();
  mod.bindCompanyBalance(host,book,context);
  return {host,context,html:mod.renderCompanyBalance(book,context)};
}

try {
  const first = await freshModule();
  const target = first.focusCompanyBalance({clientId:2,classifications:[{period:'2026-09'}]});
  assert.deepEqual(target,{clientId:2,period:'2026-09'});
  const savedData=makeReport('2026-09','2026-09');
  const saved = await loadReport(first,makeBook(target.period),async () => savedData);
  assert.match(saved.html,/123\.45/);
  assert.match(saved.html,/data-cob-account="540101"/,'Posted source payments have numbered categories.');
  assert.match(saved.html,/data-cob-account="540102"/,'Documented expense classifications also have numbered categories.');
  assert.match(saved.html,/999\.99/);
  assert.match(saved.html,/1,123\.44/,'The report incorporates both sources once at the parent and total.');
  assert.doesNotMatch(saved.html,/data-cob-detail=/,'Raw source rows are not repeated under report categories.');
  assert.equal(first.companyBalanceTest.reportTotals(savedData,savedData.category_rows).debit_fen,112344);
  assert.equal(savedData.ledger.reduce((sum,line)=>sum+line.debit_fen,0),12345,'Classifications do not create formal journal entries.');
  assert.equal(savedData.category_rows[2].source_refs[0].record_id,21);
  assert.equal(savedData.balance_details[1].account_code,'5401','Original source account IDs stay intact.');
  assert.equal(location.hash,'#balance/2/2026-09/2026-09');
  assert.equal(location.search,'?keep=1');
  assert.deepEqual(historyCalls.at(-1).state,{keep:true});

  // A fresh module has no pending postings, classifications or query cache.
  // Only the URL is retained, and the saved amounts are fetched again.
  const reloaded = await freshModule();
  const restored = reloaded.readCompanyBalanceRoute();
  assert.deepEqual(restored,{clientId:2,start:'2026-09',end:'2026-09'});
  assert.equal(reloaded.restoreCompanyBalanceRange(restored),true);
  let restoredUrl = '';
  const restoredResult = await loadReport(reloaded,makeBook(restored.start),async url => {
    restoredUrl = url;
    return makeReport(restored.start,restored.end);
  });
  assert.match(restoredUrl,/start=2026-09&end=2026-09&basis=standard$/);
  assert.match(restoredResult.html,/123\.45/);
  assert.match(restoredResult.html,/data-cob-account="540102"/,'Reloaded reports retain generated category codes.');
  assert.match(restoredResult.html,/1,123\.44/);
  assert.doesNotMatch(restoredResult.html,/本次保存的分录/);

  const multiple = await freshModule();
  multiple.focusCompanyBalance({clientId:2,classifications:[{period:'2026-09'}]});
  assert.equal(multiple.restoreCompanyBalanceRange({clientId:2,start:'2026-08',end:'2026-10'}),true);
  let multipleUrl = '';
  const multipleResult = await loadReport(multiple,makeBook('2026-08'),async url => {
    multipleUrl = url;
    return makeReport('2026-08','2026-10');
  });
  assert.match(multipleUrl,/start=2026-08&end=2026-10&basis=standard$/);
  assert.match(multipleResult.html,/name="start" type="month" value="2026-08"/);
  assert.match(multipleResult.html,/name="end" type="month" value="2026-10"/);
  assert.match(multipleResult.html,/123\.45/);
  assert.match(multipleResult.html,/data-cob-check="showAuxiliary" checked/);
  assert.equal(location.hash,'#balance/2/2026-08/2026-10');
  const multipleReload = await freshModule();
  assert.deepEqual(multipleReload.readCompanyBalanceRoute(),{clientId:2,start:'2026-08',end:'2026-10'});

  for (const hash of ['#balance','#balance/0/2026-09/2026-09','#balance/-1/2026-09/2026-09','#balance/02/2026-09/2026-09','#balance/9007199254740992/2026-09/2026-09','#balance/2/2026-00/2026-09','#balance/2/2026-09/2026-13','#balance/2/0000-01/2026-09','#balance/2/1999-01/2026-09','#balance/2/2026-09/2100-01','#balance/2/0026-01/0026-09','#balance/2/9999-01/9999-09','#balance/2/2026-10/2026-09','#balance/2/2026-09/2026-09/extra','#help']) {
    assert.equal(multipleReload.readCompanyBalanceRoute(hash),null,hash);
  }
  assert.equal(multipleReload.restoreCompanyBalanceRange({clientId:2,start:null,end:'2026-09'}),false);
  assert.equal(multipleReload.restoreCompanyBalanceRange({clientId:2,start:'2026-10',end:'2026-09'}),false);
  setHash('#help');
  multipleReload.clearCompanyBalanceRoute();
  assert.equal(location.hash,'#help','Unrelated URL fragments must survive navigation.');
  setHash('#balance/not-valid');
  multipleReload.clearCompanyBalanceRoute();
  assert.equal(location.hash,'');
  assert.equal(location.search,'?keep=1');

  const failed = await freshModule();
  setHash('#balance/2/2026-09/2026-09');
  failed.restoreCompanyBalanceRange({clientId:2,start:'2026-10',end:'2026-10'});
  let attempts = 0;
  const failedBook = makeBook('2026-10');
  const failedResult = await loadReport(failed,failedBook,async () => {attempts++;throw new Error('模拟网络中断');});
  assert.equal(location.hash,'#balance/2/2026-09/2026-09','A failed query must not replace the last successful range.');
  assert.equal(attempts,1,'Failed queries must not create an automatic retry loop.');
  assert.match(failedResult.html,/余额表读取失败，请重试/);
  assert.match(failedResult.html,/模拟网络中断/);
  assert.doesNotMatch(failedResult.html,/当前条件下暂无科目余额/);
  failedResult.context.api = async () => makeReport('2026-10','2026-10',[]);
  failedResult.host.handlers.get('click')({target:{closest:selector=>selector==='[data-cob-action]'?{dataset:{cobAction:'refresh'}}:null}});
  await tick();
  failed.bindCompanyBalance(makeHost(),failedBook,failedResult.context);
  assert.equal(location.hash,'#balance/2/2026-10/2026-10','An explicit successful retry persists its range.');

  const departed = await freshModule();
  setHash('#balance/2/2026-09/2026-09');
  let finishRequest;
  const departedBook = makeBook('2026-09');
  const departedContext = {api:() => new Promise(resolve => {finishRequest=resolve;}),toast(){}};
  departed.renderCompanyBalance(departedBook,departedContext);
  const departedHost = makeHost();
  departed.bindCompanyBalance(departedHost,departedBook,departedContext);
  departed.clearCompanyBalanceRoute();
  const callsWhenLeaving = historyCalls.length;
  finishRequest(makeReport('2026-09','2026-09'));
  await tick();
  assert.equal(location.hash,'','A response arriving after the report is detached must not restore its route.');
  assert.equal(historyCalls.length,callsWhenLeaving);

  const fallback = await freshModule();
  const fallbackBook = {...makeBook('2026-09'),...makeReport('2026-09','2026-09')};
  const fallbackHtml = fallback.renderCompanyBalance(fallbackBook,{});
  assert.match(fallbackHtml,/123\.45/,'Book-supplied posted balances survive the initial fallback.');
  assert.match(fallbackHtml,/data-cob-account="540102"/,'Book-supplied category metadata survives the initial fallback.');
  assert.match(fallbackHtml,/999\.99/,'The fallback preserves documented classification values.');
  assert.match(fallbackHtml,/1,123\.44/);
  assert.doesNotMatch(fallbackHtml,/data-cob-detail=/);
  const loading = await freshModule();
  const loadingBook = makeBook('2026-09');
  assert.match(loading.renderCompanyBalance(loadingBook,{}),/正在读取余额表/);
  assert.doesNotMatch(loading.renderCompanyBalance(loadingBook,{}),/当前条件下暂无科目余额/);
  loading.restoreCompanyBalanceRange({clientId:2,start:'2025-12',end:'2026-09'});
  const safe = loading.renderCompanyBalance(loadingBook,{});
  assert.match(safe,/name="start" type="month" value="2026-09"/,'A range predating the client must fall back to its book period.');
  setHash('#balance/2/2026-09/2026-09');
  loading.clearCompanyBalanceRoute();
  assert.equal(location.hash,'');

  console.log('balance URL restoration survives reload, preserves ranges and category amounts, retries safely, and keeps classifications outside formal journals');
} finally {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
}
