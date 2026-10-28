import assert from 'node:assert/strict';
import {parseHTML} from './node_modules/linkedom/esm/index.js';
import {readFile} from 'node:fs/promises';
import {renderBook,bindBook,setBookView} from '../../outputs/yidaizhang-local/public/finance-ui.js';
import {companyVouchersTest} from '../../outputs/yidaizhang-local/public/company-vouchers.js';

const {window}=parseHTML('<html><body><main id="host"></main><aside id="modal"></aside></body></html>');
globalThis.window=window;globalThis.document=window.document;
Object.defineProperty(window.HTMLElement.prototype,'elements',{configurable:true,get(){const nodes=[...this.querySelectorAll('input,select,textarea,button')];return new Proxy(nodes,{get:(target,key)=>key in target?target[key]:nodes.find(el=>el.getAttribute('name')===key)});}});
globalThis.FormData=class{constructor(form){this.rows=[...form.querySelectorAll('[name]')].filter(el=>!el.disabled).map(el=>[el.name,el.value]);}entries(){return this.rows[Symbol.iterator]();}};
const host=document.querySelector('#host'),modalHost=document.querySelector('#modal');
const client={id:92771,name:'凭证联动测试公司',start_period:'2026-01',standard:'small2013'};
const accounts=[{code:'1001',name:'库存现金',direction:'debit',report_key:'cash'},{code:'1002',name:'银行存款',direction:'debit',report_key:'cash'}];
const vouchers=[],calls=[],toasts=[];
let currentPeriod='2026-09',writeError=null,reloadError=null,currentSubmit=null,currentOptions=null;
function snapshot(period=currentPeriod){return {client,period,accounts,vouchers:vouchers.filter(v=>v.date.slice(0,7)===period),opening_balances:[],opening_version:1,periods:[],checks:[],assets:[],inventory_items:[],inventory_movements:[],payroll:[],journals:[]};}
const ctx={clients:[client],user:{name:'吕'},setBook:(id,period)=>{calls.push(['setBook',id,period]);assert.equal(id,client.id);currentPeriod=period;},toast:(...args)=>toasts.push(args),
  modal:(title,html,submit,options)=>{currentSubmit=submit;currentOptions=options;modalHost.innerHTML=`<section class="modal ${options?.wide?'wide-modal':''}"><form id="app-modal-form"><div class="modal-body">${html}</div></form></section>`;return Promise.resolve();},
  api:async(path,options)=>{if(!options){assert.match(path,/^\/api\/books\//);return snapshot(new URL(path,'http://localhost').searchParams.get('period'));}calls.push(['write',path,options]);if(writeError)throw writeError;const v={id:1,number:1,status:'active',source_type:'manual',version:2,created_by_name:'吕',...options.body};if(options.method==='PATCH'){v.id=Number(path.split('/').at(-1));const index=vouchers.findIndex(x=>x.id===v.id);vouchers[index]=v;}else{v.id=vouchers.length+1;v.number=v.id;vouchers.push(v);}return v;},
  reload:async()=>{calls.push(['reload',currentPeriod]);if(reloadError)throw reloadError;host.innerHTML=await renderBook(client.id,currentPeriod,ctx);bindBook(host,ctx);}
};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
async function paint(view='vouchers'){setBookView(view);host.innerHTML=await renderBook(client.id,currentPeriod,ctx);bindBook(host,ctx);}
async function click(selector){const el=host.querySelector(selector);assert.ok(el,selector);el.dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));await tick();}
function setSelect(el,value){for(const option of el.querySelectorAll('option'))option.toggleAttribute('selected',option.value===value);Object.defineProperty(el,'value',{value,writable:true,configurable:true});}
function fillVoucher(date,summary){const form=document.querySelector('#app-modal-form');form.elements.date.value=date;form.elements.summary.value=summary;form.elements.attachment_count.value='2';const rows=[...form.querySelectorAll('.voucher-line')];setSelect(rows[0].querySelector('.voucher-account'),'1001');rows[0].querySelector('.voucher-debit').value='12.34';setSelect(rows[0].querySelector('.voucher-cf'),'operating');setSelect(rows[1].querySelector('.voucher-account'),'1002');rows[1].querySelector('.voucher-credit').value='12.34';setSelect(rows[1].querySelector('.voucher-cf'),'operating');return form;}

await paint('home');await click('[data-cw-new-voucher]');
assert.equal(currentOptions.wide,true,'Both empty new-voucher forms and edit forms explicitly request the wide dialog.');
assert.equal(document.querySelectorAll('.voucher-editor col').length,6);
let form=fillVoucher('2026-10-15','跨月新增定位');
Object.assign(companyVouchersTest.stateFor(snapshot('2026-10')),{query:'不会匹配的旧搜索',status:'void',source:'invoice',page:5});
await currentSubmit(form);
assert.equal(currentPeriod,'2026-10');assert.ok(host.querySelector('.cv-root'));assert.match(host.textContent,/跨月新增定位/);
assert.deepEqual(calls.slice(-3).map(x=>x[0]),['write','setBook','reload']);
assert.equal(calls.at(-2)[2],'2026-10');

await click('[data-book-action="edit-voucher"]');assert.equal(currentOptions.wide,true);
form=document.querySelector('#app-modal-form');assert.equal(form.elements.date.getAttribute('min'),'2026-10-01');assert.equal(form.elements.date.getAttribute('max'),'2026-10-31');assert.match(form.querySelector('.voucher-date-hint').textContent,/原月份/);
form=fillVoucher('2026-11-16','跨月编辑保留原凭证');const beforeEdit=calls.length;
await assert.rejects(()=>currentSubmit(form),/编辑凭证日期须在原月份内/);assert.equal(calls.length,beforeEdit);assert.equal(currentPeriod,'2026-10');assert.equal(form.elements.summary.value,'跨月编辑保留原凭证');
form=fillVoucher('2026-10-16','原月编辑定位');await currentSubmit(form);
assert.equal(currentPeriod,'2026-10');assert.match(host.textContent,/原月编辑定位/);
assert.equal(calls.findLast(x=>x[0]==='write')[2].method,'PATCH');

await click('[data-book-action="new-voucher"]');form=fillVoucher('2026-12-20','失败不丢输入');
const callCount=calls.length;writeError=new Error('服务端拒绝保存');
await assert.rejects(()=>currentSubmit(form),/服务端拒绝保存/);
assert.equal(currentPeriod,'2026-10');assert.equal(calls.length,callCount+1,'Write failure never changes period or reloads.');
assert.equal(form.elements.summary.value,'失败不丢输入');assert.equal(form.elements.date.value,'2026-12-20');assert.equal(form.querySelector('.voucher-debit').value,'12.34');
writeError=null;reloadError=new Error('刷新网络失败');await currentSubmit(form);
assert.equal(currentPeriod,'2026-12');assert.match(toasts.at(-1)[0],/凭证已保存至 2026-12/);assert.equal(toasts.at(-1)[1],'error');
reloadError=null;

await paint('accounts');await click('[data-book-action="opening"]');
assert.ok(document.querySelector('.opening-editor'));assert.match(document.querySelector('.modal-body').textContent,/仅用于新账套初始化/);
const css=await readFile(new URL('../../outputs/yidaizhang-local/public/finance.css',import.meta.url),'utf8');
assert.match(css,/\.modal\.wide-modal:has\(\.voucher-editor\)\{width:1180px\}/);
assert.match(css,/\.modal \.voucher-editor table\{table-layout:fixed;min-width:960px\}/);
assert.match(css,/\.modal-body:has\(\.opening-editor\)\{color:#000\}/);
assert.match(css,/\.modal \.opening-editor th\{color:#000/);
console.log('Approved voucher checks passed: explicit wide new/edit dialogs, home-to-voucher save, new cross-period navigation clears stale filters, edit date range and cross-month guard retain input, same-month edit localization, failed save retains period and input, saved-but-refresh-failed notification, opening dialog black-text selectors. Mock data only; no server or database writes.');
