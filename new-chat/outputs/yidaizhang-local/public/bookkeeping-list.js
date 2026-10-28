export const BOOKKEEPING_LIST_KEY = '记账|年度记账|exact-matrix';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const glyphs = {
  search: '<circle cx="8" cy="8" r="5"/><path d="m12 12 4 4"/>',
  refresh: '<path d="M14 6a6 6 0 1 0 1 6M14 2v4h-4"/>',
  check: '<path d="m4 9 3 3 7-8"/>',
  minus: '<path d="M5 9h8"/>',
  rejected: '<path d="m5 5 8 8M13 5l-8 8"/>'
};
const svg = name => `<svg viewBox="0 0 18 18" aria-hidden="true">${glyphs[name] || ''}</svg>`;
const positive = value => Number(value) > 0;

export function createBookkeepingState() { return { mineOnly: false }; }

/** Derive month status from real persisted period/voucher totals only. */
export function bookkeepingMonth(client, period, record) {
  if (/^\d{4}-\d{2}$/.test(client.start_period || '') && period < client.start_period) return { state: 'unbuilt', label: '未建账', period, voucherCount: 0, unreviewedCount: 0 };
  const voucherCount = Math.max(0, Number(record?.voucher_count) || 0), unreviewedCount = Math.max(0, Number(record?.unreviewed_count) || 0);
  // Pending review is not a failed review. A rejection is displayed only when
  // a future/manual persisted record explicitly identifies that actual state.
  const rejected = record?.review_status === 'rejected' || record?.audit_status === 'rejected';
  const state = rejected ? 'rejected' : record?.closed === true || positive(record?.closed) || record?.status === 'closed' ? 'closed' : voucherCount > 0 ? 'working' : 'empty';
  return { state, label: { rejected: '审核不通过', closed: '已完成', working: '进行中', empty: '未开始' }[state], period, voucherCount, unreviewedCount };
}

export function getBookkeepingData(ctx) {
  const state = ctx.state || createBookkeepingState(), year = Math.min(2099, Math.max(2000, Number(ctx.year) || new Date().getFullYear()));
  const active = (ctx.clients || []).filter(client => !client.deleted);
  const query = String(ctx.search || '').trim().toLowerCase(), userId = Number(ctx.user?.id);
  const filtered = active.filter(client =>
    (ctx.mode !== 'close' || Boolean(client.enabled)) &&
    (!ctx.accountant || Number(client.accountant_id) === Number(ctx.accountant)) &&
    (!ctx.taxpayer || client.taxpayer_type === ctx.taxpayer) &&
    (!ctx.label || (client.labels || []).includes(ctx.label)) &&
    (!query || `${client.name || ''} ${client.enterprise_name || ''} ${client.mnemonic || ''} ${client.tax_no || ''} ${client.code || ''} ${client.note || ''}`.toLowerCase().includes(query)) &&
    (!state.mineOnly || Number(client.accountant_id) === userId || (client.authorized_user_ids || []).some(id => Number(id) === userId)));
  const periodMap = new Map();
  for (const row of ctx.bookPeriods || []) {
    const key = `${Number(row.client_id)}|${row.period}`, prior = periodMap.get(key);
    // Bootstrap normally supplies one record per month. Merge defensively so
    // repeated summaries cannot conceal a real close or double-count vouchers.
    periodMap.set(key, prior ? { ...prior, ...row, closed: Boolean(prior.closed) || Boolean(row.closed), voucher_count: Math.max(Number(prior.voucher_count) || 0, Number(row.voucher_count) || 0), unreviewed_count: Math.max(Number(prior.unreviewed_count) || 0, Number(row.unreviewed_count) || 0) } : row);
  }
  return { active, filtered, periodMap, year };
}

function monthCell(client, period, record) {
  const month = bookkeepingMonth(client, period, record);
  const title = `${period} · ${month.label}${month.voucherCount ? ` · ${month.voucherCount} 张活动凭证` : ''}${month.unreviewedCount ? ` · 待审核 ${month.unreviewedCount} 张` : ''}`;
  const content = month.state === 'closed' ? `<span class="bk-status-dot bk-status-closed">${svg('check')}</span>` : month.state === 'unbuilt' ? `<span class="bk-status-dot bk-status-unbuilt">${svg('minus')}</span>` : month.state === 'rejected' ? `<span class="bk-status-dot bk-status-rejected">${svg('rejected')}</span>` : escape(month.label);
  const attrs = `class="bk-month-state bk-month-${month.state}" data-bookkeeping-state="${month.state}" data-bookkeeping-period="${period}" title="${escape(title)}" aria-label="${escape(`${client.name} ${title}`)}"`;
  return month.state === 'unbuilt' ? `<span ${attrs}>${content}</span>` : `<button type="button" ${attrs} data-action="open-book" data-id="${client.id}" data-period="${period}">${content}</button>`;
}

