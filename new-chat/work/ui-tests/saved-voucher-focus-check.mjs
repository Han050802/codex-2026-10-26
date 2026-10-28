import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {renderCompanyVouchers,bindCompanyVouchers,focusCompanyVoucher,companyVouchersTest as ui} from '../../outputs/yidaizhang-local/public/company-vouchers.js';

// Every book and voucher below is synthetic. No server or database is used.
const {window}=parseHTML('<html><body><main id="workspace"></main></body></html>');
globalThis.document=window.document;
const host=document.querySelector('#workspace');
const scrolled=[],errors=[];
window.HTMLElement.prototype.scrollIntoView=function(options){scrolled.push({id:this.dataset.cvVoucher,options});};
const ctx={toast:(message,type)=>errors.push({message,type})};
function makeBook(clientId,period,count=501){return {
  client:{id:clientId,name:`合成定位公司 ${clientId}`},period,periods:[],
  vouchers:Array.from({length:count},(_,index)=>({
    id:index+1,number:index+1,date:`${period}-15`,summary:`保存凭证 ${index+1}`,
    created_by_name:'合成会计',status:'active',source_type:'manual',reviewed:false,
    lines:[{account_code:'1002',account_name:'银行存款',debit_fen:100,credit_fen:0},
      {account_code:'5001',account_name:'主营业务收入',debit_fen:0,credit_fen:100}],
  })),
};}
function render(book){host.innerHTML=renderCompanyVouchers(book,ctx);return host;}
function snapshot(book){const state=ui.stateFor(book);return structuredClone({...state,selected:[...state.selected]});}
function poison(book,size=500){Object.assign(ui.stateFor(book),{
  query:'旧查询不会匹配',status:'void',source:'invoice',dateFrom:'2026-12-01',dateTo:'2026-12-31',min:'999.00',max:'1000.00',
  page:7,size,selected:new Set(['1','2']),scrollToSaved:'1',focusId:'2',
});}

const target=makeBook(99501,'2026-10');
const otherCompany=makeBook(99502,'2026-10');
const otherMonth=makeBook(99501,'2026-09');
poison(target);poison(otherCompany,20);poison(otherMonth,50);
const otherCompanyBefore=snapshot(otherCompany),otherMonthBefore=snapshot(otherMonth);
render(target);
assert.equal(host.querySelector('[data-cv-voucher="501"]'),null,'Old filters should hide the saved voucher before focusing');
assert.equal(focusCompanyVoucher(target.client.id,target.period,501),true);
const state=ui.stateFor(target);
for(const key of ['query','source','dateFrom','dateTo','min','max'])assert.equal(state[key],'',`${key} should be reset`);
assert.equal(state.status,'active');
assert.equal(state.page,1);
assert.equal(state.size,500,'Existing page size must be retained');
assert.equal(state.selected.size,0);
assert.equal(state.focusId,'501');
assert.equal(state.scrollToSaved,null);
render(target);
assert.equal(state.page,2);
assert.equal(host.querySelector('[data-cv-page-input]').value,'2');
assert.equal(host.querySelectorAll('[data-cv-voucher]').length,1);
assert.ok(host.querySelector('[data-cv-voucher="501"]'));
assert.match(host.querySelector('.cv-page-count').textContent,/共2页, 501条记录/);
assert.equal(host.querySelector('.cv-selection-bar'),null);
assert.equal(host.querySelector('[data-cv-query]').value,'');
assert.equal(host.querySelector('[data-cv-filter="status"] option[selected]').value,'active');
assert.equal(state.focusId,undefined,'Focus should be consumed after rendering');
assert.equal(state.scrollToSaved,'501');
bindCompanyVouchers(host,target,ctx);
assert.deepEqual(scrolled,[{id:'501',options:{block:'nearest'}}]);
assert.equal(state.scrollToSaved,null);
bindCompanyVouchers(host,target,ctx);
assert.equal(scrolled.length,1,'Binding again must not scroll a second time');
console.log('PASS saved voucher 501 clears filters and selection, lands on page 2 and scrolls into view once');

assert.deepEqual(snapshot(otherCompany),otherCompanyBefore);
assert.deepEqual(snapshot(otherMonth),otherMonthBefore);
console.log('PASS focus preserves another company and another month without leaking filter or selection changes');

const smallerPage=makeBook(99503,'2026-10',101);
poison(smallerPage,50);
assert.equal(focusCompanyVoucher(String(smallerPage.client.id),smallerPage.period,'77'),true);
render(smallerPage);
assert.equal(ui.stateFor(smallerPage).size,50);
assert.equal(ui.stateFor(smallerPage).page,2);
assert.equal(host.querySelectorAll('[data-cv-voucher]').length,50);
assert.ok(host.querySelector('[data-cv-voucher="77"]'));
assert.equal(host.querySelector('[data-cv-size] option[selected]').value,'50');
console.log('PASS nondefault page size 50 is retained and saved voucher is located on its corresponding page');

const beforeInvalid=[target,otherCompany,otherMonth,smallerPage].map(snapshot);
for(const args of [
  [],[null,'2026-10',501],['client','2026-10',501],[-1,'2026-10',501],[1.5,'2026-10',501],
  [99501,'2026-00',501],[99501,'2026-13',501],[99501,'2026-1',501],[99501,'2026-10x',501],
  [99501,'2026-10',null],[99501,'2026-10',''],[99501,'2026-10','voucher'],[99501,'2026-10',-1],[99501,'2026-10',1.5],
])assert.equal(focusCompanyVoucher(...args),false,`Invalid arguments must be rejected: ${JSON.stringify(args)}`);
assert.deepEqual([target,otherCompany,otherMonth,smallerPage].map(snapshot),beforeInvalid);
assert.deepEqual(errors,[]);
console.log('PASS invalid identifiers and periods return false without changing existing state');
console.log(JSON.stringify({ok:true,syntheticVouchers:501,pageSize:state.size,savedVoucherPage:state.page,scrollCalls:scrolled.length,errors},null,2));
