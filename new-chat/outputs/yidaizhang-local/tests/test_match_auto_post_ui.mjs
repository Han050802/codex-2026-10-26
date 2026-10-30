import assert from 'node:assert/strict';
import {bindReconcile, renderReconcile, resetReconcile, reconcilePostingState, processReconcileBatch} from '../public/reconcile.js';
const invoice={number:'SYNTHETIC-INVOICE'};
const posted={transaction_index:0,status:'posted',voucher_id:7,voucher_ref:'记 2026-09-0007',posted_lines:[{account_code:'1002',account_name:'银行存款',debit_fen:15520000,credit_fen:0},{account_code:'5001',account_name:'主营业务收入',debit_fen:0,credit_fen:15520000}]};
assert.equal(reconcilePostingState({status:'review',reason:'actual posting error'},{status:'invoice',reason:'按发票流程处理'}).reason,'actual posting error');
assert.equal(reconcilePostingState({status:'review'},posted).posted,true);
assert.deepEqual(reconcilePostingState({status:'review'},posted).lines,posted.posted_lines);
assert.equal(reconcilePostingState({status:'review',reason:'未找到唯一匹配发票'},{status:'review',reason:'回单实际入账原因'}).reason,'回单实际入账原因');
const routes=[];
await processReconcileBatch(async(url,options)=>{routes.push({url,options});return{};},{client_id:4},true);
await processReconcileBatch(async(url,options)=>{routes.push({url,options});return{};},{client_id:4});
assert.deepEqual(routes.map(call=>call.url),['/api/reconcile/batch-preview','/api/reconcile/batch-auto']);
function control(dataset={}){
 return {dataset,disabled:false,hidden:false,value:'',files:[],handlers:new Map(),addEventListener(type,handler){this.handlers.set(type,handler);}};
}
function fixtureHost(){
 const root={isConnected:true,onclick:null,contains(node){return node===this.page;},querySelector(selector){
  return {'[data-rc-account]':this.account,'[data-rc-client]':this.client,'.rc-root':this.page}[selector]||null;
 },querySelectorAll(selector){
  if(selector==='[data-rc-file]')return this.files;
  if(selector==='input,select,button')return [this.account,this.client,...this.files];
  if(selector==='[data-rc-progress]')return this.progress;
  return [];
 }};
 let html='';
 Object.defineProperty(root,'innerHTML',{get(){return html;},set(value){
  html=value;if(this.page)this.page.isConnected=false;
  this.page={isConnected:true};this.account=control();this.client=control();
  this.files=[control({rcFile:'statement'}),control({rcFile:'invoices'})];this.progress=[control(),control()];
 }});
 root.innerHTML='';return root;
}
const clients=[{id:4,name:'合成本方公司',standard:'small2013',start_period:'2026-01'}];
async function receiptFixture({receiptError=false,receiptReview='',invoiceUnmatched=false,transaction={},withInvoice=false,batchError=false,bookError=false,bookPending=false,unknownClient=false,withReceipt=true,malformedBatch=false,extraTransaction=false}={}){
 resetReconcile();
 const root=fixtureHost(),calls=[],opened=[];
 const tx={date:'2026-09-15',amount:'155200.00',counterparty:'合成交易公司',note:'合成业务',...transaction};
 const fixtureApi=async (url,options)=>{
  calls.push({url,options});
  if(url==='/api/reconcile/parse/start')return {job_id:'synthetic-job'};
  if(url.startsWith('/api/reconcile/parse/progress?'))return {status:'completed',result:{account_name:unknownClient?'尚未建档的本方公司':clients[0].name,transactions:extraTransaction?[tx,{...tx,date:'2026-09-16',amount:'20.00'}]:[tx],invoices:withInvoice?[invoice]:[],receipts:withReceipt?[{...tx,number:'SYNTHETIC-RECEIPT'}]:[]}};
  if(url==='/api/reconcile/match')return {matches:[{transaction_index:0,invoice_index:withInvoice&&!invoiceUnmatched?0:null,status:withInvoice&&!invoiceUnmatched?'matched':'review'},...(extraTransaction?[{transaction_index:1,invoice_index:null,status:'review',reasons:['未找到唯一匹配发票']}]:[])],receipt_matches:{matches:withReceipt?[{transaction_index:0,receipt_index:0,status:'matched'}]:[]},unmatched_invoices:[]};
  if(url==='/api/reconcile/receipt-post'){
   if(unknownClient)throw new Error('本方名称必须与客户名称或企业全称一致');
   if(receiptError)throw new Error('synthetic receipt service failed');
   if(receiptReview)return {rows:[{transaction_index:0,status:'review',reason:receiptReview}]};
   return {rows:[{...posted,period:'2026-09'}]};
  }
  if(url.startsWith('/api/books/')){if(bookError)throw new Error('synthetic book display failed');if(bookPending)return new Promise(()=>{});return {accounts:[]};}
  if(url==='/api/reconcile/batch-auto'){
   if(unknownClient)throw new Error('本方名称必须与客户名称或企业全称一致');
   if(batchError)throw new Error('本方名称必须与客户名称或企业全称一致');
   if(malformedBatch==='null-row')return {rows:[null]};
   if(malformedBatch==='duplicate-index')return {rows:[posted,posted]};
   if(malformedBatch)return {};
   if(invoiceUnmatched)return {rows:[{transaction_index:0,invoice_index:null,status:'review',reason:'未找到唯一匹配发票'}],unmatched_invoices:[]};
   return {client_name:clients[0].name,rows:[{...posted,invoice_index:0}],unmatched_invoices:[]};
  }
  if(url==='/api/reconcile/retry-saved')return {rows:[]};
  throw new Error('Unexpected fixture route: '+url);
 };
 root.innerHTML=renderReconcile(clients);bindReconcile(root,fixtureApi,clients,summary=>opened.push(summary));
 // Upload archives are bound to an explicitly selected company before OCR.
 root.client.value=String(clients[0].id);await root.client.handlers.get('change')({target:root.client});
 const file=new Blob(['synthetic input'],{type:'application/pdf'});file.name='synthetic.pdf';
 root.files[0].files=[file];await root.files[0].handlers.get('change')();
 const action=name=>({dataset:{rcAction:name},textContent:'',closest(selector){return selector==='[data-rc-action]'?this:null;}});
 await root.onclick({target:action('parse')});
 const parsedHtml=root.innerHTML;
 if(parsedHtml.includes('data-rc-action="show-balance"'))await root.onclick({target:action('show-balance')});
 return {root,calls,opened,html:parsedHtml};
}
const previousReader=globalThis.FileReader,previousAlert=globalThis.alert;
const alerts=[];
globalThis.FileReader=class {readAsDataURL(){this.result='data:application/pdf;base64,c3ludGhldGlj';queueMicrotask(()=>this.onload());}};
globalThis.alert=message=>alerts.push(message);
try{
 const result=await receiptFixture();
 assert.match(result.html,/data-rc-action="show-balance"/,'Receipt-only posting must expose balance navigation.');
 assert.match(result.html,/已入账 <b>1<\/b>/);
 assert.match(result.html,/待处理 <b>0<\/b>/);
 assert.equal(result.opened.length,1);
 assert.equal(result.opened[0].clientId,4);
 assert.deepEqual(result.opened[0].postings,[{period:'2026-09',voucher_id:7,posted_lines:posted.posted_lines}]);
 assert.ok(!result.calls.some(request=>request.url==='/api/reconcile/batch-auto'),'Receipt-only processing does not send an empty invoice batch.');

 const failed=await receiptFixture({receiptError:true});
 assert.match(failed.html,/synthetic receipt service failed/);
 assert.match(failed.html,/已入账 <b>0<\/b>/);
 assert.match(failed.html,/待处理 <b>1<\/b>/,'A matched receipt stays pending when its posting request fails.');
 assert.doesNotMatch(failed.html,/正在核对入账/,'A failed request must end its processing status.');
 assert.doesNotMatch(failed.html,/data-rc-action="show-balance"/);
 assert.equal(failed.opened.length,0);

 const mixed=await receiptFixture({withInvoice:true});
 assert.match(mixed.html,/已入账 <b>1<\/b>/,'A transaction reported by both sources is counted once.');
 assert.equal(mixed.opened[0].postings.length,1,'Balance navigation deduplicates the same voucher.');
 assert.equal(alerts.length,0,alerts.join('\n'));
 assert.equal(mixed.calls.find(call=>call.url==='/api/reconcile/batch-auto').options.body.receipts.length,1);

 const rejected=await receiptFixture({withInvoice:true,receiptError:true,batchError:true});
 assert.doesNotMatch(rejected.html,/正在核对入账/);
 assert.match(rejected.html,/本方名称必须与客户名称或企业全称一致/);
 assert.match(rejected.html,/已入账 <b>0<\/b>/);
 assert.match(rejected.html,/待处理 <b>1<\/b>/);

 const unidentified=await receiptFixture({unknownClient:true,withInvoice:true});
 assert.doesNotMatch(unidentified.html,/正在核对入账/);
 assert.match(unidentified.html,/本方名称必须与客户名称或企业全称一致/);
 assert.ok(unidentified.calls.filter(call=>['/api/reconcile/receipt-post','/api/reconcile/batch-auto'].includes(call.url)).every(call=>call.options.body.client_id===4),'OCR names must not transfer original-file archives to another company.');
 assert.match(unidentified.html,/已入账 <b>0<\/b>/);

 const bookFailure=await receiptFixture({withInvoice:true,withReceipt:false,bookError:true});
 assert.match(bookFailure.html,/已入账 <b>1<\/b>/,'Optional account display data cannot prevent invoice posting.');
 assert.ok(bookFailure.calls.findIndex(call=>call.url==='/api/reconcile/batch-auto')<bookFailure.calls.findIndex(call=>call.url.startsWith('/api/books/')));
 assert.doesNotMatch(bookFailure.html,/正在核对入账|synthetic book display failed/);

 const slowBook=await receiptFixture({withInvoice:true,withReceipt:false,bookPending:true});
 assert.match(slowBook.html,/已入账 <b>1<\/b>/,'A display request that never finishes cannot delay the final posting status.');
 assert.doesNotMatch(slowBook.html,/正在核对入账|正在识别/);

 for(const options of [{withInvoice:true,batchError:true},{withInvoice:true,receiptError:true}]){
  const recovered=await receiptFixture(options);
  assert.match(recovered.html,/已入账 <b>1<\/b>/);
  assert.match(recovered.html,/待处理 <b>0<\/b>/);
  assert.match(recovered.html,/data-rc-preview-status aria-live="polite"><\/p>/,'A successful alternative posting clears stale request failures.');
 }

 const partial=await receiptFixture({withInvoice:true,batchError:true,extraTransaction:true});
 assert.match(partial.html,/已入账 <b>1<\/b>/);
 assert.match(partial.html,/待处理 <b>1<\/b>/);
 assert.doesNotMatch(partial.html,/正在核对入账/);
 assert.equal(partial.opened[0].postings.length,1,'Partial batch failure preserves an actual posted receipt.');

 const malformed=await receiptFixture({withInvoice:true,withReceipt:false,malformedBatch:true});
 assert.match(malformed.html,/未收到完整的入账结果/);
 assert.match(malformed.html,/已入账 <b>0<\/b>/);
 assert.doesNotMatch(malformed.html,/正在核对入账/);
 for(const malformedBatch of ['null-row','duplicate-index']){
  const invalidRows=await receiptFixture({withInvoice:true,withReceipt:false,malformedBatch,extraTransaction:malformedBatch==='duplicate-index'});
  assert.match(invalidRows.html,/未收到完整的入账结果/);
  assert.doesNotMatch(invalidRows.html,/正在核对入账/);
 }

 const noDocument=await receiptFixture({withReceipt:false});
 assert.match(noDocument.html,/已入账 <b>0<\/b>/);
 assert.match(noDocument.html,/待处理 <b>1<\/b>/);
 assert.doesNotMatch(noDocument.html,/正在核对入账/);
 const receiptBlocked=await receiptFixture({withInvoice:true,invoiceUnmatched:true,receiptReview:'回单实际入账原因',transaction:{counterparty:'',note:'惠享服务'}});
 assert.match(receiptBlocked.html,/回单核对通过/);
 assert.match(receiptBlocked.html,/回单实际入账原因/);
 assert.match(receiptBlocked.html,/银行回单 SYNTHETIC-RECEIPT/);
 assert.doesNotMatch(receiptBlocked.html,/待匹配发票|未找到唯一匹配发票/,'A matched receipt must show its own result rather than an unrelated invoice failure.');
 for(const transaction of [
  {date:'2026-09-21',amount:'4.20',counterparty:'',note:'利息'},
  {date:'2026-08-27',amount:'-300.00',counterparty:'',note:'惠享服务'},
  {date:'2026-08-27',amount:'-100.00',counterparty:'',note:'惠享服务'}
 ]){
  const bankOnly=await receiptFixture({withInvoice:true,invoiceUnmatched:true,transaction});
  assert.match(bankOnly.html,/回单核对通过/);
  assert.match(bankOnly.html,/已入账 <b>1<\/b>/);
  assert.match(bankOnly.html,/待处理 <b>0<\/b>/);
  assert.doesNotMatch(bankOnly.html,/待匹配发票|未找到唯一匹配发票/);
 }
 assert.equal(alerts.length,0,alerts.join('\n'));
 console.log('matched invoice/receipt posting, actual entry status, navigation, failure counts and voucher deduplication passed');
}finally{
 resetReconcile();
 if(previousReader===undefined)delete globalThis.FileReader;else globalThis.FileReader=previousReader;
 if(previousAlert===undefined)delete globalThis.alert;else globalThis.alert=previousAlert;
}
