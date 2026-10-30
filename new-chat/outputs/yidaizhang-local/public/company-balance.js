import {createBalanceXlsx, balanceDetailLabel} from './balance-xlsx.js';

/* The company balance report reads persisted account-book data. All amounts are integer fen. */
let activeCompany = null;
let state = null;
let pendingPosting = null;
let pendingRange = null;
const bound = new WeakSet();
const amountKeys = ['opening_debit_fen', 'opening_credit_fen', 'debit_fen', 'credit_fen', 'closing_debit_fen', 'closing_credit_fen'];
const categories = [['', '全部科目'], ['asset', '资产类'], ['liability', '负债类'], ['equity', '权益类'], ['cost', '成本类'], ['income', '收入类'], ['expense', '费用类']];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
const money = (value, ctx) => ctx.money ? ctx.money(Number(value || 0)) : (Number(value || 0) / 100).toLocaleString('zh-CN', {minimumFractionDigits:2, maximumFractionDigits:2});
const h = (value, ctx) => ctx.escape ? ctx.escape(value ?? '') : escapeHtml(value);
const number = value => Number(value || 0);
const periodOk = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const compactPeriod = value => String(value || '').replace('-', '');
const basisPreferenceKey = 'company-balance:standard-basis';
function readStandardBasis() {
  try { return globalThis.localStorage?.getItem(basisPreferenceKey) !== 'actual'; } catch { return true; }
}
function rememberStandardBasis(enabled) {
  try { globalThis.localStorage?.setItem(basisPreferenceKey,enabled ? 'standard' : 'actual'); } catch { /* Storage is optional. */ }
}
const requestedBasis = current => current.standardBasis === false ? 'actual' : 'standard';
const matchesBasis = (data,current) => requestedBasis(current) === 'standard' ? data?.basis === 'standard' : data?.basis !== 'standard';
const queryKey = (book,current) => `${book.client.id}:${current.start}:${current.end}:${requestedBasis(current)}`;
const hasReportProjection = data => data?.has_projection === true || (data?.balance_details || []).some(entry => entry.is_projection || entry.source_type === 'report_closing');
function projectionNotice(data,ctx) {
  return hasReportProjection(data) ? `<p class="notice" data-cob-projection-note>含未结转损益测算 · ${h(data.projection_note || '仅按报表口径测算，未生成凭证、未审核、未锁定期间。',ctx)}</p>` : '';
}

function balanceRange(clientId, start, end) {
  clientId = Number(clientId);
  if (!Number.isSafeInteger(clientId) || clientId <= 0 || typeof start !== 'string' || typeof end !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(start) || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(end) || start > end) return null;
  return {clientId, start, end};
}

// Keep only the report location in the URL. Saved amounts remain on the server.
export function readCompanyBalanceRoute(hash = globalThis.window?.location?.hash || '') {
  const match = /^#balance\/([1-9]\d*)\/(\d{4}-\d{2})\/(\d{4}-\d{2})$/.exec(hash);
  return match ? balanceRange(match[1], match[2], match[3]) : null;
}

function replaceBalanceHash(hash) {
  const browser = globalThis.window;
  if (!browser?.location || !browser.history?.replaceState || browser.location.hash === hash) return;
  try { browser.history.replaceState(browser.history.state, '', browser.location.pathname + browser.location.search + hash); } catch (_) { /* URL persistence must not block the report. */ }
}

export function clearCompanyBalanceRoute() {
  pendingRange = null;
  if (/^#balance(?:\/|$)/.test(globalThis.window?.location?.hash || '')) replaceBalanceHash('');
}

export function restoreCompanyBalanceRange(range) {
  const valid = balanceRange(range?.clientId, range?.start, range?.end);
  if (!valid) return false;
  pendingRange = valid;
  pendingPosting = null;
  return true;
}

function rememberBalanceRange(book, current) {
  const range = balanceRange(book.client.id, current.start, current.end);
  if (range) replaceBalanceHash(`#balance/${range.clientId}/${range.start}/${range.end}`);
}

// The posting flow supplies only successful saves. The report itself is fetched
// again from the server; the supplied lines identify the entries to highlight.
export function focusCompanyBalance(detail) {
  const clientId = Number(detail?.clientId);
  const postings = Array.isArray(detail?.postings) ? detail.postings.filter(p => periodOk(String(p?.period || '')) && Array.isArray(p.posted_lines)).map(p => ({...p, period:String(p.period), posted_lines:p.posted_lines.map(line => ({...line}))})) : [];
  const classifications = Array.isArray(detail?.classifications) ? detail.classifications.filter(c => periodOk(String(c?.period || ''))).map(c => ({...c, period:String(c.period)})) : [];
  if (!Number.isSafeInteger(clientId) || clientId <= 0 || (!postings.length && !classifications.length)) throw new Error('已保存，但缺少余额表所需的公司或账期');
  const startPeriod = periodOk(String(detail?.startPeriod || '')) ? detail.startPeriod : '';
  pendingPosting = {clientId, postings, classifications, startPeriod};
  pendingRange = null;
  const firstPeriod = [...postings,...classifications].map(p => p.period).sort()[0];
  return {clientId, period:startPeriod && firstPeriod < startPeriod ? startPeriod : firstPeriod};
}

// The workspace period is the calendar month; when it has no vouchers yet,
// show the book from its start to the latest booked month instead of a report
// where every entry is opening balance.
function defaultRange(book) {
  const booked = (book.periods || []).filter(p => Number(p?.voucher_count) > 0 && String(p.period) <= book.period).map(p => String(p.period)).sort();
  if (!booked.length || booked.includes(book.period)) return [book.period, book.period];
  const end = booked[booked.length - 1], first = String(book.client?.start_period || '');
  return [first && first <= booked[0] && first.slice(0,4) === end.slice(0,4) ? first : booked[0], end];
}

function freshState(book) {
  const [start, end] = defaultRange(book);
  return {book, defaultPeriod:book.period, start, end, standardBasis:readStandardBasis(), codeFrom:'', codeTo:'', min:'', max:'', levelFrom:'1', levelTo:'6', draft:{}, category:'', showDisabled:true, showAuxiliary:false, showZero:false, showActivityZero:true, ytd:false, expanded:true, collapsed:new Set(), filtersOpen:true, data:null, loading:false, exporting:false, failedKey:'', error:'', request:0};
}

function getState(book) {
  if (pendingPosting && pendingPosting.clientId === Number(book.client.id)) {
    activeCompany = String(book.client.id);
    state = freshState(book);
    const periods = [...pendingPosting.postings,...pendingPosting.classifications].map(p => p.period).sort();
    state.start = periods[0]; state.end = periods[periods.length-1];
    if (book.client.start_period) {
      if (state.start < book.client.start_period) state.start = book.client.start_period;
      if (state.end < book.client.start_period) state.end = book.client.start_period;
    }
    state.postings = pendingPosting.postings;
    state.showZero = false; state.showAuxiliary = true; state.expanded = true;
    state.focusPending = true;
    pendingPosting = null;
  } else if (pendingRange && pendingRange.clientId === Number(book.client.id)) {
    activeCompany = String(book.client.id);
    state = freshState(book);
    if (!book.client.start_period || pendingRange.start >= book.client.start_period) {
      state.start = pendingRange.start; state.end = pendingRange.end;
      state.showAuxiliary = true;
    }
    pendingRange = null;
  } else if (!state || activeCompany !== String(book.client.id)) {
    activeCompany = String(book.client.id);
    state = freshState(book);
  } else {
    if (state.defaultPeriod !== book.period) {
      delete state.postings; delete state.focusPending;
      [state.start, state.end] = defaultRange(book);
      delete state.draft.start;
      delete state.draft.end;
      state.defaultPeriod = book.period;
      state.data = null;
      state.failedKey = '';
      state.error = '';
      state.request++;
      state.loading = false;
    }
    if (state.book !== book) {
      state.book = book;
      state.data = null;
      state.failedKey = '';
      state.error = '';
      state.request++;
      state.loading = false;
    }
  }
  return state;
}

function hierarchy(accounts) {
  const sorted = accounts.map(a => ({...a, code:String(a.code ?? a.account_code)})).sort((a,b) => a.code.localeCompare(b.code));
  const levels = new Map();
  return sorted.map(account => {
    const parent = sorted.filter(a => a.code !== account.code && account.code.startsWith(a.code)).sort((a,b) => b.code.length-a.code.length)[0];
    const level = parent ? (levels.get(parent.code) || 1)+1 : 1;
    levels.set(account.code, level);
    return {...account, parent_code:parent?.code || null, level, is_leaf:!sorted.some(a => a.code !== account.code && a.code.startsWith(account.code))};
  });
}

function rollupTrial(rawRows, accounts) {
  const accountRows = hierarchy(accounts);
  return accountRows.map(account => {
    const code = account.code;
    const own = rawRows.find(r => String(r.account_code) === code) || {};
    const descendants = rawRows.filter(r => String(r.account_code).startsWith(code));
    const sum = key => descendants.reduce((total,r) => total+number(r[key]), 0);
    const opening = sum('opening_debit_fen')-sum('opening_credit_fen');
    const closing = sum('closing_debit_fen')-sum('closing_credit_fen');
    return {...account, ...own, account_code:code, account_name:account.name || own.account_name || '', parent_code:account.parent_code, level:account.level, is_leaf:account.is_leaf, opening_debit_fen:Math.max(0,opening), opening_credit_fen:Math.max(0,-opening), debit_fen:sum('debit_fen'), credit_fen:sum('credit_fen'), closing_debit_fen:Math.max(0,closing), closing_credit_fen:Math.max(0,-closing), ...(descendants.some(r => 'ytd_debit_fen' in r) ? {ytd_debit_fen:sum('ytd_debit_fen'), ytd_credit_fen:sum('ytd_credit_fen')} : {})};
  });
}

function reportRows(data) {
  return Array.isArray(data.category_rows) ? data.category_rows : Array.isArray(data.balance_categories) ? data.balance_categories : data.trial_balance_rollup || [];
}

function reportAccounts(data, accounts=[]) {
  const categories = Array.isArray(data.category_accounts) ? data.category_accounts : hasCategoryRows(data) ? reportRows(data).map(row => ({...row,code:String(row.account_code),name:row.account_name})) : [];
  return [...new Map([...accounts,...categories].map(account => [String(account.code),account])).values()];
}

function hasCategoryRows(data) {
  return Array.isArray(data.category_rows) || Array.isArray(data.balance_categories);
}

function detailCode(entry) {
  return String(entry.category_code || entry.account_code || '');
}

function reportData(book, current) {
  if (current.data && current.data.start_period === current.start && current.data.end_period === current.end && matchesBasis(current.data,current)) return current.data;
  if (current.start !== book.period || current.end !== book.period || !matchesBasis(book,current)) return {basis:requestedBasis(current),start_period:current.start, end_period:current.end, trial_balance:[], trial_balance_rollup:[], ledger:[]};
  return {basis:book.basis,has_projection:book.has_projection,projection_note:book.projection_note,start_period:book.period, end_period:book.period, trial_balance:book.trial_balance || [], trial_balance_rollup:book.trial_balance_rollup || rollupTrial(book.trial_balance || [], book.accounts || []), ledger:book.ledger || [], expense_classifications:book.expense_classifications || [], balance_details:book.balance_details, category_rows:book.category_rows, balance_categories:book.balance_categories, category_accounts:book.category_accounts};
}

function toFen(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) throw new Error('余额只能填写数字，最多保留两位小数');
  const sign = text.startsWith('-') ? -1 : 1;
  const [whole, fraction=''] = text.replace(/^-/, '').split('.');
  const result = sign * (Number(whole)*100+Number(fraction.padEnd(2,'0')));
  if (!Number.isSafeInteger(result)) throw new Error('余额金额超出可用范围');
  return result;
}