function pageNumbers(page, pages) {
  const start = Math.max(1, Math.min(page - 2, pages - 4)), end = Math.min(pages, start + 4);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function renderBookkeepingList(ctx, data = getBookkeepingData(ctx)) {
  const { filtered, periodMap, year } = data, state = ctx.state || createBookkeepingState();
  const scope = ctx.scope || (ctx.mode === 'close' ? 'close' : 'matrix'), key = ctx.key || BOOKKEEPING_LIST_KEY;
  const selected = ctx.selected || new Set(), paging = ctx.paging || { page: 1, size: 30 };
  paging.size = [30, 50, 100, 500].includes(Number(paging.size)) ? Number(paging.size) : 30;
  const pages = Math.max(1, Math.ceil(filtered.length / paging.size)); paging.page = Math.min(pages, Math.max(1, Number(paging.page) || 1));
  const visible = filtered.slice((paging.page - 1) * paging.size, paging.page * paging.size);
  const businessPeriod = String(ctx.currentPeriod || ctx.period || `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`);
  const currentMonth = Number(businessPeriod.slice(0, 4)) === year ? Number(businessPeriod.slice(5, 7)) : 0;
  const users = (ctx.users || []).filter(user => user.enabled !== 0), minYear = Number(ctx.minYear) || 2000, maxYear = Number(ctx.maxYear) || 2099;
  const selectedCount = [...selected].filter(id => filtered.some(client => Number(client.id) === Number(id))).length;
  const selectAttrs = `data-company-select-page="${scope}" data-entity-select-page="${scope}" aria-label="全选本页" ${visible.length ? '' : 'disabled'}`;
  const rowAlias = scope === 'close' ? 'data-close-client' : 'data-matrix-client';
  const rows = visible.map((client, index) => `<tr data-bookkeeping-client="${client.id}"><td class="bk-selection-cell"><input type="checkbox" data-company-select="${scope}" data-entity-select="${scope}" ${rowAlias} value="${client.id}" ${selected.has(Number(client.id)) ? 'checked' : ''} aria-label="选择${escape(client.name)}"></td><td class="bk-index-cell">${(paging.page - 1) * paging.size + index + 1}</td><td class="bk-name-cell"><div><button type="button" class="bk-client-name" data-action="client-detail" data-id="${client.id}" title="${escape(client.name)}">${escape(client.name)}</button><button type="button" class="bk-enter-book" data-action="open-book" data-id="${client.id}">进账簿</button></div></td>${Array.from({ length: 12 }, (_, month) => { const period = `${year}-${String(month + 1).padStart(2, '0')}`; return `<td data-bookkeeping-month="${month + 1}">${monthCell(client, period, periodMap.get(`${Number(client.id)}|${period}`))}</td>`; }).join('')}</tr>`).join('');
  const operationPeriod = ctx.mode && ctx.mode !== 'annual' ? `<label class="bk-operation-period">期间 <input type="month" data-filter="period" aria-label="业务期间" value="${escape(ctx.period || '')}"></label>` : '';
  const selectionTools = `<div class="bk-selection-tools" data-bookkeeping-selection-tools="${scope}" ${selectedCount ? '' : 'hidden'}><span>已选 <strong data-selection-count="${scope}">${selectedCount}</strong> 家</span><button type="button" class="link-btn" data-action="selection-all" data-scope="${scope}" data-key="${escape(key)}">全选筛选 ${filtered.length} 家</button><button type="button" class="link-btn" data-action="selection-clear" data-scope="${scope}">取消</button><button type="button" class="link-btn bk-remove" data-action="selection-remove" data-scope="${scope}" data-operation="recycle" data-key="${escape(key)}" data-selection-requires="${scope}" ${selectedCount ? '' : 'disabled'}>删除</button>${ctx.mode === 'close' ? `<button type="button" class="link-btn" data-action="batch-close" data-selection-requires="close" ${selectedCount ? '' : 'disabled'}>结账已选客户</button>` : ctx.mode === 'review' ? `<button type="button" class="link-btn" data-action="bookkeeping-review-selected" data-selection-requires="${scope}" ${selectedCount ? '' : 'disabled'}>审核所选账套</button>` : ctx.mode === 'print' ? `<button type="button" class="link-btn" data-action="bookkeeping-print-selected" data-selection-requires="${scope}" ${selectedCount ? '' : 'disabled'}>装订打印所选账套</button>` : ''}</div>`;
  return `<section class="bookkeeping-list-page" data-bookkeeping-list data-bookkeeping-mode="${escape(ctx.mode || 'annual')}"><div class="bk-toolbar"><div class="bk-tools-left"><div class="bk-employee"><span>▧</span><select data-filter="accountant" aria-label="全部员工"><option value="">全部员工</option>${users.map(user => `<option value="${user.id}" ${String(ctx.accountant) === String(user.id) ? 'selected' : ''}>${escape(user.name)}</option>`).join('')}</select><i>⌄</i></div><form class="bk-search" data-search-form><input name="q" aria-label="客户助记码" placeholder="请输入客户助记码..." value="${escape(ctx.search || '')}"><button type="submit" aria-label="搜索">${svg('search')}</button></form><label class="bk-mine"><input type="checkbox" data-bookkeeping-mine ${state.mineOnly ? 'checked' : ''}>名下账套</label></div>${operationPeriod}<div class="bk-year-control" data-bookkeeping-year="${year}"><button type="button" data-bookkeeping-year-step="-1" data-action="bookkeeping-year-prev" aria-label="上一年度" ${year <= minYear ? 'disabled' : ''}>‹</button><strong>${year}年</strong><button type="button" data-bookkeeping-year-step="1" data-action="bookkeeping-year-next" aria-label="下一年度" ${year >= maxYear ? 'disabled' : ''}>›</button></div>${selectionTools}<button type="button" class="bk-refresh" data-action="refresh">${svg('refresh')} 刷新</button></div><div class="bk-table-shell" data-table-key="${escape(key)}" data-selection-scope="${scope}" data-entity-scope="${scope}"><div class="bk-table-scroll"><table class="bk-table"><colgroup><col class="bk-select-col"><col class="bk-index-col"><col class="bk-name-col">${Array.from({ length: 12 }, () => '<col class="bk-month-col">').join('')}</colgroup><thead><tr><th data-bookkeeping-column="select"><input type="checkbox" ${selectAttrs}></th><th data-bookkeeping-column="index">序号</th><th data-bookkeeping-column="name">客户名称</th>${Array.from({ length: 12 }, (_, month) => `<th data-bookkeeping-column="month${String(month + 1).padStart(2, '0')}"><span class="${currentMonth === month + 1 ? 'bk-current-month' : ''}">${month + 1}月</span></th>`).join('')}</tr></thead><tbody>${rows || '<tr class="bk-empty-row"><td colspan="15">暂无符合条件的客户账套</td></tr>'}</tbody></table></div></div><div class="bk-footer"><div class="bk-legend"><span><i class="bk-status-dot bk-status-unbuilt">${svg('minus')}</i>未建账</span><span><i class="bk-status-dot bk-status-closed">${svg('check')}</i>已完成</span><span><i class="bk-status-dot bk-status-rejected">${svg('rejected')}</i>审核不通过</span></div><div class="bk-pagination"><span>共${filtered.length}条记录，${pages}页</span><button type="button" data-action="table-page" data-key="${escape(key)}" data-page="${paging.page - 1}" aria-label="上一页" ${paging.page <= 1 ? 'disabled' : ''}>‹</button>${pageNumbers(paging.page, pages).map(page => `<button type="button" class="${page === paging.page ? 'bk-current-page' : ''}" data-action="table-page" data-key="${escape(key)}" data-page="${page}" ${page === paging.page ? 'aria-current="page"' : ''}>${page}</button>`).join('')}<button type="button" data-action="table-page" data-key="${escape(key)}" data-page="${paging.page + 1}" aria-label="下一页" ${paging.page >= pages ? 'disabled' : ''}>›</button><select data-page-size="${escape(key)}" aria-label="每页条数">${[30, 50, 100, 500].map(size => `<option value="${size}" ${paging.size === size ? 'selected' : ''}>${size} 条/页</option>`).join('')}</select><form class="bk-jump" data-bookkeeping-jump><label>跳至 <input name="page" type="number" min="1" max="${pages}" aria-label="跳至页码"> 页</label><button type="submit" class="bk-jump-submit" aria-label="跳转到指定页">确定</button></form></div></div></section>`;
}

export function bindBookkeepingList(container, ctx) {
  const root = container.querySelector('[data-bookkeeping-list]'); if (!root) return;
  root.addEventListener('change', event => { if (event.target.matches('[data-bookkeeping-mine]')) ctx.onMine?.(event.target.checked); });
  root.addEventListener('submit', event => {
    if (!event.target.matches('[data-bookkeeping-jump]')) return;
    event.preventDefault(); const input = event.target.querySelector('[name="page"]'), page = Number(input.value), max = Number(input.getAttribute('max'));
    if (!Number.isInteger(page) || page < 1 || page > max) { input.setCustomValidity?.(`请输入1至${max}的页码`); input.reportValidity?.(); return; }
    input.setCustomValidity?.(''); ctx.onPage?.(page);
  });
}
