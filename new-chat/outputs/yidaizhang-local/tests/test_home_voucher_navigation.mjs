import assert from 'node:assert/strict';
import {bindBook, renderBook, setBookView} from '../public/finance-ui.js';
import {renderCompanyHome} from '../public/company-workspace.js';
import {companyVouchersTest as vouchers, focusCompanyVoucher, resetCompanyVoucherFilters} from '../public/company-vouchers.js';

const currentPeriod = '2026-10';
const historyPeriod = '2025-08';
const visibleText = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
};
const voucher = (id, period, attachments = 0) => ({
  id, date: `${period}-15`, number: id, summary: `真实凭证 ${id}`,
  source_type: 'manual', status: 'active', reviewed: false, version: 1,
  attachment_count: attachments,
  lines: [
    {account_code: '1001', account_name: '库存现金', debit_fen: 12345, credit_fen: 0},
    {account_code: '2202', account_name: '应付账款', debit_fen: 0, credit_fen: 12345},
  ],
});
const makeBook = (client, period) => ({
  client, period, periods: [], opening_balances: [], trial_balance: [],
  accounts: [{code: '1001', name: '库存现金'}, {code: '2202', name: '应付账款'}],
  vouchers: period === historyPeriod
    ? [voucher(51, period, 1), voucher(52, period, 2)]
    : [voucher(61, period, 2)],
  dashboard: {
    voucher_count: period === historyPeriod ? 2 : 1,
    attachment_count: period === historyPeriod ? 3 : 2,
    voucher_history: {
      voucher_count: 3, attachment_count: 5,
      periods: [
        {period: currentPeriod, voucher_count: 1, attachment_count: 2},
        {period: historyPeriod, voucher_count: 2, attachment_count: 3},
      ],
    },
  },
});
function addOldFilters(state) {
  Object.assign(state, {
    query: '不应继续保留的搜索', status: 'void', source: 'invoice',
    dateFrom: '2026-10-01', dateTo: '2026-10-31', min: '999', max: '1000',
    page: 7, size: 20, focusId: '99999', scrollToSaved: '99998',
  });
  state.selected.add('99997');
}
function assertReset(state) {
  assert.equal(state.query, '');
  assert.equal(state.status, 'active');
  for (const field of ['source', 'dateFrom', 'dateTo', 'min', 'max']) assert.equal(state[field], '', `${field} must reset.`);
  assert.equal(state.page, 1);
  assert.equal(state.size, 20, 'Opening from home keeps the user’s page-size preference.');
  assert.equal(state.selected.size, 0);
  assert.ok(state.focusId == null, 'An earlier saved-row target must not survive a home entry.');
  assert.ok(state.scrollToSaved == null, 'An earlier scroll target must not survive a home entry.');
}

// A home entry resets only its target company/month, while saved-voucher
// navigation still focuses the requested row after clearing old filters.
const resetClient = {id: 886101, name: '筛选隔离测试', start_period: '2025-01'};
const resetBook = makeBook(resetClient, historyPeriod);
const state = vouchers.stateFor(resetBook);
const otherCompanyState = vouchers.stateFor(makeBook({...resetClient, id: 886102}, historyPeriod));
const otherMonthState = vouchers.stateFor(makeBook(resetClient, currentPeriod));
for (const item of [state, otherCompanyState, otherMonthState]) addOldFilters(item);
assert.equal(resetCompanyVoucherFilters(resetClient.id, historyPeriod), true);
assertReset(state);
assert.equal(otherCompanyState.query, '不应继续保留的搜索');
assert.equal(otherMonthState.query, '不应继续保留的搜索');
assert.equal(resetCompanyVoucherFilters('invalid', historyPeriod), false);
assert.equal(resetCompanyVoucherFilters(resetClient.id, '2025-13'), false);
addOldFilters(state);
assert.equal(focusCompanyVoucher(resetClient.id, historyPeriod, 52), true);
assert.equal(state.focusId, '52');
assert.equal(state.query, '');
assert.equal(state.status, 'active');
assert.equal(state.selected.size, 0);
assert.equal(state.size, 20);
assert.equal(state.scrollToSaved, null);

