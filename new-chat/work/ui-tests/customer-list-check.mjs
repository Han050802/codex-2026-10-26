import {parseHTML} from 'linkedom';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const base=process.argv[2];
assert(base,'Run with python run-checks.py customer-list-check.mjs');
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
const storage=new Map();
globalThis.localStorage=window.localStorage={getItem:key=>storage.get(String(key))??null,setItem:(key,value)=>storage.set(String(key),String(value)),removeItem:key=>storage.delete(String(key)),clear:()=>storage.clear()};
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
function count(scope='clients'){const el=$(`[data-selection-count="${scope}"]`);return el?Number(el.textContent.trim()):frontend.selectedCompanyIds(scope).length;}
function rows(scope){return $$(`input[data-company-select="${scope}"]`);}
function header(scope){return $(`input[data-company-select-page="${scope}"]`);}
function clear(scope){click($(`[data-action="selection-clear"][data-scope="${scope}"]`),'clear '+scope);}
function chooseAll(scope){click($(`[data-action="selection-all"][data-scope="${scope}"]`),'select all '+scope);}
async function nav(name,sub){click($(`[data-nav="${name}"]`),'nav '+name);await waitFor(()=>$(`[data-nav="${name}"].active`),'nav '+name);await delay(35);if(sub){click($(`[data-sub="${sub}"]`),'sub '+sub);await waitFor(()=>$(`[data-sub="${sub}"].active`),'sub '+sub);await delay(40);}assert(!$('.page-error'),name+'/'+sub+' failed');}
async function search(value){const form=$('[data-search-form]');assert(form,'Search form');form.elements.q.value=value;form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await delay(45);}
async function reset(){click($('[data-action="reset-filters"]'),'reset filters');await delay(45);}
async function page(scope,direction){const shell=$(`[data-selection-scope="${scope}"]`);assert(shell,'Table selection shell '+scope);const buttons=$$('[data-action="table-page"]',shell.closest('[data-customer-list]')||shell);const button=direction==='next'?buttons.at(-1):buttons[0];click(button,'page '+direction);await delay(30);}
async function dismiss(){const close=$('#modal-root [data-close]');assert(close,'Modal close');click(close,'modal cancel');await waitFor(()=>!$('#app-modal-form'),'modal closed');}
function submitModal(){const form=$('#app-modal-form');assert(form,'Expected confirmation modal');form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));}
function assertSelectionEmpty(scope){assert.equal(count(scope),0);assert(rows(scope).every(row=>!row.checked));const h=header(scope);if(h){assert(!h.checked);assert(!h.indeterminate);}}

