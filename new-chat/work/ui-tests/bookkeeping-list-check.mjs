import {parseHTML} from 'linkedom';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const base=process.argv[2];
assert(base,'Run with python run-checks.py bookkeeping-list-check.mjs');
const address=new URL(base);
assert.equal(address.hostname,'127.0.0.1','Only the disposable loopback QA server is allowed');
assert(!['8765','8766'].includes(address.port),'Refusing production/demo service ports');
const root='C:/Users/Admin/Documents/Codex/2026-10-26/new-chat/outputs/yidaizhang-local';
const nativeFetch=globalThis.fetch;
let cookie='',requests=0;
const traffic=[],errors=[],scenarios=[],blobs=[];
process.on('unhandledRejection',error=>errors.push(error));
globalThis.fetch=async(path,options={})=>{
  const url=new URL(path,base);
  assert.equal(url.origin,address.origin,'Unexpected external request');
  const headers={Origin:base,Connection:'close',...options.headers};
  if(cookie)headers.Cookie=cookie;
  const entry={path:url.pathname,query:Object.fromEntries(url.searchParams),method:options.method||'GET',body:typeof options.body==='string'?JSON.parse(options.body):options.body};
  const response=await nativeFetch(url,{...options,headers});
  entry.status=response.status;traffic.push(entry);requests++;
  const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];
  return response;
};
const health=await (await fetch('/api/health')).json();assert(health.demo,'Only a synthetic demo fixture is allowed');
const login=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'demo1',password:'DemoOnly123!'})});
assert.equal(login.status,200,'Synthetic demo login failed');
const {window}=parseHTML(await readFile(root+'/public/index.html','utf8'));
globalThis.window=window;globalThis.document=window.document;globalThis.CustomEvent=window.CustomEvent;
window.location={href:base+'/',assign:path=>{window.lastDownload=String(path);}};
window.history={replaceState(){}};window.print=()=>{};window.HTMLElement.prototype.reportValidity=()=>true;
Object.defineProperty(window.HTMLElement.prototype,'checked',{configurable:true,get(){return this.hasAttribute('checked');},set(value){this.toggleAttribute('checked',Boolean(value));}});
Object.defineProperty(window.HTMLElement.prototype,'elements',{configurable:true,get(){const nodes=[...this.querySelectorAll('input,select,textarea,button')];return new Proxy(nodes,{get(target,key){if(key in target)return target[key];return nodes.find(el=>el.getAttribute('name')===key);}});}});
class DOMFormData{
  constructor(form){this.list=[];for(const el of form?.querySelectorAll('input,select,textarea')||[]){const name=el.getAttribute('name');if(!name||el.disabled)continue;const type=el.getAttribute('type');if((type==='checkbox'||type==='radio')&&!el.checked)continue;if(type==='file')continue;const value=el.tagName==='SELECT'?(el.querySelector('option[selected]')||el.querySelector('option'))?.getAttribute('value')??el.textContent:el.value;this.list.push([name,String(value??'')]);}}
  entries(){return this.list[Symbol.iterator]();}
}
globalThis.FormData=DOMFormData;
URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:synthetic-bookkeeping-'+blobs.length;};
URL.revokeObjectURL=()=>{};
const $=(selector,inside=document)=>inside.querySelector(selector);
const $$=(selector,inside=document)=>[...inside.querySelectorAll(selector)];
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
async function waitFor(predicate,label){for(let i=0;i<200;i++){if(errors.length)throw errors.shift();if(await predicate())return;await delay(20);}throw new Error('Timed out: '+label+'; '+($('#main-content')?.textContent||'').slice(0,250));}
function click(el,label='button'){assert(el,'Missing '+label);assert(!el.disabled&&!el.hasAttribute('disabled'),label+' is disabled');el.dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));}
function change(el){el.dispatchEvent(new window.Event('change',{bubbles:true,cancelable:true}));}
function check(el,value=true){assert(el,'Missing checkbox');assert(!el.disabled&&!el.hasAttribute('disabled'),'Checkbox is disabled');el.checked=value;change(el);}
function setSelect(el,value,dispatch=true){assert(el,'Missing select');let found=false;for(const option of $$('option',el)){
  // Native HTMLOptionElement.value falls back to its text; linkedom returns an
  // empty string for options without value attributes. Materialize that native
  // fallback in this DOM fixture before application code reads select.value.
  if(!option.hasAttribute('value'))option.setAttribute('value',option.textContent);
  const chosen=option.getAttribute('value')===String(value);option.toggleAttribute('selected',chosen);if(chosen)found=true;
}assert(found,'Missing option '+value);if(dispatch)change(el);}
function count(scope){const el=$(`[data-selection-count="${scope}"]`);assert(el,'Missing selection count '+scope);return Number(el.textContent.trim());}
function rows(scope){return $$(`input[data-company-select="${scope}"]`);}
function header(scope){return $(`input[data-company-select-page="${scope}"]`);}
function clear(scope){click($(`[data-action="selection-clear"][data-scope="${scope}"]`),'clear '+scope);}
function chooseAll(scope){if(scope==='clients'&&$('[data-customer-selection-tools]')?.hidden&&rows(scope).length)check(rows(scope)[0]);click($(`[data-action="selection-all"][data-scope="${scope}"]`),'select all '+scope);}
async function nav(name,sub){click($(`[data-nav="${name}"]`),'nav '+name);await waitFor(()=>$(`[data-nav="${name}"].active`),'nav '+name);await delay(35);if(sub){click($(`[data-sub="${sub}"]`),'sub '+sub);await waitFor(()=>$(`[data-sub="${sub}"].active`),'sub '+sub);await delay(40);}assert(!$('.page-error'),name+'/'+sub+' failed');}
async function search(value){const form=$('[data-search-form]');assert(form,'Search form');form.elements.q.value=value;form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await delay(45);}
async function reset(){if($('[data-customer-list]')){await search('');click($('.cl-tools-left [data-action="customer-filter"]'),'customer filters');await waitFor(()=>$('[data-action="customer-reset-filters"]'),'filter reset button');click($('[data-action="customer-reset-filters"]'),'reset customer filters');await waitFor(()=>!$('#app-modal-form'),'filters reset');}else click($('[data-action="reset-filters"]'),'reset filters');await delay(45);}
async function filterTaxpayer(value){if($('[data-customer-list]')){click($('.cl-tools-left [data-action="customer-filter"]'),'customer filters');await waitFor(()=>$('#app-modal-form [name="taxpayer_type"]'),'taxpayer filter');setSelect($('#app-modal-form [name="taxpayer_type"]'),value,false);submitModal();await waitFor(()=>!$('#app-modal-form'),'taxpayer filter applied');}else setSelect($('[data-filter="taxpayer"]'),value);await delay(45);}
async function page(scope,direction){const shell=$(`[data-selection-scope="${scope}"]`);assert(shell,'Table selection shell '+scope);const buttons=$$('[data-action="table-page"]',shell.closest('[data-customer-list],[data-bookkeeping-list]')||shell);const button=direction==='next'?buttons.at(-1):buttons[0];click(button,'page '+direction);await delay(30);}
async function dismiss(){const close=$('#modal-root [data-close]');assert(close,'Modal close');click(close,'modal cancel');await waitFor(()=>!$('#app-modal-form'),'modal closed');}
function submitModal(){const form=$('#app-modal-form');assert(form,'Expected confirmation modal');form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));}
function assertSelectionEmpty(scope){assert.equal(count(scope),0);assert(rows(scope).every(row=>!row.checked));const h=header(scope);if(h){assert(!h.checked);assert(!h.indeterminate);}}

