import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseHTML} from 'linkedom';

// Run only through the disposable service runner alongside this file.
const base = process.argv[2];
assert(base, 'Run python work/ui-tests/run-progress-linkage.py');
const address = new URL(base);
assert.equal(address.hostname, '127.0.0.1');
assert(!['8765', '8766'].includes(address.port), 'Never use a running user service');
const root = fileURLToPath(new URL('../../outputs/yidaizhang-local/', import.meta.url));
const nativeFetch = globalThis.fetch, traffic = [], errors = [], scenarios = [];
let cookie = '';
process.on('unhandledRejection', error => errors.push(error));
globalThis.fetch = async (path, options = {}) => {
  const url = new URL(path, base);
  assert.equal(url.origin, address.origin);
  const headers = {Origin: base, Connection: 'close', ...options.headers};
  if (cookie) headers.Cookie = cookie;
  const response = await nativeFetch(url, {...options, headers});
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  traffic.push({method: options.method || 'GET', path: url.pathname, status: response.status});
  return response;
};
assert.equal((await (await fetch('/api/health')).json()).demo, true);
const login = await fetch('/api/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username: 'demo1', password: 'DemoOnly123!'})});
assert.equal(login.status, 200);
const {window} = parseHTML(await readFile(new URL('../../outputs/yidaizhang-local/public/index.html', import.meta.url), 'utf8'));
globalThis.window = window; globalThis.document = window.document; globalThis.CustomEvent = window.CustomEvent;
window.location = {href: base + '/', assign() {}}; window.history = {replaceState() {}}; window.print = () => {};
window.HTMLElement.prototype.reportValidity = () => true;
Object.defineProperty(window.HTMLElement.prototype, 'checked', {configurable: true, get() {return this.hasAttribute('checked');}, set(value) {this.toggleAttribute('checked', Boolean(value));}});
Object.defineProperty(window.HTMLElement.prototype, 'elements', {configurable: true, get() {const nodes = [...this.querySelectorAll('input,select,textarea,button')]; return new Proxy(nodes, {get(target, key) {return key in target ? target[key] : nodes.find(el => el.getAttribute('name') === key);}});}});
Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {configurable: true, get() {return (this.querySelector('option[selected]') || this.querySelector('option'))?.getAttribute('value') || '';}, set(value) {for (const option of this.querySelectorAll('option')) option.toggleAttribute('selected', option.getAttribute('value') === String(value));}});
globalThis.FormData = class {constructor(form) {this.list = [...form.querySelectorAll('input[name],select[name],textarea[name]')].filter(el => !el.disabled && (!['checkbox','radio'].includes(el.type) || el.checked)).map(el => [el.name, el.value]);} entries() {return this.list[Symbol.iterator]();}};
const $ = (selector, within = document) => within.querySelector(selector);
const $$ = (selector, within = document) => [...within.querySelectorAll(selector)];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, label) {for (let i = 0; i < 180; i++) {if (errors.length) throw errors.shift(); if (await predicate()) return; await delay(20);} throw new Error('Timed out: ' + label + '; ' + document.body.textContent.slice(-400));}
function click(el, label = '') {assert(el, 'Missing control ' + label); assert(!el.disabled); el.dispatchEvent(new window.Event('click', {bubbles: true, cancelable: true}));}
function change(el) {el.dispatchEvent(new window.Event('change', {bubbles: true, cancelable: true}));}
const frontend = await import(pathToFileURL(root + '/public/app.js').href + '?progress-linkage=' + Date.now());
await waitFor(() => $('.progress-card'), 'app bootstrap');
const api = frontend.api;
let boot = await api('/api/bootstrap');
assert.deepEqual(boot.clients, [], 'Runner must start with a completely empty disposable customer database');
const month = '2026-09', nextMonth = '2026-10';
const companies = [];
for (const label of ['A','B']) companies.push(await api('/api/clients', {method:'POST', body:{name:'合成状态联动公司' + label, code:'PROGRESS-' + label, standard:'small2013', taxpayer_type:'small', start_period:month, accountant_id:1}}));
const [a,b] = companies;
async function refresh() {const before = traffic.length; click($('[data-action="refresh"]')); await waitFor(() => traffic.slice(before).some(r => r.path === '/api/bootstrap'), 'bootstrap refresh request'); await delay(45);}
async function setPeriod(period) {const input = $('[data-filter="period"]'); assert(input); input.value = period; change(input); await waitFor(() => $('[data-filter="period"]')?.value === period && !!$(`[data-action="company-home"][data-id="${a.id}"]`), 'period render'); await delay(60);}
const headers = ['人工确认记录','票据进度','记账进度','申报记录','缴款记录','个税记录'];
function states(id) {const row = $(`[data-action="company-home"][data-id="${id}"]`)?.closest('tr'); assert(row, 'Missing company row ' + id); const table = row.closest('table'), labels = $$('thead th', table).map(el => el.textContent.trim()), cells = $$('td', row); return headers.map(label => {const index = labels.indexOf(label); assert(index >= 0, 'Missing header ' + label); return cells[index].textContent.trim();});}
const blank = ['未登记','未登记','未记账','未登记','未登记','未登记'];
function expectRows(expectedA, expectedB = blank) {assert.deepEqual(states(a.id), expectedA, 'Company A six status columns'); assert.deepEqual(states(b.id), expectedB, 'Company B six status columns');}
function expectCards(expected) {assert.equal($$('.progress-card').length, 5); for (let i=0; i<5; i++) for (let j=0; j<3; j++) assert.equal(Number($(`[data-action="progress-filter"][data-value="${i}:${j}"] b`).textContent), expected[i][j], `Card ${i}, status ${j}`);}
function initialCards() {expectCards(Array.from({length:5}, () => [2,0,0]));}
await refresh(); await setPeriod(month); expectRows(blank); initialCards(); scenarios.push('Empty books show unregistered/unbooked consistently in six columns and five cards');
const invoice = await api('/api/invoices', {method:'POST', body:{client_id:a.id, period:month, date:month+'-15', kind:'output', number:'PROGRESS-INVOICE', summary:'合成销售票据', category:'销售', amount_fen:10000, tax_fen:0, total_fen:10000}});
await refresh();
let current = ['未登记','已登记·待制证','未记账','未登记','未登记','未登记'];
expectRows(current); expectCards([[2,0,0],[1,1,0],[2,0,0],[2,0,0],[2,0,0]]);
scenarios.push('Manual invoice registration updates only its company and pending-voucher card');

