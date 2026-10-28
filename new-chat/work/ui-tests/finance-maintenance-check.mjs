import {parseHTML} from 'linkedom';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

// Pure synthetic DOM/transport fixture. No local application database or HTTP
// server is opened by this check; domain behavior is covered by finance tests.
const {window}=parseHTML('<html><body><main id="workspace"></main><div id="modal-root"></div></body></html>');
globalThis.window=window;globalThis.document=window.document;
Object.defineProperty(window.HTMLElement.prototype,'checked',{configurable:true,get(){return this.hasAttribute('checked');},set(value){this.toggleAttribute('checked',Boolean(value));}});
Object.defineProperty(window.HTMLElement.prototype,'elements',{configurable:true,get(){const nodes=[...this.querySelectorAll('input,select,textarea,button')];return new Proxy(nodes,{get(target,key){return key in target?target[key]:nodes.find(el=>el.getAttribute('name')===key);}});}});
const mod=await import(pathToFileURL('C:/Users/Admin/Documents/Codex/2026-10-26/new-chat/outputs/yidaizhang-local/public/finance-ui.js').href+'?maintenance-check='+Date.now());
const $=(s,inEl=document)=>inEl.querySelector(s),$$=(s,inEl=document)=>[...inEl.querySelectorAll(s)];
const delay=()=>new Promise(resolve=>setTimeout(resolve,5));
const calls=[],toasts=[];let modalResolve;
const fixture={client:{id:918,name:'合成公司',standard:'small2013',taxpayer_type:'small'},period:'2026-09',periods:[],accounts:[{id:1,code:'1002',name:'银行存款',category:'asset',direction:'debit',report_key:'cash',is_preset:true,version:1},{id:2,code:'9999',name:'未用自定义',category:'asset',direction:'debit',report_key:'other_asset',is_preset:false,version:1}],opening_balances:[],assets:[],inventory_items:[],inventory_movements:[],payroll:[],journals:[],checks:[],vouchers:Array.from({length:65},(_,i)=>({id:i+1,date:'2026-09-01',number:'记-'+(i+1),summary:i===0?'安全摘要 $& $\' <b>':'合成凭证'+(i+1),status:i===64?'void':'active',reviewed:i===62,source_type:i===63?'bank':'manual',version:1,lines:[{account_code:'1002',account_name:'银行存款',debit_fen:100,credit_fen:0}]}))};
const workspace=$('#workspace'),modalRoot=$('#modal-root');
const ctx={clients:[fixture.client],api:async(url,options)=>{if(!options)return structuredClone(fixture);calls.push({url,...structuredClone(options)});if(url.endsWith('/review'))return {};if(url.includes('/63'))throw new Error('须先取消审核');if(url.includes('/assets/77/depreciations/')){const a=fixture.assets[0];assert.equal(options.body.version,a.version);a.version++;a.depreciations=a.depreciations.filter(r=>!url.includes('/'+r.period+'/'));return {};}const id=Number(url.match(/vouchers\/(\d+)/)?.[1]);const row=fixture.vouchers.find(v=>v.id===id);if(row){row.status='void';row.version++;}return {};},toast:(...args)=>toasts.push(args),reload:async()=>{workspace.innerHTML=await mod.renderBook(fixture.client.id,fixture.period,ctx);mod.bindBook(workspace,ctx);},modal:(title,html,onSubmit)=>new Promise(resolve=>{modalResolve=resolve;modalRoot.innerHTML=`<h2>${title}</h2><form id="app-modal-form">${html}</form>`;$('#app-modal-form').addEventListener('submit',async e=>{e.preventDefault();await onSubmit?.(e.target);modalRoot.innerHTML='';resolve();});})};
const click=el=>{assert(el);assert(!el.disabled);el.dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));};
const check=(el,value=true)=>{assert(el);assert(!el.disabled);el.checked=value;el.dispatchEvent(new window.Event('change',{bubbles:true}));};
const scope=()=> $('[data-book-maintenance-scope="vouchers"]');
const count=()=> Number($('[data-book-selected-count]',scope()).textContent);
const boxes=()=> $$('[data-book-maintenance-row]',scope());
const header=()=> $('[data-book-maintenance-page]',scope());
const action=name=> $('[data-book-maintenance="'+name+'"]',scope());
await ctx.reload();
assert.equal(boxes().length,30);assert.equal(count(),0);assert(action('delete').disabled);
check(header());assert.equal(count(),30);assert(header().checked);assert(!header().indeterminate);
check(boxes()[0],false);assert.equal(count(),29);assert(header().indeterminate);
click(action('next'));assert.equal(boxes().length,30);assert(boxes().every(b=>!b.checked));
check(boxes()[0]);assert.equal(count(),30);assert(header().indeterminate);
click(action('prev'));assert(!boxes()[0].checked);assert(header().indeterminate);
click(action('all'));assert.equal(count(),64);assert(header().checked);
click(action('next'));assert(boxes().every(b=>b.checked));
click(action('next'));assert.equal(boxes().length,5);assert(boxes().at(-1).disabled);assert(!boxes().at(-1).checked);
click(action('clear'));assert.equal(count(),0);assert(!header().checked);

// Repainting selection, pagination or filter must preserve the original row
// actions. This previously exposed listeners attached to replaced table rows.
click(action('prev'));click(action('prev'));check(boxes()[1]);
click($('[data-book-action="review-voucher"][data-id="2"]',scope()));await delay();
assert.equal(calls.filter(c=>c.url.endsWith('/2/review')).length,1);
assert($('[data-book-maintenance-row][value="1"]',scope()).getAttribute('aria-label').includes("$& $' <b>"));

