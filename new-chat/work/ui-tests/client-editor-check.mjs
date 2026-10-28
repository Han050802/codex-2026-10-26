import {parseHTML} from 'linkedom';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const base=process.argv[2];
assert(base,'Run with python run-checks.py client-editor-check.mjs');
const address=new URL(base);assert.equal(address.hostname,'127.0.0.1');assert(!['8765','8766'].includes(address.port),'Refusing live application ports');
const root='C:/Users/Admin/Documents/Codex/2026-10-26/new-chat/outputs/yidaizhang-local';
const originalFetch=globalThis.fetch;
let cookie='',requests=0,errors=[];
process.on('unhandledRejection',e=>errors.push(e));
globalThis.fetch=async(path,opts={})=>{const headers={Origin:base,Connection:'close',...opts.headers};if(cookie)headers.Cookie=cookie;const res=await originalFetch(new URL(path,base),{...opts,headers});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];requests++;return res;};
const login=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'demo1',password:'DemoOnly123!'})});
assert.equal(login.status,200,await login.text());
const health=await (await fetch('/api/health')).json();assert(health.demo,'Only the disposable synthetic demo fixture is allowed');
const {window}=parseHTML(await readFile(root+'/public/index.html','utf8'));
globalThis.window=window;globalThis.document=window.document;globalThis.CustomEvent=window.CustomEvent;
window.location={href:base+'/',assign:path=>{window.lastDownload=String(path);}};
window.history={replaceState(){}};window.print=()=>{};window.HTMLElement.prototype.reportValidity=()=>true;
Object.defineProperty(window.HTMLElement.prototype,'checked',{configurable:true,get(){return this.hasAttribute('checked');},set(v){this.toggleAttribute('checked',Boolean(v));}});
Object.defineProperty(window.HTMLElement.prototype,'elements',{configurable:true,get(){const nodes=[...this.querySelectorAll('input,select,textarea,button')];return new Proxy(nodes,{get(target,key){if(key in target)return target[key];return nodes.find(el=>el.getAttribute('name')===key);}});}});
class DOMFormData{constructor(form){this.list=[];for(const el of form?.querySelectorAll('input,select,textarea')||[]){const name=el.getAttribute('name');if(!name||el.disabled)continue;const type=el.getAttribute('type');if((type==='checkbox'||type==='radio')&&!el.checked)continue;if(type==='file')continue;const value=el.tagName==='SELECT'?(el.querySelector('option[selected]')||el.querySelector('option'))?.getAttribute('value')??el.textContent:el.value;this.list.push([name,String(value??'')]);}}entries(){return this.list[Symbol.iterator]();}}
globalThis.FormData=DOMFormData;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn,label){for(let i=0;i<150;i++){if(errors.length)throw errors.shift();if(fn())return;await delay(20);}throw new Error('Timed out: '+label+'\n'+document.querySelector('#app').textContent.slice(0,300));}
function click(el,label='button'){assert(el,label);el.dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));}
function input(name,value){const el=document.querySelector(`#client-editor-form [name="${name}"]`);assert(el,'input '+name);el.value=String(value);el.dispatchEvent(new window.Event('input',{bubbles:true}));return el;}
function radio(name,value){for(const el of document.querySelectorAll(`input[name="${name}"]`))el.checked=el.value===value;const selected=document.querySelector(`input[name="${name}"][value="${value}"]`);selected.dispatchEvent(new window.Event('change',{bubbles:true}));}
function combo(name,query,value){const el=document.querySelector(`[data-ce-combo="${name}"]`);assert(el,'combo '+name);el.dispatchEvent(new window.Event('focusin',{bubbles:true}));el.value=query;el.dispatchEvent(new window.Event('input',{bubbles:true}));const option=document.querySelector(`[data-ce-option="${name}"][data-value="${value}"]`);click(option,name+' option '+value);}
function submit(){document.querySelector('#client-editor-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));}
async function setEnabled(id,enabled){
  click(document.querySelector(`[data-action="client-enable-settings"][data-id="${id}"]`),'customer enabled settings');
  await waitFor(()=>document.querySelector('#app-modal-form [name="enabled"]'),'enabled form');
  const control=document.querySelector('#app-modal-form [name="enabled"]');
  for(const option of control.querySelectorAll('option'))option.toggleAttribute('selected',option.getAttribute('value')===(enabled?'1':'0'));
  document.querySelector('#app-modal-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  await waitFor(()=>!document.querySelector('#app-modal-form')&&document.querySelector(`[data-action="client-enable-settings"][data-id="${id}"]`)?.textContent===(enabled?'已启用':'已禁用'),'enabled state persisted');
}
function finished(){const form=document.querySelector('#client-editor-form');return !form||(!form.querySelector('[type=submit]').disabled&&!document.querySelector('.ce-error-summary')?.hidden&&document.querySelector('.ce-error-summary')?.textContent);}
const scenarios=[];
const frontend=await import(pathToFileURL(root+'/public/app.js').href+'?profile-test='+Date.now());
await waitFor(()=>document.querySelector('.progress-card'),'app startup');
assert.equal((await frontend.api('/api/bootstrap')).clients.filter(client=>/^DEMO\d{4}$/.test(client.code)&&/^演示企业\d{3}有限公司$/.test(client.name)).length,200,'Disposable fixture must retain all 200 explicitly seeded synthetic customers');
click(document.querySelector('[data-nav="客户"]'));
await waitFor(()=>document.querySelector('[data-action="client-new"]'),'client page');
await delay(30);
click(document.querySelector('[data-action="client-new"]'));
await waitFor(()=>document.querySelector('#client-editor-form'),'full client editor');
assert.equal(document.querySelectorAll('[data-ce-tab]').length,3);
assert.equal(document.querySelectorAll('.ce-section-title').length,3);
assert(!document.querySelector('#app-modal-form'));
submit();await waitFor(()=>document.querySelector('.ce-error-summary')?.textContent,'required validation');
assert(document.querySelector('#client-editor-form'));
scenarios.push('full panel and required validation');

const stamp=String(Date.now()),tax='UITEST'+stamp;
input('name','合成面板验收客户');input('enterprise_name','合成面板验收完整企业');input('tax_no',tax);
const enterpriseInput=document.querySelector('[data-ce-combo="enterprise_form"]');enterpriseInput.value='合伙';enterpriseInput.dispatchEvent(new window.Event('input',{bubbles:true}));
const composingEnter=new window.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperties(composingEnter,{key:{value:'Enter'},isComposing:{value:true}});enterpriseInput.dispatchEvent(composingEnter);assert(!composingEnter.defaultPrevented);assert.equal(document.querySelector('[data-ce-value="enterprise_form"]').value,'公司');
const chooseEnter=new window.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(chooseEnter,'key',{value:'Enter'});enterpriseInput.dispatchEvent(chooseEnter);assert(chooseEnter.defaultPrevented);assert.equal(document.querySelector('[data-ce-value="enterprise_form"]').value,'合伙企业');
combo('region','北京','北京');combo('industry','合成定制行业','合成定制行业');combo('accountant_id','演示操作员1','1');combo('standard','2007','enterprise2007');radio('taxpayer_type','general');
input('established_date','1999-12-31');input('mnemonic','UIPANEL'+stamp);input('contact_name','合成联系人');
input('registered_address','合成注册地址');assert.equal(document.querySelector('[data-ce-counter="registered_address"]').textContent,'6 / 100');
input('business_scope','合成业务范围');
input('annual_report_password','Synthetic-UI-New-Secret!');
click(document.querySelector('[data-ce-tab="finance"]'));click(document.querySelector('[data-ce-tab="basic"]'));
assert.equal(document.querySelector('[name="contact_name"]').value,'合成联系人');
click(document.querySelector('[data-ce-action="close"]'));await waitFor(()=>document.querySelector('[data-ce-leave="keep"]'),'discard guard');click(document.querySelector('[data-ce-leave="keep"]'));await delay(20);
assert.equal(document.querySelector('[name="tax_no"]').value,tax);
scenarios.push('searchable choices, counters, tab draft, cancel guard');

// Local import updates the draft and must preserve an unsaved password.
const imported={name:'合成面板验收客户',contact_name:'文件填入联系人',labels:['本地更新','联调']};
const fileInput=document.querySelector('#ce-import-file');const fileText=JSON.stringify(imported);
Object.defineProperty(fileInput,'files',{configurable:true,value:[{name:'synthetic.json',size:fileText.length,text:async()=>fileText}]});
fileInput.dispatchEvent(new window.Event('change',{bubbles:true}));
await waitFor(()=>document.querySelector('[name="contact_name"]')?.value==='文件填入联系人','local draft import');
assert.equal(document.querySelector('[name="annual_report_password"]').value,'Synthetic-UI-New-Secret!');
scenarios.push('local file import preserves unsaved private input');
submit();await waitFor(finished,'create result');
assert(!document.querySelector('#client-editor-form'),[...document.querySelectorAll('.ce-field-error')].map(el=>el.textContent).filter(Boolean).join('; ')||document.querySelector('.ce-error-summary')?.textContent);
let boot=await frontend.api('/api/bootstrap');let customer=boot.clients.find(c=>c.tax_no===tax);assert(customer);assert(customer.has_annual_report_password);assert.equal(customer.standard,'enterprise2007');assert.equal(customer.taxpayer_type,'general');assert.equal(customer.established_date,'1999-12-31');assert.deepEqual(customer.labels,['本地更新','联调']);
assert((await frontend.api(`/api/books/${customer.id}?period=${customer.start_period}`)).accounts.length>0);
scenarios.push('full profile creates persistent independent book');

async function search(text){const form=document.querySelector('[data-search-form]');assert(form,'list search');form.elements.q.value=text;form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await delay(50);}
await search(tax);click(document.querySelector(`[data-action="client-edit"][data-id="${customer.id}"]`),'edit saved client');
await waitFor(()=>document.querySelector('#client-editor-form'),'reopen saved');
assert.equal(document.querySelector('[name="enterprise_name"]').value,'合成面板验收完整企业');
assert.equal(document.querySelector('[name="annual_report_password"]').value,'');
assert(document.querySelector('[data-ce-combo="standard"]').disabled);
assert(document.querySelector('[name="start_period"]').hasAttribute('readonly'));
input('contact_phone','bad-phone');submit();await waitFor(()=>!document.querySelector('.ce-error-summary')?.hidden,'server validation');
assert.equal(document.querySelector('[name="contact_phone"]').value,'bad-phone');
input('contact_phone','13800000000');submit();await waitFor(()=>!document.querySelector('#client-editor-form'),'corrected save');
boot=await frontend.api('/api/bootstrap');customer=boot.clients.find(c=>c.id===customer.id);assert(customer.has_annual_report_password);assert.equal(customer.contact_phone,'13800000000');
scenarios.push('reopen, locked bookkeeping settings, rejected save retains draft');

await search(customer.mnemonic);click(document.querySelector(`[data-action="client-edit"][data-id="${customer.id}"]`),'mnemonic search and edit');await waitFor(()=>document.querySelector('#client-editor-form'),'edit to clear');click(document.querySelector('[data-ce-clear-sensitive="annual_report_password"]'));submit();await waitFor(()=>!document.querySelector('#client-editor-form'),'explicit clear');
assert.equal((await frontend.api('/api/bootstrap')).clients.find(c=>c.id===customer.id).has_annual_report_password,false);
scenarios.push('tax ID and mnemonic search, explicit private clear');

await setEnabled(customer.id,false);assert.equal((await frontend.api('/api/bootstrap')).clients.find(c=>c.id===customer.id).enabled,0);
await setEnabled(customer.id,true);assert.equal((await frontend.api('/api/bootstrap')).clients.find(c=>c.id===customer.id).enabled,1);
scenarios.push('existing customer can be disabled and reenabled');

// Existing clients lack the new tax number/region fields; contact edits must work.
await search('DEMO0001');const legacyEdit=document.querySelector('[data-action="client-edit"]');assert(legacyEdit);const legacyId=Number(legacyEdit.dataset.id);click(legacyEdit);await waitFor(()=>document.querySelector('#client-editor-form'),'legacy editor');input('contact_name','旧客户补充联系人');submit();await waitFor(()=>!document.querySelector('#client-editor-form')||!document.querySelector('.ce-error-summary')?.hidden,'legacy save');assert(!document.querySelector('#client-editor-form'),document.querySelector('.ce-error-summary')?.textContent);assert.equal((await frontend.api('/api/bootstrap')).clients.find(c=>c.id===legacyId).contact_name,'旧客户补充联系人');
scenarios.push('legacy client accepts partial profile completion');

click(document.querySelector('[data-action="client-new"]'));await waitFor(()=>document.querySelector('#client-editor-form'),'second new editor');input('name','丢弃用合成草稿');click(document.querySelector('[data-nav="首页"]'));await waitFor(()=>document.querySelector('[data-ce-leave="keep"]'),'navigation draft guard');click(document.querySelector('[data-ce-leave="keep"]'));await delay(30);assert(document.querySelector('#client-editor-form'));click(document.querySelector('[data-nav="首页"]'));await waitFor(()=>document.querySelector('[data-ce-leave="discard"]'),'navigation discard');click(document.querySelector('[data-ce-leave="discard"]'));await waitFor(()=>!document.querySelector('#client-editor-form')&&document.querySelector('.progress-card'),'return home');
scenarios.push('navigation guard keeps or discards explicitly');
const {createClientEditor}=await import(pathToFileURL(root+'/public/client-editor.js').href);
const host=document.createElement('div');document.body.append(host);const notices=[];let isolated;
isolated=createClientEditor({client:customer,users:boot.users,period:customer.start_period,api:async()=>customer,toast:message=>notices.push(message),onSaved:async()=>{isolated.destroy();throw new Error('合成刷新失败');}});
host.innerHTML=isolated.render();isolated.bind(host);host.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
await waitFor(()=>notices.some(message=>message.includes('已保存')&&message.includes('刷新失败')),'saved but refresh failure notification');host.remove();
scenarios.push('saved data is distinguished from later refresh failure');
assert.equal(errors.length,0,errors.map(String).join('\n'));
await writeFile('client-editor-report.json',JSON.stringify({scenarios,requests,allPassed:true,note:'Static DOM with real HTTP; no browser visual QA.'},null,2));
console.log(JSON.stringify({scenarios,requests,allPassed:true}));
process.exit(0);