// A write while an already open book is displayed must be visible after the
// actual workbench back control; a cached render alone is insufficient.
click($(`[data-action="company-home"][data-id="${a.id}"]`)); await waitFor(() => $('.cw-shell'), 'company home open');
const voucher = await api(`/api/books/${a.id}/vouchers`, {method:'POST', body:{date:month+'-15', summary:'合成手工凭证', attachment_count:2, lines:[{account_code:'1002', debit_fen:10000, credit_fen:0, cashflow_category:'operating'},{account_code:'5001', debit_fen:0, credit_fen:10000, cashflow_category:'unclassified'}]}});
const backStart = traffic.length; click($('[data-cw-action="back"]'), 'return workbench'); await waitFor(() => $('.progress-card'), 'workbench back');
assert(traffic.slice(backStart).some(r => r.path === '/api/bootstrap'), 'Returning to workbench must reload authoritative data');
current[2] = '已记账'; expectRows(current); expectCards([[2,0,0],[1,1,0],[1,1,0],[2,0,0],[2,0,0]]);
scenarios.push('Real voucher and company back control reload bootstrap and show 已记账 without closing');
let tax = await api('/api/tax-records', {method:'POST', body:{client_id:a.id,period:month,tax_type:'增值税',status:'pending',payment_status:'unpaid',confirmation_status:'pending',amount_fen:1300,paid_fen:0,source:'manual'}});
await refresh(); current = ['待确认','已登记·待制证','已记账','已登记·准备中','待缴款','未登记']; expectRows(current); expectCards([[1,1,0],[1,1,0],[1,1,0],[1,1,0],[2,0,0]]);
tax = await api(`/api/tax-records/${tax.id}`, {method:'PATCH',body:{version:tax.version,status:'submitted',payment_status:'paid',confirmation_status:'confirmed',paid_fen:1300,reference:'SYNTHETIC-ACK-VAT'}});
await refresh(); current = ['已确认','已登记·待制证','已记账','已登记申报','已登记缴款','未登记']; expectRows(current); expectCards([[1,0,1],[1,1,0],[1,1,0],[1,0,1],[2,0,0]]);
scenarios.push('Pending and submitted/paid/confirmed VAT records update real declaration, payment and confirmation states');
let individual = await api('/api/tax-records', {method:'POST', body:{client_id:a.id,period:month,tax_type:'个人所得税',status:'pending',payment_status:'unpaid',confirmation_status:'pending',amount_fen:300,paid_fen:0,source:'manual'}});
await refresh(); current[0] = '待确认'; current[4] = '待缴款'; current[5] = '已登记·准备中'; expectRows(current); expectCards([[1,1,0],[1,1,0],[1,1,0],[1,0,1],[1,1,0]]);
individual = await api(`/api/tax-records/${individual.id}`, {method:'PATCH',body:{version:individual.version,status:'submitted',payment_status:'paid',confirmation_status:'confirmed',paid_fen:300,reference:'SYNTHETIC-ACK-IIT'}});
await refresh(); current[0] = '已确认'; current[4] = '已登记缴款'; current[5] = '已登记申报'; expectRows(current); expectCards([[1,0,1],[1,1,0],[1,1,0],[1,0,1],[1,0,1]]);
scenarios.push('Individual tax has an independent declaration column and participates in truthful aggregate confirmation/payment');