const frontend=await import(pathToFileURL(root+'/public/app.js').href+'?bookkeeping-list-test='+Date.now());
await waitFor(()=>$('.progress-card'),'app startup');
let boot=await frontend.api('/api/bootstrap');assert.equal(boot.clients.length,200,'Exactly 200 explicitly seeded disposable clients are required');
const period=$('[data-filter="period"]').value,year=Number(period.slice(0,4));
const sorted=values=>[...values].map(Number).sort((a,b)=>a-b);
const byId=(data,id)=>data.clients.find(client=>Number(client.id)===Number(id));
const monthState=(id,pd)=>$(`[data-bookkeeping-client="${id}"] [data-bookkeeping-period="${pd}"]`);
async function refresh(){const start=traffic.length;click($('[data-action="refresh"]'),'refresh');await waitFor(()=>traffic.slice(start).some(request=>request.method==='GET'&&request.path==='/api/bootstrap'),'bootstrap refreshed');await delay(60);}
async function selectedAll(scope){if(!count(scope))check(rows(scope)[0]);chooseAll(scope);await delay(25);}
async function setSize(size){setSelect($('[data-bookkeeping-list] [data-page-size]'),String(size));await delay(45);}
async function resetSearch(){await search('');const accountant=$('[data-filter="accountant"]');if(accountant?.value)setSelect(accountant,'');await delay(40);if($('[data-bookkeeping-mine]')?.checked){check($('[data-bookkeeping-mine]'),false);await delay(40);}}
await nav('记账','年度记账');
await waitFor(()=>$('[data-bookkeeping-list]'),'annual bookkeeping module');