function filteredRows(data, current, accounts) {
  const accountMap = new Map(accounts.map(a => [String(a.code),a]));
  const minimum = toFen(current.min), maximum = toFen(current.max);
  const rows=reportRows(data);
  const activeKeys=[...amountKeys,...(current.ytd ? ['ytd_debit_fen','ytd_credit_fen'] : [])];
  // Red-letter activity and its measured closing can cancel within a root.
  // Keep a zero branch available in actual-ledger or explicitly show-zero mode.
  const zeroBranches=data.basis==='standard' && !current.showZero ? rows.filter(row => number(row.level)===1 && activeKeys.every(key => number(row[key])===0)).map(row => String(row.account_code)) : [];
  return rows.filter(row => {
    const code = String(row.account_code), account = accountMap.get(code) || row;
    if (zeroBranches.some(parent => code.startsWith(parent))) return false;
    const level = number(row.level) || 1;
    if (current.category && row.category !== current.category && account.category !== current.category) return false;
    if (current.codeFrom && code < current.codeFrom) return false;
    if (current.codeTo && code > current.codeTo && !code.startsWith(current.codeTo)) return false;
    if (level < number(current.levelFrom) || level > number(current.levelTo)) return false;
    if (!current.showDisabled && (account.disabled || account.enabled === false || account.is_active === 0 || account.status === 'disabled')) return false;
    if (!current.showAuxiliary && row.is_auxiliary) return false;
    const net = number(row.closing_debit_fen)-number(row.closing_credit_fen);
    if (minimum !== null && net < minimum) return false;
    if (maximum !== null && net > maximum) return false;
    const sourceActivity = data.basis !== 'standard' && (classificationAmount(data,code) !== 0 || (data.balance_details || []).some(entry => detailCode(entry).startsWith(code)));
    const activity = number(row.debit_fen) !== 0 || number(row.credit_fen) !== 0 || sourceActivity || (current.ytd && (number(row.ytd_debit_fen) !== 0 || number(row.ytd_credit_fen) !== 0));
    const anyBalance = number(row.opening_debit_fen) !== 0 || number(row.opening_credit_fen) !== 0 || net !== 0;
    if (!current.showZero && !anyBalance && !activity) return false;
    if (!current.showActivityZero && !net && activity) return false;
    return true;
  });
}

function classificationAmount(data, code) {
  return (data.expense_classifications || []).filter(row => row.direction === 'expense' && String(row.account_code || '').startsWith(String(code))).reduce((sum,row) => sum + number(row.amount_fen),0);
}

function balanceDetailRows(data, rows) {
  const entries = Array.isArray(data.balance_details) ? data.balance_details : [
    ...(data.ledger || []).map(row => ({...row, period_bucket:'current', closing_debit_fen:Math.max(0,number(row.debit_fen)-number(row.credit_fen)), closing_credit_fen:Math.max(0,number(row.credit_fen)-number(row.debit_fen))})),
    ...(data.expense_classifications || []).filter(row => row.direction==='expense').map(row => {
      const before = row.date?.slice(0,7) < data.start_period;
      return {...row,source_type:'expense_classification',period_bucket:before?'opening':'current',opening_debit_fen:before?number(row.amount_fen):0,opening_credit_fen:0,debit_fen:before?0:number(row.amount_fen),credit_fen:0,closing_debit_fen:number(row.amount_fen),closing_credit_fen:0};
    }),
  ];
  return entries.filter(entry => rows.some(row => detailCode(entry).startsWith(String(row.account_code)))).map(entry => {
    const invoice = entry.source_type === 'expense_classification';
    const setup = entry.source_type === 'opening_balance';
    const projected = entry.is_projection || entry.source_type === 'report_closing';
    const reference = projected ? '损益结转测算' : entry.reference || (entry.invoice_number ? `发票 ${entry.invoice_number}` : invoice ? `核对记录 #${entry.record_id}` : setup ? '建账期初' : entry.number ? `记-${String(entry.number).padStart(3,'0')}` : entry.voucher_id ? `凭证 #${entry.voucher_id}` : '');
    const dateNote = invoice && entry.date_source !== 'invoice' ? (entry.date_source==='classification' ? '发票和流水日期缺失或无效，按历史保存日期' : '发票日期缺失或无效，按流水日期') : '';
    return {...entry, reference, source_label:projected ? '损益结转测算' : invoice ? '发票核对' : setup ? '建账期初' : '凭证', date_note:dateNote, date_source_label:dateNote};
  }).sort((a,b) => String(a.date).localeCompare(String(b.date)) || number(a.number)-number(b.number) || number(a.line_id ?? a.record_id ?? a.id)-number(b.line_id ?? b.record_id ?? b.id));
}

function deleteTarget(entry) {
  if (entry.is_projection || entry.read_only || entry.source_type === 'report_closing') return null;
  if (entry.voucher_id) return {voucher_id:Number(entry.voucher_id)};
  if (entry.source_type==='expense_classification' && entry.record_id) return {record_id:Number(entry.record_id)};
  return null;
}

function deleteButton(entry, ctx) {
  const target = deleteTarget(entry);
  if (!target) return '';
  return `<button type="button" class="cob-detail-delete" data-cob-delete="${h(JSON.stringify(target),ctx)}" data-cob-delete-label="${h(`${entry.reference || ''} ${entry.summary || ''}`.trim(),ctx)}" data-cob-delete-reviewed="${entry.reviewed === true || Number(entry.reviewed) === 1 ? '1':'0'}" title="删除这笔错误数据">删除</button>`;
}

const targetKey = target => target.voucher_id ? `v:${target.voucher_id}` : `r:${target.record_id}`;
const maxDeleteEntries = 5000;

