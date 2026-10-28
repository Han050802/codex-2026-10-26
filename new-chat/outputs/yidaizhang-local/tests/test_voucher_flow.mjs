import assert from 'node:assert/strict';
import {bindBook, renderBook, setBookView} from '../public/finance-ui.js';
import {companyVouchersTest as vouchers} from '../public/company-vouchers.js';

// Exercise the public workspace actions without a browser, server or database.
// Only the DOM methods used for delegation and form reads are represented here.
const originalDocument = globalThis.document;
const originalFormData = globalThis.FormData;
globalThis.document = {querySelector: () => null};
globalThis.FormData = class {
  constructor(form) { this.form = form; }
  entries() { return Object.entries(this.form.values)[Symbol.iterator](); }
};

const client = {id: 88771, name: '凭证回归测试', start_period: '2026-01'};
const makeVoucher = (id, period, number = id) => ({
  id, date: `${period}-15`, number, summary: `凭证 ${id}`, source_type: 'manual',
  status: 'active', version: 1, reviewed: false, attachment_count: 0,
  lines: [
    {account_code: '1001', account_name: '库存现金', debit_fen: 100, credit_fen: 0},
    {account_code: '2202', account_name: '应付账款', debit_fen: 0, credit_fen: 100},
  ],
});
const makeBook = period => ({
  client, period, periods: [], opening_balances: [],
  accounts: [{code: '1001', name: '库存现金'}, {code: '2202', name: '应付账款'}],
  vouchers: Array.from({length: 24}, (_, i) => makeVoucher(i + 1, period)),
});
function formFor(date, summary = '跨月测试') {
  const values = {date, summary, attachment_count: '2'};
  const lines = [
    {'.voucher-summary': '', '.voucher-account': '1001', '.voucher-debit': '12.34', '.voucher-credit': '', '.voucher-cf': 'operating'},
    {'.voucher-summary': '', '.voucher-account': '2202', '.voucher-debit': '', '.voucher-credit': '12.34', '.voucher-cf': 'unclassified'},
  ];
  return {
    values, elements: Object.fromEntries(Object.entries(values).map(([k, value]) => [k, {value}])),
    querySelectorAll: selector => selector === '.voucher-line'
      ? lines.map(line => ({querySelector: key => ({value: line[key]})})) : [],
  };
}
async function fixture(period = '2026-09') {
  const books = new Map(['2026-09', '2026-10', '2027-01'].map(p => [p, makeBook(p)]));
  const calls = [], messages = [], handlers = new Map();
  let currentPeriod = period, modal, html = '', failSave = false, failReload = false;
  const ctx = {
    clients: [client], user: {name: '测试会计'},
    api: async (url, options) => {
      if (!options) return books.get(new URL(url, 'http://test').searchParams.get('period'));
      calls.push({kind: 'save', url, ...options});
      if (failSave) throw new Error('保存失败');
      const targetPeriod = options.body.date.slice(0, 7), saved = {
        ...makeVoucher(options.method === 'PATCH' ? Number(url.split('/').at(-1)) : 900, targetPeriod),
        ...options.body,
      };
      const target = books.get(targetPeriod);
      target.vouchers = target.vouchers.filter(v => v.id !== saved.id).concat(saved);
      return saved;
    },
    modal: (title, content, onSubmit, options) => { modal = {title, content, onSubmit, options}; },
    toast: (message, type) => messages.push({message, type}),
    setBook: (id, nextPeriod) => { calls.push({kind: 'period', id, period: nextPeriod}); currentPeriod = nextPeriod; },
    reload: async () => {
      calls.push({kind: 'reload', period: currentPeriod});
      if (failReload) throw new Error('临时断网');
      html = await renderBook(client.id, currentPeriod, ctx);
    },
  };
  setBookView('vouchers');
  await renderBook(client.id, period, ctx);
  const shell = {querySelector: () => null, addEventListener: () => {}};
  const container = {
    querySelector: selector => selector === '.cw-shell' ? shell : null,
    querySelectorAll: () => [], contains: () => true,
    addEventListener: (type, handler) => handlers.set(type, handler),
  };
  bindBook(container, ctx);
  return {
    books, calls, messages,
    get html() { return html; },
    get period() { return currentPeriod; },
    get modal() { return modal; },
    failSave: () => { failSave = true; }, failReload: () => { failReload = true; },
    open: async (action = 'new-voucher', id = 0) => {
      const control = {dataset: {bookAction: action, id: String(id)}, closest: selector => selector === '.cv-root' ? {} : null};
      handlers.get('click')({target: {closest: selector => selector === '[data-book-action]' ? control : null}, preventDefault() {}, stopPropagation() {}});
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(modal, 'A voucher list action must open its form.');
      return modal;
    },
  };
}

