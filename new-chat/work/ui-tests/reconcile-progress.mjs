import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
const {window}=parseHTML('<html><body><main id="root"></main></body></html>');
globalThis.window=window;globalThis.document=window.document;globalThis.alert=()=>{};
globalThis.FileReader=class{readAsDataURL(){this.result='data:image/png;base64,AA==';queueMicrotask(()=>this.onload());}};
window.URL.createObjectURL=()=>'blob:test';window.URL.revokeObjectURL=()=>{};globalThis.URL=window.URL;
const {renderReconcile,bindReconcile,resetReconcile}=await import(new URL('../../outputs/yidaizhang-local/public/reconcile.js',import.meta.url));
const root=document.querySelector('#root');const tick=()=>new Promise(r=>setTimeout(r,25));
const parsed={account_name:'测试公司',transactions:[{date:'2026-09-01',amount:'-10',counterparty:'甲公司'}],invoices:[{date:'2026-09-01',amount:'10',seller:'甲公司',buyer:'测试公司',number:'001'}]};
function mount(api){root.innerHTML=renderReconcile();bindReconcile(root,api);}
function choose(){const input=root.querySelector('[data-rc-file="statement"]');Object.defineProperty(input,'files',{value:[{name:'流水.png',size:2}],configurable:true});input.dispatchEvent(new window.Event('change',{bubbles:true}));}
function click(){root.querySelector('[data-rc-action="parse"]').dispatchEvent(new window.Event('click',{bubbles:true}));}
let release,poll=0,starts=0;
const api=async path=>{if(path.endsWith('/parse/start')){starts++;return {job_id:'test'};}if(path.includes('/parse/progress?')){poll++;if(poll===1)return {status:'running',elapsed_seconds:3.2,files:[{name:'<流水>.png',status:'completed',elapsed_seconds:2.1,pages:[]},{name:'发票.png',status:'running',elapsed_seconds:1.1,pages:[{orientation_passes:2}]}]};return await new Promise(r=>release=r);}if(path.endsWith('/match'))return {matches:[{transaction_index:0,invoice_index:0,status:'matched',reasons:[]}]};throw Error(path);};
resetReconcile();mount(api);choose();click();click();await tick();
assert.equal(starts,1);assert(root.textContent.includes('<流水>.png'));assert(root.textContent.includes('2.1 秒'));assert(root.textContent.includes('1 页尝试了第二个方向'));assert(!root.querySelector('[data-rc-progress] img'));
await new Promise(r=>setTimeout(r,1050));release({status:'completed',elapsed_seconds:4,files:[{name:'流水.png',status:'completed',elapsed_seconds:3,pages:[]}],result:parsed});await tick();assert(root.textContent.includes('识别完成'));assert(root.textContent.includes('核对通过'));assert(root.textContent.includes('3.0 秒'));
// A failed job retains the old editable rows and the chosen files for retry.
const failed=async path=>path.endsWith('/parse/start')?{job_id:'bad'}:{status:'failed',error:'测试错误',files:[],elapsed_seconds:1};
mount(failed);choose();click();await tick();assert(root.textContent.includes('测试错误'));assert.equal(root.querySelector('[data-rc-field="transactions"]').value,'2026-09-01');assert(!root.querySelector('[data-rc-action="parse"]').disabled);assert(root.querySelector('[data-rc-selection]').textContent.includes('流水.png'));
// A reset/new session must never be overwritten by an older in-flight job.
let finish;const stale=async path=>path.endsWith('/parse/start')?{job_id:'old'}:await new Promise(r=>finish=r);
mount(stale);choose();click();await tick();resetReconcile();mount(stale);finish({status:'completed',files:[],elapsed_seconds:1,result:parsed});await tick();assert.equal(root.querySelectorAll('[data-rc-field="transactions"]').length,0);assert(!root.querySelector('[data-rc-action="parse"]').disabled);
// Removing the whole app root leaves its children attached to that detached root.
let finishDetached;const detachedApi=async path=>path.endsWith('/parse/start')?{job_id:'detached'}:await new Promise(r=>finishDetached=r);
resetReconcile();mount(detachedApi);choose();click();await tick();root.remove();
finishDetached({status:'completed',files:[],elapsed_seconds:1,result:parsed});await tick();
document.body.append(root);mount(detachedApi);assert.equal(root.querySelectorAll('[data-rc-field="transactions"]').length,0);assert(!root.querySelector('[data-rc-action="parse"]').disabled);
// Re-enter while the detached task is still running; an old result cannot overwrite the new page.
let finishOld;const pendingApi=async path=>path.endsWith('/parse/start')?{job_id:'old-page'}:await new Promise(r=>finishOld=r);
resetReconcile();mount(pendingApi);choose();click();await tick();root.remove();
const newRoot=document.createElement('main');document.body.append(newRoot);newRoot.innerHTML=renderReconcile();bindReconcile(newRoot,pendingApi);assert(!newRoot.querySelector('[data-rc-action="parse"]').disabled);
finishOld({status:'completed',files:[],elapsed_seconds:1,result:parsed});await tick();assert.equal(newRoot.querySelectorAll('[data-rc-field="transactions"]').length,0);assert(!newRoot.querySelector('[data-rc-action="parse"]').disabled);
console.log('recognition progress, retry, and session isolation passed');