// Select persisted sources, so parent/category rows and both sides of a voucher
// share one selection. Collapsing the tree does not change the deletion scope.
function deletionModel(data, current, book) {
  const rows = filteredRows(data,current,book.accounts || []);
  const sources = new Map();
  const byCode = new Map(rows.map(row => [String(row.account_code),new Set()]));
  if (current.deleteMode && data.basis !== 'standard' && !current.loading && !current.failedKey) {
    for (const entry of balanceDetailRows(data,rows)) {
      const target = deleteTarget(entry);
      if (!target || !/^[a-f0-9]{64}$/.test(entry.delete_token || '') || entry.source_type === 'closing' || entry.reviewed === true || Number(entry.reviewed) === 1) continue;
      target.delete_token = entry.delete_token;
      const key = targetKey(target);
      const source = sources.get(key) || {key,target,entry,opening:false};
      source.opening ||= entry.period_bucket === 'opening';
      sources.set(key,source);
      for (const [code,keys] of byCode) if (detailCode(entry).startsWith(code)) keys.add(key);
    }
  }
  const selected = current.selection || (current.selection = new Set());
  for (const key of selected) if (!sources.has(key)) selected.delete(key);
  return {sources,byCode,selected,chosen:[...sources.values()].filter(source => selected.has(source.key))};
}

function selectionCheck(value, keys, model, ctx, label) {
  const count = [...keys].filter(key => model.selected.has(key)).length;
  const mixed = count > 0 && count < keys.size;
  return `<input type="checkbox" class="cob-selection" data-cob-select="${h(value,ctx)}" aria-label="${h(label,ctx)}" aria-checked="${mixed?'mixed':count>0}" ${mixed?'data-cob-mixed':''} ${keys.size && count===keys.size?'checked':''} ${!keys.size?'disabled':''}>`;
}

function deletionToolbar(data, current, book, ctx) {
  if (!current.deleteMode) return '';
  const model = deletionModel(data,current,book);
  return `<div class="cob-delete-bar" role="region" aria-label="批量删除余额表数据"><label class="cob-check">${selectionCheck('all',new Set(model.sources.keys()),model,ctx,'全选当前筛选下可删除的数据')}<span>全选</span></label><span role="status">已选 ${model.chosen.length} 笔来源记录</span><button type="button" class="cob-delete-selected" data-cob-action="delete-selected" ${!model.chosen.length || model.chosen.length>maxDeleteEntries || current.deleting?'disabled':''}>${current.deleting?'删除中…':'删除所选'}</button><button type="button" data-cob-action="delete-mode" ${current.deleting?'disabled':''}>取消</button><p>${model.chosen.length>maxDeleteEntries?'每次最多删除 5000 笔，请缩小筛选范围或减少勾选。':'实际账面数据；全选包含当前筛选下折叠的明细。已审核凭证、期初设置和结转测算不可选。'}</p></div>`;
}

async function deleteSelected(host, book, ctx, actions) {
  const current = getState(book);
  if (current.deleting || current.loading || !current.deleteMode) return;
  const chosen = deletionModel(reportData(book,current),current,book).chosen;
  if (!chosen.length) throw new Error('请先勾选要删除的数据');
  if (chosen.length>maxDeleteEntries) throw new Error('每次最多删除 5000 笔，请缩小筛选范围或减少勾选');
  const vouchers = chosen.filter(source => source.target.voucher_id).length;
  const records = chosen.length-vouchers;
  const preview = chosen.slice(0,10).map(({entry}) => `<li>${h([entry.date,entry.reference,entry.summary].filter(Boolean).join(' · '),ctx)}</li>`).join('');
  return ctx.modal('删除所选余额表数据', `<p>已选择 ${vouchers} 张凭证、${records} 条发票核对分类记录。</p><p>凭证将整张作废，包括同一凭证在其他科目中的分录，并保留审计记录；相关来源恢复为可重新处理。已结账期间不能删除，任何一笔无法删除时整批保留。</p>${chosen.some(source=>source.opening)?'<p class="notice">所选数据包含计入期初余额的历史凭证，也会一并作废。</p>':''}<ul class="cob-delete-preview">${preview}</ul>${chosen.length>10?`<p>另有 ${chosen.length-10} 笔来源记录。</p>`:''}<label class="field"><span>删除原因</span><textarea name="reason" required maxlength="500" rows="3">保存错误，删除</textarea></label>`, async form => {
    if (current.deleting) return;
    current.deleting = true;
    if (current.host?.isConnected) repaint(current.host,book,ctx,actions);
    try {
      const result = await ctx.api(`/api/books/${encodeURIComponent(book.client.id)}/balance-entries/delete-batch`, {method:'POST',body:{entries:chosen.map(source=>source.target),reason:form.elements.reason.value}});
      current.selection.clear();
      current.data = null;
      current.failedKey = '';
      delete current.postings;
      ctx.toast(`已删除 ${result?.deleted_count ?? chosen.length} 笔来源记录`);
      await ctx.reload?.();
      if (state === current) {
        const liveHost = current.host?.isConnected ? current.host : host;
        if (liveHost?.isConnected) await queryData(liveHost,current.book,ctx,actions,{force:true});
      }
    } finally {
      current.deleting = false;
      if (state === current && current.host?.isConnected) repaint(current.host,current.book,ctx,actions);
    }
  });
}

async function deleteEntry(button, host, book, ctx, actions) {
  const current = getState(book);
  const target = JSON.parse(button.dataset.cobDelete);
  if (button.dataset.cobDeleteReviewed === '1') throw new Error('该凭证已审核，请先在凭证列表取消审核后再删除');
  const label = button.dataset.cobDeleteLabel || '';
  const scope = target.voucher_id ? '将作废整张凭证（借贷两边的分录一起删除），来源回单或核对记录会恢复为可重新处理。' : '将删除这条发票核对分类记录，之后可重新核对保存。';
  return ctx.modal('删除余额表数据', `<p>${h(label,ctx)}</p><p class="muted">${scope}凭证作废后保留审计记录，不影响其他数据。</p><label class="field"><span>删除原因</span><textarea name="reason" required maxlength="500" rows="3">保存错误，删除</textarea></label>`, async form => {
    await ctx.api(`/api/books/${encodeURIComponent(book.client.id)}/balance-entries/delete`, {method:'POST', body:{...target, reason:form.elements.reason.value}});
    ctx.toast('已删除');
    current.data = null;
    current.failedKey = '';
    await ctx.reload?.();
    const liveHost = current.host?.isConnected ? current.host : host;
    if (liveHost?.isConnected) await queryData(liveHost,book,ctx,actions,{force:true});
  });
}

function detailGroups(details, rows) {
  const groups = new Map(rows.map(row => [String(row.account_code),[]]));
  for (const entry of details) {
    const owner = rows.filter(row => detailCode(entry).startsWith(String(row.account_code))).sort((a,b) => String(b.account_code).length-String(a.account_code).length)[0];
    if (owner) groups.get(String(owner.account_code)).push(entry);
  }
  return groups;
}

function visibleRows(rows, current) {
  // An ancestor excluded by the current filters cannot be expanded in this view.
  const visibleCodes = new Set(rows.map(row => String(row.account_code)));
  const collapsed = [...current.collapsed].filter(code => visibleCodes.has(code));
  return rows.filter(row => {
    if (!current.expanded && rows.some(parent => String(parent.account_code)!==String(row.account_code) && String(row.account_code).startsWith(String(parent.account_code)))) return false;
    return !collapsed.some(code => String(row.account_code) !== code && String(row.account_code).startsWith(code));
  });
}

function reportTotals(data, rows) {
  const keys = [...amountKeys,'ytd_debit_fen','ytd_credit_fen'];
  const result = Object.fromEntries(keys.map(key => [key,0]));
  // The same selected roots feed both the screen and Excel totals.
  const roots = rows.filter(row => !rows.some(parent => parent!==row && String(row.account_code).startsWith(String(parent.account_code))));
  for (const row of roots) {
    keys.forEach(key => result[key] += number(row[key]));
  }
  return result;
}

function icon(name) {
  const paths = {
    print:'<path d="M5 6V2h10v4M5 14H2V7h16v7h-3M5 11h10v7H5z"/><path d="M15 9h1"/>',
    export:'<path d="M11 2H4v16h12v-7M11 2v5h5M11 2l5 5M9 10v6m-3-3 3 3 3-3"/>',
    refresh:'<path d="M16 6a7 7 0 1 0 1 7M16 2v5h-5"/>',
    gear:'<path d="m8 2 4 0 .6 2 2 .9 1.8-.4 2 3.5-1.4 1.5v2l1.4 1.5-2 3.5-1.8-.4-2 .9L12 19H8l-.6-2-2-.9-1.8.4-2-3.5L3 11.5v-2L1.6 8l2-3.5 1.8.4 2-.9z"/><circle cx="10" cy="10.5" r="3"/>',
    down:'<path d="m4 7 6 6 6-6"/>',
    up:'<path d="m4 12 6-6 6 6"/>',
    chevron:'<path d="m7 3 7 7-7 7"/>',
    subjects:'<rect x="3" y="2.5" width="14" height="15" rx="2"/><path d="M7 2.5v15M3 7.5h14M10 11h4m-4 3h4"/>',
  };
  return `<svg class="cob-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.down}</svg>`;
}

