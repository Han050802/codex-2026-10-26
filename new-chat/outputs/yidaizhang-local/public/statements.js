import {createStatutoryBalanceXlsx, createStatutoryProfitXlsx} from './statement-xlsx.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));

function amountText(value, money) {
  if (value === null || value === undefined || value === '') return '';
  return money(value);
}

function safeName(value) {
  return String(value ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
}

export function statutoryStatement(book) {
  const statement = book?.reports?.statutory;
  if (!statement?.balance_sheet?.rows || !statement?.profit?.rows) throw new Error('报表数据还没准备好，请刷新账套后再生成');
  return statement;
}

export function downloadStatutory(book, kind) {
  const statement = statutoryStatement(book);
  const balance = kind !== 'profit';
  const bytes = balance ? createStatutoryBalanceXlsx(statement) : createStatutoryProfitXlsx(statement);
  const label = balance ? '资产负债表' : '利润表';
  const period = String(statement.period || book.period || '').replace('-', '');
  const blob = new Blob([bytes], {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeName(statement.company || book.client?.name)}_${label}_${period}.xlsx`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return anchor.download;
}

function reportHelpers(helpers = {}) {
  return {h: helpers.h || escapeHtml, money: helpers.money};
}

function balanceStatus(statement, h, money) {
  return `<p class="${statement.balanced ? 'book-ok' : 'book-warning'}">${statement.balanced ? '资产负债表已平衡：资产总计等于负债和所有者权益总计。' : `资产负债表不平，差额 ${h(money(statement.difference_fen))}。`}</p>`;
}

function balanceTable(statement, h, money) {
  const cell = value => amountText(value, money);
  const balanceRows = (statement.balance_sheet.rows || []).map(row => `<tr><td>${h(row.asset_name)}</td><td class="number">${h(row.asset_line)}</td><td class="number">${h(cell(row.asset_ending_fen))}</td><td class="number">${h(cell(row.asset_begin_fen))}</td><td>${h(row.equity_name)}</td><td class="number">${h(row.equity_line)}</td><td class="number">${h(cell(row.equity_ending_fen))}</td><td class="number">${h(cell(row.equity_begin_fen))}</td></tr>`).join('');
  return `<section class="book-report"><h3>资产负债表 <small>${h(statement.balance_sheet.form_no)}</small></h3><p class="muted">${h(statement.company)} · ${h(statement.date)} · 单位：元</p><div class="table-wrap book-table statutory-sheet"><table><thead><tr><th>资产</th><th>行次</th><th>期末余额</th><th>年初余额</th><th>负债和所有者权益</th><th>行次</th><th>期末余额</th><th>年初余额</th></tr></thead><tbody>${balanceRows}</tbody></table></div></section>`;
}

function profitTable(statement, h, money, spaced) {
  const cell = value => amountText(value, money);
  const profitRows = (statement.profit.rows || []).map(row => `<tr><td>${h(row.name)}</td><td class="number">${h(row.line)}</td><td class="number">${h(cell(row.month_fen))}</td><td class="number">${h(cell(row.ytd_fen))}</td></tr>`).join('');
  return `<section class="book-report${spaced ? ' book-section-gap' : ''}"><h3>利润表 <small>${h(statement.profit.form_no)}</small></h3><p class="muted">${h(statement.company)} · ${h(statement.period)} · 单位：元</p><div class="table-wrap book-table statutory-sheet"><table><thead><tr><th>项目</th><th>行次</th><th>本月金额</th><th>本年累计金额</th></tr></thead><tbody>${profitRows}</tbody></table></div></section>`;
}

function notesList(statement, h) {
  return `<ul class="statutory-notes">${(statement.notes || []).map(note => `<li>${h(note)}</li>`).join('')}</ul>`;
}

const missingStatement = '<p class="book-warning">资产负债表和利润表还没有生成，请刷新账套。</p>';

export function renderStatutorySheet(book, kind, helpers) {
  const {h, money} = reportHelpers(helpers);
  const statement = book?.reports?.statutory;
  if (!statement?.balance_sheet?.rows || !statement?.profit?.rows) return missingStatement;
  const profit = kind === 'profit';
  return `<div class="statutory-reports" data-statutory-sheet="${profit ? 'profit' : 'balance'}">${profit ? '' : balanceStatus(statement, h, money)}${profit ? profitTable(statement, h, money, false) : balanceTable(statement, h, money)}${notesList(statement, h)}</div>`;
}

export function renderStatutoryReports(book, helpers) {
  const {h, money} = reportHelpers(helpers);
  const statement = book?.reports?.statutory;
  if (!statement) return missingStatement;
  return `<div class="statutory-reports">${balanceStatus(statement, h, money)}${balanceTable(statement, h, money)}${profitTable(statement, h, money, true)}${notesList(statement, h)}</div>`;
}
