import {parseHTML} from 'linkedom';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const base=process.argv[2];
assert(base,'Run with python run-checks.py selection-check.mjs');
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
  const entry={path:url.pathname,method:options.method||'GET',body:typeof options.body==='string'?JSON.parse(options.body):options.body};
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
URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:synthetic-selection-'+blobs.length;};
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
async function reset(){if($('[data-customer-list]')){await search('');click($('.cl-tools-left [data-action="customer-filter"]'),'customer filters');await waitFor(()=>$('[data-action="customer-reset-filters"]'),'filter reset button');click($('[data-action="customer-reset-filters"]'),'reset customer filters');await waitFor(()=>!$('#app-modal-form'),'filters reset');}else if($('[data-bookkeeping-list]')){await search('');if($('[data-filter="accountant"]').value){setSelect($('[data-filter="accountant"]'),'');await delay(35);}if($('[data-bookkeeping-mine]').checked){check($('[data-bookkeeping-mine]'),false);await delay(35);}}else click($('[data-action="reset-filters"]'),'reset filters');await delay(45);}
async function filterTaxpayer(value){if($('[data-customer-list]')){click($('.cl-tools-left [data-action="customer-filter"]'),'customer filters');await waitFor(()=>$('#app-modal-form [name="taxpayer_type"]'),'taxpayer filter');setSelect($('#app-modal-form [name="taxpayer_type"]'),value,false);submitModal();await waitFor(()=>!$('#app-modal-form'),'taxpayer filter applied');}else setSelect($('[data-filter="taxpayer"]'),value);await delay(45);}
async function page(scope,direction){const shell=$(`[data-selection-scope="${scope}"]`);assert(shell,'Table selection shell '+scope);const buttons=$$('[data-action="table-page"]',shell.closest('[data-customer-list],[data-bookkeeping-list]')||shell);const button=direction==='next'?buttons.at(-1):buttons[0];click(button,'page '+direction);await delay(30);}
async function dismiss(){const close=$('#modal-root [data-close]');assert(close,'Modal close');click(close,'modal cancel');await waitFor(()=>!$('#app-modal-form'),'modal closed');}
function submitModal(){const form=$('#app-modal-form');assert(form,'Expected confirmation modal');form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));}
function assertSelectionEmpty(scope){assert.equal(count(scope),0);assert(rows(scope).every(row=>!row.checked));const h=header(scope);if(h){assert(!h.checked);assert(!h.indeterminate);}}

const frontend=await import(pathToFileURL(root+'/public/app.js').href+'?selection-test='+Date.now());
await waitFor(()=>$('.progress-card'),'app startup');
let boot=await frontend.api('/api/bootstrap');assert.equal(boot.clients.length,200,'Fixture must contain exactly 200 synthetic clients');
const period=$('[data-filter="period"]').value;
await nav('客户','全部客户');
await waitFor(()=>header('clients'),'new selection controls');
assertSelectionEmpty('clients');
// The screenshot uses 500 rows by default; explicitly request 50 for the
// existing cross-page selection regression rather than changing its scope.
setSelect($('[data-page-size]'),'50');await delay(45);
const initialPageSize=rows('clients').length;assert(initialPageSize>0&&initialPageSize<200);
check(header('clients'),true);
assert.equal(count('clients'),initialPageSize);assert(rows('clients').every(row=>row.checked));assert(header('clients').checked);assert(!header('clients').indeterminate);
const firstPageFirstId=Number(rows('clients')[0].value);
check(rows('clients')[0],false);
assert.equal(count('clients'),initialPageSize-1);assert(!header('clients').checked);assert(header('clients').indeterminate);
await page('clients','next');
assert(rows('clients').every(row=>!row.checked),'Previous page selection leaked into visible row state');
const secondPageFirstId=Number(rows('clients')[0].value);
check(rows('clients')[0],true);assert.equal(count('clients'),initialPageSize);assert(header('clients').indeterminate);
await page('clients','previous');assert(!rows('clients').find(row=>Number(row.value)===firstPageFirstId).checked);assert(header('clients').indeterminate);
chooseAll('clients');assert.equal(count('clients'),200);assert(rows('clients').every(row=>row.checked));assert(header('clients').checked);
await page('clients','next');assert(rows('clients').every(row=>row.checked));assert(header('clients').checked);
clear('clients');assertSelectionEmpty('clients');
scenarios.push('200 clients: per-page select, partial header, cross-page state, all filtered and clear');

