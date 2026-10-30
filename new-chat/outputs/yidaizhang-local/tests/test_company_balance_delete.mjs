import assert from 'node:assert/strict';

const originalStorage = globalThis.localStorage;
const preferences = new Map([['company-balance:standard-basis', 'standard']]);
globalThis.localStorage = {getItem:key=>preferences.get(key) ?? null, setItem:(key,value)=>preferences.set(key,value)};
let generation = 0;
const fresh = () => import(`../public/company-balance.js?batch-delete-test=${++generation}`);
const tick = () => new Promise(resolve=>setTimeout(resolve,0));
const deleteToken = 'a'.repeat(64);
const row = (code,category,extra={}) => ({code,name:`科目 ${code}`,account_code:code,account_name:`科目 ${code}`,category,level:1,is_leaf:true,opening_debit_fen:0,opening_credit_fen:0,debit_fen:10000,credit_fen:0,closing_debit_fen:10000,closing_credit_fen:0,...extra});
const rows = [row('1002','asset'),row('5401','expense',{is_leaf:false}),row('540101','expense',{level:2,parent_code:'5401'}),row('540102','expense',{level:2,parent_code:'5401'}),row('6001','income')];
const entry = (voucher_id,account_code,extra={}) => ({source_type:'voucher',voucher_id,line_id:voucher_id*10,delete_token:deleteToken,date:'2026-09-12',account_code,summary:`原始记录 ${voucher_id}`,period_bucket:'current',debit_fen:10000,credit_fen:0,closing_debit_fen:10000,closing_credit_fen:0,...extra});
const details = [
  entry(11,'540101',{summary:'费用 <script>unsafe</script>'}),
  entry(11,'1002',{line_id:112,debit_fen:0,credit_fen:10000}),
  entry(12,'540102',{date:'2026-08-12',period_bucket:'opening'}),
  {source_type:'expense_classification',record_id:21,delete_token:deleteToken,account_code:'5401',category_code:'540102',date:'2026-09-13',summary:'分类费用',period_bucket:'current',debit_fen:20000,closing_debit_fen:20000},
  entry(13,'6001'),
  entry(91,'540101',{reviewed:true}),
  entry(92,'540101',{reviewed:1}),
  entry(93,'540101',{source_type:'closing'}),
  entry(94,'540101',{is_projection:true}),
  entry(95,'540101',{read_only:true}),
  entry(96,'540101',{source_type:'report_closing'}),
  {source_type:'opening_balance',account_code:'540102',period_bucket:'opening',debit_fen:100},
];
const actual = {basis:'actual',start_period:'2026-09',end_period:'2026-09',trial_balance:rows,trial_balance_rollup:rows,category_rows:rows,category_accounts:rows,balance_details:details,ledger:details};
const standard = {...actual,basis:'standard',has_projection:true,balance_details:details.map(item=>({...item,read_only:true}))};
const book = {client:{id:423,name:'批量删除测试公司',start_period:'2026-01'},period:'2026-09',accounts:rows};
const baseState = extra => ({start:'2026-09',end:'2026-09',deleteMode:true,selection:new Set(),category:'',codeFrom:'',codeTo:'',min:'',max:'',levelFrom:'1',levelTo:'6',showDisabled:true,showAuxiliary:true,showZero:false,showActivityZero:true,expanded:true,collapsed:new Set(),...extra});
const makeHost = extra => ({matches:()=>true,parentNode:null,isConnected:true,querySelectorAll:()=>[],handlers:new Map(),addEventListener(event,handler){this.handlers.set(event,handler);},...extra});
const emitClick = (host,selector,dataset) => host.handlers.get('click')({target:{closest:query=>query===selector ? {dataset} : null}});
const action = (host,value) => emitClick(host,'[data-cob-action]',{cobAction:value});
const select = (host,value,checked=true,extra={}) => host.handlers.get('change')({target:{closest:query=>query==='[data-cob-select]' ? {dataset:{cobSelect:value},checked,...extra} : null}});
const check = (host,key,checked) => host.handlers.get('change')({target:{closest:query=>query==='[data-cob-check]' ? {dataset:{cobCheck:key},checked} : null}});
const checkbox = (html,value) => html.match(new RegExp(`<input[^>]*data-cob-select="${value}"[^>]*>`))?.[0] || '';

