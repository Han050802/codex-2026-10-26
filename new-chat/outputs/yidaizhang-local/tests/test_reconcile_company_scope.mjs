import assert from 'node:assert/strict';
import {bindReconcile, renderReconcile, resetReconcile, setReconcileCompany} from '../public/reconcile.js';

// Synthetic DOM and documents only: no server, real company, or business data.
const clients = [
 {id:41,name:'SYNTHETIC COMPANY A',enterprise_name:'SYNTHETIC ENTERPRISE A',standard:'small2013',start_period:'2026-01'},
 {id:42,name:'SYNTHETIC COMPANY B',enterprise_name:'SYNTHETIC ENTERPRISE B',standard:'small2013',start_period:'2026-01'}
];
const transaction = {date:'2026-09-15',amount:'10.00',counterparty:'SYNTHETIC COUNTERPARTY',note:'SYNTHETIC TRANSACTION A'};
const invoice = {date:'2026-09-15',amount:'10.00',seller:clients[1].enterprise_name,buyer:transaction.counterparty,number:'SYNTHETIC INVOICE A'};
const posted = {transaction_index:0,invoice_index:0,status:'posted',voucher_id:7001,voucher_ref:'SYNTHETIC VOUCHER A',period:'2026-09',posted_lines:[]};

function control(dataset={}) {
 return {dataset,disabled:false,hidden:false,value:'',files:[],handlers:new Map(),addEventListener(type,handler){this.handlers.set(type,handler);}};
}
function fixtureHost() {
 const root = {isConnected:true,onclick:null,contains(node){return node===this.page;},querySelector(selector){
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
  this.files=[control({rcFile:'statement'}),control({rcFile:'invoices'})];
  this.progress=[control({rcProgress:'statement'}),control({rcProgress:'invoice'})];
 }});
 root.innerHTML='';return root;
}
function action(name) {
 return {dataset:{rcAction:name},textContent:'',closest(selector){return selector==='[data-rc-action]'?this:null;}};
}
const click = (root,name) => root.onclick({target:action(name)});
function deferred() {
 let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};
}
function mount(root,api,client,onPosted=()=>{}) {
 root.innerHTML=renderReconcile(clients,{client});bindReconcile(root,api,clients,onPosted,{client});
}
function assertCurrentCompany(root,client) {
 const select=root.innerHTML.match(/<select data-rc-client[^>]*>[\s\S]*?<\/select>/)?.[0];
 assert.ok(select,'The current company selector must be rendered.');
 assert.match(select,/<select data-rc-client disabled>/,'Company-scoped reconciliation must fix the current book.');
 assert.equal((select.match(/<option /g)||[]).length,1,'Other company books must not be selectable.');
 assert.ok(select.includes(`<option value="${client.id}" selected>${client.name}</option>`));
}
function fixtureApi({pauseRoute}={}) {
 const calls=[],entered=deferred(),release=deferred();
 const api=async(url,options)=>{
  calls.push({url,options});
  if(url===pauseRoute){entered.resolve();await release.promise;}
  if(url==='/api/reconcile/parse/start')return {job_id:'synthetic-company-job'};
  if(url.startsWith('/api/reconcile/parse/progress?'))return {status:'completed',result:{
   archive_id:'synthetic_archive_for_company_a_001',account_name:clients[1].enterprise_name,transactions:[transaction],invoices:[invoice],
   receipts:[{...transaction,number:'SYNTHETIC RECEIPT A'}],warnings:['SYNTHETIC WARNING A']
  }};
  if(url==='/api/reconcile/match')return {matches:[{transaction_index:0,invoice_index:0,status:'matched'}],receipt_matches:{matches:[{transaction_index:0,receipt_index:0,status:'matched'}]},unmatched_invoices:[]};
  if(url==='/api/reconcile/receipt-post'||url==='/api/reconcile/batch-auto')return {rows:[posted],client_name:clients[0].name,unmatched_invoices:[]};
  if(url==='/api/reconcile/retry-saved')return {rows:[]};
  if(url.startsWith('/api/books/'))return {accounts:[]};
  if(url.startsWith('/api/reconcile/records?'))return {records:[{id:99,transaction:{...transaction,counterparty:'SYNTHETIC HISTORY A'},invoice,voucher_id:7001}]};
  throw new Error('Unexpected synthetic route: '+url);
 };
 return {api,calls,entered:entered.promise,release:release.resolve};
}
async function selectStatement(root) {
 const file=new Blob(['synthetic input'],{type:'application/pdf'});file.name='synthetic-company-a.pdf';
 root.files[0].files=[file];await root.files[0].handlers.get('change')();
}