// This targeted test uses only the throwaway fixture created by run-checks.py.
// It never opens a reference website or a browser, and refuses live app ports.
const frontend=await import(pathToFileURL(root+'/public/app.js').href+'?customer-list-test='+Date.now());
await waitFor(()=>$('.progress-card'),'app startup');
let boot=await frontend.api('/api/bootstrap');
assert.equal(boot.clients.length,200,'Fixture must contain exactly 200 synthetic clients');
const period=$('[data-filter="period"]').value;
assert.equal(boot.users.length,3,'Fixture must expose the three synthetic operators');
const fixtureIds=boot.clients.map(client=>Number(client.id));
const byId=(data,id)=>data.clients.find(client=>Number(client.id)===Number(id));
const sorted=values=>[...values].map(Number).sort((a,b)=>a-b);
const visibleIds=()=>rows('clients').map(input=>Number(input.value));
const selectionIds=()=>frontend.selectedCompanyIds('clients').map(Number);
function inputValue(el,value){assert(el,'Missing input');el.value=String(value);el.dispatchEvent(new window.Event('input',{bubbles:true,cancelable:true}));}
function csvRows(text){
  const rows=[];let row=[],cell='',quoted=false;
  text=text.replace(/^\uFEFF/,'');
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(ch==='"'){
      if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;
    }else if(ch===','&&!quoted){row.push(cell);cell='';}
    else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(Boolean))rows.push(row);row=[];cell='';}
    else cell+=ch;
  }
  if(cell||row.length){row.push(cell);rows.push(row);}
  return rows;
}
async function currentBoot(){return frontend.api('/api/bootstrap?period='+period);}
async function patchClient(id,values){const data=await currentBoot();return frontend.api(`/api/clients/${id}`,{method:'PATCH',body:{version:byId(data,id).version,...values}});}
async function refresh(){const start=traffic.length;click($('[data-action="refresh"]'),'refresh current page');await waitFor(()=>traffic.slice(start).some(request=>request.method==='GET'&&request.path==='/api/bootstrap'),'bootstrap refresh');await delay(65);}
async function assertFiltered(expected,label){
  const ids=sorted(expected.map(client=>Number(client.id)));
  assert(visibleIds().every(id=>ids.includes(id)),label+': unexpected visible customer');
  if(ids.length){check(rows('clients')[0]);if(selectionIds().length!==ids.length)chooseAll('clients');await delay(20);assert.deepEqual(sorted(selectionIds()),ids,label+': cross-page filtered set');clear('clients');}
  else assert.equal(visibleIds().length,0,label+': expected an empty result');
}
function submitForm(form){assert(form,'Missing form');form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));}
async function sessionFor(username){
  const response=await nativeFetch(new URL('/api/login',base),{method:'POST',headers:{Origin:base,Connection:'close','Content-Type':'application/json'},body:JSON.stringify({username,password:'DemoOnly123!'})});
  requests++;assert.equal(response.status,200,'Synthetic secondary login');
  const session=await response.json(),sessionCookie=response.headers.get('set-cookie').split(';')[0];
  return async(path,{method='GET',body}={})=>{
    const response=await nativeFetch(new URL(path,base),{method,headers:{Origin:base,Connection:'close',Cookie:sessionCookie,'X-CSRF-Token':session.csrf,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});requests++;
    const value=await response.json();assert.equal(response.status,200,'Secondary operator request '+method+' '+path);return value;
  };
}

// Change only synthetic fixture records to cover distinct region/status values.
await patchClient(fixtureIds[4],{region:'北京',service_status:'active'});
await patchClient(fixtureIds[5],{region:'上海',service_status:'paused'});
await patchClient(fixtureIds[6],{service_status:'terminated'});
await patchClient(fixtureIds[7],{authorized_user_ids:[boot.users[0].id]});
boot=await currentBoot();
await nav('客户','全部客户');
await refresh();

const expectedColumns=['select','index','name','industry','region','taxpayer_type','standard','book_status','accountant_id','authorized_user_ids','service_status','enabled','actions'];
const columnHeads=()=>$$('th[data-customer-column]');
await waitFor(()=>columnHeads().length===13,'exact customer list module');
assert.deepEqual(columnHeads().map(node=>node.dataset.customerColumn),expectedColumns,'All thirteen columns and their order must match the supplied layout');
assert(!columnHeads().some(node=>/客户编码|随手记|标签|建账年月/.test(node.textContent)),'Extra legacy columns must not remain in the customer list');
const customerShell=$('[data-selection-scope="clients"]');assert(customerShell);
assert.equal(customerShell.dataset.tableKey,'客户|全部客户|exact-list','Customer pagination state must use one stable table key');
const expectedHeaderLabels={industry:'行业',region:'地区',taxpayer_type:'纳税性质',standard:'会计制度',book_status:'记账状况',accountant_id:'记账会计',authorized_user_ids:'授权用户',service_status:'服务状态',enabled:'启用状态',actions:'操作'};
for(const [key,label] of Object.entries(expectedHeaderLabels))assert($(`th[data-customer-column="${key}"]`).textContent.includes(label),'Missing exact column label '+label);
assert($('th[data-customer-column="name"]').textContent.startsWith('客户名称(启用200家'),'Name header must include the actual enabled count');
const toolbar=$('.cl-toolbar');assert(toolbar);
const tenEntrypoints=['.cl-employee','[data-search-form]','[data-action="customer-filter"]','[data-action="client-new"]','[data-action="customer-industry"]','[data-action="import"][data-kind="clients"]','[data-action="customer-tags"]','.cl-dropdown:nth-of-type(1)','.cl-dropdown:nth-of-type(2)','[data-action="refresh"]'];
for(const selector of tenEntrypoints)assert($(selector,toolbar),'Missing single-row toolbar entry '+selector);
assert.equal($$('.cl-dropdown',toolbar).length,2,'Authorization and export each have one menu');
assert($('[data-cl-import-only]',toolbar)&&$('[data-cl-mine-only]',toolbar),'Import-list and assigned-book filters are available');
for(const selector of ['[data-action="customer-authorize"][data-mode="set"]','[data-action="customer-authorize"][data-mode="clear"]','[data-action="export"][data-kind="clients"]','[data-action="export-selected"]','[data-action="template"][data-kind="clients"]'])assert($(selector,toolbar),'Missing menu entry '+selector);
const firstRow=rows('clients')[0]?.closest('tr');assert(firstRow,'First synthetic customer row');
const nameCell=$('[data-customer-cell="name"]',firstRow)||firstRow.children[2];
assert($('[data-action="open-book"]',nameCell),'Book entry belongs in the customer name cell');
const actionCell=$('[data-customer-cell="actions"]',firstRow)||firstRow.lastElementChild;
assert.deepEqual($$('[data-action]',actionCell).map(node=>node.dataset.action),['client-row-refresh','client-edit','client-delete'],'Row operation cell has exactly refresh/edit/delete');
assert($('[data-action="client-enable-settings"]',firstRow),'Enable setting must be in the separate enable-status cell');
assert($('[data-action="client-service-settings"]',firstRow),'Service status must remain separate from enabled');
assertSelectionEmpty('clients');
const selectionBar=()=>$('[data-customer-selection-tools]');
assert(!selectionBar()||selectionBar().hidden||selectionBar().style.display==='none','Selection bar must be hidden before selecting');
check(rows('clients')[0]);assert.equal(count(),1);
assert(selectionBar()&&!selectionBar().hidden&&selectionBar().style.display!=='none','Selection bar must appear after selecting');
clear('clients');assertSelectionEmpty('clients');
assert(!selectionBar()||selectionBar().hidden||selectionBar().style.display==='none','Clearing selection hides the extra bar');
scenarios.push('exact thirteen columns, name-cell book entry, three row icons and conditional selection toolbar');
scenarios.push('single toolbar contains all ten main entry points, both local filters and working authorization/export menu entries');

// The circular arrow may re-read the selected row but must never toggle enabled
// or produce a version bump. Inspect real request methods and persisted state.
const refreshId=Number(rows('clients')[0].value),beforeRefresh=byId(await currentBoot(),refreshId);
const refreshTraffic=traffic.length;
click($(`[data-action="client-row-refresh"][data-id="${refreshId}"]`),'customer circular refresh arrow');
await waitFor(()=>traffic.slice(refreshTraffic).some(request=>request.method==='GET'&&request.path==='/api/bootstrap'),'row GET refresh');
await delay(65);
const refreshRequests=traffic.slice(refreshTraffic);
assert(refreshRequests.length>0&&refreshRequests.every(request=>request.method==='GET'),'Circular row arrow must only send GET requests');
const afterRefresh=byId(await currentBoot(),refreshId);
assert.equal(afterRefresh.enabled,beforeRefresh.enabled,'Row refresh cannot change enabled');
assert.equal(afterRefresh.version,beforeRefresh.version,'Row refresh cannot change optimistic version');
scenarios.push('circular row arrow performs GET refresh without changing enabled or version');

async function filterCustomers(values={}){
  click($('.cl-tools-left [data-action="customer-filter"]'),'customer filters');
  await waitFor(()=>$('#app-modal-form [name="industry"]'),'filter form');
  const form=$('#app-modal-form');
  for(const name of ['accountant_id','taxpayer_type','standard','industry','region','book_status','service_status','enabled','label']){
    const control=$(`[name="${name}"]`,form);assert(control,'Missing customer filter '+name);
    if(control.tagName==='SELECT')setSelect(control,values[name]??'',false);else inputValue(control,values[name]??'');
  }
  submitForm(form);await waitFor(()=>!$('#app-modal-form'),'filter applied');await delay(35);
}
async function clearFilters(){
  if($('[data-cl-mine-only]')?.checked){check($('[data-cl-mine-only]'),false);await delay(35);}
  if($('[data-cl-import-only]')?.checked){check($('[data-cl-import-only]'),false);await delay(35);}
  await search('');await filterCustomers();
}
async function setPageSize(size){setSelect($('[data-page-size]'),String(size));await delay(45);}
function openMenu(name){const summary=$(`[data-customer-menu-trigger="${name}"]`);click(summary,name+' menu');summary.closest('details').open=true;}
async function waitModalSaved(label){await waitFor(()=>!$('#app-modal-form'),label);await delay(50);}
function selectedRow(id){return $(`input[data-company-select="clients"][value="${id}"]`);}

// Default pagination follows the screenshot. The cross-page exercise explicitly
// switches to 50, rather than assuming the original default is a small page.
assert.equal($('[data-page-size]').value,'500','Default customer page size must match the supplied 500-row control');
assert.equal(rows('clients').length,200,'The 200-customer fixture fits on the default 500-row page');
await setPageSize(50);assert.equal(rows('clients').length,50);
check(header('clients'));assert.equal(count(),50);assert(header('clients').checked);
const omittedId=Number(rows('clients')[0].value);check(rows('clients')[0],false);assert.equal(count(),49);assert(header('clients').indeterminate);
await page('clients','next');assert(rows('clients').every(row=>!row.checked));
const otherPageId=Number(rows('clients')[0].value);check(rows('clients')[0]);assert.equal(count(),50);assert(header('clients').indeterminate);
await page('clients','previous');assert(!selectedRow(omittedId).checked);assert(header('clients').indeterminate);
chooseAll('clients');assert.deepEqual(sorted(selectionIds()),sorted(fixtureIds));
await page('clients','next');assert(rows('clients').every(row=>row.checked));assert(header('clients').checked);
clear('clients');assertSelectionEmpty('clients');
scenarios.push('default 500 rows, explicit 50-row paging, partial header and all-filter selection preserve the correct cross-page ids');

// Sorting changes display order, while subsequent selection still uses stable
// ids and all-filter selection covers every record exactly once.
click($('[data-action="customer-sort"]'),'sort customer name ascending');await delay(40);
const asc=boot.clients.slice().sort((a,b)=>a.name.localeCompare(b.name,'zh-CN')).map(client=>Number(client.id));
assert.deepEqual(visibleIds(),asc.slice(0,rows('clients').length));
click($('[data-action="customer-sort"]'),'sort customer name descending');await delay(40);
const desc=asc.slice().reverse();assert.deepEqual(visibleIds(),desc.slice(0,rows('clients').length));
check(rows('clients')[0]);chooseAll('clients');assert.deepEqual(sorted(selectionIds()),sorted(fixtureIds));clear('clients');
scenarios.push('ascending/descending customer name sort remains compatible with selection by stable customer ids');

// Every option is exercised through the visible filter form, then the exact
// cross-page selection is compared with real bootstrap data.
const filterCases=[
  ['industry','商贸',client=>client.industry==='商贸'],
  ['region','北京',client=>client.region==='北京'],
  ['taxpayer_type','general',client=>client.taxpayer_type==='general'],
  ['standard','enterprise2007',client=>client.standard==='enterprise2007'],
  ['service_status','active',client=>client.service_status==='active'],
  ['service_status','paused',client=>client.service_status==='paused'],
  ['service_status','terminated',client=>client.service_status==='terminated'],
  ['service_status','unset',client=>client.service_status==='unset'],
  ['accountant_id',String(boot.users[1].id),client=>Number(client.accountant_id)===Number(boot.users[1].id)]
];
for(const [field,value,predicate] of filterCases){
  check(rows('clients')[0]);await filterCustomers({[field]:value});assertSelectionEmpty('clients');
  await assertFiltered(boot.clients.filter(predicate),field+' filter');await filterCustomers();
}
const currentWorking=boot.book_periods.filter(row=>row.period===period&&Number(row.voucher_count)>0).map(row=>Number(row.client_id));
await filterCustomers({book_status:'working'});await assertFiltered(boot.clients.filter(client=>currentWorking.includes(Number(client.id))),'real bookkeeping activity filter');
await filterCustomers();
setSelect($('[data-filter="accountant"]'),String(boot.users[2].id));await delay(45);await assertFiltered(boot.clients.filter(client=>Number(client.accountant_id)===Number(boot.users[2].id)),'employee dropdown');
setSelect($('[data-filter="accountant"]'),'');await delay(45);
check($('[data-cl-mine-only]'));await delay(45);await assertFiltered(boot.clients.filter(client=>Number(client.accountant_id)===Number(boot.users[0].id)||(client.authorized_user_ids||[]).includes(boot.users[0].id)),'assigned book metadata');
check($('[data-cl-mine-only]'),false);await delay(45);
scenarios.push('industry, region, tax nature, accounting standard, four service statuses, accountant and real bookkeeping-state filters match persisted data');
scenarios.push('employee and assigned-book filters include actual accountant/assignment metadata without changing access rights');

// Matching an imported CSV is a view operation. The records and versions remain
// untouched and unmatched names never create synthetic customers in the app.
const importedIds=[fixtureIds[18],fixtureIds[72]],importText='客户名称\r\n'+importedIds.map(id=>byId(boot,id).name).join('\r\n')+'\r\n不存在的合成名单名称';
const beforeListImport=await currentBoot(),listImportTraffic=traffic.length;
check($('[data-cl-import-only]'));
const importInput=$('#customer-list-import');assert(importInput);
Object.defineProperty(importInput,'files',{configurable:true,value:[{name:'synthetic-list.csv',size:Buffer.byteLength(importText),text:async()=>importText}]});
change(importInput);await waitFor(()=>rows('clients').length===2&&$('[data-cl-import-only]').checked,'local import matching');
assert.deepEqual(sorted(visibleIds()),sorted(importedIds));
assert(traffic.slice(listImportTraffic).every(request=>request.method==='GET'),'Imported-list filtering cannot send write requests');
const afterListImport=await currentBoot();assert.equal(afterListImport.clients.length,200);
assert.deepEqual(afterListImport.clients.map(client=>[client.id,client.version]),beforeListImport.clients.map(client=>[client.id,client.version]));
const replacementIds=[fixtureIds[21],fixtureIds[61]],replacementText='客户名称\r\n'+replacementIds.map(id=>byId(boot,id).name).join('\r\n');
click($('.cl-tools-left [data-action="customer-filter"]'),'import replacement controls');await waitFor(()=>$('[data-action="customer-import-replace"]'),'replace import action');
click($('[data-action="customer-import-replace"]'),'replace imported list');await waitFor(()=>!$('#app-modal-form'),'replacement chooser modal closed');
const replacementInput=$('#customer-list-import');
Object.defineProperty(replacementInput,'files',{configurable:true,value:[{name:'synthetic-replacement.csv',size:Buffer.byteLength(replacementText),text:async()=>replacementText}]});change(replacementInput);
await waitFor(()=>rows('clients').length===2&&visibleIds().every(id=>replacementIds.includes(id)),'replacement list matched');assert.deepEqual(sorted(visibleIds()),sorted(replacementIds));
click($('.cl-tools-left [data-action="customer-filter"]'),'clear import controls');await waitFor(()=>$('[data-action="customer-import-clear"]'),'clear import action');
click($('[data-action="customer-import-clear"]'),'clear imported list');await waitFor(()=>!$('#app-modal-form')&&$('[data-cl-import-only]')&&!$('[data-cl-import-only]').checked&&rows('clients').length===200,'imported list cleared');
const resetInput=$('#customer-list-import');Object.defineProperty(resetInput,'files',{configurable:true,value:[{name:'synthetic-reset.csv',size:Buffer.byteLength(replacementText),text:async()=>replacementText}]});change(resetInput);
await waitFor(()=>rows('clients').length===2&&$('[data-cl-import-only]').checked,'prepare reset list');check($('[data-cl-mine-only]'));await delay(40);
click($('.cl-tools-left [data-action="customer-filter"]'),'reset import and assigned controls');await waitFor(()=>$('[data-action="customer-reset-filters"]'),'reset all filters action');
click($('[data-action="customer-reset-filters"]'),'reset all customer filters');
await waitFor(()=>!$('#app-modal-form')&&$('[data-cl-import-only]')&&$('[data-cl-mine-only]')&&!$('[data-cl-import-only]').checked&&!$('[data-cl-mine-only]').checked&&rows('clients').length===200,'reset clears imported and assigned filters');
const resetListBoot=await currentBoot();assert.deepEqual(resetListBoot.clients.map(client=>[client.id,client.version]),beforeListImport.clients.map(client=>[client.id,client.version]));
scenarios.push('imported CSV list can be replaced, cleared and reset together with assigned-book filtering without altering customer records');
// Re-enable the existing replacement list once to verify a checkbox change
// also removes any selected ids from the filtered range.
const lastImportInput=$('#customer-list-import');Object.defineProperty(lastImportInput,'files',{configurable:true,value:[{name:'synthetic-last.csv',size:Buffer.byteLength(importText),text:async()=>importText}]});change(lastImportInput);
await waitFor(()=>rows('clients').length===2&&$('[data-cl-import-only]').checked,'last import list');
check(rows('clients')[0]);check($('[data-cl-import-only]'),false);await delay(40);assertSelectionEmpty('clients');
await search('NO-SYNTHETIC-MATCH-'+Date.now());assert.equal(rows('clients').length,0);assertSelectionEmpty('clients');assert(header('clients').disabled||header('clients').hasAttribute('disabled'));
await clearFilters();scenarios.push('CSV imported-name matching filters only existing records without writes, clears selection when changed and handles empty results');

// Cross-page bulk industry update must issue exactly two optimistic PATCHes.
await setPageSize(50);check(rows('clients')[0]);const industryA=Number(rows('clients')[0].value);
await page('clients','next');check(rows('clients')[0]);const industryB=Number(rows('clients')[0].value);
const beforeIndustry=await currentBoot(),industry='合成专项行业'+Date.now(),industryTraffic=traffic.length;
click($('[data-action="customer-industry"]'),'bulk industry');await waitFor(()=>$('#app-modal-form [name="industry"]'),'bulk industry form');
const industryControl=$('#app-modal-form [name="industry"]');inputValue(industryControl,industry);submitModal();await waitModalSaved('industry saved');
boot=await currentBoot();
assert.deepEqual(sorted(boot.clients.filter(client=>client.industry===industry).map(client=>Number(client.id))),sorted([industryA,industryB]));
for(const client of boot.clients.filter(client=>![industryA,industryB].includes(Number(client.id))))assert.equal(client.industry,byId(beforeIndustry,client.id).industry,'Unselected industry must be unchanged');
assert.deepEqual(sorted(traffic.slice(industryTraffic).filter(request=>request.method==='PATCH'&&/^\/api\/clients\/\d+$/.test(request.path)).map(request=>Number(request.path.split('/').at(-1)))),sorted([industryA,industryB]));
if(count())clear('clients');scenarios.push('bulk industry updates only the two selected customers across pages through real versioned PATCH requests');

// Authorization is a saved assignment list. It can be populated and explicitly
// cleared; neither state is permitted to remove another operator's edit access.
const authIds=visibleIds().slice(2,4);assert.equal(authIds.length,2);
for(const id of authIds)check(selectedRow(id));
openMenu('authorize');click($('.cl-toolbar [data-action="customer-authorize"][data-mode="set"]'),'set assignment list');
await waitFor(()=>$('#app-modal-form [name="authorization_mode"]'),'assignment form');
setSelect($('#app-modal-form [name="authorization_mode"]'),'set',false);
for(const input of $$('#app-modal-form input[name="authorized_user_ids"]'))check(input,true);
submitModal();await waitModalSaved('assignment list saved');boot=await currentBoot();
for(const id of authIds)assert.deepEqual(sorted(byId(boot,id).authorized_user_ids),sorted(boot.users.map(user=>user.id)));
const authClientId=authIds[0];
await patchClient(authClientId,{authorized_user_ids:[boot.users[0].id]});
for(const username of ['demo2','demo3']){
  const asUser=await sessionFor(username),data=await asUser('/api/bootstrap?period='+period),record=byId(data,authClientId);
  const updated=await asUser(`/api/clients/${authClientId}`,{method:'PATCH',body:{version:record.version,boss_note:'合成分工专项：'+username+'可编辑'}});
  assert.deepEqual(updated.authorized_user_ids,[boot.users[0].id]);
  assert((await asUser(`/api/books/${authClientId}?period=${period}`)).accounts.length>0);
}
await refresh();if(count())clear('clients');for(const id of authIds)check(selectedRow(id));
openMenu('authorize');click($('.cl-toolbar [data-action="customer-authorize"][data-mode="clear"]'),'clear assignment list');
await waitFor(()=>$('#app-modal-form [name="authorization_mode"]'),'clear assignment form');
assert.equal($('#app-modal-form [name="authorization_mode"]').value,'clear');submitModal();await waitModalSaved('assignment list cleared');
boot=await currentBoot();for(const id of authIds)assert.deepEqual(byId(boot,id).authorized_user_ids,[]);
for(const username of ['demo1','demo2','demo3']){
  const asUser=await sessionFor(username),data=await asUser('/api/bootstrap?period='+period),record=byId(data,authClientId);
  const updated=await asUser(`/api/clients/${authClientId}`,{method:'PATCH',body:{version:record.version,boss_note:'合成清空分工专项：'+username+'可编辑'}});
  assert.deepEqual(updated.authorized_user_ids,[]);
}
await refresh();if(count())clear('clients');
scenarios.push('three-user assignment list round-trips, explicit clear persists [] and all three real logins retain edit access with or without assignment');

// Capture the actual CSV Blob generated from the menu, not just the success
// toast. Only the selected customers may appear in its data rows.
const exportIds=visibleIds().slice(0,2);for(const id of exportIds)check(selectedRow(id));
const exportBlobCount=blobs.length;openMenu('export');click($('.cl-toolbar [data-action="export-selected"]'),'export selected menu entry');
await waitFor(()=>blobs.length===exportBlobCount+1,'selected customer CSV blob');
const exportedRows=csvRows(await blobs.at(-1).text());assert.equal(exportedRows.length,3,'Selected export has one header and exactly two customer rows');
const nameIndex=exportedRows[0].indexOf('客户名称');assert(nameIndex>=0);
assert.deepEqual(exportedRows.slice(1).map(row=>row[nameIndex]).sort(),exportIds.map(id=>byId(boot,id).name).sort());
clear('clients');scenarios.push('export dropdown generates a real CSV containing exactly the selected range');

// Column settings hide an optional column while protecting the selection,
// customer name and operation columns. Refresh must preserve that preference.
click($('[data-action="customer-columns"]'),'gear column settings');
await waitFor(()=>$('#app-modal-form input[name="visible_columns"]'),'column preferences');
for(const key of ['select','index','name','actions']){
  const checkbox=$(`#app-modal-form input[name="visible_columns"][value="${key}"]`);assert(checkbox&&checkbox.checked,'Required column checked '+key);assert(checkbox.disabled||checkbox.hasAttribute('disabled'),'Required column cannot be hidden '+key);
}
check($('#app-modal-form input[name="visible_columns"][value="industry"]'),false);submitModal();await waitModalSaved('columns saved');
assert($('th[data-customer-column="industry"]').hidden);assert(!$('th[data-customer-column="actions"]').hidden);assert.equal($$('.cl-row-actions [data-action]').length,rows('clients').length*3);
await refresh();assert($('th[data-customer-column="industry"]').hidden);assert(!$('th[data-customer-column="actions"]').hidden);
click($('[data-action="customer-columns"]'),'restore optional industry column');await waitFor(()=>$('#app-modal-form input[name="visible_columns"]'),'restore columns');check($('#app-modal-form input[name="visible_columns"][value="industry"]'),true);submitModal();await waitModalSaved('column restored');
scenarios.push('gear settings persist optional visibility while keeping mandatory selection/name/operation columns available');

// Use the actual new-customer editor and omit service_status entirely in user
// input; its hidden draft default must persist as unset rather than active.
click($('[data-action="client-new"]'),'new customer editor');await waitFor(()=>$('#client-editor-form'),'new editor');
const createdName='合成新增列表专项'+Date.now(),createdTax='LISTQA'+Date.now();
function editorInput(name,value){inputValue($(`#client-editor-form [name="${name}"]`),value);}
function editorCombo(name,query,value){const control=$(`[data-ce-combo="${name}"]`);control.dispatchEvent(new window.Event('focusin',{bubbles:true}));inputValue(control,query);click($(`[data-ce-option="${name}"][data-value="${value}"]`),'editor choice '+name);}
editorInput('name',createdName);editorInput('enterprise_name',createdName+'完整企业');editorInput('tax_no',createdTax);
editorCombo('industry','其他专业咨询','其他专业咨询');editorCombo('region','北京','北京');editorCombo('accountant_id',boot.users[0].name,String(boot.users[0].id));
submitForm($('#client-editor-form'));await waitFor(()=>!$('#client-editor-form'),'new customer saved');
boot=await currentBoot();const created=boot.clients.find(client=>client.tax_no===createdTax);assert(created,'New customer persisted');
assert.equal(created.service_status,'unset','New editor default service state must be 未设置');assert.equal(created.enabled,1);
assert(/^KH\d{6}$/.test(created.code),'Customer code remains auto-generated without adding a list column');
scenarios.push('actual new customer form saves an automatically coded enabled customer with service status unset');

assert.equal(errors.length,0,errors.map(String).join('\n'));
const report={scenarios,scenarioCount:scenarios.length,requests,allPassed:true,safety:'Only disposable loopback demo200 fixture; refused live ports 8765/8766. No reference website or browser used.',limits:'Linkedom functional checks with real HTTP; screenshot geometry and visual matching are verified separately by root.'};
await writeFile('customer-list-report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report));process.exit(0);
