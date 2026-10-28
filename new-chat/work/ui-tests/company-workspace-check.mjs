import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {renderBook,bindBook,setBookView} from '../../outputs/yidaizhang-local/public/finance-ui.js';
import {companyBalanceTest} from '../../outputs/yidaizhang-local/public/company-balance.js';

// Integration-only fixture: no HTTP server, filesystem database, or real client
// records are opened. Every transport call below uses synthetic in-memory data.
const {window}=parseHTML('<html><body><main id="workspace"></main><div id="modal-root"></div></body></html>');
globalThis.window=window;
globalThis.document=window.document;
globalThis.CustomEvent=window.CustomEvent;
window.innerHeight=1000;
window.print=()=>{};
Object.defineProperty(window.HTMLElement.prototype,'checked',{configurable:true,get(){return this.hasAttribute('checked');},set(value){this.toggleAttribute('checked',Boolean(value));}});
Object.defineProperty(window.HTMLElement.prototype,'elements',{configurable:true,get(){const nodes=[...this.querySelectorAll('input,select,textarea,button')];return new Proxy(nodes,{get(target,key){return key in target?target[key]:nodes.find(el=>el.getAttribute('name')===key);}});}});
Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??'';},set(value){for(const option of this.querySelectorAll('option'))option.toggleAttribute('selected',option.value===String(value));}});
window.HTMLElement.prototype.getBoundingClientRect=()=>({top:120,left:0,right:100,bottom:160,width:100,height:40});
globalThis.FormData=class {
  constructor(form){this.values=[...form.querySelectorAll('input[name],select[name],textarea[name]')].filter(el=>!el.disabled&&(!['checkbox','radio'].includes(el.type)||el.checked)).map(el=>[el.name,el.value]);}
  entries(){return this.values[Symbol.iterator]();}
};
const $=(selector,root=document)=>root.querySelector(selector);
const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
const host=$('#workspace'),modalRoot=$('#modal-root');
const clone=value=>structuredClone(value);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function settle(){for(let i=0;i<5;i++)await tick();}
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