const expectedColumns=['select','index','name',...Array.from({length:12},(_,i)=>'month'+String(i+1).padStart(2,'0'))];
assert.deepEqual($$('th[data-bookkeeping-column]').map(node=>node.dataset.bookkeepingColumn),expectedColumns,'Only checkbox, sequence, customer name and twelve months are allowed');
assert.equal($$('[data-bookkeeping-list] thead th').length,15);
assert.equal($('[data-page-size]').value,'30');assert.equal(rows('matrix').length,30);
assert(!$('.stat-grid')&&!$('.panel-title')&&!$('.notice'),'Annual page must not include added headings, statistics or notices');
assert($('[data-filter="accountant"]')&&$('[data-search-form]')&&$('[data-bookkeeping-mine]')&&$('[data-bookkeeping-year-step="-1"]')&&$('[data-bookkeeping-year-step="1"]')&&$('[data-action="refresh"]'));
assert(!$('.bk-operation-period'),'Annual page keeps only the original toolbar controls');
assert.equal($('.bk-current-month')?.textContent,Number(period.slice(5,7))+'月');
assert.equal($$('.bk-legend>span').map(node=>node.textContent).join('|'),'未建账|已完成|审核不通过');
assert($('[data-bookkeeping-selection-tools="matrix"]').hidden);
for(const row of $$('[data-bookkeeping-client]')){
  assert.equal(row.children.length,15);assert($('[data-action="open-book"]',row.children[2]),'Book entry belongs in the customer-name cell');
  assert(!row.querySelector('.row-actions'),'No separate operation column');
}
scenarios.push('annual screenshot structure: exact fifteen columns, original toolbar, current-month circle, legend, 30-row pagination and no extra title/statistics');

// Compare every visible month with persisted summaries, not the screenshot's
// fabricated examples. Unreviewed activity remains progress, never rejection.
for(const client of boot.clients.slice(0,30))for(let month=1;month<=12;month++){
  const pd=`${year}-${String(month).padStart(2,'0')}`,record=boot.book_periods.find(row=>Number(row.client_id)===Number(client.id)&&row.period===pd);
  const expected=pd<client.start_period?'unbuilt':record?.closed||record?.status==='closed'?'closed':Number(record?.voucher_count)>0?'working':'empty';
  const cell=monthState(client.id,pd);assert(cell,'Month cell present');assert.equal(cell.dataset.bookkeepingState,expected);
  if(record?.unreviewed_count&&!record.closed)assert.notEqual(cell.dataset.bookkeepingState,'rejected');
}
assert($$('.bk-month-closed').length>0,'Seeded real sequential closes must be visible');assert($$('.bk-month-working').length>0,'Seeded real current vouchers must be visible');
scenarios.push('all visible month cells derive closed/progress/empty states from real ledger summaries and do not equate pending review with failure');