try {
  const mod = await fresh();
  const ui = mod.companyBalanceTest;
  const originalActual = JSON.stringify(actual), originalStandard = JSON.stringify(standard);
  const current = baseState({selection:new Set(['v:11','v:12','r:21','v:13','v:91','v:999'])});
  const model = ui.deletionModel(actual,current,book);
  assert.deepEqual(new Set(model.sources.keys()),new Set(['v:11','v:12','r:21','v:13']),'Both voucher sides, parents and categories share one source selection.');
  assert.deepEqual(model.byCode.get('5401'),new Set(['v:11','v:12','r:21']));
  assert.deepEqual([...model.byCode.get('540101')],['v:11']);
  assert.deepEqual([...model.byCode.get('1002')],['v:11']);
  assert.equal(model.chosen.length,4);
  assert.equal(model.sources.get('v:12').opening,true);
  assert.ok(model.chosen.every(source=>source.target.delete_token===deleteToken),'Every selected source carries its report concurrency token into the batch target.');
  assert.deepEqual([...current.selection],['v:11','v:12','r:21','v:13'],'Stale, reviewed and noneditable source IDs are removed.');
  for (const token of [undefined,'','a'.repeat(63),'a'.repeat(65),'A'.repeat(64),'g'.repeat(64)]) {
    const unsigned = {...actual,balance_details:[entry(101,'540101',{delete_token:token})]};
    assert.equal(ui.deletionModel(unsigned,baseState(),book).sources.size,0,'A missing or malformed concurrency token makes the source unselectable.');
  }
  for (const data of [standard,{...actual,balance_details:details.filter(item=>item.read_only || item.is_projection || item.source_type==='report_closing')}]) {
    assert.equal(ui.deletionModel(data,baseState(),book).sources.size,0,'Read-only and projected report sources cannot be selected.');
  }
  for (const unavailable of [{deleteMode:false},{loading:true},{failedKey:'failed-query'}]) {
    assert.equal(ui.deletionModel(actual,baseState(unavailable),book).sources.size,0);
  }
  const filtered = baseState({category:'expense',expanded:false,collapsed:new Set(['5401']),selection:new Set(['v:11'])});
  const filteredModel = ui.deletionModel(actual,filtered,book);
  assert.deepEqual(new Set(filteredModel.sources.keys()),new Set(['v:11','v:12','r:21']),'Current filters limit selection while collapsed descendants remain eligible.');
  const markup = ui.tableMarkup(actual,filtered,book,{});
  assert.doesNotMatch(markup,/data-cob-account="540101"/);
  assert.match(checkbox(markup,'account:5401'),/aria-checked="mixed".*data-cob-mixed/);
  assert.match(checkbox(markup,'all'),/aria-checked="mixed"/);
  const mixedInput = {indeterminate:false};
  const mixedHost = makeHost({isConnected:false,querySelectorAll:selector=>selector==='[data-cob-mixed]' ? [mixedInput] : []});
  mod.renderCompanyBalance(book,{});
  mod.bindCompanyBalance(mixedHost,book,{api:async()=>standard,toast(){}});
  await tick();
  assert.equal(mixedInput.indeterminate,true,'Binding sets the native checkbox mixed state.');

  const live = await fresh();
  const requests = [], toasts = [], dialogs = [];
  let rejectDelete = true, deleted = false, reloads = 0;
  const context = {
    api:async (url,options) => {
      requests.push({url,options});
      if (url.endsWith('/balance-entries/delete-batch')) {
        if (rejectDelete) throw new Error('模拟接口失败');
        deleted = true;
        return {deleted_count:3};
      }
      return url.endsWith('basis=standard') ? standard : deleted ? {...actual,balance_details:[],ledger:[]} : actual;
    },
    toast:(...args)=>toasts.push(args),
    modal:(title,content,submit)=>dialogs.push({title,content,submit}),
    reload:async()=>{reloads++;},
  };
  const host = makeHost();
  const html = () => live.renderCompanyBalance(book,context);
  assert.match(html(),/data-cob-check="standardBasis" checked/);
  live.bindCompanyBalance(host,book,context);
  await tick();
  assert.match(requests.at(-1).url,/basis=standard$/);
  action(host,'delete-mode');
  await tick();
  assert.match(requests.at(-1).url,/basis=actual$/,'Default standard view fetches actual sources when deletion management opens.');
  assert.match(html(),/data-cob-check="standardBasis"\s+disabled/);
  assert.doesNotMatch(html(),/data-cob-check="standardBasis" checked/);
  assert.equal(preferences.get('company-balance:standard-basis'),'standard','Temporary actual mode preserves the saved report preference.');
  const beforeLockedChange = requests.length;
  check(host,'standardBasis',true);
  await tick();
  assert.equal(requests.length,beforeLockedChange,'The report basis cannot change during deletion management.');

  select(host,'account:5401');
  assert.match(html(),/已选 3 笔来源记录/);
  emitClick(host,'[data-cob-toggle]',{cobToggle:'5401'});
  assert.doesNotMatch(html(),/data-cob-account="540101"/);
  select(host,'all');
  assert.match(html(),/已选 4 笔来源记录/,'Select all includes sources hidden under a collapsed parent.');
  emitClick(host,'[data-cob-category]',{cobCategory:'expense'});
  assert.match(html(),/已选 3 笔来源记录/,'Changing filters removes selections outside the current scope.');
  select(host,'account:540101',false);
  assert.match(html(),/已选 2 笔来源记录/);
  assert.match(checkbox(html(),'account:5401'),/aria-checked="mixed"/);
  select(host,'all',false);
  for (const key of ['v:91','v:92','v:93','v:94','v:95','v:96','v:999']) select(host,key);
  assert.match(html(),/已选 0 笔来源记录/);
  select(host,'v:11',true,{disabled:true});
  assert.match(html(),/已选 0 笔来源记录/);
  select(host,'all');
  assert.match(html(),/已选 3 笔来源记录/);

  action(host,'delete-selected');
  await tick();
  assert.equal(dialogs.length,1);
  assert.match(dialogs[0].content,/2 张凭证、1 条发票核对分类记录/);
  assert.match(dialogs[0].content,/历史凭证/);
  assert.match(dialogs[0].content,/整批保留/);
  assert.match(dialogs[0].content,/&lt;script&gt;unsafe&lt;\/script&gt;/,'The confirmation preview escapes source text.');
  assert.equal((dialogs[0].content.match(/<li>/g)||[]).length,3,'The preview lists unique source records.');
  assert.equal(requests.filter(item=>item.options?.method==='POST').length,0,'Opening the preview does not submit a deletion.');
  const form = {elements:{reason:{value:'保存错误，批量删除'}}};
  await assert.rejects(dialogs[0].submit(form),/模拟接口失败/);
  assert.match(html(),/已选 3 笔来源记录/,'A failed batch retains all selected sources for retry.');
  assert.doesNotMatch(html(),/>删除中…</);
  assert.equal(reloads,0);
  const failedPost = requests.filter(item=>item.options?.method==='POST');
  assert.equal(failedPost.length,1);
  assert.equal(failedPost[0].url,'/api/books/423/balance-entries/delete-batch');
  assert.deepEqual(new Set(failedPost[0].options.body.entries.map(item=>JSON.stringify(item))),new Set([{voucher_id:11,delete_token:deleteToken},{voucher_id:12,delete_token:deleteToken},{record_id:21,delete_token:deleteToken}].map(item=>JSON.stringify(item))));
  assert.equal(failedPost[0].options.body.reason,'保存错误，批量删除');

  rejectDelete = false;
  action(host,'delete-selected');
  await tick();
  const beforeSuccess = requests.length;
  await dialogs.at(-1).submit(form);
  const successRequests = requests.slice(beforeSuccess);
  assert.equal(successRequests.filter(item=>item.options?.method==='POST').length,1,'One confirmation sends one batch request for all unique sources.');
  assert.equal(successRequests.length,2,'Successful deletion refetches the actual report once.');
  assert.match(successRequests[1].url,/basis=actual$/);
  assert.equal(reloads,1,'Successful deletion refreshes the enclosing account book.');
  assert.match(html(),/已选 0 笔来源记录/);
  assert.ok(toasts.some(([message])=>/已删除 3 笔来源记录/.test(message)));
  action(host,'delete-mode');
  await tick();
  assert.match(requests.at(-1).url,/basis=standard$/);
  assert.match(html(),/data-cob-check="standardBasis" checked/,'Closing deletion management restores the preceding standard basis.');
  assert.doesNotMatch(html(),/class="cob-delete-bar"/);
  assert.equal(preferences.get('company-balance:standard-basis'),'standard');
  assert.equal(JSON.stringify(actual),originalActual,'Selection and deletion do not mutate source report objects.');
  assert.equal(JSON.stringify(standard),originalStandard,'Projected and read-only standard data remain intact.');

  preferences.set('company-balance:standard-basis','actual');
  const actualDefault = await fresh(), actualHost = makeHost();
  let actualQueries = 0;
  const actualContext = {api:async()=>{actualQueries++;return actual;},toast(){}};
  actualDefault.renderCompanyBalance(book,actualContext);
  actualDefault.bindCompanyBalance(actualHost,book,actualContext);
  await tick();
  action(actualHost,'delete-mode');
  action(actualHost,'delete-mode');
  await tick();
  assert.equal(actualQueries,1,'Entering and exiting deletion management in actual mode reuses its loaded report.');
  assert.doesNotMatch(actualDefault.renderCompanyBalance(book,actualContext),/data-cob-check="standardBasis" checked/);
  assert.equal(preferences.get('company-balance:standard-basis'),'actual');

  const crowded = await fresh(), crowdedHost = makeHost();
  const crowdedRows = [row('5401','expense')];
  const crowdedBook = {...book,client:{...book.client,id:424},accounts:crowdedRows};
  const crowdedData = {...actual,trial_balance:crowdedRows,trial_balance_rollup:crowdedRows,category_rows:crowdedRows,category_accounts:crowdedRows,balance_details:Array.from({length:5001},(_,index)=>entry(100000+index,'5401'))};
  const crowdedCalls = [], crowdedDialogs = [];
  const crowdedContext = {api:async(...args)=>{crowdedCalls.push(args);return crowdedData;},toast(){},modal:(...args)=>crowdedDialogs.push(args)};
  crowded.renderCompanyBalance(crowdedBook,crowdedContext);
  crowded.bindCompanyBalance(crowdedHost,crowdedBook,crowdedContext);
  await tick();
  action(crowdedHost,'delete-mode');
  select(crowdedHost,'all');
  const overLimit = crowded.renderCompanyBalance(crowdedBook,crowdedContext);
  assert.match(overLimit,/已选 5001 笔来源记录/);
  assert.match(overLimit,/每次最多删除 5000 笔，请缩小筛选范围或减少勾选/);
  assert.match(overLimit,/<button[^>]*data-cob-action="delete-selected"[^>]*disabled/,'An over-limit selection disables the delete button.');
  await assert.rejects(crowded.companyBalanceTest.deleteSelected(crowdedHost,crowdedBook,crowdedContext,{}),/每次最多删除 5000 笔/,'The helper enforces the limit even when called without the disabled button.');
  assert.equal(crowdedDialogs.length,0);
  assert.equal(crowdedCalls.length,1,'An over-limit attempt opens no confirmation and sends no deletion request.');
  select(crowdedHost,'v:105000',false);
  const atLimit = crowded.renderCompanyBalance(crowdedBook,crowdedContext);
  assert.match(atLimit,/已选 5000 笔来源记录/);
  assert.doesNotMatch(atLimit,/<button[^>]*data-cob-action="delete-selected"[^>]*disabled/,'The maximum allowed selection remains usable.');
  await crowded.companyBalanceTest.deleteSelected(crowdedHost,crowdedBook,crowdedContext,{});
  assert.equal(crowdedDialogs.length,1);
  assert.equal((crowdedDialogs[0][1].match(/<li>/g)||[]).length,10,'Large valid selections keep the confirmation preview bounded.');
  assert.match(crowdedDialogs[0][1],/另有 4990 笔来源记录/);
  console.log('balance batch selection, concurrency tokens, filtered collapsed scope, protected sources, mode restoration, confirmation, failure retention, success refresh and 5000-source limit passed');
} finally {
  if (originalStorage===undefined) delete globalThis.localStorage;
  else globalThis.localStorage=originalStorage;
}