function check(name, label, value, extra='') {
  return `<label class="cob-check"><input type="checkbox" data-cob-check="${name}" ${value?'checked':''} ${extra}><span>${label}</span></label>`;
}

function subjectMenu(current, ctx) {
  const categoryLabel = h(categories.find(c => c[0] === current.category)?.[1] || '全部科目',ctx);
  return `<details class="cob-subject-menu"><summary aria-label="科目分类：${categoryLabel}" title="选择科目分类"><span class="cob-subject-icon">${icon('subjects')}</span><span class="cob-subject-label">${categoryLabel}</span><span class="cob-subject-caret">${icon('down')}</span></summary><div class="cob-menu">${categories.map(([key,label]) => `<button type="button" data-cob-category="${key}" class="${current.category===key?'selected':''}">${h(label,ctx)}</button>`).join('')}<hr><button type="button" data-book-action="new-account">＋ 新增科目</button><button type="button" data-book-action="opening">录入期初余额</button><button type="button" data-cob-action="accounts">科目与期初管理</button></div></details>`;
}

function levelOptions(selected) {
  return [1,2,3,4,5,6].map(n => `<option value="${n}" ${String(n)===String(selected)?'selected':''}>${n}级</option>`).join('');
}

function filters(current, book, ctx) {
  const values={...current,...current.draft};
  const accountList = `<datalist id="cob-account-codes">${reportAccounts(reportData(book,current),book.accounts || []).map(a => `<option value="${h(a.code,ctx)}">${h(a.name,ctx)}</option>`).join('')}</datalist>`;
  return `<form class="cob-filters ${current.filtersOpen?'':'cob-filters-collapsed'}" data-cob-form>
    <div class="cob-filter-main">
      <div class="cob-filter-lines">
        <div class="cob-filter-line">
          <label class="cob-filter-label" for="cob-code-from">科目</label>
          <div class="cob-line-field cob-subject-field"><input id="cob-code-from" name="codeFrom" value="${h(values.codeFrom,ctx)}" placeholder="选择…" list="cob-account-codes" aria-label="起始科目"><button type="button" data-cob-subject="codeFrom" aria-label="选择起始科目">···</button></div>
          <span class="cob-range-dash">—</span>
          <div class="cob-line-field cob-subject-field"><input name="codeTo" value="${h(values.codeTo,ctx)}" placeholder="选择…" list="cob-account-codes" aria-label="结束科目"><button type="button" data-cob-subject="codeTo" aria-label="选择结束科目">···</button></div>
          <label class="cob-filter-label cob-level-label" for="cob-level-from">科目级次</label>
          <div class="cob-line-field cob-level-field"><select id="cob-level-from" name="levelFrom" aria-label="起始科目级次">${levelOptions(values.levelFrom)}</select>${icon('down')}</div>
          <span class="cob-range-dash">—</span>
          <div class="cob-line-field cob-level-field"><select name="levelTo" aria-label="结束科目级次">${levelOptions(values.levelTo)}</select>${icon('down')}</div>
        </div>
        <div class="cob-filter-line cob-period-line">
          <label class="cob-filter-label" for="cob-period-start">期间</label>
          <div class="cob-line-field cob-month-field"><input id="cob-period-start" name="start" type="month" value="${h(values.start,ctx)}" required aria-label="起始期间">${icon('down')}</div>
          <span class="cob-range-dash">—</span>
          <div class="cob-line-field cob-month-field"><input name="end" type="month" value="${h(values.end,ctx)}" required aria-label="结束期间">${icon('down')}</div>
          <label class="cob-filter-label cob-balance-label" for="cob-balance-min">期末余额</label>
          <div class="cob-line-field cob-amount-field"><input id="cob-balance-min" name="min" value="${h(values.min,ctx)}" inputmode="decimal" aria-label="最小期末净余额"></div>
          <span class="cob-range-dash">—</span>
          <div class="cob-line-field cob-amount-field"><input name="max" value="${h(values.max,ctx)}" inputmode="decimal" aria-label="最大期末净余额"></div>
          <span class="cob-filter-spacer"></span>
        </div>
      </div>
      <div class="cob-query-buttons"><button class="cob-query" type="submit" ${current.loading?'disabled':''}>${current.loading?'查询中':'查询'}</button><button class="cob-reset" type="button" data-cob-action="reset">重置</button></div>
    </div>
    <div class="cob-display-settings"><span>显示设置：</span>${check('standardBasis','按标准表结转口径',current.standardBasis!==false,current.deleteMode?'disabled title="退出删除模式后可切换报表口径"':'')}${check('showDisabled','显示禁用科目',current.showDisabled)}${check('showAuxiliary','显示辅助核算',current.showAuxiliary)}${check('showZero','显示无余额无发生科目',current.showZero)}${check('showActivityZero','显示有发生无余额科目',current.showActivityZero)}<button class="cob-toggle-filters" type="button" data-cob-action="filters">${icon(current.filtersOpen?'up':'down')}${current.filtersOpen?'收起更多条件':'展开更多条件'}</button></div>
    ${accountList}
  </form>`;
}

function tableMarkup(data, current, book, ctx) {
  const rows = filteredRows(data,current,book.accounts || []);
  const visible = visibleRows(rows,current);
  const details = balanceDetailRows(data,rows);
  const grouped = hasCategoryRows(data) ? new Map() : detailGroups(details,visible);
  const hasYtd = reportRows(data).some(row => 'ytd_debit_fen' in row);
  const keys = [...amountKeys.slice(0,4), ...(current.ytd?['ytd_debit_fen','ytd_credit_fen']:[]), ...amountKeys.slice(4)];
  const total = reportTotals(data, rows);
  const cell = (row,key) => `<td class="cob-number">${number(row[key]) ? money(row[key],ctx) : ''}</td>`;
  const blankColspan = keys.length+4;
  const selection = current.deleteMode ? deletionModel(data,current,book) : null;
  const detailMarkup = entry => {
    const {company, expense} = balanceDetailLabel(entry);
    const target = deleteTarget(entry), key = target && targetKey(target);
    const checkbox = selection && selection.sources.has(key) ? selectionCheck(key,new Set([key]),selection,ctx,`选择${entry.reference || company}`) : '';
    return `<tr class="cob-detail ${entry.source_type==='expense_classification'?'cob-classification':''}" data-cob-detail="${h(entry.record_id ?? entry.line_id ?? entry.id ?? '',ctx)}"><td colspan="3" class="cob-detail-label"><div class="cob-detail-party">${checkbox}${h(company,ctx)}</div><div>${h(expense,ctx)}</div></td>${keys.map(key => cell(entry,key)).join('')}<td class="cob-detail-actions">${deleteButton(entry,ctx)}</td></tr>`;
  };
  const postedCodes = new Set((current.postings || []).flatMap(p => p.posted_lines.map(line => String(line.account_code || ''))));
  return `<div class="cob-grid-box"><div class="cob-grid-scroll" data-cob-grid tabindex="0" aria-label="科目余额表，表格可滚动"><table class="cob-table ${current.ytd?'cob-has-ytd':''}"><colgroup><col class="cob-col-index"><col class="cob-col-code"><col class="cob-col-name">${keys.map(() => '<col class="cob-col-amount">').join('')}<col class="cob-col-fill"></colgroup>
    <thead><tr><th rowspan="2" class="cob-gear-cell">${selection?selectionCheck('all',new Set(selection.sources.keys()),selection,ctx,'全选当前筛选下可删除的数据'):`<details class="cob-grid-menu"><summary aria-label="科目数据管理">${icon('gear')}</summary><div class="cob-menu"><button type="button" data-book-action="new-account">＋ 新增科目</button><button type="button" data-book-action="opening">录入期初余额</button><button type="button" data-cob-action="accounts">科目与期初管理</button></div></details>`}</th><th rowspan="2">科目编码</th><th rowspan="2">${hasCategoryRows(data)?'科目及分类':'科目及逐笔款项'}</th><th colspan="2">期初余额</th><th colspan="2">本期发生额</th>${current.ytd?'<th colspan="2">本年累计发生额</th>':''}<th colspan="2">期末余额</th><th rowspan="2"></th></tr><tr>${keys.map((_,i) => `<th>${i%2===0?'借方金额':'贷方金额'}</th>`).join('')}</tr></thead>
    <tbody>${visible.length ? visible.map((row,index) => {
      const parent = row.is_leaf === false || row.is_leaf === 0;
      const collapsed = !current.expanded || current.collapsed.has(String(row.account_code));
      return `<tr class="${row.is_category?'cob-category ':''}${parent?'cob-parent ':''}${postedCodes.has(String(row.account_code))?'cob-posted':''}" data-cob-account="${h(row.account_code,ctx)}"><td class="cob-index">${selection?selectionCheck(`account:${row.account_code}`,selection.byCode.get(String(row.account_code)),selection,ctx,`选择${row.account_code} ${row.account_name}下的数据`):index+1}</td><td class="cob-code"><div style="padding-left:${Math.min(5,Math.max(0,number(row.level)-1))*17}px">${parent?`<button type="button" class="cob-tree-toggle ${collapsed?'collapsed':''}" data-cob-toggle="${h(row.account_code,ctx)}" aria-label="${collapsed?'展开':'收起'}${h(row.account_name,ctx)}" aria-expanded="${!collapsed}"></button>`:'<span class="cob-tree-space"></span>'}<span>${h(row.account_code,ctx)}</span></div></td><td class="cob-account-name"><button type="button" data-cob-ledger="${h(row.account_code,ctx)}" style="padding-left:${Math.min(5,Math.max(0,number(row.level)-1))*17}px" title="${h(row.account_name,ctx)} · 查看明细账">${h(row.account_name,ctx)}</button></td>${keys.map(key => cell(row,key)).join('')}<td></td></tr>${(grouped.get(String(row.account_code)) || []).map(detailMarkup).join('')}`;
    }).join('') : `<tr><td class="cob-empty" colspan="${blankColspan}"><div>${current.error?'余额表读取失败，请重试':current.loading||!current.data?'正在读取余额表…':'当前条件下暂无科目余额'}</div>${current.error?'<p>请点击“重新读取”，已保存记录不会因读取失败而删除。</p>':current.loading||!current.data?'<p>正在查询凭证、发票日期与分类目。</p>':'<p>请核对查询期间和筛选条件，款项按发票日期归入期初或本期并结转期末。</p><button type="button" data-book-action="opening">录入期初余额</button><button type="button" data-book-action="new-voucher">新增凭证</button><button type="button" data-cob-action="show-all">显示全部科目</button>'}</td></tr>`}</tbody>
    ${visible.length ? `<tfoot><tr><td></td><td colspan="2">合计</td>${keys.map(key => cell(total,key)).join('')}<td></td></tr></tfoot>`:''}</table></div><div class="cob-report-status"><span>${current.start===current.end?compactPeriod(current.end):`${compactPeriod(current.start)} — ${compactPeriod(current.end)}`}<span class="cob-status-divider">|</span>${visible.length} 个科目 · ${details.length} 笔明细<span class="cob-status-divider">|</span>单位：元</span><span>${current.ytd&&!hasYtd?'正在读取本年累计…':''}</span></div></div>`;
}