check(rows('clients')[0]);await search('DEMO0001');assertSelectionEmpty('clients');assert.equal(rows('clients').length,1);
await reset();check(rows('clients')[0]);await filterTaxpayer('general');assertSelectionEmpty('clients');
const general=boot.clients.filter(c=>c.taxpayer_type==='general');chooseAll('clients');assert.equal(count('clients'),general.length);
setSelect($('[data-filter="accountant"]'),'1');await delay(45);assertSelectionEmpty('clients');
const generalMine=general.filter(c=>Number(c.accountant_id)===1);chooseAll('clients');assert.equal(count('clients'),generalMine.length);
click($('[data-sub="0申报"]'),'switch customer subpage');await delay(45);
await nav('客户','全部客户');assertSelectionEmpty('clients');await reset();check(rows('clients')[0]);await search('NO-SYNTHETIC-CUSTOMER-MATCH-'+Date.now());
assertSelectionEmpty('clients');assert.equal(rows('clients').length,0);
const emptyHeader=header('clients');assert(!emptyHeader||emptyHeader.disabled||emptyHeader.hasAttribute('disabled'),'Empty table header must be disabled');
const emptyAll=$('[data-action="selection-all"][data-scope="clients"]');assert(!emptyAll||emptyAll.disabled||emptyAll.hasAttribute('disabled')||$('[data-customer-selection-tools]')?.hidden,'Empty select-all must be disabled or its whole toolbar hidden');
await reset();scenarios.push('search, taxpayer, employee and subpage changes clear selection; empty list cannot select');

// Customer list no longer has an accounting-period field. Change it through
// the real home workbench, which still exposes that control and selection.
await nav('首页','工作进展');check(rows('clients')[0]);
const [yearNumber,monthNumber]=period.split('-').map(Number);const priorDate=new Date(yearNumber,monthNumber-2,1);
const priorPeriod=`${priorDate.getFullYear()}-${String(priorDate.getMonth()+1).padStart(2,'0')}`;
let periodInput=$('[data-filter="period"]');periodInput.value=priorPeriod;change(periodInput);
await waitFor(()=>count('clients')===0&&$('[data-filter="period"]').value===priorPeriod,'period change clears selection');
periodInput=$('[data-filter="period"]');periodInput.value=period;change(periodInput);
await waitFor(()=>$('[data-filter="period"]').value===period,'restore current period');await delay(50);
await nav('客户','全部客户');setSelect($('[data-page-size]'),'50');await delay(45);assertSelectionEmpty('clients');
scenarios.push('changing accounting period clears selection');

// A client disabled for bookkeeping remains available for contact/label work
// and explicit customer export, while it must never enter the close selection.
const disabledClient=boot.clients.find(c=>Number(c.id)===4);assert(disabledClient);
await frontend.api(`/api/clients/${disabledClient.id}`,{method:'PATCH',body:{version:disabledClient.version,enabled:false}});
click($('[data-action="refresh"]'),'refresh disabled client');await waitFor(()=>$(`[data-action="client-enable-settings"][data-id="${disabledClient.id}"]`)?.textContent==='已禁用','disabled client loaded');

// Capture the real downloadable CSV Blob and verify precisely the two selected
// clients across pages, rather than trusting a notification or hardcoded count.
check($(`input[data-company-select="clients"][value="${disabledClient.id}"]`));const exportFirstId=Number(disabledClient.id);
await page('clients','next');check(rows('clients')[0]);const exportSecondId=Number(rows('clients')[0].value);
assert.equal(count('clients'),2);const oldBlobCount=blobs.length;
click($('[data-action="export-selected"]'),'export selected clients');
await waitFor(()=>blobs.length===oldBlobCount+1,'selected CSV blob');
const csvText=await blobs.at(-1).text();const csvLines=csvText.replace(/^\uFEFF/,'').trim().split(/\r?\n/);
assert.equal(csvLines.length,3,'Selected CSV must have header plus exactly two clients');
for(const id of [exportFirstId,exportSecondId])assert(csvText.includes(boot.clients.find(c=>Number(c.id)===id).code),'Selected client missing from CSV');
for(const c of boot.clients.filter(c=>![exportFirstId,exportSecondId].includes(Number(c.id))))assert(!csvText.includes('"'+c.code+'"'),'Unselected client leaked into CSV');
scenarios.push('selected CSV export contains exactly two selected clients across pages');