try {
  const f = await fixture();
  const target = f.books.get('2026-10'), state = vouchers.stateFor(target);
  Object.assign(state, {query: '找不到的摘要', status: 'void', source: 'invoice', dateFrom: '2026-10-30', dateTo: '2026-10-31', min: '999', max: '9999', page: 9, size: 20});
  state.selected.add('1');
  const dialog = await f.open();
  assert.equal(dialog.options.wide, true, 'Voucher entry always explicitly requests a wide dialog.');
  assert.match(dialog.content, /voucher-col-account/);
  assert.match(dialog.content, /voucher-col-cashflow/);
  assert.match(dialog.content, /aria-label="删除分录"/);
  await dialog.onSubmit(formFor('2026-10-18'));
  assert.deepEqual(f.calls.map(c => c.kind), ['save', 'period', 'reload']);
  assert.equal(f.calls[0].url, `/api/books/${client.id}/vouchers`);
  assert.equal(f.calls[0].body.lines[0].debit_fen, 1234);
  assert.equal(f.period, '2026-10');
  assert.equal(f.calls[2].period, '2026-10', 'Reload must use the saved month.');
  assert.match(f.html, /data-cv-voucher="900"/, 'The saved voucher must be present after reload.');
  assert.match(f.html, /data-cv-page-input[^>]*value="2"/, 'The list must open the page containing the saved voucher.');
  assert.equal(state.query, '');
  assert.equal(state.status, 'active');
  assert.equal(state.source, '');
  assert.equal(state.dateFrom, '');
  assert.equal(state.dateTo, '');
  assert.equal(state.min, '');
  assert.equal(state.max, '');
  assert.equal(state.selected.size, 0);

  const year = await fixture();
  await (await year.open()).onSubmit(formFor('2027-01-05'));
  assert.equal(year.period, '2027-01', 'Saving across a year boundary must follow the saved voucher.');
  assert.match(year.html, /data-cw-period value="2027-01"/);

  const failed = await fixture(); failed.failSave();
  await assert.rejects((await failed.open()).onSubmit(formFor('2026-10-18')), /保存失败/);
  assert.equal(failed.period, '2026-09');
  assert.deepEqual(failed.calls.map(c => c.kind), ['save'], 'A rejected write must not navigate or reload.');

  const stale = await fixture(); stale.failReload();
  await assert.doesNotReject((await stale.open()).onSubmit(formFor('2026-10-18')));
  assert.equal(stale.period, '2026-10');
  assert.equal(stale.calls.filter(c => c.kind === 'save').length, 1);
  assert.ok(stale.messages.some(m => m.type === 'error' && /凭证已保存至 2026-10.*列表刷新失败/.test(m.message)), 'A refresh failure must explain the completed save.');

  const edit = await fixture(), editDialog = await edit.open('edit-voucher', 1);
  assert.match(editDialog.content, /min="2026-09-01" max="2026-09-30"/);
  await assert.rejects(editDialog.onSubmit(formFor('2026-10-18')), /原月份/);
  assert.equal(edit.calls.length, 0, 'Cross-month edits must be stopped before writing.');
  await editDialog.onSubmit(formFor('2026-09-18', '修改摘要'));
  assert.equal(edit.calls[0].method, 'PATCH');
  assert.equal(edit.calls[0].body.version, 1);
  assert.equal(edit.period, '2026-09');
  console.log('voucher dialog, cross-month/year save, saved-row pagination and failure handling checks passed');
} finally {
  globalThis.document = originalDocument;
  globalThis.FormData = originalFormData;
}