const bTax = await api('/api/tax-records', {method:'POST',body:{client_id:b.id,period:nextMonth,tax_type:'个人所得税',status:'submitted',payment_status:'paid',confirmation_status:'confirmed',amount_fen:0,paid_fen:0,reference:'SYNTHETIC-B-OCT',source:'manual'}});
await refresh(); expectRows(current); await setPeriod(nextMonth);
expectRows(blank,['已确认','未登记','未记账','未登记','已登记缴款','已登记申报']); expectCards([[1,0,1],[2,0,0],[2,0,0],[2,0,0],[1,0,1]]);
await setPeriod(month); expectRows(current); scenarios.push('Two companies and two months remain isolated while cards follow selected month');

let posted = await api(`/api/invoices/${invoice.id}/post`, {method:'POST',body:{version:invoice.version,debit_account:'1122',credit_account:'5001',tax_account:'2221'}});
await refresh(); current[1] = '已制证'; expectRows(current); expectCards([[1,0,1],[1,0,1],[1,1,0],[1,0,1],[1,0,1]]);
let book = await api(`/api/books/${a.id}?period=${month}`), sourceVoucher = book.vouchers.find(v => v.id === posted.voucher_id); assert(sourceVoucher);
await api(`/api/books/${a.id}/vouchers/${sourceVoucher.id}/withdraw`, {method:'POST',body:{version:sourceVoucher.version,reason:'合成回归撤回'}});
await refresh(); current[1] = '已登记·待制证'; expectRows(current);
boot = await api('/api/bootstrap'); posted = boot.invoices.find(i => i.id === invoice.id);
await api(`/api/invoices/${posted.id}`, {method:'DELETE',body:{version:posted.version}});
await api(`/api/books/${a.id}/vouchers/${voucher.id}`, {method:'DELETE',body:{version:voucher.version}});
await refresh(); current[1] = '未登记'; current[2] = '未记账'; expectRows(current); expectCards([[1,0,1],[2,0,0],[2,0,0],[1,0,1],[1,0,1]]);
await api(`/api/tax-records/${tax.id}`, {method:'DELETE',body:{version:tax.version}}); await refresh(); current[3] = '未登记'; expectRows(current);
await api(`/api/tax-records/${individual.id}`, {method:'DELETE',body:{version:individual.version}}); await refresh(); expectRows(blank); initialCards();
await setPeriod(nextMonth); expectRows(blank,['已确认','未登记','未记账','未登记','已登记缴款','已登记申报']);
scenarios.push('Invoice posting, withdrawal, deletion, voucher voiding and tax deletion all revert statuses without affecting another company/month');

// Returning from another top-level view also reloads, avoiding stale home rows.
click($('[data-nav="收费"]')); await waitFor(() => $('[data-nav="收费"].active'), 'fees navigation'); await delay(35);
await api(`/api/tax-records/${bTax.id}`, {method:'DELETE',body:{version:bTax.version}});
const navStart = traffic.length; click($('[data-nav="首页"]')); await waitFor(() => $('.progress-card'), 'home navigation');
assert(traffic.slice(navStart).some(r => r.path === '/api/bootstrap'), 'Entering 首页 must reload authoritative data'); expectRows(blank); initialCards();
scenarios.push('Top-level navigation home reloads externally changed records');
assert.equal(errors.length, 0); assert(!$('.page-error'));
assert(traffic.filter(r => !['GET'].includes(r.method)).every(r => r.status === 200), 'Every synthetic mutation must succeed');
console.log(JSON.stringify({ok:true, scenarios, requests:traffic.length, writes:traffic.filter(r => r.method !== 'GET').length, note:'All writes were restricted to an unseeded TemporaryDirectory database; no production/demo database opened.'}, null, 2));
