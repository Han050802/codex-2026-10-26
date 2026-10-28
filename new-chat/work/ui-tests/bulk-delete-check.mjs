import {parseHTML} from 'linkedom';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const base=process.argv[2];
assert(base,'Run with python run-checks.py bulk-delete-check.mjs');
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
function chooseAll(scope){click($(`[data-action="selection-all"][data-scope="${scope}"]`),'select all '+scope);}
async function nav(name,sub){click($(`[data-nav="${name}"]`),'nav '+name);await waitFor(()=>$(`[data-nav="${name}"].active`),'nav '+name);await delay(35);if(sub){click($(`[data-sub="${sub}"]`),'sub '+sub);await waitFor(()=>$(`[data-sub="${sub}"].active`),'sub '+sub);await delay(40);}assert(!$('.page-error'),name+'/'+sub+' failed');}
async function search(value){const form=$('[data-search-form]');assert(form,'Search form');form.elements.q.value=value;form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await delay(45);}
async function reset(){click($('[data-action="reset-filters"]'),'reset filters');await delay(45);}
async function page(scope,direction){const shell=$(`[data-selection-scope="${scope}"]`);assert(shell,'Table selection shell '+scope);const buttons=$$('[data-action="table-page"]',shell.closest('[data-bookkeeping-list],[data-customer-list]')||shell);const button=direction==='next'?buttons.at(-1):buttons[0];click(button,'page '+direction);await delay(30);}
async function dismiss(){const close=$('#modal-root [data-close]');assert(close,'Modal close');click(close,'modal cancel');await waitFor(()=>!$('#app-modal-form'),'modal closed');}
function submitModal(){const form=$('#app-modal-form');assert(form,'Expected confirmation modal');form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));}
function assertSelectionEmpty(scope){assert.equal(count(scope),0);assert(rows(scope).every(row=>!row.checked));const h=header(scope);if(h){assert(!h.checked);assert(!h.indeterminate);}}

