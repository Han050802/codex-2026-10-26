import assert from 'node:assert/strict';
import {
 bindReconcile, renderReconcile, resetReconcile, setReconcileCompany,
 reconcileHistoryRows, reconcileVoucherTarget,
} from '../public/reconcile.js';

// Synthetic DOM and history only; no browser, server, or customer data.
const companies = [
 {id:581,name:'SYNTHETIC HISTORY COMPANY A',enterprise_name:'SYNTHETIC HISTORY ENTERPRISE A',start_period:'2025-01',standard:'small2013'},
 {id:582,name:'SYNTHETIC HISTORY COMPANY B',enterprise_name:'SYNTHETIC HISTORY ENTERPRISE B',start_period:'2025-01',standard:'small2013'},
];
const lines = [
 {account_code:'5602',account_name:'SYNTHETIC EXPENSE',debit_fen:10000,credit_fen:0},
 {account_code:'1002',account_name:'SYNTHETIC BANK',debit_fen:0,credit_fen:10000},
];
const record = {
 id:901,voucher_id:'7001',transaction:{date:'2025-12-15',amount:'-100.00',counterparty:'SYNTHETIC LEGACY INVOICE'},
 invoice:{number:'SYNTHETIC-LEGACY-1',amount:'100.00'},status:'matched',archive_ids:[],
};
const receipt = {
 voucher_id:7002,voucher_ref:'SYNTHETIC OLD RECEIPT VOUCHER',period:'2025-08',voucher_date:'2025-08-14',
 posted_lines:lines,source_type:'bank_receipt',receipt:{number:'SYNTHETIC-RECEIPT-1'},
 transaction:{date:'2025-08-14',amount:'-100.00',counterparty:'SYNTHETIC RECEIPT WITHOUT RECORD'},
 record_id:null,status:'posted',archive_ids:[],
};
const pending = {
 id:902,status:'reviewed',transaction:{date:'2025-11-01',amount:'-20.00',counterparty:'SYNTHETIC PENDING'},
 invoice:{number:'SYNTHETIC-PENDING-1',amount:'20.00'},voucher_id:null,archive_ids:[],
};
const postedInvoice = {
 voucher_id:7001,record_id:901,voucher_ref:'SYNTHETIC OLD INVOICE VOUCHER',period:'2025-12',voucher_date:'2025-12-15',
 posted_lines:lines,source_type:'reconciliation',transaction:record.transaction,invoice:record.invoice,
 status:'posted',archive_ids:[],
};

const merged = reconcileHistoryRows([record,pending],[postedInvoice,receipt,{...receipt,voucher_id:'7002'}]);
assert.equal(merged.length,3,'Invoice records and standalone receipt vouchers must coexist without duplicates.');
const mergedInvoice = merged.find(row=>Number(row.voucher_id)===7001);
assert.equal(Number(mergedInvoice.record_id),901);
assert.deepEqual(mergedInvoice.posted_lines,lines,'Use the actual posted voucher lines.');
assert.equal(merged.filter(row=>Number(row.voucher_id)===7002).length,1);
const mergedReceipt = merged.find(row=>Number(row.voucher_id)===7002);
assert.equal(mergedReceipt.id,undefined,'A receipt voucher must never impersonate a reconciliation record ID.');
assert.ok(merged.some(row=>!row.voucher_id&&Number(row.record_id||row.id)===902),'Keep unposted saved records actionable.');
assert.deepEqual(reconcileHistoryRows(),[]);

assert.deepEqual(reconcileVoucherTarget(mergedInvoice,'581'),{clientId:581,voucherId:7001,period:'2025-12'});
assert.deepEqual(reconcileVoucherTarget({voucher_id:7002,voucher_date:'2025-08-14'},581),{clientId:581,voucherId:7002,period:'2025-08'});
assert.deepEqual(reconcileVoucherTarget(record,581),{clientId:581,voucherId:7001,period:'2025-12'});
for(const [row,cid] of [[{voucher_id:7001,period:'2025-13'},581],[{period:'2025-12'},581],[{voucher_id:7001,period:'2025-12'},'']]){
 assert.throws(()=>reconcileVoucherTarget(row,cid),'Invalid IDs or periods must not navigate to another/default month.');
}