const clients=[
  {id:92101,name:'合成甲公司 <A>',standard:'small2013',taxpayer_type:'general',start_period:'2026-01',enabled:1},
  {id:92102,name:'合成乙公司 B',standard:'small2013',taxpayer_type:'small',start_period:'2026-10',enabled:1},
  {id:92103,name:'已停用合成公司',start_period:'2026-01',enabled:0},
  {id:92104,name:'已删除合成公司',start_period:'2026-01',enabled:1,deleted:true},
];
const initialAccounts=[
  {id:1,code:'1002',name:'银行存款',category:'asset',direction:'debit',report_key:'cash',is_preset:true,version:1},
  {id:2,code:'100201',name:'基本账户',category:'asset',direction:'debit',report_key:'cash',is_preset:false,version:1},
  {id:3,code:'3001',name:'实收资本',category:'equity',direction:'credit',report_key:'capital',is_preset:true,version:1},
  {id:4,code:'5001',name:'主营业务收入',category:'income',direction:'credit',report_key:'revenue',is_preset:true,version:1},
  {id:5,code:'5602',name:'管理费用',category:'expense',direction:'debit',report_key:'administration',is_preset:true,version:1},
];
function voucher(id,date,summary,value){return {id,date,number:id,summary,status:'active',reviewed:false,source_type:'manual',created_by_name:'合成会计',attachment_count:2,version:1,lines:[{id:id*10,account_code:'100201',account_name:'基本账户',summary,debit_fen:value,credit_fen:0,cashflow_category:'operating'},{id:id*10+1,account_code:'5001',account_name:'主营业务收入',summary,debit_fen:0,credit_fen:value,cashflow_category:'unclassified'}]};}
const records=new Map([
  [92101,{accounts:clone(initialAccounts),opening:[{account_code:'100201',debit_fen:100000,credit_fen:0},{account_code:'3001',debit_fen:0,credit_fen:100000}],openingVersion:7,vouchers:[voucher(101,'2026-09-15','甲公司九月销售',12345),voucher(102,'2026-08-15','甲公司八月销售',1000)]}],
  [92102,{accounts:clone(initialAccounts),opening:[{account_code:'100201',debit_fen:900000,credit_fen:0},{account_code:'3001',debit_fen:0,credit_fen:900000}],openingVersion:3,vouchers:[voucher(201,'2026-10-15','乙公司十月销售',88888)]}],
]);
function balance(cid,start,end){
  const record=records.get(cid);
  assert.ok(record,`Unknown synthetic client ${cid}`);
  const hierarchy=companyBalanceTest.hierarchy(record.accounts);
  const valid=record.vouchers.filter(row=>row.status==='active');
  const raw=hierarchy.map(account=>{
    const opening=record.opening.find(row=>row.account_code===account.code)||{};
    let begin=Number(opening.debit_fen||0)-Number(opening.credit_fen||0),debit=0,credit=0,ytdDebit=0,ytdCredit=0;
    for(const row of valid)for(const line of row.lines.filter(line=>line.account_code===account.code)){
      const period=row.date.slice(0,7);
      if(period<start)begin+=line.debit_fen-line.credit_fen;
      if(period>=start&&period<=end){debit+=line.debit_fen;credit+=line.credit_fen;}
      if(period>=`${end.slice(0,4)}-01`&&period<=end){ytdDebit+=line.debit_fen;ytdCredit+=line.credit_fen;}
    }
    const closing=begin+debit-credit;
    return {...account,account_code:account.code,account_name:account.name,opening_debit_fen:Math.max(begin,0),opening_credit_fen:Math.max(-begin,0),debit_fen:debit,credit_fen:credit,closing_debit_fen:Math.max(closing,0),closing_credit_fen:Math.max(-closing,0),ytd_debit_fen:ytdDebit,ytd_credit_fen:ytdCredit};
  });
  return {start_period:start,end_period:end,trial_balance:raw,trial_balance_rollup:companyBalanceTest.rollupTrial(raw,record.accounts),ledger:valid.filter(row=>row.date.slice(0,7)>=start&&row.date.slice(0,7)<=end).flatMap(row=>row.lines.map(line=>({...line,date:row.date,number:row.number,summary:line.summary||row.summary})))};
}
function makeBook(cid,period){
  const record=records.get(cid),trial=balance(cid,period,period),vouchers=record.vouchers.filter(row=>row.date.slice(0,7)===period),bank=trial.trial_balance_rollup.find(row=>row.account_code==='1002').closing_debit_fen;
  return {client:clone(clients.find(row=>row.id===cid)),period,accounts:clone(record.accounts),opening_balances:clone(record.opening),opening_version:record.openingVersion,vouchers:clone(vouchers),...trial,periods:[],assets:[],inventory_items:[],inventory_movements:[],payroll:[],journals:[],checks:[],reports:{cash_flow:{net_fen:vouchers.reduce((total,row)=>total+row.lines[0].debit_fen,0)}},dashboard:{voucher_count:vouchers.length,attachment_count:vouchers.reduce((total,row)=>total+row.attachment_count,0),invoices:{input:{count:0,total_fen:0},output:{count:0,total_fen:0}},tax_payable_fen:0,funds:{bank_fen:bank,cash_fen:0,receivable_fen:0,payable_fen:0,receivable_account_count:0,payable_account_count:0}}};
}
let selected={cid:92101,period:'2026-09'};
const calls=[],toasts=[],modalHistory=[],pendingModals=[];
let nextId=1000,reloadCount=0,closedBooks=0;
const ctx={
  clients,user:{id:99,name:'合成会计'},escape,
  setBook(cid,period){selected={cid:Number(cid),period};},
  closeBook(){closedBooks++;},
  toast(message,type){toasts.push({message,type});},
  async api(path,options){
    calls.push({path,...clone(options||{})});
    const url=new URL(path,'http://synthetic.invalid'),match=url.pathname.match(/^\/api\/books\/(\d+)(.*)$/);
    assert.ok(match,`Unexpected synthetic API path: ${path}`);
    const cid=Number(match[1]),route=match[2],record=records.get(cid);
    assert.ok(record,`No synthetic fixture for ${cid}`);
    if(!options){
      if(!route)return makeBook(cid,url.searchParams.get('period'));
      if(route==='/balance')return balance(cid,url.searchParams.get('start'),url.searchParams.get('end'));
      throw new Error(`Unexpected GET ${path}`);
    }
    const body=options.body;
    if(route==='/vouchers'&&options.method==='POST'){
      const row={id:nextId++,number:nextId,date:body.date,summary:body.summary,status:'active',reviewed:false,source_type:'manual',created_by_name:'合成会计',attachment_count:body.attachment_count,version:1,lines:body.lines.map(line=>({...line,account_name:record.accounts.find(a=>a.code===line.account_code)?.name}))};
      record.vouchers.push(row);return clone(row);
    }
    if(route==='/accounts'&&options.method==='POST'){const row={...body,id:nextId++,is_preset:false,version:1};record.accounts.push(row);return clone(row);}
    if(route==='/opening'&&options.method==='POST'){assert.equal(body.version,record.openingVersion);record.opening=clone(body.balances);record.openingVersion++;return {version:record.openingVersion};}
    throw new Error(`Unexpected synthetic write ${options.method} ${path}`);
  },
  async reload(){reloadCount++;host.innerHTML=await renderBook(selected.cid,selected.period,ctx);bindBook(host,ctx);},
  modal(title,html,onSubmit){
    const item={title,onSubmit,closed:false};modalHistory.push(item);
    modalRoot.innerHTML=`<h2>${escape(title)}</h2><form id="app-modal-form">${html}<button type="submit">保存</button></form>`;
    item.form=$('#app-modal-form');
    return new Promise(resolve=>{item.resolve=resolve;pendingModals.push(item);});
  },
};
function closeModals(){modalRoot.innerHTML='';for(const item of pendingModals)if(!item.closed){item.closed=true;item.resolve();}}
async function submitModal(){const item=modalHistory.at(-1);assert.ok(item?.form,'Expected a modal form');await item.onSubmit?.(item.form);closeModals();await settle();}
async function click(selector,root=host){const el=typeof selector==='string'?$(selector,root):selector;assert.ok(el,`Missing control ${selector}`);assert.ok(!el.disabled,`Disabled control ${selector}`);el.dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));await settle();}
async function input(selector,value,type='input',root=host){const el=$(selector,root);assert.ok(el,`Missing field ${selector}`);el.value=value;el.dispatchEvent(new window.Event(type,{bubbles:true,cancelable:true}));await settle();}
async function view(name){setBookView(name);await ctx.reload();await settle();}
async function restore(cid=92101,period='2026-09',name='home'){closeModals();selected={cid,period};await view(name);}
async function submitBalance(){const form=$('[data-cob-form]',host);assert.ok(form);form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();}
const results=[];
async function check(name,run){const startCalls=calls.length;try{await run();results.push({name,ok:true,calls:calls.length-startCalls});console.log(`PASS ${name}`);}catch(error){results.push({name,ok:false,error:error.stack||String(error)});console.error(`FAIL ${name}: ${error.message}`);}finally{closeModals();}}

