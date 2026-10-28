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

const frontend=await import(pathToFileURL(root+'/public/app.js').href+'?ticket-integration='+Date.now());
await waitFor(()=>$('.progress-card'),'app startup');
let boot=await frontend.api('/api/bootstrap');assert.equal(boot.clients.length,200);
const period=$('[data-filter="period"]').value;
const created=[];for(let i=0;i<2;i++)created.push(await frontend.api('/api/clients',{method:'POST',body:{name:'票据集成专项'+i,code:'TKT-INTEGRATED-'+i,taxpayer_type:'small',standard:'small2013',start_period:period,accountant_id:boot.users[0].id}}));
await nav('票据','智能取票');click($('.tl-top-right [data-action="refresh"]'));await delay(100);await waitFor(()=>$('.tl-small'),'small screenshot layout');
assert.equal($$('thead th').length,13);assert($('[data-ticket-column="vat_filing_frequency"]'));assert(!$('[data-ticket-column="invoice_count"]'));assert(!$('[data-action="ticket-auth"]'));scenarios.push('small exact13 columns and toolbar route');
const searchForm=$('[data-ticket-search-form]');searchForm.elements.q.value='票据集成专项';searchForm.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>rows('tickets').length===2,'ticket search renders two');
check(header('tickets'));assert.equal(frontend.selectedCompanyIds('tickets').length,2);click($('[data-action="ticket-schedule"]'));await waitFor(()=>$('[data-ticket-confirm-list]'),'schedule confirm');assert.equal($$('[data-confirm-client-id]').length,2);assert.equal($('[data-ticket-confirm-list]').dataset.period,period);$('#app-modal-form').elements.scheduled_at.value=period+'-20T09:30';$('#app-modal-form').elements.note.value='整合路由本地预约';submitModal();await waitFor(()=>$('[data-ticket-batch-results]'),'schedule result');boot=await frontend.api('/api/bootstrap');assert.equal(boot.ticket_tasks.filter(t=>created.some(c=>c.id===t.client_id)).length,2);assert(!boot.invoices.some(t=>created.some(c=>c.id===t.client_id)));scenarios.push('UI multi-select schedule actual persisted local only');await dismiss();
const firstId=created[0].id;click($(`[data-action="ticket-frequency"][data-id="${firstId}"]`));await waitFor(()=>$('#app-modal-form [name="vat_filing_frequency"]'),'frequency dialog');setSelect($('#app-modal-form [name="vat_filing_frequency"]'),'quarter',false);submitModal();await waitFor(()=>$('[data-ticket-batch-results]'),'frequency result');await dismiss();assert.equal($(`tr[data-ticket-client-id="${firstId}"] [data-ticket-cell="vat_filing_frequency"]`).textContent,'季');scenarios.push('UI row frequency updates real rendered field');
click($(`tr[data-ticket-client-id="${firstId}"] [data-action="ticket-row-more"]`));await waitFor(()=>$(`#app-modal-form [data-action="ticket-auth"][data-id="${firstId}"]`),'more auth');click($(`#app-modal-form [data-action="ticket-auth"][data-id="${firstId}"]`));await waitFor(()=>$('#app-modal-form [name="status"]'),'auth dialog');setSelect($('#app-modal-form [name="status"]'),'confirmed',false);submitModal();await waitFor(()=>$('[data-ticket-batch-results]'),'auth result');await dismiss();boot=await frontend.api('/api/bootstrap');assert.equal(boot.ticket_auth_checks.find(t=>t.client_id===firstId).status,'confirmed');assert(!boot.invoices.some(t=>t.client_id===firstId));scenarios.push('UI more action local manual auth with no synthetic invoices');
click($('[data-action="ticket-tasks"]'));await waitFor(()=>$('[data-selection-scope="ticket_tasks"]'),'task manager selection table');assert.equal(rows('ticket_tasks').length,2);check(header('ticket_tasks'));click($('[data-action="selection-remove"][data-scope="ticket_tasks"]'));await waitFor(()=>$('[data-batch-remove-list][data-remove-entity="ticket_tasks"]'),'task batch delete confirmation');assert.equal($$('[data-remove-id]').length,2);submitModal();await waitFor(()=>$('[data-batch-remove-results]'),'task batch delete result');boot=await frontend.api('/api/bootstrap');assert(!boot.ticket_tasks.some(t=>created.some(c=>c.id===t.client_id)));scenarios.push('UI task manager select-all and real batch delete');await dismiss();
click($('[data-action="ticket-taxpayer"][data-value="general"]'));await waitFor(()=>$('.tl-general'),'general tab');assert($('[data-ticket-column="invoice_count"]'));assert($('[data-action="ticket-auth"]'));assert(!$('.tl-amount-warnings'));click($('[data-action="ticket-taxpayer"][data-value="small"]'));await waitFor(()=>$('.tl-small'),'small tab');const clearForm=$('[data-ticket-search-form]');clearForm.elements.q.value='';clearForm.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>rows('tickets').length===30,'small default30');const jump=$('[data-ticket-jump-input]');assert(jump);jump.value='2';change(jump);await waitFor(()=>$('[data-ticket-page-number="2"][aria-current="page"]'),'actual root jump second page');assert.equal($('[data-ticket-cell="index"]').textContent,'31');scenarios.push('general/small switching and page-number jump root delegation');
assert.equal(errors.length,0);const report={passed:scenarios.length,requests,scenarios,liveDataTouched:false};await writeFile(new URL('./ticket-integration-report.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