const previousReader=globalThis.FileReader,previousAlert=globalThis.alert,alerts=[];
globalThis.FileReader=class {readAsDataURL(){this.result='data:application/pdf;base64,c3ludGhldGlj';queueMicrotask(()=>this.onload());}};
globalThis.alert=message=>alerts.push(message);
try {
 resetReconcile();
 const root=fixtureHost(),fixture=fixtureApi(),opened=[];
 mount(root,fixture.api,clients[0],summary=>opened.push(summary));
 assertCurrentCompany(root,clients[0]);
 await selectStatement(root);
 await click(root,'parse');
 assert.match(root.innerHTML,/SYNTHETIC TRANSACTION A/,'The fixture must actually import a transaction.');
 assert.match(root.innerHTML,/data-rc-account value="SYNTHETIC ENTERPRISE B"/,'Keep OCR text available for review when it names another company.');
 assertCurrentCompany(root,clients[0]);
 assert.ok(fixture.calls.some(call=>call.url==='/api/reconcile/receipt-post'));
 assert.ok(fixture.calls.some(call=>call.url==='/api/reconcile/batch-auto'));
 assert.equal(fixture.calls.find(call=>call.url==='/api/reconcile/parse/start').options.body.client_id,clients[0].id);
 for(const call of fixture.calls.filter(call=>['/api/reconcile/match','/api/reconcile/receipt-post','/api/reconcile/batch-auto'].includes(call.url)))assert.equal(call.options.body.archive_id,'synthetic_archive_for_company_a_001',call.url+' must retain the archived originals.');
 assert.match(root.innerHTML,/本批原件已归档/);
 await click(root,'show-balance');
 assert.equal(opened[0].clientId,clients[0].id,'Balance navigation must retain the open company.');

 // Both editable account text and a forged change on the disabled selector
 // must keep every matching/posting request inside the open company book.
 root.account.value=clients[1].enterprise_name;
 root.account.handlers.get('input')({target:root.account});
 await root.account.handlers.get('change')({target:root.account});
 root.client.value=String(clients[1].id);
 await root.client.handlers.get('change')({target:root.client});
 await click(root,'match');
 await click(root,'history');
 assert.match(root.innerHTML,/SYNTHETIC HISTORY A/);
 const scoped=fixture.calls.filter(call=>['/api/reconcile/match','/api/reconcile/receipt-post','/api/reconcile/batch-auto','/api/reconcile/retry-saved'].includes(call.url));
 assert.ok(scoped.length>=8,'Exercise OCR and subsequent manual reprocessing.');
 for(const call of scoped)assert.equal(call.options.body.client_id,clients[0].id,call.url+' must use the open company, regardless of recognized or edited names.');
 assert.ok(scoped.filter(call=>call.url==='/api/reconcile/match').every(call=>call.options.body.account_name===clients[1].enterprise_name));
 assert.ok(fixture.calls.some(call=>call.url==='/api/reconcile/records?client_id='+clients[0].id));

 setReconcileCompany(clients[1]);
 mount(root,fixture.api,clients[1]);
 assertCurrentCompany(root,clients[1]);
 assert.match(root.innerHTML,/data-rc-account value="SYNTHETIC ENTERPRISE B"/);
 for(const marker of ['synthetic_archive_for_company_a_001','SYNTHETIC TRANSACTION A','SYNTHETIC INVOICE A','SYNTHETIC RECEIPT A','SYNTHETIC HISTORY A','SYNTHETIC VOUCHER A','SYNTHETIC WARNING A','synthetic-company-a.pdf','data-rc-action="show-balance"']){
  assert.ok(!root.innerHTML.includes(marker),'A company switch must clear previous company data: '+marker);
 }
 mount(root,fixture.api,clients[0]);
 assertCurrentCompany(root,clients[0]);
 assert.match(root.innerHTML,/data-rc-account value="SYNTHETIC ENTERPRISE A"/);
 assert.doesNotMatch(root.innerHTML,/SYNTHETIC TRANSACTION A|synthetic-company-a\.pdf/,'Returning to a company must not restore another scope\'s import.');

 // Resolve an old match, or an already-issued receipt request, only after
 // switching companies. Neither response may start another posting request,
 // overwrite the new screen, or restore old balance navigation.
 for(const pauseRoute of ['/api/reconcile/match','/api/reconcile/receipt-post']){
  resetReconcile();
  const pendingRoot=fixtureHost(),pending=fixtureApi({pauseRoute});
  mount(pendingRoot,pending.api,clients[0]);
  await selectStatement(pendingRoot);
  const processing=click(pendingRoot,'parse');
  await pending.entered;
  const requestsBeforeSwitch=pending.calls.length;
  setReconcileCompany(clients[1]);
  mount(pendingRoot,pending.api,clients[1]);
  const newCompanyHtml=pendingRoot.innerHTML;
  pending.release();await processing;
  assert.equal(pending.calls.length,requestsBeforeSwitch,'A stale '+pauseRoute+' response must not start subsequent network requests.');
  assert.equal(pendingRoot.innerHTML,newCompanyHtml,'A stale response must not replace the new company screen.');
  assertCurrentCompany(pendingRoot,clients[1]);
  assert.doesNotMatch(pendingRoot.innerHTML,/SYNTHETIC TRANSACTION A|SYNTHETIC VOUCHER A|data-rc-action="show-balance"/);
 }
 assert.deepEqual(alerts,[],'Stale processing must stop silently after switching companies.');
 console.log('company-scoped reconciliation, import reset and stale-response isolation passed');
} finally {
 resetReconcile();
 if(previousReader===undefined)delete globalThis.FileReader;else globalThis.FileReader=previousReader;
 if(previousAlert===undefined)delete globalThis.alert;else globalThis.alert=previousAlert;
}