await check('company home uses synthetic persisted book data and escapes company text',async()=>{
  await restore();assert.ok($('.cw-home-page',host));assert.equal($('.cw-company-button span',host).textContent,clients[0].name);assert.equal($$('.cw-stat-value',host)[0].textContent,'1张');assert.equal($$('.cw-stat-value',host)[1].textContent,'2张');assert.equal($('A',host),null);
  await click('[data-cw-action="companies"]');assert.equal($$('[data-cw-company]',host).length,2);assert.equal($('[data-cw-company="92103"]',host),null);assert.equal($('[data-cw-company="92104"]',host),null);
  await input('.cw-company-popover input','乙');assert.equal($$('[data-cw-company]',host).length,1);assert.equal($('[data-cw-company]',host).dataset.cwCompany,'92102');
});

await check('home add voucher opens once, saves integer fen and reloads the voucher page',async()=>{
  await restore();const before=modalHistory.length;await click('[data-cw-new-voucher]');assert.ok($('.cv-root',host));assert.equal(modalHistory.length-before,1);assert.equal(modalHistory.at(-1).title,'新增凭证');
  const form=modalHistory.at(-1).form;form.elements.date.value='2026-09-20';form.elements.summary.value='集成新增凭证';form.elements.attachment_count.value='3';
  const lines=$$('.voucher-line',form);assert.equal(lines.length,2);
  $('.voucher-summary',lines[0]).value='手工分录一';$('.voucher-account',lines[0]).value='100201';$('.voucher-debit',lines[0]).value='45.67';$('.voucher-cf',lines[0]).value='operating';
  $('.voucher-summary',lines[1]).value='手工分录二';$('.voucher-account',lines[1]).value='5001';$('.voucher-credit',lines[1]).value='45.67';
  await submitModal();const saved=calls.findLast(call=>call.method==='POST'&&call.path==='/api/books/92101/vouchers');assert.ok(saved);assert.equal(saved.body.lines[0].debit_fen,4567);assert.equal(saved.body.lines[1].credit_fen,4567);assert.equal(saved.body.attachment_count,3);assert.equal(saved.body.lines[0].summary,'手工分录一');assert.ok($('.cv-root',host));assert.match(host.textContent,/集成新增凭证|手工分录一/);
});