check(header('matrix'));assert.equal(count('matrix'),30);assert(!$('[data-bookkeeping-selection-tools="matrix"]').hidden);
const omitted=Number(rows('matrix')[0].value);check(rows('matrix')[0],false);assert.equal(count('matrix'),29);assert(header('matrix').indeterminate);
await page('matrix','next');assert(rows('matrix').every(input=>!input.checked));check(rows('matrix')[0]);assert.equal(count('matrix'),30);
await page('matrix','previous');assert(!rows('matrix').find(input=>Number(input.value)===omitted).checked);assert(header('matrix').indeterminate);
await selectedAll('matrix');assert.deepEqual(sorted(frontend.selectedCompanyIds('matrix')),sorted(boot.clients.map(client=>client.id)));clear('matrix');assertSelectionEmpty('matrix');assert($('[data-bookkeeping-selection-tools="matrix"]').hidden);
const jump=$('[data-bookkeeping-jump]');jump.querySelector('[name="page"]').value='3';jump.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>$('[aria-current="page"]')?.textContent==='3','jump to third page');assert.equal(rows('matrix')[0].closest('tr').querySelector('.bk-index-cell').textContent,'61');
const badJump=$('[data-bookkeeping-jump]');badJump.querySelector('[name="page"]').value='999';badJump.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await delay(30);assert.equal($('[aria-current="page"]').textContent,'3','Out-of-range jump cannot change page');
const firstJump=$('[data-bookkeeping-jump]');firstJump.querySelector('[name="page"]').value='1';firstJump.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>$('[aria-current="page"]')?.textContent==='1','jump back to first page');
scenarios.push('page select, partial header, cross-page selection and all-filter selection preserve real company ids and hide the compact bar after clearing');

check(rows('matrix')[0]);setSelect($('[data-filter="accountant"]'),String(boot.users[1].id));await delay(45);assertSelectionEmpty('matrix');await selectedAll('matrix');
assert.deepEqual(sorted(frontend.selectedCompanyIds('matrix')),sorted(boot.clients.filter(client=>Number(client.accountant_id)===Number(boot.users[1].id)).map(client=>client.id)));clear('matrix');
setSelect($('[data-filter="accountant"]'),'');await delay(40);check($('[data-bookkeeping-mine]'));await delay(40);await selectedAll('matrix');
assert.deepEqual(sorted(frontend.selectedCompanyIds('matrix')),sorted(boot.clients.filter(client=>Number(client.accountant_id)===Number(boot.users[0].id)||(client.authorized_user_ids||[]).includes(boot.users[0].id)).map(client=>client.id)));clear('matrix');check($('[data-bookkeeping-mine]'),false);await delay(40);
await search('DEMO0004');assert.equal(rows('matrix').length,1);assertSelectionEmpty('matrix');await search('NO-SYNTHETIC-BOOK-MATCH');assert.equal(rows('matrix').length,0);assert(header('matrix').disabled||header('matrix').hasAttribute('disabled'));
await resetSearch();scenarios.push('employee, assigned-book and search filters clear selection and operate on actual company assignments; empty result cannot select');

// Year arrows and refresh are read-only view operations.
check(rows('matrix')[0]);const yearTraffic=traffic.length,versions=boot.clients.map(client=>[client.id,client.version,client.enabled]);
click($('[data-bookkeeping-year-step="-1"]'),'previous bookkeeping year');await waitFor(()=>$('[data-bookkeeping-year]')?.dataset.bookkeepingYear===String(year-1),'previous year');assertSelectionEmpty('matrix');assert.equal($$('.bk-current-month').length,0);
click($('[data-bookkeeping-year-step="1"]'),'next bookkeeping year');await waitFor(()=>$('[data-bookkeeping-year]')?.dataset.bookkeepingYear===String(year),'year restored');await refresh();
assert(traffic.slice(yearTraffic).every(request=>request.method==='GET'),'Year and refresh controls cannot issue mutations');
assert.deepEqual((await frontend.api('/api/bootstrap')).clients.map(client=>[client.id,client.version,client.enabled]),versions);
scenarios.push('year navigation and refresh update the view through reads without changing client versions, enabled states or bookkeeping');

