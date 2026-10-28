import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<html><body><main id="root"></main></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.alert = () => {};
globalThis.FileReader = class {
  readAsDataURL() { this.result = 'data:application/pdf;base64,AA=='; queueMicrotask(() => this.onload()); }
};
window.URL.createObjectURL = () => 'blob:fake';
window.URL.revokeObjectURL = () => {};
globalThis.URL = window.URL;
const { renderReconcile, bindReconcile, resetReconcile } = await import(new URL('../../outputs/yidaizhang-local/public/reconcile.js', import.meta.url));
const root = document.querySelector('#root');
const data = {
  account_name: '本方公司',
  transactions: [
    {date:'2026-09-01', amount:'-100.00', counterparty:'通过公司'},
    {date:'2026-09-02', amount:'-200.00', counterparty:'待处理公司'},
    {date:'2026-09-03', amount:'-300.00', counterparty:'无发票公司'},
  ],
  invoices: [
    {date:'2026-09-01', amount:'100.00', seller:'通过公司', buyer:'本方公司', number:'PASS-100'},
    {date:'2026-09-02', amount:'210.00', seller:'待处理公司', buyer:'本方公司', number:'REVIEW-200'},
    {date:'2026-09-04', amount:'400.00', seller:'未匹配发票公司', buyer:'本方公司', number:'UNMATCHED-400'},
  ], warnings: [],
};
let failNextMatch = false;
const api = async (path) => {
  if (path === '/api/reconcile/match' && failNextMatch) { failNextMatch = false; throw new Error('模拟核对失败'); }
  if (path === '/api/reconcile/parse/start') return {job_id:'test'};
  if (path.startsWith('/api/reconcile/parse/progress?')) return {status:'completed',files:[],result:structuredClone(data)};
  if (path === '/api/reconcile/match') return {matches:[
    {transaction_index:0,invoice_index:0,status:'matched',reasons:[]},
    {transaction_index:1,invoice_index:1,status:'review',reasons:['金额有差异']},
    {transaction_index:2,invoice_index:null,status:'review',reasons:['未匹配']},
  ]};
  throw new Error('Unexpected '+path);
};
resetReconcile();
root.innerHTML = renderReconcile([]);
bindReconcile(root,api,[]);
const file = root.querySelector('[data-rc-file="statement"]');
Object.defineProperty(file,'files',{value:[{name:'流水.pdf',size:100}],configurable:true});
file.dispatchEvent(new window.Event('change',{bubbles:true}));
root.querySelector('[data-rc-action="parse"]').dispatchEvent(new window.Event('click',{bubbles:true}));
await new Promise(resolve=>setTimeout(resolve,30));
const results = root.querySelector('.rc-results');
assert(results, '应显示核对结果表');
assert(results.textContent.includes('PASS-100'), '核对通过的发票出现在结果中');
assert(!results.textContent.includes('REVIEW-200'), '待处理发票不出现在结果中');
assert(!results.textContent.includes('待处理公司'), '待处理交易不出现在结果中');
assert(!results.textContent.includes('无发票公司'), '未匹配交易不出现在结果中');
assert(!results.textContent.includes('UNMATCHED-400'), '未匹配发票不出现在结果中');
assert(!results.textContent.includes('待处理'), '结果中不展示待处理状态');
console.log('passed-only reconciliation results verified');

let matchButton = root.querySelector('[data-rc-action="match"]');
assert(matchButton.hidden, '自动核对完成后隐藏核对按钮');
assert(root.querySelector('[data-rc-pending]'), '待处理区域存在');
const input = root.querySelector('[data-rc-field="transactions"][data-key="counterparty"]');
input.value='变更后公司';
input.dispatchEvent(new window.Event('input',{bubbles:true}));
matchButton=root.querySelector('[data-rc-action="match"]');
assert(!matchButton.hidden && matchButton.textContent==='重新核对', '修改后显示重新核对');
assert(!root.querySelector('[data-rc-pending]'), '修改后移除过期待处理项');
assert(root.querySelector('.rc-result-empty').textContent.includes('数据已修改'), '结果提示数据已修改');
assert(root.querySelector('[data-rc-action="save-all"]').disabled, '修改后不可保存过期结果');
matchButton.dispatchEvent(new window.Event('click',{bubbles:true}));
await new Promise(resolve=>setTimeout(resolve,30));
assert(root.querySelector('[data-rc-action="match"]').hidden, '重新核对成功后再次隐藏按钮');
console.log('automatic matching state and invalidation verified');

const again = root.querySelector('[data-rc-field="transactions"][data-key="counterparty"]');
again.value='再次变更'; again.dispatchEvent(new window.Event('input',{bubbles:true}));
failNextMatch=true;
root.querySelector('[data-rc-action="match"]').dispatchEvent(new window.Event('click',{bubbles:true}));
await new Promise(resolve=>setTimeout(resolve,30));
assert(!root.querySelector('[data-rc-action="match"]').hidden, '核对失败后可重试');
assert(root.querySelector('[data-rc-action="save-all"]').disabled, '核对失败后不能保存');
assert(!root.querySelector('[data-rc-pending]'), '核对失败后不展示旧结果');
resetReconcile(); root.innerHTML=renderReconcile([]); bindReconcile(root,api,[]);
assert(!root.querySelector('[data-rc-action="match"]').hidden, '空数据可发起核对');
assert(root.querySelector('[data-rc-action="save-all"]').disabled, '空数据不可保存');
console.log('empty and failed matching state verified');