await check('voucher page navigates to queried balance; filters and ledger details stay bound after repaint',async()=>{
  await restore(92101,'2026-09','vouchers');await click('[data-cv-do="ledger"]');assert.ok($('.company-balance',host));assert.equal($('.company-balance',host).getAttribute('aria-busy'),'false');assert.ok(calls.some(call=>call.path==='/api/books/92101/balance?start=2026-09&end=2026-09'));
  await input('[name="codeFrom"]','1002');await input('[name="codeTo"]','1002');await submitBalance();assert.deepEqual($$('tr[data-cob-account]',host).map(row=>row.dataset.cobAccount),['1002','100201']);
  const before=modalHistory.length;await click('[data-cob-ledger="100201"]');assert.equal(modalHistory.length-before,1);assert.match(modalHistory.at(-1).title,/100201/);assert.ok($('.cob-ledger',modalRoot));
});

await check('balance add-account form works after asynchronous section replacement and inherits parent properties',async()=>{
  await restore(92101,'2026-09','ledger');const before=modalHistory.length;await click('.cob-subject-menu [data-book-action="new-account"]');assert.equal(modalHistory.length-before,1);assert.equal(modalHistory.at(-1).title,'新增会计科目');
  const form=modalHistory.at(-1).form;form.elements.code.value='100202';form.elements.code.dispatchEvent(new window.Event('change',{bubbles:true}));await settle();assert.equal(form.elements.category.value,'asset');assert.equal(form.elements.direction.value,'debit');assert.equal(form.elements.report_key.value,'cash');form.elements.name.value='集成新增银行';await submitModal();
  const saved=calls.findLast(call=>call.path==='/api/books/92101/accounts');assert.equal(saved.body.code,'100202');assert.equal(saved.body.name,'集成新增银行');assert.ok($('.company-balance',host));
  const checkbox=$('[data-cob-check="showZero"]',host);checkbox.checked=true;checkbox.dispatchEvent(new window.Event('change',{bubbles:true}));await settle();assert.ok($('[data-cob-account="100202"]',host));
});

await check('balance opening form contains leaf accounts and saves one versioned balanced payload',async()=>{
  await restore(92101,'2026-09','ledger');const before=modalHistory.length,writeBefore=calls.filter(call=>call.method).length;await click('.cob-subject-menu [data-book-action="opening"]');assert.equal(modalHistory.length-before,1);assert.equal(modalHistory.at(-1).title,'设置期初余额');const form=modalHistory.at(-1).form;assert.equal($('[data-opening-code="1002"]',form),null);assert.ok($('[data-opening-code="100201"]',form));
  for(const row of $$('[data-opening-code]',form)){$('.opening-debit',row).value='0';$('.opening-credit',row).value='0';}
  $('.opening-debit',$('[data-opening-code="100201"]',form)).value='500.00';$('.opening-credit',$('[data-opening-code="3001"]',form)).value='500.00';await submitModal();
  assert.equal(calls.filter(call=>call.method).length-writeBefore,1);const saved=calls.findLast(call=>call.path==='/api/books/92101/opening');assert.equal(saved.body.version,7);assert.equal(saved.body.balances.find(row=>row.account_code==='100201').debit_fen,50000);assert.equal(saved.body.balances.reduce((total,row)=>total+row.debit_fen-row.credit_fen,0),0);
});