const frontend=await import(pathToFileURL(root+'/public/app.js').href+'?bulk-delete-test='+Date.now());
await waitFor(()=>$('.progress-card'),'app startup');
let boot=await frontend.api('/api/bootstrap');assert.equal(boot.clients.length,200,'Expected only the explicit disposable 200-client fixture');
const period=$('[data-filter="period"]').value,day=period+'-01',stamp=String(Date.now());
const post=(path,body)=>frontend.api(path,{method:'POST',body});
const patch=(path,body)=>frontend.api(path,{method:'PATCH',body});
const newClient=letter=>post('/api/clients',{name:'合成批删验收'+letter,code:'BULK-QA-'+stamp+'-'+letter,start_period:period,standard:'small2013',taxpayer_type:'small',accountant_id:1});
const master=await newClient('主账'),matrixA=await newClient('矩阵A'),matrixB=await newClient('矩阵B'),matrixC=await newClient('矩阵未选');
const invoicePayload=index=>({client_id:master.id,period,kind:'expense',number:'BULK-INV-'+stamp+'-'+index,date:day,amount_fen:10000,tax_fen:0,total_fen:10000,summary:'合成批删票据'+index});
const invoices=[];for(let i=0;i<4;i++)invoices.push(await post('/api/invoices',invoicePayload(i)));
const postedInvoice=await post(`/api/invoices/${invoices[3].id}/post`,{version:invoices[3].version,debit_account:'5602',credit_account:'1002'});
const taxes=[];for(let i=0;i<4;i++)taxes.push(await post('/api/tax-records',{client_id:master.id,period,tax_type:'合成批删税种'+i,status:i===0?'submitted':'pending',payment_status:i===0?'paid':'unpaid',amount_fen:10000,paid_fen:i===0?10000:0,reference:i===0?'SYNTHETIC-LOCAL-ACK':'',note:'仅合成本地登记'}));
const contracts=[];for(let i=0;i<3;i++)contracts.push(await post('/api/contracts',{client_id:master.id,service:'合成批删服务'+i,start_period:period,end_period:period,monthly_fee_fen:10000}));
const receipt=await post('/api/receipts',{contract_id:contracts[0].id,date:day,amount_fen:30000,method:'合成本地登记',note:'不会产生真实收款'});
const contacts=[],projects=[],requestsDraft=[],notes=[],journals=[];
for(let i=0;i<3;i++){
  contacts.push(await post('/api/tax-agents',{client_id:master.id,name:'合成批删联系人'+i,phone:'',role:'合成角色'}));
  projects.push(await post('/api/projects',{client_id:master.id,name:'合成批删项目'+i,due_date:day,steps:[{title:'合成步骤',done:false}]}));
  requestsDraft.push(await post('/api/invoice-requests',{client_id:master.id,buyer_name:'合成购方'+i,content:'仅申请草稿',amount_fen:10000,tax_fen:0}));
  notes.push(await post('/api/notes',{client_id:master.id,text:'合成批删跟进'+i}));
  journals.push(await post(`/api/books/${master.id}/journals`,{date:day,summary:'合成批删流水'+i,bank_account:'1002',counter_account:'5001',direction:'income',amount_fen:10000,cashflow_category:'operating'}));
}
const postedJournal=await post(`/api/books/${master.id}/journals`,{date:day,summary:'合成已制证流水',bank_account:'1002',counter_account:'5001',direction:'income',amount_fen:10000,cashflow_category:'operating'});
await post(`/api/books/${master.id}/journals/${postedJournal.id}/post`,{version:postedJournal.version});
const manual=[];
for(let i=0;i<3;i++)manual.push(await post(`/api/books/${master.id}/vouchers`,{date:day,summary:'合成批删手工凭证'+i,lines:[{account_code:'1002',debit_fen:10000,credit_fen:0,cashflow_category:'financing'},{account_code:'3001',debit_fen:0,credit_fen:10000,cashflow_category:'unclassified'}]}));
await post(`/api/books/${master.id}/vouchers/${manual[1].id}/review`,{version:manual[1].version,reviewed:true});
const matrixVoucher=await post(`/api/books/${matrixA.id}/vouchers`,{date:day,summary:'合成矩阵回收保留凭证',lines:[{account_code:'1002',debit_fen:10000,credit_fen:0,cashflow_category:'financing'},{account_code:'3001',debit_fen:0,credit_fen:10000,cashflow_category:'unclassified'}]});