// Current-month numbers and all-period history remain visibly separate.
const home = renderCompanyHome(makeBook(resetClient, currentPeriod));
const statisticButtons = [...home.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
  .filter(([, attributes]) => /\bcw-stat-value\b/.test(attributes));
assert.equal(statisticButtons.length, 2);
assert.deepEqual(statisticButtons.map(([, , content]) => visibleText(content).replace(/\s/g, '')), ['1张', '2张']);
for (const [, attributes] of statisticButtons) assert.match(attributes, /data-cw-vouchers="2026-10"/);
assert.match(home, /凭证\(2026\/10\)/);
const historyDetails = [...home.matchAll(/<details\b[\s\S]*?<\/details>/g)]
  .map(([html]) => html).find(html => /全部期间/.test(html));
assert.ok(historyDetails, 'Home exposes all-period history in an expandable entry.');
assert.match(visibleText(historyDetails), /全部期间.*3.*5/);
assert.match(historyDetails, /data-cw-vouchers="2025-08"/);
assert.match(historyDetails, /data-cw-vouchers="2026-10"/);

const emptyBook = makeBook(resetClient, currentPeriod);
emptyBook.vouchers = [];
emptyBook.dashboard = {voucher_count: 0, attachment_count: 0, voucher_history: {voucher_count: 0, attachment_count: 0, periods: []}};
const emptyHome = renderCompanyHome(emptyBook);
assert.match(visibleText(emptyHome), /全部期间\s*0/);
assert.doesNotMatch(emptyHome, /data-cw-vouchers="2025-08"/);

// Exercise the actual home event delegation and finance workspace actions.
// This host implements only the DOM methods used by those public bindings.
let fixtureId = 886200;
async function fixture() {
  const client = {id: ++fixtureId, name: `首页凭证测试 ${fixtureId}`, start_period: '2025-01'};
  const books = new Map([currentPeriod, historyPeriod].map(period => [period, makeBook(client, period)]));
  const calls = [], messages = [];
  let selectedPeriod = currentPeriod, html = '', shell, failReload = false;
  const containerHandlers = new Map();
  const container = {
    querySelector: selector => selector === '.cw-shell' ? shell : null,
    querySelectorAll: () => [], contains: () => true,
    addEventListener: (type, handler) => containerHandlers.set(type, handler),
    removeEventListener: (type, handler) => { if (containerHandlers.get(type) === handler) containerHandlers.delete(type); },
  };
  Object.defineProperty(container, 'innerHTML', {get: () => html, set: value => { html = value; }});
  const mount = () => {
    const handlers = new Map();
    shell = {querySelector: () => null, addEventListener: (type, handler) => handlers.set(type, handler), handlers};
    bindBook(container, ctx);
  };
  const ctx = {
    clients: [client], user: {name: '测试会计'},
    api: async (path, options) => {
      assert.equal(options, undefined, 'Viewing home statistics and vouchers must not mutate accounting records.');
      const url = new URL(path, 'http://test.invalid');
      assert.equal(url.pathname, `/api/books/${client.id}`);
      const period = url.searchParams.get('period');
      calls.push({kind: 'load', clientId: client.id, period});
      assert.ok(books.has(period), 'A history entry must request its exact accounting month.');
      return structuredClone(books.get(period));
    },
    toast: (message, type) => messages.push({message, type}),
    setBook: (id, period) => {
      calls.push({kind: 'setBook', clientId: id, period});
      assert.equal(id, client.id, 'History navigation must remain in the selected company.');
      selectedPeriod = period;
    },
    reload: async () => {
      calls.push({kind: 'reload', period: selectedPeriod});
      if (failReload) throw new Error('SYNTHETIC HOME VOUCHER RELOAD FAILED');
      html = await renderBook(client.id, selectedPeriod, ctx);
      mount();
    },
  };
  setBookView('home');
  html = await renderBook(client.id, selectedPeriod, ctx);
  mount();
  calls.length = 0;
  return {
    books, client, calls, messages, ctx,
    get html() { return html; },
    get period() { return selectedPeriod; },
    failReload: () => { failReload = true; },
    click: async period => {
      assert.ok(html.includes(`data-cw-vouchers="${period}"`), 'The clicked month must be exposed by the rendered home.');
      const control = {dataset: {cwVouchers: period}, disabled: false, hasAttribute: name => name === 'data-cw-vouchers'};
      const event = {
        target: {closest: selector => selector.includes('[data-cw-vouchers]') ? control : null},
        preventDefault() {},
      };
      shell.handlers.get('click')(event);
      await settle();
    },
  };
}

const originalDocument = globalThis.document;
globalThis.document = {querySelector: () => null};
try {
  const historical = await fixture();
  const historicalState = vouchers.stateFor(historical.books.get(historyPeriod));
  addOldFilters(historicalState);
  await historical.click(historyPeriod);
  assert.equal(historical.period, historyPeriod, 'A history entry switches across years to the voucher month.');
  assert.deepEqual(historical.calls.map(call => call.kind), ['setBook', 'reload', 'load']);
  assert.equal(historical.calls.at(-1).period, historyPeriod);
  assertReset(historicalState);
  assert.match(historical.html, /data-cw-period value="2025-08"/);
  assert.match(historical.html, /data-cv-voucher="51"/);
  assert.match(historical.html, /data-cv-voucher="52"/);
  assert.doesNotMatch(historical.html, /data-cv-voucher="61"/);
  assert.equal(historical.messages.length, 0);

  const refreshedBook = historical.books.get(historyPeriod);
  refreshedBook.vouchers.push(voucher(53, historyPeriod));
  await historical.ctx.reload();
  assert.match(historical.html, /data-cv-voucher="53"/, 'Refresh must re-read stored vouchers for the selected historical month.');
  assert.equal(historical.calls.at(-1).period, historyPeriod);

  const current = await fixture();
  const currentState = vouchers.stateFor(current.books.get(currentPeriod));
  addOldFilters(currentState);
  await current.click(currentPeriod);
  assertReset(currentState);
  assert.match(current.html, /data-cv-voucher="61"/, 'The current-month statistic also opens an unfiltered list.');
  assert.doesNotMatch(current.html, /data-cv-voucher="51"/);

  const failed = await fixture();
  failed.failReload();
  await failed.click(historyPeriod);
  assert.equal(failed.period, historyPeriod);
  assert.ok(failed.messages.some(item => item.type === 'error' && /SYNTHETIC HOME VOUCHER RELOAD FAILED/.test(item.message)), 'A failed history refresh must be reported through the workspace error toast.');
  assert.deepEqual(failed.calls.map(call => call.kind), ['setBook', 'reload']);
} finally {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
}

console.log('home voucher statistics, history navigation, filter reset, refresh and failure checks passed');