function control(dataset={}) {
 return {dataset,value:'',files:[],disabled:false,hidden:false,handlers:new Map(),
  addEventListener(type,handler){this.handlers.set(type,handler);}};
}
function host() {
 const root={isConnected:true,onclick:null,contains(node){return node===this.page;},
  querySelector(selector){return {'[data-rc-account]':this.account,'[data-rc-client]':this.client,'.rc-root':this.page}[selector]||null;},
  querySelectorAll(selector){
   if(selector==='[data-rc-file]')return this.files;
   if(selector==='input,select,button')return [this.account,this.client,...this.files];
   if(selector==='[data-rc-progress]')return this.progress;
   return [];
  }};
 let html='';
 Object.defineProperty(root,'innerHTML',{get(){return html;},set(value){
  html=value;if(this.page)this.page.isConnected=false;
  this.page={isConnected:true};this.account=control();this.client=control();
  this.files=[control({rcFile:'statement'}),control({rcFile:'invoices'})];
  this.progress=[control({rcProgress:'statement'}),control({rcProgress:'invoice'})];
 }});
 root.innerHTML='';return root;
}
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
async function settle(){for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));}
function mount(root,transport,company,openVoucher=()=>{}) {
 root.innerHTML=renderReconcile(companies,{client:company});
 bindReconcile(root,transport,companies,()=>{},{client:company,loadHistory:true,openVoucher});
}
function clickAction(root,name){
 const target={dataset:{rcAction:name},textContent:'',closest(selector){return selector==='[data-rc-action]'?this:null;}};
 return root.onclick({target});
}
function clickVoucher(root,vid,period){
 const target={dataset:{rcViewVoucher:String(vid),period},textContent:'查看凭证',
  closest(selector){return selector==='[data-rc-view-voucher]'?this:null;}};
 return root.onclick({target});
}
function historyApi(response){
 const calls=[];
 const api=async(path)=>{calls.push(path);assert.match(path,/^\/api\/reconcile\/records\?client_id=\d+$/);return typeof response==='function'?response(path):structuredClone(response);};
 return {api,calls};
}
function historyButtonCount(root,vid){return [...root.innerHTML.matchAll(/data-rc-view-voucher="(\d+)"/g)].filter(match=>match[1]===String(vid)).length;}

