import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
const {window}=parseHTML('<html><body><main id="root"></main></body></html>');
globalThis.window=window;globalThis.document=window.document;globalThis.alert=message=>{throw Error('unexpected alert: '+message)};
Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this._testValue||''},set(v){this._testValue=v}});
globalThis.FileReader=class{readAsDataURL(){this.result='data:application/pdf;base64,AA==';queueMicrotask(()=>this.onload());}};
window.URL.createObjectURL=()=> 'blob:fake';window.URL.revokeObjectURL=()=>{};globalThis.URL=window.URL;
const {renderReconcile,bindReconcile,resetReconcile}=await import('../../outputs/yidaizhang-local/public/reconcile.js');
const root=document.querySelector('#root'),clients=[{id:17,name:'本方公司'}],calls=[],posted=[];
const tx=[{date:'2026-09-01',amount:'-100.00',counterparty:'供应商甲',direction_needs_review:true},{date:'2026-10-02',amount:'-200.00',counterparty:'供应商乙'}];
const inv=tx.map((t,i)=>({date:t.date,amount:String(-Number(t.amount)),seller:t.counterparty,buyer:'本方公司',number:'INV'+i}));
const api=async(path,opt={})=>{calls.push({path,body:structuredClone(opt.body)});
 if(path==='/api/reconcile/parse/start')return {job_id:'fake'};
 if(path.startsWith('/api/reconcile/parse/progress?'))return {status:'completed',result:{account_name:'本方公司',transactions:tx,invoices:inv,warnings:[]}};
 if(path==='/api/reconcile/match')return {matches:tx.map((_,i)=>({transaction_index:i,invoice_index:i,status:'matched',reasons:[]}))};
 if(path.startsWith('/api/books/'))return {accounts:[{code:'1002',name:'银行存款',report_key:'cash'},{code:'1123',name:'预付账款',report_key:'prepaid'}]};
 if(path==='/api/reconcile/batch-preview')return {preview_token:'token',unmatched_invoices:[],rows:opt.body.transactions.map((t,i)=>({transaction_index:i,invoice_index:i,status:t.direction_needs_review?'review':'ready',reason:t.direction_needs_review?'收付款方向待确认':'合同预付款',counterparty:t.counterparty,basis:'合同依据',voucher:t.direction_needs_review?null:{date:t.date,lines:[{counterparty_parent_code:'1123',debit_fen:(i+1)*10000,credit_fen:0},{account_code:'1002',debit_fen:0,credit_fen:(i+1)*10000}]}}))};
 if(path==='/api/reconcile/batch-save')return {results:opt.body.selected_indices.map(i=>({transaction_index:i,voucher_id:i+1,posted_lines:[{account_code:'112301',account_name:tx[i].counterparty,debit_fen:(i+1)*10000,credit_fen:0}]}))};
 throw Error('Unexpected '+path);
};
const tick=()=>new Promise(r=>setTimeout(r,20));const click=el=>el.dispatchEvent(new window.Event('click',{bubbles:true}));
resetReconcile();root.innerHTML=renderReconcile(clients);bindReconcile(root,api,clients,p=>posted.push(p));
const file=root.querySelector('[data-rc-file="statement"]');Object.defineProperty(file,'files',{value:[{name:'a.pdf',size:1}]});file.dispatchEvent(new window.Event('change',{bubbles:true}));click(root.querySelector('[data-rc-action="parse"]'));await tick();
assert(root.textContent.includes('收付款方向待确认'));assert(root.textContent.includes('供应商乙'));assert(root.textContent.includes('预付账款'));assert(root.textContent.includes('银行存款'));
assert.equal(root.querySelector('[data-rc-client]').querySelector('option[selected]').value,'17');
click(root.querySelector('[data-rc-action="save-all"]'));await tick();
assert.deepEqual(calls.find(c=>c.path==='/api/reconcile/batch-save').body.selected_indices,[1]);assert.equal(posted[0].postings[0].period,'2026-10');assert(!document.querySelector('[role="dialog"]'));
// Restart and verify editing even the same amount confirms direction, invalidates preview,
// and a single save sends both independently ready rows after refreshed preview.
resetReconcile();root.innerHTML=renderReconcile(clients);bindReconcile(root,api,clients,p=>posted.push(p));
const file2=root.querySelector('[data-rc-file="statement"]');Object.defineProperty(file2,'files',{value:[{name:'a.pdf',size:1}]});file2.dispatchEvent(new window.Event('change',{bubbles:true}));click(root.querySelector('[data-rc-action="parse"]'));await tick();
const amount=root.querySelector('[data-rc-field="transactions"][data-index="0"][data-key="amount"]');amount.value='-100.00';amount.dispatchEvent(new window.Event('input',{bubbles:true}));assert(root.querySelector('[data-rc-action="save-all"]').disabled);click(root.querySelector('[data-rc-action="match"]'));await tick();assert(!root.textContent.includes('收付款方向待确认'));
const evidence=root.querySelector('[data-rc-evidence="evidence_note"]');evidence.value='合同明确预付款';evidence.dispatchEvent(new window.Event('input',{bubbles:true}));assert(root.querySelector('[data-rc-action="save-all"]').disabled);click(root.querySelector('[data-rc-action="preview"]'));await tick();click(root.querySelector('[data-rc-action="save-all"]'));await tick();
const final=calls.filter(c=>c.path==='/api/reconcile/batch-save').at(-1);assert.deepEqual(final.body.selected_indices,[0,1]);assert.equal(final.body.evidence[0].evidence_note,'合同明确预付款');assert.deepEqual(posted.at(-1).postings.map(x=>x.period),['2026-09','2026-10']);
console.log('batch preview, mixed readiness, direction confirmation and single save passed');
const alertMessages=[];globalThis.alert=x=>alertMessages.push(x);
resetReconcile();root.innerHTML=renderReconcile(clients);bindReconcile(root,api,clients,()=>{throw Error('导航不可用')});
const file3=root.querySelector('[data-rc-file="statement"]');Object.defineProperty(file3,'files',{value:[{name:'a.pdf',size:1}]});file3.dispatchEvent(new window.Event('change',{bubbles:true}));click(root.querySelector('[data-rc-action="parse"]'));await tick();click(root.querySelector('[data-rc-action="save-all"]'));await tick();
assert(alertMessages.some(x=>x.includes('已保存，但打开余额表失败')));assert(root.textContent.includes('已保存并记账'));assert(root.textContent.includes('供应商乙'));assert(root.querySelector('[data-rc-action="save-all"]').disabled);assert(root.querySelector('[data-rc-action="show-balance"]'));
console.log('successful save survives navigation failure without duplicate submission');
// Navigation can replace the original main node before it fails. Returning to
// the reconciliation view must recover saved information from module state.
resetReconcile();root.innerHTML=renderReconcile(clients);bindReconcile(root,api,clients,()=>{root.remove();throw Error('渲染失败')});
const file4=root.querySelector('[data-rc-file="statement"]');Object.defineProperty(file4,'files',{value:[{name:'a.pdf',size:1}]});file4.dispatchEvent(new window.Event('change',{bubbles:true}));click(root.querySelector('[data-rc-action="parse"]'));await tick();click(root.querySelector('[data-rc-action="save-all"]'));await tick();assert(!root.isConnected);
const restored=document.createElement('main');document.body.append(restored);restored.innerHTML=renderReconcile(clients);bindReconcile(restored,api,clients,()=>{});
assert(restored.textContent.includes('已保存并记账'));assert(restored.textContent.includes('供应商乙'));assert(restored.querySelector('[data-rc-action="show-balance"]'));assert(restored.querySelector('[data-rc-action="save-all"]').disabled);
console.log('saved information survives removed reconciliation root and return');