function postingSummary(current, book, ctx) {
  if (!current.postings?.length) return '';
  const entries = current.postings.flatMap(p => p.posted_lines.map(line => `<li>${h(p.period,ctx)} · 凭证 #${h(p.voucher_id,ctx)} · ${h(line.account_code,ctx)} ${h(line.account_name,ctx)} · ${number(line.debit_fen) ? `借 ${money(line.debit_fen,ctx)}` : `贷 ${money(line.credit_fen,ctx)}`}</li>`)).join('');
  return `<div class="cob-posting-summary" role="status"><strong>${h(book.client.name,ctx)} · 本次保存的分录</strong><ul>${entries}</ul><p>下方余额表的本期发生额汇总所选期间全部凭证，可能与本次金额不同。</p></div>`;
}

export function renderCompanyBalance(book, ctx) {
  const current = getState(book);
  const data = reportData(book,current);
  const unavailable = current.loading || Boolean(current.failedKey);
  return `<section class="company-balance" data-cob-company="${h(book.client.id,ctx)}" aria-label="科目余额表" aria-busy="${current.loading}"><div class="cob-toolbar">${subjectMenu(current,ctx)}<div class="cob-toolbar-actions"><button type="button" class="cob-delete-mode" data-cob-action="delete-mode" ${current.deleting?'disabled':''}>${current.deleteMode?'退出删除':'删除数据'}</button>${check('ytd','显示本年累计',current.ytd)}<label class="cob-expand-all"><input type="checkbox" data-cob-check="expanded" ${current.expanded?'checked':''}><span class="cob-switch" aria-hidden="true"></span><span>全部展开</span></label><button type="button" data-cob-action="print" ${unavailable?'disabled':''}>${icon('print')}云打印<span class="cob-toolbar-pipe">|</span>${icon('down')}</button><button type="button" data-cob-action="export" ${current.exporting?'disabled':''} title="导出全账套按标准表结转口径的余额总表">${icon('export')}${current.exporting?'导出中…':'导出总表'}</button><button type="button" data-cob-action="refresh" ${current.loading?'disabled':''}>${icon('refresh')}刷新</button></div></div>${postingSummary(current,book,ctx)}${projectionNotice(data,ctx)}${current.error?`<div class="cob-query-error" role="alert"><span>余额表读取失败：${h(current.error,ctx)}</span><button type="button" data-cob-action="refresh">重新读取</button></div>`:''}${filters(current,book,ctx)}${deletionToolbar(data,current,book,ctx)}${tableMarkup(data,current,book,ctx)}</section>`;
}

function resolveHost(container) {
  return container?.matches?.('.company-balance') ? container : container?.querySelector?.('.company-balance');
}

function repaint(host, book, ctx, actions) {
  if (!host?.parentNode) return null;
  const scroll = host.querySelector('[data-cob-grid]');
  const top = scroll?.scrollTop || 0, left = scroll?.scrollLeft || 0;
  const template = document.createElement('template');
  template.innerHTML = renderCompanyBalance(book,ctx);
  const replacement = template.content.firstElementChild;
  host.replaceWith(replacement);
  bindCompanyBalance(replacement,book,ctx,actions);
  const nextGrid = replacement.querySelector('[data-cob-grid]');
  if (nextGrid) { nextGrid.scrollTop=top; nextGrid.scrollLeft=left; }
  return replacement;
}

function valuesFromForm(form, current) {
  const values = Object.fromEntries(new FormData(form).entries());
  for (const key of ['start','end','codeFrom','codeTo','min','max','levelFrom','levelTo']) values[key] = String(values[key] ?? current[key] ?? '').trim();
  if (!periodOk(values.start) || !periodOk(values.end)) throw new Error('请选择有效的起止期间');
  if (values.start > values.end) throw new Error('起始期间不能晚于结束期间');
  if (current.book.client.start_period && values.start < current.book.client.start_period) throw new Error('查询期间不能早于建账月份');
  if (values.codeFrom && !/^\d{4,12}$/.test(values.codeFrom)) throw new Error('起始科目请填写科目编码或从列表选择');
  if (values.codeTo && !/^\d{4,12}$/.test(values.codeTo)) throw new Error('结束科目请填写科目编码或从列表选择');
  if (values.codeFrom && values.codeTo && values.codeFrom > values.codeTo) throw new Error('起始科目不能大于结束科目');
  if (number(values.levelFrom) > number(values.levelTo)) throw new Error('起始级次不能大于结束级次');
  const minimum=toFen(values.min), maximum=toFen(values.max);
  if (minimum !== null && maximum !== null && minimum > maximum) throw new Error('最小余额不能大于最大余额');
  if (values.start !== current.start || values.end !== current.end) { delete current.postings; delete current.focusPending; }
  Object.assign(current,values);
  current.draft={};
}

async function queryData(host, book, ctx, actions, {force=false}={}) {
  const current = getState(book);
  const key = queryKey(book,current);
  if (current.loading || (!force && (current.data || current.failedKey === key))) return;
  current.loading = true;
  current.error = '';
  const request = ++current.request;
  let target = repaint(host,book,ctx,actions) || host;
  try {
    const data = await ctx.api(`/api/books/${encodeURIComponent(book.client.id)}/balance?start=${encodeURIComponent(current.start)}&end=${encodeURIComponent(current.end)}&basis=${requestedBasis(current)}`);
    if (state !== current || request !== current.request) return;
    if (!data || !matchesBasis(data,current) || data.start_period !== current.start || data.end_period !== current.end || !Array.isArray(data.trial_balance) || !Array.isArray(data.trial_balance_rollup)) throw new Error('余额表数据格式错误，请刷新重试');
    current.data = data;
    current.failedKey = '';
  } catch (error) {
    if (state !== current || request !== current.request) return;
    current.failedKey = key;
    current.error = error.message || '余额表读取失败';
    ctx.toast(current.error,'error');
  } finally {
    if (state === current && request === current.request) {
      current.loading = false;
      const liveHost=current.host?.isConnected?current.host:target;
      if (liveHost?.isConnected) repaint(liveHost,book,ctx,actions);
    }
  }
}