// Fresh independent synthetic books exercise pre-start grey marks, a real
// unreviewed voucher and a real empty-period close after an API reload.
const stamp=Date.now(),newClients=[];
for(const letter of ['A','B','C'])newClients.push(await frontend.api('/api/clients',{method:'POST',body:{name:'合成年记账专项'+letter,code:'BOOK-LIST-'+stamp+'-'+letter,start_period:period,standard:'small2013',taxpayer_type:'small',accountant_id:boot.users[0].id}}));
const [working,closable,untouched]=newClients;
const voucher=await frontend.api(`/api/books/${working.id}/vouchers`,{method:'POST',body:{date:period+'-01',summary:'合成年记账专项真实凭证',lines:[{account_code:'1002',debit_fen:10000,credit_fen:0},{account_code:'3001',debit_fen:0,credit_fen:10000}]}});
await refresh();await search(working.code);
for(let month=1;month<Number(period.slice(5,7));month++){const pd=`${year}-${String(month).padStart(2,'0')}`;const cell=monthState(working.id,pd);assert.equal(cell.dataset.bookkeepingState,'unbuilt');assert.equal(cell.tagName,'SPAN','Pre-start months cannot open an invalid book');}
assert.equal(monthState(working.id,period).dataset.bookkeepingState,'working');assert(!monthState(working.id,period).querySelector('.bk-status-rejected'));
const openTraffic=traffic.length;click(monthState(working.id,period),'open real month book');await waitFor(()=>$('[data-book-view="vouchers"]'),'independent book opened');
assert(traffic.slice(openTraffic).some(request=>request.path===`/api/books/${working.id}`&&request.query.period===period),'Month click requests the exact independent ledger and period');
click($('[data-action="close-book"]'),'return to annual matrix');await waitFor(()=>$('[data-bookkeeping-list]'),'matrix returned');
scenarios.push('new account shows grey unbuilt months before its start, actual unreviewed voucher shows cyan progress and month entry opens the exact real book');

// Leave a global customer tax filter behind deliberately. The new bookkeeping
// matrix has its own visible scope, so an old hidden filter cannot remove a
// selected small taxpayer from the close confirmation or execution.
await nav('客户','全部客户');click($('.cl-tools-left [data-action="customer-filter"]'),'leave an independent customer tax filter');await waitFor(()=>$('#app-modal-form [name="taxpayer_type"]'),'customer tax filter');setSelect($('#app-modal-form [name="taxpayer_type"]'),'general',false);submitModal();await waitFor(()=>!$('#app-modal-form'),'customer tax filter saved');
// Close only one explicitly selected empty current book; the other empty book
// stays open. Confirmation is a real decision point and preserves its period.
await nav('记账','批量结账');await resetSearch();await search(closable.code);check(rows('close')[0]);
assert.equal($('.bk-operation-period input').value,period);const closeTraffic=traffic.length;
click($('[data-action="batch-close"]'),'close selected empty book');await waitFor(()=>$('[data-batch-close-list]'),'close confirmation');
assert.deepEqual($$('[data-confirm-client-id]').map(node=>Number(node.dataset.confirmClientId)),[Number(closable.id)]);assert($('[data-batch-close-period]').textContent.includes(period));
await dismiss();assert.equal(traffic.slice(closeTraffic).filter(request=>request.method==='POST'&&request.path.endsWith('/close')).length,0);
click($('[data-action="batch-close"]'),'close selected book after review');await waitFor(()=>$('[data-batch-close-list]'),'second close confirmation');submitModal();await waitFor(()=>$('#modal-title')?.textContent==='批量结账结果','real close result');
boot=await frontend.api('/api/bootstrap');assert(boot.book_periods.some(row=>Number(row.client_id)===Number(closable.id)&&row.period===period&&row.closed));assert(!boot.book_periods.some(row=>Number(row.client_id)===Number(untouched.id)&&row.period===period&&row.closed));
await dismiss();await nav('记账','年度记账');await resetSearch();await search(closable.code);assert.equal(monthState(closable.id,period).dataset.bookkeepingState,'closed');assert(monthState(closable.id,period).querySelector('.bk-status-closed'));
scenarios.push('close mode confirms one selected company and period, cancel has no write, actual close turns that month green while the unselected book stays open');
scenarios.push('an old customer general-taxpayer filter cannot hide or exclude a visibly selected small-taxpayer book from the new close operation');