async function refresh(){const before=traffic.length;click($('[data-action="refresh"]'),'refresh');await waitFor(()=>traffic.slice(before).some(r=>r.path==='/api/bootstrap'),'bootstrap refresh');await delay(45);}
async function inClient(navName,sub){await nav(navName,sub);await refresh();const filter=$('[data-filter="clientId"]');if(filter){setSelect(filter,String(master.id));await delay(55);}await waitFor(()=>!$('.page-error'),'client page rendered');}
function row(scope,id){return $(`input[data-entity-select="${scope}"][value="${id}"]`);}
async function findRow(scope,id){for(let attempt=0;attempt<15;attempt++){const found=row(scope,id);if(found)return found;const shell=$(`[data-selection-scope="${scope}"]`);assert(shell,'Missing selection shell '+scope);const next=$$('[data-action="table-page"]',shell.closest('[data-bookkeeping-list],[data-customer-list]')||shell).at(-1);assert(next&&!next.disabled&&!next.hasAttribute('disabled'),'Record not visible '+scope+'/'+id);click(next,'next '+scope+' page');await delay(25);}throw new Error('Too many pages for '+scope);}
async function selectIds(scope,ids){const clearButton=$(`[data-action="selection-clear"][data-scope="${scope}"]`);if(clearButton&&!clearButton.disabled&&!clearButton.hasAttribute('disabled'))click(clearButton,'clear old '+scope);for(const id of ids)check(await findRow(scope,id));assert.equal(count(scope),ids.length);}
async function closeResult(){if($('#app-modal-form'))await dismiss();}
async function remove(scope,ids,operation='delete',{expected={},beforeSubmit,cancelFirst=false}={}){
  await selectIds(scope,ids);
  const start=traffic.length;
  const open=()=>click($(`[data-action="selection-remove"][data-scope="${scope}"][data-operation="${operation}"]`),'remove '+scope);
  const confirm=async()=>{await waitFor(()=>$('[data-batch-remove-list]'),'confirmation '+scope);assert.deepEqual($$('[data-batch-remove-list] [data-remove-id]').map(el=>Number(el.dataset.removeId)).sort((a,b)=>a-b),[...ids].map(Number).sort((a,b)=>a-b));};
  open();await confirm();
  assert.equal(traffic.slice(start).filter(r=>r.method!=='GET').length,0,'Opening confirmation caused mutation');
  if(cancelFirst){await dismiss();assert.equal(traffic.slice(start).filter(r=>r.method!=='GET').length,0,'Cancelling caused mutation');open();await confirm();}
  if(beforeSubmit)await beforeSubmit();
  if(operation==='reverse'){$('#app-modal-form').elements.reverse_date.value=day;$('#app-modal-form').elements.reverse_note.value='合成批量冲销验收';}
  submitModal();await waitFor(()=>$('[data-batch-remove-results]'),'results '+scope);
  const results=$$('[data-delete-result-id]');assert.equal(results.length,ids.length,'Wrong result count '+scope);
  for(const id of ids){const result=results.find(el=>Number(el.dataset.deleteResultId)===Number(id));assert(result,'Missing result '+scope+'/'+id);assert.equal(result.dataset.resultOk,String(expected[id]??true),'Wrong outcome '+scope+'/'+id+': '+result.textContent);}
  const mutations=traffic.slice(start).filter(r=>r.method!=='GET');
  await closeResult();return mutations;
}
function exists(data,key,id){return data[key].some(item=>Number(item.id)===Number(id));}

await inClient('票据','票据录入');
let mutations=await remove('invoices',invoices.slice(0,2).map(i=>i.id),'delete',{cancelFirst:true});
assert.deepEqual(mutations.filter(r=>r.method==='DELETE').map(r=>Number(r.path.split('/').at(-1))).sort((a,b)=>a-b),invoices.slice(0,2).map(i=>i.id).sort((a,b)=>a-b));
boot=await frontend.api('/api/bootstrap');for(const item of invoices.slice(0,2))assert(!exists(boot,'invoices',item.id));assert(exists(boot,'invoices',invoices[2].id));assert(exists(boot,'invoices',invoices[3].id));
scenarios.push('invoice checkbox deletes exactly two of three unposted records; confirmation cancel makes no request');
mutations=await remove('invoices',[invoices[3].id],'delete',{expected:{[invoices[3].id]:false}});assert(mutations.length===0||mutations.some(r=>r.method==='DELETE'&&r.status===409),'Posted invoice must be refused before sending or by the real API');
assert.equal((await frontend.api(`/api/books/${master.id}?period=${period}`)).vouchers.find(v=>v.id===postedInvoice.voucher_id).status,'active');
scenarios.push('posted invoice is blocked and its real ledger voucher stays active');

await inClient('报税','报税记录');await remove('tax_records',taxes.slice(0,2).map(i=>i.id));
boot=await frontend.api('/api/bootstrap');assert(!exists(boot,'tax_records',taxes[0].id));assert(!exists(boot,'tax_records',taxes[1].id));assert(exists(boot,'tax_records',taxes[2].id));
scenarios.push('two selected local tax registrations disappear while unselected record remains');
await remove('tax_records',[taxes[2].id,taxes[3].id],'delete',{expected:{[taxes[2].id]:false,[taxes[3].id]:true},beforeSubmit:()=>patch(`/api/tax-records/${taxes[2].id}`,{version:taxes[2].version,note:'合成并发更新，旧版本须失败'})});
boot=await frontend.api('/api/bootstrap');assert(exists(boot,'tax_records',taxes[2].id));assert(!exists(boot,'tax_records',taxes[3].id));
scenarios.push('stale tax version fails individually without preventing the other selected deletion');