const pickerGroups = [['','全部科目'], ['asset','资产'], ['liability','负债'], ['equity','权益'], ['cost','成本'], ['profit','损益']];
const pickerDisabled = a => Boolean(a.disabled || a.enabled === false || a.is_active === 0 || a.status === 'disabled');
const pickerInCategory = (account, category) => !category || (category === 'profit' ? ['income','expense'].includes(account.category) : account.category === category);
const pickerFullName = (account, all) => all.filter(a => account.code.startsWith(a.code)).sort((a,b) => a.code.length-b.code.length).map(a => a.name).join('_');
function pickerFiltered(selector, all=hierarchy(selector.accounts)) {
  const term=selector.search.trim().toLowerCase();
  return all.filter(a => (selector.disabled || !pickerDisabled(a)) && pickerInCategory(a,selector.category) && (!selector.treeCode || a.code.startsWith(selector.treeCode)) && (!term || [a.code,a.name,pickerFullName(a,all)].some(v => String(v || '').toLowerCase().includes(term))));
}
function pickerTree(selector, ctx) {
  const all=hierarchy(selector.accounts).filter(a => selector.disabled || !pickerDisabled(a));
  const accountNodes = (category, parent=null, depth=1) => all.filter(a => pickerInCategory(a,category) && (parent ? a.parent_code===parent : !all.some(p => p.code===a.parent_code && pickerInCategory(p,category)))).map(a => {
    const children=all.some(child => child.parent_code===a.code && pickerInCategory(child,category));
    const expanded=selector.expandedAccounts.has(a.code);
    return `<div class="cob-picker-tree-row ${selector.treeCode===a.code?'selected':''}" style="padding-left:${12+depth*16}px">${children?`<button type="button" class="cob-picker-tree-toggle" data-picker-toggle-account="${h(a.code,ctx)}" aria-label="${expanded?'收起':'展开'}${h(a.name,ctx)}" aria-expanded="${expanded}">${expanded?'▾':'▸'}</button>`:'<span class="cob-picker-tree-spacer"></span>'}<button type="button" class="cob-picker-tree-label" data-picker-tree-code="${h(a.code,ctx)}" title="${h(a.name,ctx)}">${h(a.name,ctx)}</button></div>${children && expanded ? accountNodes(category,a.code,depth+1) : ''}`;
  }).join('');
  return `<div class="cob-picker-tree-row ${!selector.category && !selector.treeCode?'selected':''}"><span class="cob-picker-tree-icon">▦</span><button type="button" class="cob-picker-tree-label" data-picker-category="">全部科目</button></div>${pickerGroups.slice(1).map(([key,label]) => {
    const expanded=selector.expandedCategories.has(key);
    return `<div class="cob-picker-tree-row ${selector.category===key && !selector.treeCode?'selected':''}"><button type="button" class="cob-picker-tree-toggle" data-picker-toggle-category="${key}" aria-label="${expanded?'收起':'展开'}${label}" aria-expanded="${expanded}">${expanded?'▾':'▸'}</button><button type="button" class="cob-picker-tree-label" data-picker-category="${key}">${label}</button></div>${expanded?accountNodes(key):''}`;
  }).join('')}`;
}

function chooseSubject(host, book, ctx, actions, fieldName) {
  const current = getState(book);
  const selector = {accounts:reportAccounts(reportData(book,current),book.accounts || []), category:'', treeCode:'', expandedCategories:new Set(), expandedAccounts:new Set(), search:'', disabled:false, page:1, size:50, selected:String(current.draft[fieldName] ?? current[fieldName] ?? '')};
  const categoryName = category => ({asset:'资产',liability:'负债',equity:'权益',cost:'成本',income:'损益',expense:'损益'}[category] || category || '');
  const filtered = () => pickerFiltered(selector);
  const pending=ctx.modal('选择科目', `<div class="cob-picker"><input type="hidden" name="account_code" value="${h(selector.selected,ctx)}"><aside class="cob-picker-categories" aria-label="科目分类"></aside><div class="cob-picker-main"><div class="cob-picker-tools"><input type="search" data-picker-search placeholder="请输入关键字" aria-label="搜索科目"><label><input type="checkbox" data-picker-disabled> 显示禁用科目</label><button type="button" data-picker-clear>清空选择</button><button type="button" data-picker-refresh>⟳ 刷新</button></div><div class="cob-picker-results"></div></div></div>`, async form => {
    current.draft[fieldName]=String(form.elements.account_code.value);
    const input=(current.host || host).querySelector(`[name="${fieldName}"]`);
    if (input) input.value=current.draft[fieldName];
  }, {wide:true});
  queueMicrotask(() => {
    const form=document.querySelector('#app-modal-form');
    const picker=form?.querySelector('.cob-picker');
    if (!picker) return;
    const submit=form.querySelector('[type="submit"]');
    if (submit) submit.textContent='确定';
    const results=picker.querySelector('.cob-picker-results');
    const tree=picker.querySelector('.cob-picker-categories');
    const drawTree=() => {const top=tree.scrollTop, left=tree.scrollLeft; tree.innerHTML=pickerTree(selector,ctx); tree.scrollTop=top; tree.scrollLeft=left;};
    const draw=() => {
      const rows=filtered(), all=hierarchy(selector.accounts);
      const pages=Math.max(1,Math.ceil(rows.length/selector.size));
      selector.page=Math.max(1,Math.min(selector.page,pages));
      const start=(selector.page-1)*selector.size;
      results.innerHTML=`<div class="cob-picker-scroll"><table><thead><tr><th>序号</th><th>科目编码</th><th>科目名称</th><th>科目全称</th><th>方向</th><th>科目类别</th></tr></thead><tbody>${rows.slice(start,start+selector.size).map((a,i) => `<tr tabindex="0" role="radio" aria-checked="${selector.selected===a.code}" data-picker-code="${h(a.code,ctx)}" class="${selector.selected===a.code?'selected':''}"><td>${start+i+1}</td><td>${h(a.code,ctx)}</td><td>${h(a.name,ctx)}</td><td>${h(pickerFullName(a,all),ctx)}</td><td>${a.direction==='debit'?'借':a.direction==='credit'?'贷':h(a.direction,ctx)}</td><td>${h(categoryName(a.category),ctx)}</td></tr>`).join('') || '<tr><td colspan="6" class="cob-picker-empty">没有符合条件的科目</td></tr>'}</tbody></table></div><div class="cob-picker-pages"><label>每页显示 <select data-picker-size aria-label="每页显示条数">${[20,50,100].map(n=>`<option ${selector.size===n?'selected':''}>${n}</option>`).join('')}</select></label><button type="button" data-picker-page="first" ${selector.page===1?'disabled':''}>|‹</button><button type="button" data-picker-page="prev" ${selector.page===1?'disabled':''}>‹</button><span>第 ${selector.page} 页</span><button type="button" data-picker-page="next" ${selector.page===pages?'disabled':''}>›</button><button type="button" data-picker-page="last" ${selector.page===pages?'disabled':''}>›|</button><span>共${pages}页，${rows.length}条记录</span></div>`;
    };
    const selectRow = row => { selector.selected=row.dataset.pickerCode; form.elements.account_code.value=selector.selected; draw(); [...results.querySelectorAll('[data-picker-code]')].find(item => item.dataset.pickerCode===selector.selected)?.focus(); };
    picker.addEventListener('click',async event => {
      const toggleCategory=event.target.closest('[data-picker-toggle-category]');
      const toggleAccount=event.target.closest('[data-picker-toggle-account]');
      const category=event.target.closest('[data-picker-category]');
      const treeAccount=event.target.closest('[data-picker-tree-code]');
      const row=event.target.closest('[data-picker-code]');
      const page=event.target.closest('[data-picker-page]');
      if (toggleCategory) {const key=toggleCategory.dataset.pickerToggleCategory; selector.expandedCategories.has(key)?selector.expandedCategories.delete(key):selector.expandedCategories.add(key); drawTree();}
      else if (toggleAccount) {const key=toggleAccount.dataset.pickerToggleAccount; selector.expandedAccounts.has(key)?selector.expandedAccounts.delete(key):selector.expandedAccounts.add(key); drawTree();}
      else if (category) {selector.category=category.dataset.pickerCategory; selector.treeCode=''; if(selector.category) selector.expandedCategories.add(selector.category); selector.page=1; drawTree(); draw();}
      else if (treeAccount) {selector.treeCode=treeAccount.dataset.pickerTreeCode; selector.category=hierarchy(selector.accounts).find(a=>a.code===selector.treeCode)?.category || ''; if (['income','expense'].includes(selector.category)) selector.category='profit'; selector.page=1; drawTree(); draw();}
      else if (row) selectRow(row);
      else if (page && !page.disabled) {const pages=Math.max(1,Math.ceil(filtered().length/selector.size)); selector.page=({first:1,prev:selector.page-1,next:selector.page+1,last:pages})[page.dataset.pickerPage]; draw();}
      else if (event.target.closest('[data-picker-clear]')) {selector.selected=''; form.elements.account_code.value=''; draw();}
      else if (event.target.closest('[data-picker-refresh]')) {
        const button=event.target.closest('[data-picker-refresh]'); button.disabled=true;
        try {const latest=await ctx.api(`/api/books/${encodeURIComponent(book.client.id)}?period=${encodeURIComponent(book.period)}`); if (!Array.isArray(latest.accounts)) throw new Error('科目数据格式错误'); selector.accounts=reportAccounts(reportData(book,current),latest.accounts); if (selector.treeCode && !selector.accounts.some(a=>String(a.code)===selector.treeCode)) selector.treeCode=''; drawTree(); if (selector.selected && !selector.accounts.some(a=>String(a.code)===selector.selected)) {selector.selected=''; form.elements.account_code.value='';} draw();}
        catch(error) {ctx.toast(error.message || '刷新科目失败','error');} finally {button.disabled=false;}
      }
    });
    picker.addEventListener('keydown',event => {const row=event.target.closest('[data-picker-code]'); if (row && (event.key==='Enter' || event.key===' ')) {event.preventDefault(); selectRow(row);}});
    picker.addEventListener('input',event => {if(event.target.matches('[data-picker-search]')) {selector.search=event.target.value; selector.page=1; draw();}});
    picker.addEventListener('change',event => {if(event.target.matches('[data-picker-disabled]')) {selector.disabled=event.target.checked; selector.page=1; drawTree(); draw();} else if(event.target.matches('[data-picker-size]')) {selector.size=Number(event.target.value); selector.page=1; draw();}});
    drawTree(); draw();
  });
  return pending;
}

