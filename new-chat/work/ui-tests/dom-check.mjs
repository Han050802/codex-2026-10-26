import {parseHTML} from 'linkedom';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const base=process.argv[2]||process.env.YDZ_TEST_URL||'http://127.0.0.1:8766';
const root='C:/Users/Admin/Documents/Codex/2026-10-26/new-chat/outputs/yidaizhang-local';
const originalFetch=globalThis.fetch;
let cookie='',requests=0,errors=[];
process.on('unhandledRejection',e=>errors.push(e));
globalThis.fetch=async(path,opts={})=>{const headers={Origin:base,Connection:'close',...opts.headers};if(cookie)headers.Cookie=cookie;const res=await originalFetch(new URL(path,base),{...opts,headers});const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];requests++;return res;};
const login=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'demo1',password:'DemoOnly123!'})});
assert.equal(login.status,200,await login.text());
const {window}=parseHTML(await readFile(root+'/public/index.html','utf8'));
globalThis.window=window;globalThis.document=window.document;
window.location={href:base+'/',assign:path=>{window.lastDownload=String(path);}};
window.history={replaceState(){}};window.print=()=>{};window.HTMLElement.prototype.reportValidity=()=>true;
Object.defineProperty(window.HTMLElement.prototype,'elements',{configurable:true,get(){const nodes=[...this.querySelectorAll('input,select,textarea,button')];return new Proxy(nodes,{get(target,key){if(key in target)return target[key];return nodes.find(el=>el.getAttribute('name')===key);}});}});
class DOMFormData{
  constructor(form){this.list=[];for(const el of form?.querySelectorAll('input,select,textarea')||[]){const name=el.getAttribute('name');if(!name||el.disabled)continue;const type=el.getAttribute('type');if((type==='checkbox'||type==='radio')&&!el.checked&&!el.hasAttribute('checked'))continue;if(type==='file')continue;const value=el.tagName==='SELECT'?(el.querySelector('option[selected]')||el.querySelector('option'))?.getAttribute('value')??el.textContent:el.value;this.list.push([name,String(value??'')]);}}
  entries(){return this.list[Symbol.iterator]();}
}
globalThis.FormData=DOMFormData;globalThis.CustomEvent=window.CustomEvent;
function delay(ms){return new Promise(r=>setTimeout(r,ms));}
async function waitFor(fn,label){for(let i=0;i<100;i++){if(errors.length)throw errors.shift();if(fn())return;await delay(25);}throw new Error('Timed out: '+label+'\n'+document.querySelector('#app').textContent.slice(0,500));}
function click(el,label){assert(el,label);el.dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));}
function checkPage(label){assert(!document.querySelector('.page-error'),label+': '+document.querySelector('.page-error')?.textContent);const text=document.querySelector('.workspace')?.textContent||'';assert(text.length>15,label+' blank');assert(!/\bundefined\b|\bNaN\b/.test(text),label+' invalid data');}
const frontend=await import(pathToFileURL(root+'/public/app.js').href+'?test='+Date.now());
await waitFor(()=>document.querySelector('.progress-card'),'app startup');
assert.equal(document.querySelectorAll('.topnav [data-nav]').length,12);
assert.equal(document.querySelectorAll('.progress-card').length,5);
const visited=[];
for(const nav of [...document.querySelectorAll('[data-nav]')].map(e=>e.dataset.nav)){
  click(document.querySelector(`[data-nav="${nav}"]`),nav);await waitFor(()=>document.querySelector(`[data-nav="${nav}"].active`),'nav '+nav);await delay(50);
  for(const sub of [...document.querySelectorAll('[data-sub]')].map(e=>e.dataset.sub)){
    click(document.querySelector(`[data-sub="${sub}"]`),sub);await waitFor(()=>document.querySelector(`[data-sub="${sub}"].active`),'sub '+sub);await delay(75);checkPage(nav+'/'+sub);visited.push(nav+'/'+sub);
  }
}
// Exercise the separately authored financial workspace and every financial tab.
click(document.querySelector('[data-nav="客户"]'),'customer nav');await delay(75);
click(document.querySelector('[data-action="open-book"]'),'open company book');
await waitFor(()=>document.querySelector('[data-book-view]'),'finance workspace');
for(const view of [...document.querySelectorAll('[data-book-view]')].map(e=>e.dataset.bookView)){
  click(document.querySelector(`[data-book-view="${view}"]`),view);await delay(25);checkPage('book/'+view);visited.push('book/'+view);
}
// Opening a voucher tests root/agent modal integration and line insertion.
click(document.querySelector('[data-book-view="vouchers"]'),'voucher tab');
click(document.querySelector('[data-book-action="new-voucher"]'),'new voucher');
await waitFor(()=>document.querySelector('#voucher-lines'),'voucher modal');
assert.equal(document.querySelectorAll('.voucher-line').length,2);
click(document.querySelector('#voucher-add-line'),'add voucher line');
assert.equal(document.querySelectorAll('.voucher-line').length,3);
click(document.querySelector('[data-close]'),'close voucher');
await waitFor(()=>!document.querySelector('#app-modal-form'),'modal close');
assert.equal(errors.length,0,errors.map(String).join('\n'));
const workflows=[];
if(process.argv.includes('--workflows')){
  async function nav(name,sub){click(document.querySelector(`[data-nav="${name}"]`),name);await delay(60);if(sub){click(document.querySelector(`[data-sub="${sub}"]`),sub);await delay(60);}}
  function setValue(el,value){assert(el,'missing field');if(el.tagName==='SELECT'){for(const o of el.querySelectorAll('option')){if(o.getAttribute('value')===String(value))o.setAttribute('selected','');else o.removeAttribute('selected');}}else if(el.type==='checkbox'){el.checked=!!value;if(value)el.setAttribute('checked','');else el.removeAttribute('checked');}else el.value=String(value);}
  async function fillAndSubmit(values,label){await waitFor(()=>document.querySelector('#app-modal-form'),label+' modal');const form=document.querySelector('#app-modal-form');for(const [k,v] of Object.entries(values))setValue(form.elements[k],v);form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>!document.querySelector('#app-modal-form')||document.querySelector('.modal-error')?.textContent,label+' result');assert(!document.querySelector('.modal-error')?.textContent,label+': '+document.querySelector('.modal-error')?.textContent);workflows.push(label);}
  await nav('客户','全部客户');click(document.querySelector('[data-action="client-new"]'),'new client');
  const stamp=String(Date.now());
  await waitFor(()=>document.querySelector('#client-editor-form'),'full customer editor');
  const customerForm=document.querySelector('#client-editor-form');
  for(const [name,value] of Object.entries({name:'合成联调验收企业',enterprise_name:'合成联调验收完整企业',tax_no:'QA'+stamp,industry:'商务服务业',region:'北京',standard:'enterprise2007',accountant_id:'1'})){
    const control=customerForm.querySelector(`[data-ce-value="${name}"],[data-ce-input="${name}"]`);setValue(control,value);control.dispatchEvent(new window.Event(control.hasAttribute('data-ce-value')?'change':'input',{bubbles:true}));
  }
  for(const radio of customerForm.querySelectorAll('[name="taxpayer_type"]')){radio.checked=radio.value==='general';radio.toggleAttribute('checked',radio.checked);}
  customerForm.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  await waitFor(()=>!document.querySelector('#client-editor-form'),'customer creation');workflows.push('customer creation');
  let data=await frontend.api('/api/bootstrap');const customer=data.clients.find(c=>c.tax_no==='QA'+stamp);assert(customer?.enabled);
  await nav('票据','票据录入');click(document.querySelector('[data-action="invoice-new"]'),'new invoice');
  await fillAndSubmit({client_id:customer.id,kind:'output',number:'QA-INV-'+stamp,amount:'100.00',tax:'13.00',summary:'界面联调销售'},'invoice entry');
  await nav('票据','智能凭证');const filter=document.querySelector('[data-filter="clientId"]');setValue(filter,customer.id);filter.dispatchEvent(new window.Event('change',{bubbles:true}));await delay(100);
  click(document.querySelector('[data-action="invoice-post"]'),'invoice post');await fillAndSubmit({debit_account:'1122',credit_account:'6001',tax_account:'2221'},'invoice to voucher');
  await nav('收费','服务合同');click(document.querySelector('[data-action="contract-new"]'),'contract new');
  await fillAndSubmit({client_id:customer.id,service:'界面验收服务',monthly_fee:'300.00'},'contract creation');
  data=await frontend.api('/api/bootstrap');const contract=data.contracts.find(c=>c.client_id===customer.id);assert(contract);
  click(document.querySelector('[data-action="receipt-new"]'),'receipt new');await fillAndSubmit({contract_id:contract.id,amount:'100.00'},'receipt registration');
  data=await frontend.api('/api/bootstrap');assert.equal(data.contracts.find(c=>c.id===contract.id).received_fen,10000);
  await nav('客户','办税人管理');click(document.querySelector('[data-action="agent-new"]'),'contact new');await fillAndSubmit({name:'合成办税联系人',phone:'',client_id:customer.id},'tax contact');
  await nav('票据','发票开具');click(document.querySelector('[data-action="request-new"]'),'invoice request new');await fillAndSubmit({client_id:customer.id,buyer_name:'合成购买方',content:'服务费',amount:'100.00',tax:'13.00'},'local invoice request');
  await nav('客户','全部客户');
  // Enter the test client through the visible search form.
  const search=document.querySelector('[data-search-form]');setValue(search.elements.q,customer.code);search.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await delay(100);
  click(document.querySelector('[data-action="open-book"]'),'test client book');await waitFor(()=>document.querySelector('[data-book-view]'),'test book');
  click(document.querySelector('[data-book-view="assets"]'),'asset tab');click(document.querySelector('[data-book-action="new-asset"]'),'asset modal');await fillAndSubmit({name:'合成办公设备',cost:'1200.00',residual:'0.00',life_months:'12'},'fixed asset purchase');
  click(document.querySelector('[data-book-view="inventory"]'),'inventory tab');click(document.querySelector('[data-book-action="new-item"]'),'item modal');await fillAndSubmit({sku:'QA-SKU',name:'合成库存商品',unit:'件'},'inventory item');
  click(document.querySelector('[data-book-action="inventory-move"]'),'stock in');await fillAndSubmit({quantity:'2',amount:'20.00'},'inventory receipt');
  click(document.querySelector('[data-book-view="payroll"]'),'payroll tab');click(document.querySelector('[data-book-action="new-payroll"]'),'salary entry');await fillAndSubmit({employee_name:'合成职员',gross:'1000.00',withheld_tax:'10.00',social:'100.00',other_deduction:'0.00'},'payroll entry');
  click(document.querySelector('[data-book-action="post-payroll"]'),'salary accrue');await fillAndSubmit({},'payroll accrual');
  click(document.querySelector('[data-book-action="pay-payroll"]'),'salary pay');await fillAndSubmit({},'payroll payment entry');
  click(document.querySelector('[data-book-view="vouchers"]'),'manual voucher tab');click(document.querySelector('[data-book-action="new-voucher"]'),'manual voucher');
  await waitFor(()=>document.querySelector('#voucher-lines'),'manual voucher editor');
  let voucherForm=document.querySelector('#app-modal-form');setValue(voucherForm.elements.summary,'界面验收手工凭证');
  let lines=[...voucherForm.querySelectorAll('.voucher-line')];setValue(lines[0].querySelector('.voucher-account'),'1002');setValue(lines[0].querySelector('.voucher-debit'),'123.45');setValue(lines[0].querySelector('.voucher-cf'),'operating');setValue(lines[1].querySelector('.voucher-account'),'6001');setValue(lines[1].querySelector('.voucher-credit'),'123.44');
  voucherForm.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>document.querySelector('.modal-error')?.textContent,'unbalanced voucher validation');
  assert(document.querySelector('.modal-error').textContent.includes('不平衡'));assert.equal(lines[1].querySelector('.voucher-credit').value,'123.44');
  setValue(lines[1].querySelector('.voucher-credit'),'123.45');await fillAndSubmit({},'manual voucher validation and save');
  const currentBook=await frontend.api(`/api/books/${customer.id}?period=${new Date().toISOString().slice(0,7)}`),invoiceVoucher=currentBook.vouchers.find(v=>v.source_type==='invoice');assert(invoiceVoucher);
  click(document.querySelector(`[data-book-action="withdraw-source"][data-id="${invoiceVoucher.id}"]`),'withdraw invoice source');await fillAndSubmit({reason:'合成联调验收撤回'},'source voucher withdrawal');
  data=await frontend.api('/api/bootstrap');assert.equal(data.invoices.find(i=>i.client_id===customer.id).status,'unprocessed');
  const period=new Date().toISOString().slice(0,7);const checked=await frontend.api(`/api/books/${customer.id}?period=${period}`);
  assert.equal(checked.payroll[0].net_fen,89000);assert(checked.payroll[0].payment_voucher_id);assert.equal(checked.assets[0].cost_fen,120000);assert.equal(checked.inventory_items[0].quantity,'2');assert.equal(checked.inventory_items[0].inventory_account,'1405');assert(checked.reports.balance_sheet.balanced);
}
await writeFile('dom-report.json',JSON.stringify({visited,workflows,requests,errors:[],note:'Static DOM and real HTTP integration, not visual browser QA.'},null,2));
console.log(JSON.stringify({pages:visited.length,workflows,requests,allPassed:true}));
process.exit(0);