await inClient('收费','服务合同');await remove('contracts',[contracts[0].id,contracts[1].id],'delete',{expected:{[contracts[0].id]:false,[contracts[1].id]:true}});
boot=await frontend.api('/api/bootstrap');assert(exists(boot,'contracts',contracts[0].id));assert(!exists(boot,'contracts',contracts[1].id));assert(exists(boot,'contracts',contracts[2].id));
scenarios.push('contract with receipt history is protected while selected empty contract deletes');
await inClient('收费','收款记录');await remove('receipts',[receipt.id],'reverse');
boot=await frontend.api('/api/bootstrap');const fee=boot.contracts.find(c=>c.id===contracts[0].id);assert.equal(fee.received_fen,0);assert.equal(fee.debt_fen,10000);assert.equal(fee.prepaid_fen,0);assert(boot.receipts.some(r=>r.reversal_of===receipt.id&&r.amount_fen===-30000));
const originalReceipt=row('receipts',receipt.id);assert(originalReceipt?.disabled||originalReceipt?.hasAttribute('disabled'),'Reversed receipt must be unselectable');
scenarios.push('receipt batch reversal creates an explicit negative record and recalculates actual debt');

for(const [navName,sub,scope,items,operation] of [
  ['客户','办税人管理','tax_agents',contacts,'delete'],
  ['工商项目','项目管理','projects',projects,'delete'],
  ['票据','发票开具','invoice_requests',requestsDraft,'cancel'],
]){
  await inClient(navName,sub);await remove(scope,items.slice(0,2).map(i=>i.id),operation);boot=await frontend.api('/api/bootstrap');
  if(operation==='cancel'){assert(items.slice(0,2).every(i=>boot.invoice_requests.find(r=>r.id===i.id)?.status==='cancelled'));assert.equal(boot.invoice_requests.find(r=>r.id===items[2].id).status,'draft');}
  else{assert(items.slice(0,2).every(i=>!exists(boot,scope,i.id)));assert(exists(boot,scope,items[2].id));}
  scenarios.push(scope+': selected two records process; third record remains untouched');
}

await nav('首页','工作进展');await refresh();await search(master.code);click($(`[data-action="notes"][data-id="${master.id}"]`),'open follow-up list');await waitFor(()=>row('notes',notes[0].id),'follow-up selectable modal');
await remove('notes',notes.slice(0,2).map(i=>i.id));boot=await frontend.api('/api/bootstrap');assert(notes.slice(0,2).every(i=>!exists(boot,'notes',i.id)));assert(exists(boot,'notes',notes[2].id));
scenarios.push('follow-up modal batch removes only selected notes and preserves unselected history');

await inClient('票据','智能流水');await remove('journals',journals.slice(0,2).map(i=>i.id));
let book=await frontend.api(`/api/books/${master.id}?period=${period}`);assert(journals.slice(0,2).every(i=>!book.journals.some(j=>j.id===i.id)));assert(book.journals.some(j=>j.id===journals[2].id));
await remove('journals',[postedJournal.id],'delete',{expected:{[postedJournal.id]:false}});
scenarios.push('bank journal batch deletes selected unposted rows and blocks posted journal');

