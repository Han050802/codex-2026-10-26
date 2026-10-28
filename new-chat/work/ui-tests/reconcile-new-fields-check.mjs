import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
const {window}=parseHTML('<html><body><main id="root"></main></body></html>');
globalThis.window=window;globalThis.document=window.document;
const alerts=[];globalThis.alert=m=>alerts.push(m);
globalThis.FileReader=class{readAsDataURL(){this.result='data:application/pdf;base64,AA==';queueMicrotask(()=>this.onload());}};
window.URL.createObjectURL=()=>'blob:fake';window.URL.revokeObjectURL=()=>{};globalThis.URL=window.URL;
const {renderReconcile,bindReconcile,resetReconcile}=await import(new URL('../../outputs/yidaizhang-local/public/reconcile.js',import.meta.url));
const root=document.querySelector('#root'),clients=[{id:7,name:'本方公司'},{id:8,name:'另一公司'}],calls=[];
const parsed={account_name:'本方公司',transactions:[{date:'2026-09-01',amount:'-100.00',counterparty:'甲公司',needs_review:true},{date:'2026-09-02',amount:'-200.00',counterparty:'乙公司',needs_review:true}],invoices:[{date:'2026-09-01',amount:'100.00',seller:'甲公司',buyer:'本方公司',number:'1001',needs_review:true},{date:'2026-09-02',amount:'200.00',seller:'乙公司',buyer:'本方公司',number:'1002',needs_review:true}],warnings:[]};
let failSecond=true,release,waitFirst=true;
const api=async(path,options={})=>{calls.push({path,...options,body:options.body?structuredClone(options.body):undefined});if(path==='/api/reconcile/parse/start')return {job_id:'test'};if(path.startsWith('/api/reconcile/parse/progress?'))return {status:'completed',files:[],elapsed_seconds:1,result:structuredClone(parsed)};if(path==='/api/reconcile/match')return {matches:[0,1].map(i=>({transaction_index:i,invoice_index:i,status:'matched',reasons:[]}))};if(path==='/api/reconcile/save'){if(waitFirst){waitFirst=false;await new Promise(r=>release=r);}if(options.body.batch.transaction_index===1&&failSecond){failSecond=false;throw new Error('模拟失败');}return {id:100};}throw new Error('Unexpected '+path);};
resetReconcile();root.innerHTML=renderReconcile(clients);bindReconcile(root,api,clients);
const tick=()=>new Promise(r=>setTimeout(r,15));
function selectFiles(type,files){const el=root.querySelector(`[data-rc-file="${type}"]`);Object.defineProperty(el,'files',{value:files,configurable:true});el.dispatchEvent(new window.Event('change',{bubbles:true}));}
function click(selector){const el=root.querySelector(selector);assert(el,selector);el.dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));}
function change(selector,value,event='change'){const el=root.querySelector(selector);assert(el,selector);Object.defineProperty(el,'value',{value,configurable:true});el.dispatchEvent(new window.Event(event,{bubbles:true}));}
selectFiles('statement',[{name:'流水.pdf',size:100}]);selectFiles('invoices',[{name:'发票.pdf',size:100}]);click('[data-rc-action="parse"]');await tick();
assert.equal(calls.filter(x=>x.path==='/api/reconcile/match').length,1,'识别后自动匹配');
assert.equal(root.querySelectorAll('[data-rc-verified],[data-rc-account-verified],[data-rc-pair],[data-rc-approve]').length,0,'一致项目无需逐项勾选或选择');assert.equal(root.querySelectorAll('.rc-badge.ok').length,2);
click('[data-rc-action="save-all"]');await tick();assert(alerts.some(x=>x.includes('请先选择保存公司')));
change('[data-rc-client]','7');await tick();assert.equal(calls.filter(x=>x.path==='/api/reconcile/match').at(-1).body.client_id,7);click('[data-rc-action="save-all"]');await tick();
assert(root.querySelector('[data-rc-field]').disabled&&root.querySelector('[data-rc-account]').disabled&&root.querySelector('[data-rc-client]').disabled,'保存期间禁止修改');
change('[data-rc-field="transactions"][data-index="1"][data-key="amount"]','-999','input');click('[data-rc-action="save-all"]');release();await tick();
let saves=calls.filter(x=>x.path==='/api/reconcile/save');assert.equal(saves.length,2,'忙碌时防止重复提交');assert.equal(saves[1].body.transaction.amount,'-200.00','保存期间修改无效');assert(saves.every(x=>x.body.client_id===7&&x.body.batch.transactions.length===2&&!('bank_account' in x.body)));
assert(root.textContent.includes('已保存核对记录'));assert(alerts.some(x=>x.includes('模拟失败')));
click('[data-rc-action="save-all"]');await tick();assert.equal(calls.filter(x=>x.path==='/api/reconcile/save').length,3,'重试只提交失败项目');assert.equal(root.querySelectorAll('.rc-badge.approved').length,2);
click('[data-rc-action="match"]');await tick();click('[data-rc-action="save-all"]');await tick();assert.equal(calls.filter(x=>x.path==='/api/reconcile/save').length,3,'重新核对不重复保存');
change('[data-rc-client]','8');await tick();assert.equal(root.querySelectorAll('.rc-badge.ok').length,2,'不同公司状态独立');change('[data-rc-client]','7');await tick();assert.equal(root.querySelectorAll('.rc-badge.approved').length,2,'切换回来保留本公司已保存状态');
console.log('reconcile auto-match and save regression passed');