const label='SELECTION-QA-'+Date.now();
await frontend.api('/api/settings',{method:'POST',body:{version:boot.settings.version,labels:[...(boot.settings.labels||[]),label]}});
await nav('客户','标签设置');click($('[data-action="refresh"]'),'refresh label settings');await waitFor(()=>$('#batch-label')?.textContent.includes(label),'new global label loaded');
await reset();
check($(`input[data-company-select="labels"][value="${disabledClient.id}"]`));const labelFirstId=Number(disabledClient.id);
await page('labels','next');check(rows('labels')[0]);const labelSecondId=Number(rows('labels')[0].value);
assert.equal(count('labels'),2);setSelect($('#batch-label'),label,false);
const labelStart=traffic.length;
click($('[data-action="labels-assign"]'),'assign to selected clients');
await waitFor(()=>traffic.slice(labelStart).filter(r=>r.method==='PATCH'&&/^\/api\/clients\/\d+$/.test(r.path)).length===2,'exactly two label patches');
await waitFor(async()=>{const b=await frontend.api('/api/bootstrap');return b.clients.filter(c=>(c.labels||[]).includes(label)).length===2;},'labels persisted');
boot=await frontend.api('/api/bootstrap');
assert.deepEqual(boot.clients.filter(c=>(c.labels||[]).includes(label)).map(c=>Number(c.id)).sort((a,b)=>a-b),[labelFirstId,labelSecondId].sort((a,b)=>a-b));
assert.deepEqual(traffic.slice(labelStart).filter(r=>r.method==='PATCH'&&/^\/api\/clients\/\d+$/.test(r.path)).map(r=>Number(r.path.split('/').at(-1))).sort((a,b)=>a-b),[labelFirstId,labelSecondId].sort((a,b)=>a-b));
scenarios.push('batch labels perform real HTTP updates only for the two selected clients');
scenarios.push('disabled client remains selectable for explicit export and label maintenance');

await nav('客户','全部客户');await reset();
const recycleId=5;check($(`input[data-company-select="clients"][value="${recycleId}"]`));
let recycleClient=(await frontend.api('/api/bootstrap')).clients.find(c=>Number(c.id)===recycleId);
await frontend.api(`/api/clients/${recycleId}`,{method:'DELETE',body:{version:recycleClient.version}});
click($('[data-action="refresh"]'),'refresh after external recycle');
await waitFor(()=>count('clients')===0&&!$(`input[data-company-select="clients"][value="${recycleId}"]`),'refresh prunes recycled selection');
click($('[data-sub="回收站"]'),'recycle bin');await delay(50);assertSelectionEmpty('clients');
check($(`input[data-company-select="clients"][value="${recycleId}"]`));const recycleBlobStart=blobs.length;
click($('[data-action="export-selected"]'),'export selected recycled client');await waitFor(()=>blobs.length===recycleBlobStart+1,'recycle CSV blob');
const recycledCsv=await blobs.at(-1).text();assert.equal(recycledCsv.replace(/^\uFEFF/,'').trim().split(/\r?\n/).length,2);assert(recycledCsv.includes(recycleClient.code),'Recycled selection export must contain an actual row');
click($('[data-sub="全部客户"]'),'back to active clients');await delay(50);assertSelectionEmpty('clients');
click($('[data-sub="回收站"]'),'return to recycle bin');await delay(50);assertSelectionEmpty('clients');
recycleClient=(await frontend.api('/api/bootstrap')).clients.find(c=>Number(c.id)===recycleId);
await frontend.api(`/api/clients/${recycleId}/restore`,{method:'POST',body:{version:recycleClient.version}});
click($('[data-action="refresh"]'),'refresh restored client');await waitFor(()=>rows('clients').length===0,'empty recycle bin after restore');assertSelectionEmpty('clients');
scenarios.push('refresh prunes recycled IDs; active/recycle views never share selection; recycled selected export contains the row');