// The review entry is a navigator for the chosen real pending vouchers, not a
// bulk approval operation. Opening it and entering the book cannot auto-review.
await nav('记账','凭证审核');await resetSearch();await search(working.code);check(rows('matrix')[0]);const reviewTraffic=traffic.length;
click($('[data-action="bookkeeping-review-selected"]'),'selected review navigator');await waitFor(()=>$('[data-bookkeeping-review-summary]'),'review selected summary');
assert.equal($('[data-bookkeeping-review-summary]').dataset.selectedIds,String(working.id));
const reviewLinks=$$('[data-action="bookkeeping-open-review"]');assert.equal(reviewLinks.length,1);assert.equal(Number(reviewLinks[0].dataset.id),Number(working.id));assert.equal(reviewLinks[0].dataset.period,period);
assert(traffic.slice(reviewTraffic).every(request=>request.method==='GET'),'Review navigator cannot approve any voucher');
click(reviewLinks[0],'enter actual pending vouchers');await waitFor(()=>$('[data-book-view="vouchers"]'),'voucher review book');
assert.equal((await frontend.api(`/api/books/${working.id}?period=${period}`)).vouchers.find(row=>Number(row.id)===Number(voucher.id)).reviewed,0);
click($('[data-action="close-book"]'),'return from voucher review');await waitFor(()=>$('[data-bookkeeping-list]'),'review matrix returned');
scenarios.push('review selection lists only the selected real pending month and opens its voucher page without any automatic approval');