async function showLedger(code, book, ctx, actions={}) {
  const current = getState(book);
  let data = reportData(book,current);
  if (!current.data && (current.start!==book.period || current.end!==book.period || !matchesBasis(book,current))) {
    data = await ctx.api(`/api/books/${book.client.id}/balance?start=${encodeURIComponent(current.start)}&end=${encodeURIComponent(current.end)}&basis=${requestedBasis(current)}`);
    if (!matchesBasis(data,current)) throw new Error('余额表数据格式错误，请刷新重试');
  }
  const account = reportRows(data).find(row => String(row.account_code)===code);
  if (!account) throw new Error('科目已变化，请刷新余额表');
  let balance = number(account.opening_debit_fen)-number(account.opening_credit_fen);
  const lines = balanceDetailRows(data,[account]).filter(row => row.period_bucket!=='opening');
  const displayBalance = amount => `${amount<0?'贷':'借'} ${money(Math.abs(amount),ctx)}`;
  const rowHtml = lines.map(row => {
    balance += number(row.debit_fen)-number(row.credit_fen);
    const voucherNumber = row.reference || '—';
    return `<tr><td>${h(row.date,ctx)}</td><td>${h(voucherNumber,ctx)}</td><td>${h(row.account_code,ctx)} ${h(row.account_name,ctx)}</td><td>${h(String(row.counterparty || '').trim() || '未提供',ctx)}</td><td>${h(row.line_summary || row.summary,ctx)}</td><td class="cob-number">${row.debit_fen?money(row.debit_fen,ctx):''}</td><td class="cob-number">${row.credit_fen?money(row.credit_fen,ctx):''}</td><td class="cob-number">${displayBalance(balance)}</td><td>${deleteButton(row,ctx)}</td></tr>`;
  }).join('');
  const pending = ctx.modal(`${account.account_code} ${account.account_name} · 明细账`, `<div class="cob-ledger-head"><span>${h(book.client.name,ctx)}</span><span>${h(current.start,ctx)} — ${h(current.end,ctx)}</span></div>${projectionNotice(data,ctx)}<div class="cob-ledger wide-modal"><table><thead><tr><th>日期</th><th>凭证或来源</th><th>科目</th><th>对方公司名称</th><th>摘要</th><th>借方金额</th><th>贷方金额</th><th>余额</th><th>操作</th></tr></thead><tbody><tr class="cob-ledger-opening"><td>${h(current.start,ctx)}-01</td><td></td><td></td><td></td><td>期初余额</td><td></td><td></td><td class="cob-number">${displayBalance(number(account.opening_debit_fen)-number(account.opening_credit_fen))}</td><td></td></tr>${rowHtml || '<tr><td colspan="9" class="cob-ledger-empty">该科目本期暂无发生</td></tr>'}<tr class="cob-ledger-total"><td colspan="5">本期合计</td><td class="cob-number">${money(account.debit_fen,ctx)}</td><td class="cob-number">${money(account.credit_fen,ctx)}</td><td class="cob-number">${displayBalance(number(account.closing_debit_fen)-number(account.closing_credit_fen))}</td><td></td></tr></tbody></table></div>`);
  // Keep original voucher and classification IDs available in the detail dialog.
  // Report category codes do not replace the persisted journal account codes.
  queueMicrotask(() => {
    const ledger = globalThis.document?.querySelector('#app-modal-form .cob-ledger');
    ledger?.addEventListener('click', event => {
      const removal = event.target.closest('[data-cob-delete]');
      if (!removal || !ledger.contains(removal)) return;
      event.preventDefault();
      Promise.resolve().then(() => deleteEntry(removal,current.host,book,ctx,actions)).catch(error => ctx.toast(error?.message || String(error),'error'));
    });
  });
  return pending;
}

function csvText(value) {
  let text = String(value ?? '');
  if (/^[=+@\-\t\r]/.test(text)) text="'"+text;
  return `"${text.replace(/"/g,'""')}"`;
}

function balanceCsvLines(book, current, data, rows, total) {
  const keys=[...amountKeys.slice(0,4),...(current.ytd?['ytd_debit_fen','ytd_credit_fen']:[]),...amountKeys.slice(4)];
  const headings=['科目编码','科目名称','期初借方余额','期初贷方余额','本期借方发生额','本期贷方发生额',...(current.ytd?['本年累计借方发生额','本年累计贷方发生额']:[]),'期末借方余额','期末贷方余额'];
  return [[book.client.name,`${current.start} 至 ${current.end}`,'金额单位：元'],headings,...rows.map(row => [row.account_code,row.account_name,...keys.map(key => (number(row[key])/100).toFixed(2))]),['合计','',...keys.map(key => (number(total[key])/100).toFixed(2))]];
}

function balanceExportRows(data, rows, accounts, ytd=false) {
  const keys=[...amountKeys.slice(0,4),...(ytd?['ytd_debit_fen','ytd_credit_fen']:[]),...amountKeys.slice(4)];
  const accountMap=new Map(accounts.map(account => [String(account.code),account]));
  const groups=[['asset','资产小计'],['liability','负债小计'],['equity','权益小计'],['cost','成本小计'],['profit','损益小计'],['other','其他小计']];
  const groupFor=row => {
    const category=row.category || accountMap.get(String(row.account_code))?.category;
    return category==='income'||category==='expense' ? 'profit' : groups.some(([key]) => key===category) ? category : 'other';
  };
  const output=[], grandTotal=keys.map(() => 0);
  for (const [group,label] of groups) {
    const members=rows.filter(row => groupFor(row)===group).sort((a,b) => String(a.account_code).localeCompare(String(b.account_code)));
    if (!members.length) continue;
    // The template adds the highest selected rollups, so a parent and its
    // displayed descendants contribute only once, including contra balances.
    const roots=members.filter(row => !members.some(parent => parent!==row && String(row.account_code).startsWith(String(parent.account_code))));
    const subtotal=keys.map(key => roots.reduce((sum,row) => sum+number(row[key]),0));
    output.push(...members.map(row => ({code:String(row.account_code),name:row.account_name,level:number(row.level)||1,isCategory:Boolean(row.is_category),amounts:keys.map(key => number(row[key])/100)})));
    output.push({code:'',name:label,level:1,amounts:subtotal.map(value => value/100)});
    subtotal.forEach((value,index) => { grandTotal[index]+=value; });
  }
  output.push({code:'',name:'合  计',level:1,amounts:grandTotal.map(value => value/100)});
  return output;
}