// Filtering prunes invisible selections and no-match tables cannot operate.
let search=$('[data-book-maintenance-filter]',scope());search.value='NO-MATCH';search.dispatchEvent(new window.Event('input',{bubbles:true}));
assert.equal(count(),0);assert.equal(boxes().length,0);assert(header().disabled);assert(action('all').disabled);assert(action('delete').disabled);
search=$('[data-book-maintenance-filter]',scope());search.value='';search.dispatchEvent(new window.Event('input',{bubbles:true}));
let size=$('[data-book-maintenance-size]',scope());for(const option of $$('option',size))option.toggleAttribute('selected',option.value==='100');size.dispatchEvent(new window.Event('change',{bubbles:true}));
for(const id of [1,63,64])check($('[data-book-maintenance-row][value="'+id+'"]',scope()));
assert.equal(count(),3);const start=calls.length;click(action('delete'));await delay();
assert.equal(calls.length,start,'Confirmation must not send changes');
assert.deepEqual($$('[data-book-confirm-record]').map(el=>el.dataset.bookConfirmRecord),['64','63','1']);
assert.equal($('[data-book-delete-client]').dataset.bookDeleteClient,'918');
assert.equal($('[data-book-delete-period]').dataset.bookDeletePeriod,'2026-09');
$('#app-modal-form').elements.reason.value='合成批量删除验收';
$('#app-modal-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
for(let i=0;i<60&&!$('[data-book-result-record]');i++)await delay();
assert.deepEqual(calls.slice(start).map(c=>[c.url,c.method]),[['/api/books/918/vouchers/64/withdraw','POST'],['/api/books/918/vouchers/63','DELETE'],['/api/books/918/vouchers/1','DELETE']]);
assert(calls.slice(start).every(c=>c.body.version===1&&c.body.reason==='合成批量删除验收'));
assert.equal($$('[data-book-result-status="success"]').length,2);assert.equal($$('[data-book-result-status="failed"]').length,1);
assert.equal(count(),1);assert.deepEqual(mod.financeUiTest.selected('vouchers'),['63']);
modalRoot.innerHTML='';modalResolve();await delay();
click($('[data-book-view="accounts"]'));assert.equal($$('[data-book-maintenance-row]:not(:disabled)').length,1);assert.equal($$('[data-book-maintenance-row]:disabled').length,1);
click($('[data-book-view="ledger"]'));assert.equal($$('[data-book-maintenance-scope]').length,0,'Computed tables must not expose destructive selection');
fixture.client.id=919;await ctx.reload();assert.equal(count(),0,'Selections must clear when account book changes');
fixture.assets=[{id:77,name:'合成资产',purchase_date:'2026-06-01',start_period:'2026-07',cost_fen:1,residual_fen:0,life_months:3,accumulated_fen:1,net_fen:0,status:'active',version:7,depreciations:[{id:7701,period:'2026-07',amount_fen:0,voucher_id:null},{id:7702,period:'2026-08',amount_fen:0,voucher_id:null},{id:7703,period:'2026-09',amount_fen:1,voucher_id:7703}]}];
await ctx.reload();click($('[data-book-view="assets"]'));click($('[data-book-action="asset-detail"][data-id="77"]'));await delay();
let deps=$('[data-book-maintenance-scope="depreciations_77"]');assert(deps);click($('[data-book-maintenance="all"]',deps));deps=$('[data-book-maintenance-scope="depreciations_77"]');assert.equal(Number($('[data-book-selected-count]',deps).textContent),3);click($('[data-book-maintenance="delete"]',deps));await delay();
const depStart=calls.length;$('#app-modal-form').elements.reason.value='合成折旧撤回';$('#app-modal-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
for(let i=0;i<60&&!$('[data-book-result-record]');i++)await delay();
assert.deepEqual(calls.slice(depStart).map(c=>[c.url.match(/depreciations\/(.*?)\/withdraw/)[1],c.body.version]),[['2026-09',7],['2026-08',8],['2026-07',9]]);
assert.equal($$('[data-book-result-status="success"]').length,3);assert.equal(fixture.assets[0].depreciations.length,0);modalRoot.innerHTML='';modalResolve();await delay();
fixture.inventory_items=[{id:88,sku:'STUB',name:'合成库存商品',unit:'件',quantity:'1',value_fen:100,version:2}];fixture.inventory_movements=[{id:8801,date:'2026-09-01',item_id:88,item_name:'合成库存商品',quantity:'1',amount_fen:100,status:'active',direction:'in',voucher_id:64}];await ctx.reload();click($('[data-book-view="inventory"]'));
const items=$('[data-book-maintenance-scope="inventory_items"]'),moves=$('[data-book-maintenance-scope="inventory_movements"]');assert(items&&moves);check($('[data-book-maintenance-page]',items));assert.equal(Number($('[data-book-maintenance-scope="inventory_items"] [data-book-selected-count]').textContent),1);assert.equal(Number($('[data-book-selected-count]',moves).textContent),0);check($('[data-book-maintenance-page]',moves));assert.deepEqual(mod.financeUiTest.selected('inventory_items'),['88']);assert.deepEqual(mod.financeUiTest.selected('inventory_movements'),['8801']);
console.log(JSON.stringify({ok:true,scenarios:['page/header partial state','all filtered across pages','void/preset exclusion','filter pruning and empty guards','row action after repaint','escaped replacement tokens','confirmation snapshot','manual void and source withdrawal','partial failure retains selection','computed tables read only','company context reset','depreciation newest first and version increment including zero amounts','inventory item/movement scope isolation'],requests:calls.length}));