// Three empty current-period synthetic books allow real closes without touching
// the 200 seeded books or attempting an unnecessary mass accounting close.
const stamp=String(Date.now()),newClients=[];
for(const letter of ['A','B','C'])newClients.push(await frontend.api('/api/clients',{method:'POST',body:{name:'合成选择结账测试'+letter,code:'SELECTION-CLOSE-'+stamp+'-'+letter,start_period:period,standard:'small2013',taxpayer_type:'small',accountant_id:1}}));
await nav('记账','批量结账');click($('[data-action="refresh"]'),'refresh added empty books');await delay(80);await reset();
// The matrix may include its own search; an employee filter is unnecessary since
// IDs are selected explicitly and the confirmation must show exactly those IDs.
assertSelectionEmpty('close');const closeButton=$('[data-action="batch-close"]');assert(closeButton.disabled||closeButton.hasAttribute('disabled'),'Batch close must be disabled with no selection');
assert(!rows('close').some(row=>Number(row.value)===Number(disabledClient.id)),'Disabled client must be excluded from close rows');
const shell=$('[data-selection-scope="close"]');const size=$('[data-page-size]',shell.closest('[data-bookkeeping-list]')||shell);setSelect(size,'100');await delay(40);
// A seeded book whose initial month remains unclosed produces one real failure
// among two valid empty current-period closes, exercising partial batch results.
const failureClient=boot.clients.find(c=>Number(c.id)===200&&c.start_period<period);assert(failureClient,'Expected a pre-current unclosed synthetic book');
while(!rows('close').some(row=>Number(row.value)===Number(failureClient.id)))await page('close','next');
check($(`input[data-company-select="close"][value="${failureClient.id}"]`));
// Eligibility filtering can shift page boundaries; find each selected new book
// separately, preserving earlier-page selections on the way.
for(const c of newClients.slice(0,2)){
  while(!rows('close').some(row=>Number(row.value)===Number(c.id)))await page('close','next');
  check($(`input[data-company-select="close"][value="${c.id}"]`));
}
assert.equal(count('close'),3);
const beforeClose=await frontend.api('/api/bootstrap?period='+period);const requestStart=traffic.length;
click($('[data-action="batch-close"]'),'batch close selected');await waitFor(()=>$('[data-batch-close-list]'),'batch close confirmation');
const selectedCloseIds=[Number(failureClient.id),...newClients.slice(0,2).map(c=>Number(c.id))].sort((a,b)=>a-b);
assert.deepEqual($$('[data-confirm-client-id]').map(el=>Number(el.dataset.confirmClientId)).sort((a,b)=>a-b),selectedCloseIds);
assert($('[data-batch-close-period]').textContent.includes(period));
assert(!$('#app-modal-form').textContent.includes(newClients[2].name),'Unselected client appears in confirmation');
assert.equal(traffic.slice(requestStart).filter(r=>r.method==='POST'&&/\/close$/.test(r.path)).length,0,'Opening confirmation must not close any book');
await dismiss();assert.equal(traffic.slice(requestStart).filter(r=>r.method==='POST'&&/\/close$/.test(r.path)).length,0,'Cancelling confirmation must not close any book');
click($('[data-action="batch-close"]'),'reopen batch close');await waitFor(()=>$('[data-batch-close-list]'),'second batch close confirmation');submitModal();
await waitFor(()=>traffic.slice(requestStart).filter(r=>r.method==='POST'&&/\/close$/.test(r.path)).length===3,'three selected close requests');
await waitFor(async()=>{const b=await frontend.api('/api/bootstrap?period='+period);return newClients.slice(0,2).every(c=>b.book_periods.some(p=>Number(p.client_id)===Number(c.id)&&p.period===period&&p.closed));},'selected books actually closed');
const afterClose=await frontend.api('/api/bootstrap?period='+period);
const closes=traffic.slice(requestStart).filter(r=>r.method==='POST'&&/\/close$/.test(r.path));
assert.deepEqual(closes.map(r=>Number(r.path.split('/')[3])).sort((a,b)=>a-b),selectedCloseIds);
assert(closes.every(r=>r.body.period===period),'Close requests must use the confirmed period');
assert.equal(closes.filter(r=>r.status===200).length,2,'Exactly two valid empty books must close');
assert.equal(closes.filter(r=>r.status>=400).length,1,'The pre-current unclosed book must retain a real failure');
assert(!afterClose.book_periods.some(p=>Number(p.client_id)===Number(newClients[2].id)&&p.period===period&&p.closed),'Third unselected book was closed');
assert(!afterClose.book_periods.some(p=>Number(p.client_id)===Number(failureClient.id)&&p.period===period&&p.closed),'Failed selected book was falsely marked closed');
const newlyClosed=afterClose.book_periods.filter(p=>p.period===period&&p.closed&&!beforeClose.book_periods.some(old=>Number(old.client_id)===Number(p.client_id)&&old.period===p.period&&old.closed));
assert.equal(newlyClosed.length,2,'Only the selected two books may acquire closed status');
await waitFor(()=>$('#modal-title')?.textContent==='批量结账结果','batch close result UI');
const resultRows=$$('#app-modal-form tbody tr');assert.equal(resultRows.length,3);
for(const c of newClients.slice(0,2)){const row=resultRows.find(row=>row.textContent.includes(c.name));assert(row&&/完成|成功|已结账/.test(row.textContent),'Successful close result missing');}
const failedRow=resultRows.find(row=>row.textContent.includes(failureClient.name));assert(failedRow&&/失败|未结账/.test(failedRow.textContent),'Failed close result must be visible');
scenarios.push('batch close confirms fixed IDs/period, cancellation has no effect; two books succeed and one real failure stays open; all unselected books stay unchanged');
assert.equal(errors.length,0,'Unhandled DOM workflow error');
await writeFile('selection-report.json',JSON.stringify({scenarios,requests,allPassed:true,fixture:'temporary synthetic HTTP database only',note:'linkedom DOM and real HTTP; no browser visual QA.'},null,2));
console.log(JSON.stringify({scenarios,requests,allPassed:true}));
process.exit(0);