// Multi-company print previews must retain each company's own numbers both in
// the visible preview and at the print callback. The callback is a DOM capture;
// it never opens a system print dialog in this test runtime.
await nav('记账','账簿打印');await resetSearch();await search('BOOK-LIST-'+stamp);
for(const id of [working.id,closable.id])check($(`input[data-company-select="matrix"][value="${id}"]`));
const expectedPrintIds=sorted([working.id,closable.id]),printTraffic=traffic.length;
click($('[data-action="bookkeeping-print-selected"]'),'selected company print');await waitFor(()=>$('#app-modal-form [name="print_kind"]'),'print options');
assert.deepEqual(sorted($$('[data-print-client-id]').map(node=>node.dataset.printClientId)),expectedPrintIds);
$('#app-modal-form [name="period"]').value=period;setSelect($('#app-modal-form [name="print_kind"]'),'trial',false);submitModal();
await waitFor(()=>$$('[data-print-pack-client]').length===2,'real trial-balance print preview');
assert.deepEqual(sorted($$('[data-print-pack-client]').map(node=>node.dataset.printPackClient)),expectedPrintIds);assert(!$(`[data-print-pack-client="${untouched.id}"]`));
const expectedTrial=(await frontend.api(`/api/books/${working.id}?period=${period}`)).trial_balance.find(row=>row.account_code==='1002'||row.code==='1002');assert(expectedTrial&&expectedTrial.closing_debit_fen>0,'Working book must contain a nonzero real closing bank balance');
function trialCash(section){const row=$$('tbody tr',section).find(row=>row.children[0]?.textContent==='1002');assert(row,'1002 cash row in trial preview');return [...row.children].map(cell=>cell.textContent);}
const visibleTrial=trialCash($(`[data-print-pack-client="${working.id}"]`));assert.equal(visibleTrial[6],frontend.money(expectedTrial.closing_debit_fen));assert.equal(visibleTrial[7],frontend.money(expectedTrial.closing_credit_fen));
let printedSnapshot=null;window.print=()=>{printedSnapshot=$$('[data-print-pack-client]').map(section=>({id:Number(section.dataset.printPackClient),cash:trialCash(section)}));};
click($('[data-action="modal-print"]'),'capture selected print output');await waitFor(()=>printedSnapshot!==null,'print DOM callback');
assert.deepEqual(sorted(printedSnapshot.map(section=>section.id)),expectedPrintIds);
const printedWorking=printedSnapshot.find(section=>section.id===Number(working.id));assert.equal(printedWorking.cash[6],frontend.money(expectedTrial.closing_debit_fen),'Printing cannot substitute another company\'s closing balance');assert.equal(printedWorking.cash[7],frontend.money(expectedTrial.closing_credit_fen));
assert(traffic.slice(printTraffic).every(request=>request.method==='GET'),'Print preview and print capture cannot change books');
await delay(40);await dismiss();scenarios.push('selected two-company trial print preview and captured print output preserve each company own real closing balances and exclude the unselected company');
const beforeDisable=await frontend.api('/api/bootstrap');await frontend.api(`/api/clients/${untouched.id}`,{method:'PATCH',body:{version:byId(beforeDisable,untouched.id).version,enabled:false}});await refresh();
check($(`input[data-company-select="matrix"][value="${untouched.id}"]`));
click($('[data-action="bookkeeping-print-selected"]'),'mixed enabled and disabled company print');await waitFor(()=>$('#app-modal-form [name="print_kind"]'),'mixed print options');setSelect($('#app-modal-form [name="print_kind"]'),'trial',false);submitModal();
await waitFor(()=>$$('[data-print-pack-client]').length===2&&$(`[data-print-pack-error="${untouched.id}"]`),'mixed preview with per-company error');
assert.deepEqual(sorted($$('[data-print-pack-client]').map(node=>node.dataset.printPackClient)),expectedPrintIds);assert($(`[data-print-pack-error="${untouched.id}"]`).textContent.includes(untouched.name));
assert.equal(trialCash($(`[data-print-pack-client="${working.id}"]`))[6],frontend.money(expectedTrial.closing_debit_fen),'A blocked company must not change a valid company preview');
await dismiss();const disabledBoot=await frontend.api('/api/bootstrap');await frontend.api(`/api/clients/${untouched.id}`,{method:'PATCH',body:{version:byId(disabledBoot,untouched.id).version,enabled:true}});
scenarios.push('mixed print selection reports a disabled company separately while preserving both valid companies and their real balances');

// Deleting a selected matrix company is recycle, never a ledger cascade.
await nav('记账','年度记账');await search(working.code);check(rows('matrix')[0]);const removeTraffic=traffic.length;
click($('[data-action="selection-remove"][data-scope="matrix"]'),'recycle selected ledger company');await waitFor(()=>$('[data-batch-remove-list]'),'recycle confirmation');
assert.deepEqual($$('[data-remove-id]').map(node=>Number(node.dataset.removeId)),[Number(working.id)]);submitModal();await waitFor(()=>$('[data-batch-remove-results]'),'recycle result');
boot=await frontend.api('/api/bootstrap');assert.equal(byId(boot,working.id).deleted,1);assert.equal(byId(boot,untouched.id).deleted,0);
await dismiss();await frontend.api(`/api/clients/${working.id}/restore`,{method:'POST',body:{version:byId(boot,working.id).version}});
const restoredBook=await frontend.api(`/api/books/${working.id}?period=${period}`);assert(restoredBook.vouchers.some(row=>Number(row.id)===Number(voucher.id)&&row.status==='active'));
assert.equal(traffic.slice(removeTraffic).filter(request=>request.method==='DELETE'&&request.path===`/api/clients/${working.id}`).length,1);
scenarios.push('matrix deletion recycles only the selected company and restoration retains the same original active voucher');

assert.equal(errors.length,0,errors.map(String).join('\n'));
const report={scenarios,scenarioCount:scenarios.length,requests,allPassed:true,fixture:'fresh disposable loopback demo200 fixture only',limits:'Real HTTP plus linkedom functional checks; root separately checks browser screenshot geometry.'};
await writeFile('bookkeeping-list-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));process.exit(0);