await check('balance navigates to legacy account management and legacy add form opens once',async()=>{
  await restore(92101,'2026-09','ledger');await click('[data-cob-action="accounts"]');assert.ok($('.cw-content.cw-legacy',host));assert.match(host.textContent,/会计科目与期初余额/);assert.match(host.textContent,/集成新增银行/);const before=modalHistory.length;await click('.book-content [data-book-action="new-account"]');assert.equal(modalHistory.length-before,1);assert.equal(modalHistory.at(-1).title,'新增会计科目');
});

await check('month rail and header update the same company and reset balance periods',async()=>{
  await restore(92101,'2026-09','ledger');await click('[data-cw-month="2026-08"]');assert.deepEqual(selected,{cid:92101,period:'2026-08'});assert.equal($('[data-cw-period]',host).value,'2026-08');assert.equal($('[name="start"]',host).value,'2026-08');assert.equal($('[name="end"]',host).value,'2026-08');assert.ok(calls.some(call=>call.path==='/api/books/92101/balance?start=2026-08&end=2026-08'));
  await input('[data-cw-period]','2026-07','change');assert.equal(selected.period,'2026-07');assert.equal($('[data-cw-month="2026-07"]',host).getAttribute('aria-current'),'date');
});

await check('voucher search and selection do not leak across months',async()=>{
  await restore(92101,'2026-09','vouchers');await input('[data-cv-query]','九月');const selectedRow=$('[data-cv-row]',host);assert.ok(selectedRow);selectedRow.checked=true;selectedRow.dispatchEvent(new window.Event('change',{bubbles:true}));await settle();assert.ok($('.cv-selection-bar',host));await click('[data-cw-month="2026-08"]');assert.equal($('[data-cv-query]',host).value,'');assert.equal($('.cv-selection-bar',host),null);assert.match(host.textContent,/甲公司八月销售/);assert.doesNotMatch(host.textContent,/手工分录一/);
});

await check('company switch clamps to establishment month, returns home and isolates books',async()=>{
  await restore(92101,'2026-08','vouchers');await click('[data-cw-action="companies"]');await click('[data-cw-company="92102"]');assert.deepEqual(selected,{cid:92102,period:'2026-10'});assert.ok($('.cw-home-page',host));assert.equal($('.cw-company-button span',host).textContent,clients[1].name);assert.equal($$('.cw-stat-value',host)[0].textContent,'1张');
  await click('[data-cw-nav="general"]');await click('.cw-nav-popover [data-cw-view="vouchers"]');assert.equal($('[data-cv-query]',host).value,'');assert.equal($('.cv-selection-bar',host),null);assert.match(host.textContent,/乙公司十月销售/);assert.doesNotMatch(host.textContent,/甲公司|手工分录一/);assert.ok($('[data-cw-month="2026-09"]',host).disabled);
  await click('[data-cv-do="ledger"]');assert.equal($('[data-cob-account="100202"]',host),null);assert.match($('[data-cob-account="1002"]',host).textContent,/9,888\.88/);
});

await check('repeat bindBook on the same home shell does not duplicate voucher form actions',async()=>{
  await restore();bindBook(host,ctx);const before=modalHistory.length;await click('[data-cw-new-voucher]');assert.equal(modalHistory.length-before,1,'Rebinding the same shell must open exactly one voucher form');
});

await check('repeat bindBook on the same legacy account view does not duplicate form actions',async()=>{
  await restore(92101,'2026-09','accounts');bindBook(host,ctx);const before=modalHistory.length;await click('.book-content [data-book-action="new-account"]');assert.equal(modalHistory.length-before,1,'Rebinding legacy controls must not attach duplicate direct listeners');
});

await check('repeat bindBook on the same shell dispatches one month reload',async()=>{
  await restore(92101,'2026-09','vouchers');bindBook(host,ctx);const before=reloadCount;await click('[data-cw-month="2026-08"]');assert.equal(reloadCount-before,1,'A month click must request one reload after repeated binding');
});

assert.equal(closedBooks,0);
const failed=results.filter(result=>!result.ok);
console.log(JSON.stringify({ok:failed.length===0,scenarios:results,requests:calls.length,syntheticWrites:calls.filter(call=>call.method).length,reloads:reloadCount,unexpectedToasts:toasts.filter(toast=>toast.type==='error'),transport:'in-memory synthetic fixture only'},null,2));
if(failed.length)process.exitCode=1;