const savedAlert=globalThis.alert,alerts=[];
globalThis.alert=message=>alerts.push(message);
try {
 resetReconcile();
 const root=host(),fixture=historyApi({records:[record,pending],postings:[postedInvoice,receipt]}),opened=[];
 mount(root,fixture.api,companies[0],target=>opened.push(target));
 await settle();
 assert.equal(fixture.calls.length,1,'Entering reconciliation must load saved voucher history automatically.');
 assert.ok(root.innerHTML.includes('SYNTHETIC RECEIPT WITHOUT RECORD'),'A receipt voucher with no saved record must remain visible.');
 assert.ok(root.innerHTML.includes('SYNTHETIC PENDING'),'Unposted records must remain visible.');
 assert.equal(historyButtonCount(root,7001),1,'A voucher in both records and postings gets one history action.');
 assert.equal(historyButtonCount(root,7002),1,'Old vouchers without archives still have a direct view action.');
 assert.match(root.innerHTML,/data-period="2025-08"/);
 await clickVoucher(root,7002,'2025-08');
 assert.deepEqual(opened,[{clientId:581,voucherId:7002,period:'2025-08'}],'Use the voucher month instead of the current homepage month.');
 mount(root,fixture.api,companies[0],target=>opened.push(target));
 await settle();
 assert.equal(fixture.calls.length,1,'Redraw/rebinding must not repeatedly load history.');

 // Refresh failures preserve known vouchers and expose a retryable error.
 const fail=historyApi(()=>{throw new Error('SYNTHETIC HISTORY SERVICE FAILED');});
 mount(root,fail.api,companies[0]);
 await clickAction(root,'history');await settle();
 assert.ok(root.innerHTML.includes('SYNTHETIC RECEIPT WITHOUT RECORD'),'A failed refresh must retain the last successful history.');
 assert.ok(root.innerHTML.includes('SYNTHETIC HISTORY SERVICE FAILED')||alerts.some(message=>String(message).includes('SYNTHETIC HISTORY SERVICE FAILED')));

 resetReconcile();
 const retryRoot=host();let attempts=0;
 const retryFixture=historyApi(()=>{if(++attempts===1)throw new Error('SYNTHETIC INITIAL HISTORY ERROR');return {records:[],postings:[receipt]};});
 mount(retryRoot,retryFixture.api,companies[0]);await settle();
 assert.equal(attempts,1,'A failing auto-load must not loop through redraws.');
 assert.ok(retryRoot.innerHTML.includes('SYNTHETIC INITIAL HISTORY ERROR')||alerts.some(message=>String(message).includes('SYNTHETIC INITIAL HISTORY ERROR')));
 await clickAction(retryRoot,'history');await settle();
 assert.equal(attempts,2);
 assert.equal(historyButtonCount(retryRoot,7002),1,'Retry can load postings even when records is empty.');

 resetReconcile();
 const emptyRoot=host(),emptyFixture=historyApi({records:[],postings:[]});
 mount(emptyRoot,emptyFixture.api,companies[0]);await settle();
 assert.equal(emptyFixture.calls.length,1);
 assert.doesNotMatch(emptyRoot.innerHTML,/data-rc-view-voucher=/);
 assert.match(emptyRoot.innerHTML,/暂无|尚无|没有/,'A truly empty history needs a clear empty state.');

 // Delayed old-company history may neither overwrite the new screen nor alert.
 resetReconcile();
 const gate=deferred(),staleRoot=host(),staleCalls=[];
 const staleApi=async path=>{
  staleCalls.push(path);
  return path.endsWith('='+companies[0].id)?gate.promise:{records:[],postings:[{...receipt,voucher_id:8002,voucher_ref:'SYNTHETIC COMPANY B VOUCHER',transaction:{...receipt.transaction,counterparty:'SYNTHETIC COMPANY B ONLY'}}]};
 };
 mount(staleRoot,staleApi,companies[0]);await settle();
 setReconcileCompany(companies[1]);mount(staleRoot,staleApi,companies[1]);await settle();
 const companyBHtml=staleRoot.innerHTML,alertsBefore=alerts.length;
 gate.resolve({records:[record],postings:[receipt]});await settle();
 assert.equal(staleRoot.innerHTML,companyBHtml);
 assert.equal(alerts.length,alertsBefore,'Stale history completion must stop silently.');
 assert.ok(staleRoot.innerHTML.includes('SYNTHETIC COMPANY B ONLY'));
 assert.doesNotMatch(staleRoot.innerHTML,/SYNTHETIC RECEIPT WITHOUT RECORD|SYNTHETIC LEGACY INVOICE/);
 assert.equal(staleCalls.length,2,'Only one request per entered company is required.');

 // Leaving reconciliation also invalidates its pending response.
 resetReconcile();
 const detachedGate=deferred(),detachedRoot=host();
 mount(detachedRoot,async()=>detachedGate.promise,companies[0]);await settle();
 detachedRoot.isConnected=false;const detachedHtml=detachedRoot.innerHTML;
 detachedGate.resolve({records:[],postings:[receipt]});await settle();
 assert.equal(detachedRoot.innerHTML,detachedHtml);
 console.log('reconciliation history merge, old-month voucher navigation, auto-load, retry and stale-company isolation passed');
} finally {
 resetReconcile();
 if(savedAlert===undefined)delete globalThis.alert;else globalThis.alert=savedAlert;
}