await nav('记账','年度记账');await refresh();await remove('matrix',[matrixA.id,matrixB.id],'recycle');
boot=await frontend.api('/api/bootstrap');assert(boot.clients.find(c=>c.id===matrixA.id).deleted);assert(boot.clients.find(c=>c.id===matrixB.id).deleted);assert(!boot.clients.find(c=>c.id===matrixC.id).deleted);assert(boot.book_periods.some(p=>p.client_id===matrixA.id&&p.period===period&&p.voucher_count===1));
await nav('客户','回收站');await remove('clients',[matrixA.id,matrixB.id],'restore');book=await frontend.api(`/api/books/${matrixA.id}?period=${period}`);assert(book.vouchers.some(v=>v.id===matrixVoucher.id&&v.status==='active'));
scenarios.push('annual matrix recycles selected companies while keeping their ledger, then batch restore makes the same voucher available');
boot=await frontend.api('/api/bootstrap');for(const c of [matrixA,matrixB])await frontend.api(`/api/clients/${c.id}`,{method:'DELETE',body:{version:boot.clients.find(x=>x.id===c.id).version}});
await refresh();await remove('clients',[matrixA.id,matrixB.id],'purge',{expected:{[matrixA.id]:false,[matrixB.id]:true}});
boot=await frontend.api('/api/bootstrap');assert(boot.clients.some(c=>c.id===matrixA.id&&c.deleted));assert(!boot.clients.some(c=>c.id===matrixB.id));assert(boot.clients.some(c=>c.id===matrixC.id&&!c.deleted));
scenarios.push('recycle-bin purge removes an untouched empty book and refuses a book with real voucher history');

await nav('客户','全部客户');await refresh();await search(master.code);click($(`[data-action="open-book"][data-id="${master.id}"]`),'open main book');await waitFor(()=>$('[data-book-maintenance-scope="vouchers"]'),'voucher batch controls');
const voucherIds=[postedInvoice.voucher_id,manual[0].id,manual[1].id];
for(const id of voucherIds)check($(`[data-book-maintenance-scope="vouchers"] [data-book-maintenance-row][value="${id}"]`));
// Each checkbox change repaints the table; query the current wrapper again.
click($('[data-book-maintenance-scope="vouchers"] [data-book-maintenance="delete"]'),'batch void/withdraw vouchers');await waitFor(()=>$('[data-book-delete-scope="vouchers"]'),'voucher confirmation');
assert.deepEqual($$('[data-book-confirm-record]').map(el=>Number(el.dataset.bookConfirmRecord)).sort((a,b)=>a-b),[...voucherIds].sort((a,b)=>a-b));
assert.equal(Number($('[data-book-delete-client]').dataset.bookDeleteClient),master.id);assert.equal($('[data-book-delete-period]').dataset.bookDeletePeriod,period);
$('#app-modal-form').elements.reason.value='合成凭证批量作废与来源撤回验收';submitModal();await waitFor(()=>$$('[data-book-result-record]').length===3,'voucher processing results');
for(const id of [postedInvoice.voucher_id,manual[0].id])assert.equal($(`[data-book-result-record="${id}"]`).dataset.bookResultStatus,'success');
assert.equal($(`[data-book-result-record="${manual[1].id}"]`).dataset.bookResultStatus,'failed');
book=await frontend.api(`/api/books/${master.id}?period=${period}`);assert.equal(book.vouchers.find(v=>v.id===postedInvoice.voucher_id).status,'void');assert.equal(book.vouchers.find(v=>v.id===manual[0].id).status,'void');assert.equal(book.vouchers.find(v=>v.id===manual[1].id).status,'active');assert.equal(book.vouchers.find(v=>v.id===manual[2].id).status,'active');assert(book.reports.balance_sheet.balanced);
boot=await frontend.api('/api/bootstrap');const reverted=boot.invoices.find(i=>i.id===postedInvoice.id);assert.equal(reverted.status,'unprocessed');assert.equal(reverted.voucher_id,null);
scenarios.push('book voucher batch voids manual/source vouchers, restores invoice source state, blocks reviewed voucher and leaves unselected voucher active');

assert.equal(errors.length,0,'Unhandled UI workflow errors');
await writeFile('bulk-delete-report.json',JSON.stringify({scenarios,requests,allPassed:true,fixture:'Disposable explicit-seed HTTP database only; no running application data',note:'linkedom DOM plus real HTTP and SQLite domain checks; no browser visual QA.'},null,2));
console.log(JSON.stringify({scenarios,requests,allPassed:true}));process.exit(0);

