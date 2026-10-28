import {parseHTML} from 'linkedom';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import path from 'node:path';
const {window}=parseHTML('<html><body><div id="app"></div></body></html>');
globalThis.window=window;globalThis.document=window.document;globalThis.alert=()=>{};
globalThis.FileReader=class {readAsDataURL(){this.result='data:application/pdf;base64,QQ==';this.onload();}};
URL.createObjectURL=()=> 'blob:test';URL.revokeObjectURL=()=>{};
const {renderReconcile,bindReconcile,resetReconcile}=await import(pathToFileURL(path.resolve('outputs/yidaizhang-local/public/reconcile.js')));
const clients=[{id:1,name:'本方公司',standard:'small2013'},{id:2,name:'另一公司',standard:'small2013'}], root=document.querySelector('#app');
const calls=[];
let autoCount=0, fail=false, release=null, hold=false, parsedName='本方公司';
const finalClassification={status:'suggested',account_code:'5602',account_name:'管理费用',basis:'流水备注明确行政管理用途',review:'请核实用途',candidates:[{item_name:'办公用品',account_name:'管理费用',condition:'行政管理部门使用'}],source_urls:['https://example.test/source']};
const tx=[{date:'2026-09-09',amount:'-100',counterparty:'供应商',note:'服务'},{date:'2026-09-10',amount:'-200',counterparty:'另一供应商',note:'其他'}];
const iv=[{date:'2026-09-08',amount:'100',seller:'供应商',buyer:'本方公司',number:'INV1'},{date:'2026-09-10',amount:'199',seller:'另一供应商',buyer:'本方公司',number:'INV2'}];
const api=async (url,opts={})=>{calls.push({url,body:opts.body});
 if(url==='/api/reconcile/parse/start')return {job_id:'1'};
 if(url.startsWith('/api/reconcile/parse/progress'))return {status:'completed',result:{transactions:tx,invoices:iv,account_name:parsedName}};
 if(url==='/api/reconcile/match')return {matches:[{transaction_index:0,invoice_index:0,status:'matched'},{transaction_index:1,invoice_index:1,status:'review',reasons:['金额不一致']}],classification_transactions:[{status:'review',basis:'发票项目或业务用途缺失',review:'请补充项目和具体用途',candidates:[{item_name:'办公用品',account_name:'管理费用',condition:'行政管理部门使用'}],source_urls:['https://example.test/source']},{status:'suggested',account_code:'9999',account_name:'不应显示'}],classification_invoices:[]};
 if(url.startsWith('/api/books/'))return {accounts:[]};
 if(url==='/api/reconcile/batch-auto'){autoCount++;if(fail)throw Error('网络中断');if(hold)await new Promise(resolve=>{release=resolve;});return {client_name:'本方公司',unmatched_invoices:[1],rows:[autoCount===1?{transaction_index:0,invoice_index:0,status:'posted',classification:finalClassification,voucher_id:42,posted_lines:[{account_code:'1002',account_name:'银行存款',credit_fen:10000}]}:{transaction_index:0,invoice_index:0,status:'review',classification:finalClassification,reason:'该发票已保存，请核对是否重复'},{transaction_index:1,invoice_index:1,status:'review',reason:'金额不一致'}]};}
 if(url==='/api/reconcile/batch-preview')return {rows:[{transaction_index:0,invoice_index:0,status:'ready'}],unmatched_invoices:[]};
 throw Error('unexpected '+url);
};
function setup(){root.innerHTML=renderReconcile(clients);bindReconcile(root,api,clients);}
function click(selector){const el=root.querySelector(selector);assert(el,selector);el.dispatchEvent(new window.Event('click',{bubbles:true}));}
async function until(fn){for(let n=0;n<100;n++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw Error('timed out '+root.textContent);}
setup();
for(const [kind,name] of [['statement','流水.pdf'],['invoices','发票.pdf']]){const input=root.querySelector(`[data-rc-file="${kind}"]`);Object.defineProperty(input,'files',{value:[{name,size:10}]});input.dispatchEvent(new window.Event('change'));}
click('[data-rc-action="parse"]');await until(()=>root.textContent.includes('凭证 #42'));
assert.equal(autoCount,1);assert(root.textContent.includes('已自动入账'));assert(root.textContent.includes('无匹配流水'));assert(root.textContent.includes('发票真伪'));assert(root.textContent.includes('仍待审核'));assert(root.textContent.includes('核对通过'));assert(root.textContent.includes('待匹配'));assert(root.textContent.includes('5602 管理费用'));assert(root.textContent.includes('已入账分录'));assert(root.textContent.includes('1002 银行存款'));assert(root.textContent.includes('流水备注明确行政管理用途'));assert(!root.textContent.includes('发票项目或业务用途缺失'));assert(root.textContent.includes('办公用品 → 管理费用'));assert(root.textContent.includes('行政管理部门使用'));assert(root.textContent.includes('金额不一致'));assert(!root.textContent.includes('不应显示'));assert.equal(root.querySelector('a[href="https://example.test/source"]')?.textContent,'准则来源');
assert.deepEqual(calls.find(x=>x.url==='/api/reconcile/batch-auto').body.transactions,tx);
hold=true;click('[data-rc-action="preview"]');await until(()=>release!==null);
const evidence=root.querySelector('[data-rc-evidence="evidence_note"]');assert(evidence.disabled,'processing disables evidence inputs');evidence.value='不应写入';evidence.dispatchEvent(new window.Event('input'));hold=false;release();await until(()=>root.textContent.includes('本次工作中已自动入账'));
click('[data-rc-action="preview"]');await until(()=>autoCount===3 && root.textContent.includes('本次工作中已自动入账'));assert.deepEqual(calls.filter(x=>x.url==='/api/reconcile/batch-auto').at(-1).body.evidence,[{},{}]);
fail=true;click('[data-rc-action="preview"]');await until(()=>root.textContent.includes('网络中断'));assert(root.textContent.includes('查看已保存记录后重试'));
fail=false;const selector=root.querySelector('[data-rc-client]');Object.defineProperty(selector,'value',{value:'2',configurable:true});selector.dispatchEvent(new window.Event('change'));await until(()=>autoCount===5 && root.textContent.includes('该发票已保存'));assert(!root.textContent.includes('凭证 #42'),'previous client voucher must not appear after changing clients');
resetReconcile();root.innerHTML=renderReconcile([{id:2,name:'鸿悦盛嘉（北京）医院管理有限公司'}]);bindReconcile(root,api,[{id:2,name:'鸿悦盛嘉（北京）医院管理有限公司'}]);
const before=autoCount;click('[data-rc-action="sample"]');await until(()=>root.textContent.includes('可入账（样本）'));assert.equal(autoCount,before);assert(calls.some(x=>x.url==='/api/reconcile/batch-preview'));assert(root.textContent.includes('无法唯一确定'));assert(root.textContent.includes('发票项目或业务用途缺失'));
resetReconcile();setup();parsedName='未知公司';
for(const [kind,name] of [['statement','流水.pdf'],['invoices','发票.pdf']]){const input=root.querySelector(`[data-rc-file="${kind}"]`);Object.defineProperty(input,'files',{value:[{name,size:10}]});input.dispatchEvent(new window.Event('change'));}
const beforeNoClient=autoCount;click('[data-rc-action="parse"]');await until(()=>root.textContent.includes('无法唯一确定'));assert.equal(autoCount,beforeNoClient);assert(root.textContent.includes('核对通过'));assert(root.textContent.includes('请先选择本方客户账套'));
console.log('automatic posting UI: parse, partial results, busy guard, retry, failure, client and sample isolation passed');
