import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
const {window}=parseHTML('<html><body><main id="root"></main></body></html>');
globalThis.window=window; globalThis.document=window.document; globalThis.alert=()=>{};
const {renderReconcile,bindReconcile,resetReconcile}=await import('../../outputs/yidaizhang-local/public/reconcile.js');
const root=document.querySelector('#root'); const clients=[{id:1,name:'本方公司',standard:'small2013'}];
let calls=0, submitted;
const old={id:8,account_name:'本方公司',transaction:{date:'2026-09-01',amount:'-100',counterparty:'供应商',note:'服务费'},invoice:{date:'2026-09-01',amount:'100',seller:'供应商',buyer:'本方公司',number:'A',item_name:'服务费'},status:'matched',evidence:{business_account_code:'5602',treatment:'recognize_invoice',evidence_note:'旧依据'}};
const current=structuredClone(old); current.invoice.net_amount='100';current.invoice.tax_amount='0';current.evidence.evidence_note='新依据';
const api=async(path,opt)=>{
 if(path.startsWith('/api/reconcile/records?')) return {records:[structuredClone(++calls===1?old:current)]};
 if(path==='/api/reconcile/match') return {matches:[{transaction_index:0,invoice_index:0,status:'matched',reasons:[]}]};
 if(path.startsWith('/api/books/')) return {accounts:[{code:'1002',name:'银行存款',report_key:'cash'},{code:'5602',name:'管理费用',report_key:'expense'}]};
 if(path==='/api/reconcile/batch-auto'){submitted=opt.body;return {rows:[{transaction_index:0,invoice_index:0,status:'saved_pending',reason:'待核实',classification:{status:'review'}}],unmatched_invoices:[]};}
 throw new Error(path);
};
resetReconcile();root.innerHTML=renderReconcile(clients);bindReconcile(root,api,clients);
const select=root.querySelector('[data-rc-client]');Object.defineProperty(select,'value',{value:'1',configurable:true});select.dispatchEvent(new window.Event('change',{bubbles:true}));
root.querySelector('[data-rc-action="history"]').dispatchEvent(new window.Event('click',{bubbles:true}));await new Promise(r=>setTimeout(r,10));
root.querySelector('[data-rc-resume="8"]').dispatchEvent(new window.Event('click',{bubbles:true}));await new Promise(r=>setTimeout(r,20));
assert.equal(calls,2);assert.equal(submitted.invoices[0].net_amount,'100');assert.equal(submitted.evidence[0].evidence_note,'新依据');
assert.match(root.textContent,/已保存，待入账/);assert.match(root.textContent,/业务科目/);assert.match(root.textContent,/银行存款科目/);
console.log('续处理读取最新记录，恢复依据，区分业务和资金科目：通过');

