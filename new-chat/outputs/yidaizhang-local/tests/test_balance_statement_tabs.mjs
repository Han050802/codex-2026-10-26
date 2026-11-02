import assert from 'node:assert/strict';
import {renderStatutorySheet} from '../public/statements.js';

const statement = {
  company: '元石银河',
  period: '2026-09',
  date: '2026-09-30',
  balanced: true,
  difference_fen: 0,
  notes: ['按当前月份的有效凭证和期初余额生成。'],
  balance_sheet: {
    title: '资产负债表',
    form_no: '会小企01表',
    rows: [
      {asset_name: '货币资金', asset_line: '1', asset_ending_fen: 24648020, asset_begin_fen: null, equity_name: '短期借款', equity_line: '31', equity_ending_fen: null, equity_begin_fen: null},
    ],
  },
  profit: {
    title: '利润表',
    form_no: '会小企02表',
    rows: [
      {name: '一、营业收入', line: '1', month_fen: null, ytd_fen: 15520000},
    ],
  },
};
const book = {
  basis: 'standard',
  client: {id: 7, name: '元石银河', start_period: '2026-01'},
  period: '2026-09',
  accounts: [],
  trial_balance: [],
  reports: {statutory: statement},
};
const mod = await import(`../public/company-balance.js?statement-tabs=${Date.now()}`);
const trial = mod.renderCompanyBalance(book, {});
assert.match(trial, /role="tablist" aria-label="报表切换"/);
assert.match(trial, /data-cob-action="sheet-balance"[^>]*>资产负债表</);
assert.match(trial, /data-cob-action="sheet-profit"[^>]*>利润表</);
assert.match(trial, /data-cob-sheet="trial"/);
assert.doesNotMatch(trial, /cob-statement-menu|生成报表/);

const host = {
  matches: () => true,
  parentNode: null,
  isConnected: false,
  querySelectorAll: () => [],
  contains: () => false,
  handlers: new Map(),
  addEventListener(type, handler) { this.handlers.set(type, handler); },
};
mod.bindCompanyBalance(host, book, {
  toast() {},
  api: async () => ({basis: 'standard', start_period: '2026-09', end_period: '2026-09', trial_balance: [], trial_balance_rollup: []}),
});
const click = action => {
  const node = {
    disabled: false,
    dataset: {cobAction: action},
    closest(selector) { return selector === '[data-cob-action]' ? node : null; },
  };
  host.handlers.get('click')({target: node, preventDefault() {}, stopPropagation() {}});
};

click('sheet-balance');
const balance = mod.renderCompanyBalance(book, {});
assert.match(balance, /data-cob-sheet="balance"/);
assert.match(balance, /aria-label="资产负债表"/);
assert.match(balance, /data-statutory-sheet="balance"/);
assert.match(balance, /会小企01表/);
assert.match(balance, /货币资金/);
assert.match(balance, /246,?480\.20/);
assert.match(balance, /下载资产负债表/);
assert.doesNotMatch(balance, /营业收入/);

click('sheet-profit');
const profit = mod.renderCompanyBalance(book, {});
assert.match(profit, /data-statutory-sheet="profit"/);
assert.match(profit, /会小企02表/);
assert.match(profit, /一、营业收入/);
assert.match(profit, /155,?200\.00/);
assert.match(profit, /下载利润表/);
assert.doesNotMatch(profit, /货币资金/);

click('sheet-trial');
assert.match(mod.renderCompanyBalance(book, {}), /data-cob-sheet="trial"/);
assert.match(renderStatutorySheet({reports: {}}, 'balance', {h: value => String(value ?? ''), money: value => String(value)}), /还没有生成/);
console.log('balance page shows the balance sheet and profit statement as visible tabs');