async function exportExcel(book, ctx) {
  const current=getState(book);
  if (current.exporting) return;
  current.exporting=true;
  const exportButtons = () => current.host?.querySelectorAll?.('[data-cob-action="export"]') || [];
  const updateButtons = busy => exportButtons().forEach(button => { button.disabled=busy; button.innerHTML=`${icon('export')}${busy?'导出中…':'导出总表'}`; });
  updateButtons(true);
  try {
    // Total export is deliberately independent of the displayed month, collapsed
    // nodes, account filters and balance limits. The server owns its coverage.
    const data=await ctx.api(`/api/books/${encodeURIComponent(book.client.id)}/balance?scope=all&basis=standard`);
    if (!data || data.scope!=='all' || data.basis!=='standard' || !periodOk(data.start_period) || !periodOk(data.end_period) || data.start_period>data.end_period || !hasCategoryRows(data)) throw new Error('余额总表数据格式错误，请刷新重试');
    const totalState={...freshState(book),start:data.start_period,end:data.end_period,category:'',codeFrom:'',codeTo:'',min:'',max:'',levelFrom:'1',levelTo:'100',showDisabled:true,showAuxiliary:true,showZero:false,showActivityZero:true,ytd:false};
    const rows=filteredRows(data,totalState,book.accounts || []);
    const maxLevel=Math.max(6,...rows.map(row => number(row.level)||1));
    const bytes=createBalanceXlsx({scope:'all',basis:'standard',hasProjection:hasReportProjection(data),companyName:book.client.name,startPeriod:data.start_period,endPeriod:data.end_period,levelFrom:1,levelTo:maxLevel,showActivityZero:true,ytd:false,rows:balanceExportRows(data,rows,book.accounts || [])});
    const blob=new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    const url=URL.createObjectURL(blob), anchor=document.createElement('a');
    try {
      const now=new Date(), pad=value => String(value).padStart(2,'0');
      const timestamp=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}+${pad(now.getHours())}_${pad(now.getMinutes())}_${pad(now.getSeconds())}`;
      const reportPeriod=`${compactPeriod(data.start_period)}-${compactPeriod(data.end_period)}`;
      anchor.href=url; anchor.download=`${String(book.client.name).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')}_余额总表_${reportPeriod}+${timestamp}.xlsx`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
    } finally { setTimeout(() => URL.revokeObjectURL(url),1000); }
  } finally { current.exporting=false; updateButtons(false); }
}

export function bindCompanyBalance(container, book, ctx, actions={}) {
  const host=resolveHost(container);
  if (!host || bound.has(host)) return;
  bound.add(host);
  const current=getState(book);
  current.host=host;
  for (const input of host.querySelectorAll('[data-cob-mixed]')) input.indeterminate = true;
  if (current.focusPending && !current.loading && current.data) {
    current.focusPending = false;
    const preferred = (current.postings || []).flatMap(p => p.posted_lines).find(line => !String(line.account_code || '').startsWith('1002'));
    const rows = [...host.querySelectorAll('[data-cob-account]')];
    const target = rows.find(row => row.dataset.cobAccount === String(preferred?.account_code || '')) || rows.find(row => row.classList.contains('cob-posted'));
    target?.scrollIntoView?.({block:'nearest'});
  }
  // Re-entering a cached report must restore its range in the outer period rail.
  // Successful requests repaint and bind here too, so they notify only once.
  if (!current.loading && !current.error && !current.failedKey && matchesBasis(current.data,current) && current.data?.start_period===current.start && current.data?.end_period===current.end) {
    rememberBalanceRange(book,current);
    actions.reportRange?.(current.start,current.end);
  }
  const reportError=error => ctx.toast(error?.message || String(error),'error');
  host.addEventListener('input',event => {
    const input=event.target;
    if (input.closest('[data-cob-form]') && ['start','end','codeFrom','codeTo','min','max','levelFrom','levelTo'].includes(input.name)) current.draft[input.name]=input.value;
  });
  host.addEventListener('submit',event => {
    const form=event.target.closest('[data-cob-form]');
    if (!form) return;
    event.preventDefault();
    if (current.loading) return;
    try { valuesFromForm(form,current); current.data=null; current.failedKey=''; queryData(host,book,ctx,actions,{force:true}).catch(reportError); } catch(error) { reportError(error); }
  });
  host.addEventListener('change',event => {
    const selectionInput=event.target.closest('[data-cob-select]');
    if (typeof selectionInput?.dataset.cobSelect === 'string') {
      if (current.deleting || selectionInput.disabled) return;
      const model=deletionModel(reportData(book,current),current,book);
      const value=selectionInput.dataset.cobSelect;
      const keys=value==='all'?model.sources.keys():value.startsWith('account:')?model.byCode.get(value.slice(8)) || []:[value];
      for (const key of keys) if (model.sources.has(key)) selectionInput.checked?model.selected.add(key):model.selected.delete(key);
      repaint(host,book,ctx,actions);
      return;
    }
    const input=event.target.closest('[data-cob-check]');
    if (!input) return;
    try {
      if (input.dataset.cobCheck==='standardBasis' && current.deleteMode) return;
      current[input.dataset.cobCheck]=input.checked;
      if (input.dataset.cobCheck==='standardBasis') {
        rememberStandardBasis(input.checked);
        current.data=null; current.failedKey=''; current.error=''; current.request++; current.loading=false;
        queryData(host,book,ctx,actions,{force:true}).catch(reportError);
        return;
      }
      if (input.dataset.cobCheck==='expanded') current.collapsed.clear();
      repaint(host,book,ctx,actions);
    } catch(error) { reportError(error); }
  });
  host.addEventListener('click',event => {
    const bookAction=event.target.closest('[data-book-action]');
    if (bookAction && host.contains(bookAction)) {
      event.preventDefault();
      event.stopPropagation();
      if (bookAction.disabled) return;
      Promise.resolve().then(() => {
        if (typeof actions.perform !== 'function') throw new Error('账簿操作尚未连接，请刷新工作台');
        return actions.perform(bookAction.dataset.bookAction,Number(bookAction.dataset.id) || undefined);
      }).catch(reportError);
      return;
    }
    const removal=event.target.closest('[data-cob-delete]');
    if (removal && host.contains(removal)) { event.preventDefault(); event.stopPropagation(); Promise.resolve().then(() => deleteEntry(removal,host,book,ctx,actions)).catch(reportError); return; }
    const category=event.target.closest('[data-cob-category]');
    const toggle=event.target.closest('[data-cob-toggle]');
    const ledger=event.target.closest('[data-cob-ledger]');
    const subject=event.target.closest('[data-cob-subject]');
    const action=event.target.closest('[data-cob-action]');
    const accountRow=event.target.closest('tr[data-cob-account]');
    if (category) { current.category=category.dataset.cobCategory; repaint(host,book,ctx,actions); return; }
    if (toggle) {
      const code=toggle.dataset.cobToggle;
      if (!current.expanded) { current.expanded=true; current.collapsed=new Set(reportRows(reportData(book,current)).filter(row => !row.is_leaf && String(row.account_code)!==code && !code.startsWith(String(row.account_code))).map(row => String(row.account_code))); }
      else if (current.collapsed.has(code)) current.collapsed.delete(code); else current.collapsed.add(code);
      repaint(host,book,ctx,actions); return;
    }
    if (ledger) { showLedger(ledger.dataset.cobLedger,book,ctx,actions).catch(reportError); return; }
    if (subject) { Promise.resolve(chooseSubject(host,book,ctx,actions,subject.dataset.cobSubject)).catch(reportError); return; }
    if (accountRow && !event.target.closest('button,input,select,a,summary')) { showLedger(accountRow.dataset.cobAccount,book,ctx,actions).catch(reportError); return; }
    if (!action || action.disabled) return;
    try {
      switch(action.dataset.cobAction) {
        case 'delete-mode': {
          if (current.deleting) return;
          current.deleteMode=!current.deleteMode;
          current.selection=new Set();
          const previousBasis=current.standardBasis;
          if (current.deleteMode) { current.returnStandardBasis=previousBasis; current.standardBasis=false; }
          else { current.standardBasis=current.returnStandardBasis; }
          if (previousBasis !== current.standardBasis) {
            current.data=null; current.failedKey=''; current.error=''; current.request++; current.loading=false;
            queryData(host,book,ctx,actions,{force:true}).catch(reportError);
          } else repaint(host,book,ctx,actions);
          return;
        }
        case 'delete-selected': deleteSelected(host,book,ctx,actions).catch(reportError); return;
        case 'accounts': actions.view?.('accounts'); return;
        case 'filters': current.filtersOpen=!current.filtersOpen; repaint(host,book,ctx,actions); return;
        case 'show-all': current.showZero=true; current.showActivityZero=true; current.category=''; current.codeFrom=current.codeTo=current.min=current.max=''; current.levelFrom='1'; current.levelTo='6'; current.draft={}; repaint(host,book,ctx,actions); return;
        case 'reset': { const replacement=freshState(book); replacement.data=matchesBasis(current.data,replacement)&&current.data?.start_period===book.period&&current.data?.end_period===book.period?current.data:null; state=replacement; repaint(host,book,ctx,actions); return; }
        case 'refresh': current.data=null; current.failedKey=''; queryData(host,book,ctx,actions,{force:true}).catch(reportError); return;
        case 'print': window.print(); return;
        case 'export': exportExcel(book,ctx).catch(reportError); return;
      }
    } catch(error) { reportError(error); }
  });
  if (!current.data && !current.loading && current.failedKey!==queryKey(book,current)) queryData(host,book,ctx,actions).catch(reportError);
}

export const companyBalanceTest = {rollupTrial, hierarchy, filteredRows, visibleRows, reportTotals, toFen, pickerFiltered, pickerTree, balanceCsvLines, balanceExportRows, balanceDetailRows, detailGroups, tableMarkup, showLedger, reportRows, reportAccounts, exportExcel, deleteEntry, deletionModel, deleteSelected};
