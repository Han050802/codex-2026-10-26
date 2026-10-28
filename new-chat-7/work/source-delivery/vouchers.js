(function () {
  'use strict';
  window.Pages = window.Pages || {};
  const ui = { key: '', search: '', selected: new Set(), page: 1, size: 500, batch: false, more: false, filters: {} };
  const uid = () => 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const amount = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const symbols = {
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    filter: '<path d="M3 4h18l-7 8v7l-4 2v-9z"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3v.1"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    upload: '<path d="M8 3H4v18h16V8l-5-5H8m6 0v6h6M8 14h8m-4-4 4 4-4 4"/>',
    print: '<path d="M6 8V3h12v5M6 17H3V8h18v9h-3M6 14h12v7H6zM17 11h1"/>',
    book: '<path d="M5 3h14v18H5zM8 7h8M8 11h8M8 15h5"/>',
    refresh: '<path d="M20 9a8 8 0 1 0 0 7M20 3v6h-6"/>',
    clip: '<path d="m9 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9m-5 12 7-7"/>',
    total: '<path d="M6 5h12v16H6zM9 3h6v4H9zM9 11h6M9 15h6"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    left: '<path d="m15 5-7 7 7 7"/>',
    right: '<path d="m9 5 7 7-7 7"/>',
    first: '<path d="M5 4v16m13-15-7 7 7 7"/>',
    last: '<path d="M19 4v16M6 5l7 7-7 7"/>'
  };
  const icon = (name, cls = '') => `<svg class="v-icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${symbols[name] || symbols.book}</svg>`;
  function seed(app) {
    if (app.state.period !== '202609') return [];
    return [{ id: uid(), date: '2026-09-15', number: '记-001', maker: '用户3355', attachments: 0, entries: [156.40, 157.70, 156.70, 157.50, 156.30].map(n => ({ summary: '成本支出', account: '560217 管理费用_通讯费', debit: n, credit: 0 })).concat([{ summary: '成本支出', account: '220201 应付账款_中国电信股份有限公司北京分公司', debit: 0, credit: 784.60 }]) }];
  }
  function sync(app) {
    const key = `${app.state.company.id}:${app.state.period}`;
    if (ui.key !== key) Object.assign(ui, { key, search: '', selected: new Set(), page: 1, batch: false, more: false, filters: {} });
  }
  function all(app) {
    let records = typeof app.getVouchers === 'function' ? app.getVouchers() : null;
    if (!app.getVouchers) { try { records = JSON.parse(localStorage.getItem('yidaizhang-vouchers-' + ui.key)); } catch (_) {} }
    if (Array.isArray(records)) return records;
    const recordsSeed = seed(app);
    save(app, recordsSeed);
    return recordsSeed;
  }
  function save(app, records) {
    if (app.saveVouchers) app.saveVouchers(records);
    else localStorage.setItem('yidaizhang-vouchers-' + ui.key, JSON.stringify(records));
  }
  function totals(v) { return (v.entries || []).reduce((a, e) => [a[0] + (+e.debit || 0), a[1] + (+e.credit || 0)], [0, 0]); }
  function filtered(app) {
    const query = ui.search.trim().toLowerCase();
    return all(app).filter(v => {
      const sum = totals(v)[0];
      return (!query || [v.date, v.number, v.maker, ...(v.entries || []).flatMap(e => [e.summary, e.account, e.debit, e.credit, amount(e.debit), amount(e.credit)])].join(' ').toLowerCase().includes(query))
        && (!ui.filters.start || v.date >= ui.filters.start) && (!ui.filters.end || v.date <= ui.filters.end)
        && (!ui.filters.min || sum >= Number(ui.filters.min)) && (!ui.filters.max || sum <= Number(ui.filters.max));
    });
  }
  function render(app) {
    sync(app);
    const records = filtered(app), totalPages = Math.max(1, Math.ceil(records.length / ui.size));
    ui.page = Math.min(ui.page, totalPages);
    const shown = records.slice((ui.page - 1) * ui.size, ui.page * ui.size);
    const selectedAll = records.length > 0 && records.every(v => ui.selected.has(v.id));
    return `<div class="voucher-page">
      <div class="v-toolbar">
        <div class="v-search"><input type="search" data-v-search aria-label="搜索凭证" placeholder="可输入凭证号/摘要/科目/金额..." value="${esc(ui.search)}"><button data-v-action="search" aria-label="搜索">${icon('search')}</button></div>
        <button class="v-more ${ui.more ? 'is-open' : ''}" data-v-action="more">${icon('filter')}更多条件${icon('down')}</button>
        <button class="v-help" data-v-action="help" title="凭证操作帮助" aria-label="凭证操作帮助">${icon('help')}</button>
        <div class="v-tools-spacer"></div>
        <button class="v-orange" data-v-action="add"><span class="v-plus">＋</span>新增凭证</button>
        <div class="v-dropdown-wrap"><button class="v-orange-outline" data-v-action="batch">批量操作${icon('down')}</button>${ui.batch ? `<div class="v-dropdown"><button data-v-action="delete">删除所选凭证${ui.selected.size ? `（${ui.selected.size}）` : ''}</button><button data-v-action="exportSelected">导出所选凭证</button></div>` : ''}</div>
        <button class="v-tool" data-v-action="importExport">${icon('upload')}导入/导出</button>
        <button class="v-tool" data-v-action="print">${icon('print')}打印</button>
        <button class="v-tool" data-v-action="book">${icon('book')}电子账本</button>
        <button class="v-tool" data-v-action="refresh">${icon('refresh')}刷新</button>
        <input class="v-hidden" type="file" accept=".csv,text/csv" data-v-file>
      </div>
      ${ui.more ? `<form class="v-filter-panel" data-v-filters><label>开始日期<input type="date" name="start" value="${esc(ui.filters.start || '')}"></label><label>结束日期<input type="date" name="end" value="${esc(ui.filters.end || '')}"></label><label>最小金额<input type="number" min="0" step="0.01" name="min" value="${esc(ui.filters.min || '')}" placeholder="不限"></label><label>最大金额<input type="number" min="0" step="0.01" name="max" value="${esc(ui.filters.max || '')}" placeholder="不限"></label><button class="v-orange" type="submit">查询</button><button class="v-orange-outline" type="button" data-v-action="resetFilters">重置</button></form>` : ''}
      <div class="v-table-wrap">
        <table class="v-table"><colgroup><col class="v-col-check"><col class="v-col-summary"><col class="v-col-account"><col class="v-col-debit"><col class="v-col-credit"></colgroup>
          <thead><tr><th><input type="checkbox" data-v-select-all aria-label="选择全部凭证" ${selectedAll ? 'checked' : ''}></th><th>摘要</th><th>科目</th><th>借方金额</th><th>贷方金额</th></tr></thead>
          <tbody>${shown.length ? shown.map(v => voucherRows(v)).join('') : `<tr class="v-empty"><td colspan="5"><div class="v-empty-symbol">${icon('book')}</div><p>${ui.search || Object.keys(ui.filters).length ? '未找到符合条件的凭证' : '本期暂无凭证'}</p><button data-v-action="add">＋ 新增凭证</button></td></tr>`}</tbody>
        </table>
      </div>
      <div class="v-pagination"><span>每页显示</span><select data-v-size aria-label="每页显示"><option value="20" ${ui.size === 20 ? 'selected' : ''}>20</option><option value="50" ${ui.size === 50 ? 'selected' : ''}>50</option><option value="100" ${ui.size === 100 ? 'selected' : ''}>100</option><option value="500" ${ui.size === 500 ? 'selected' : ''}>500</option></select><button data-v-action="first" title="首页" ${ui.page <= 1 ? 'disabled' : ''}>${icon('first')}</button><button data-v-action="prev" title="上一页" ${ui.page <= 1 ? 'disabled' : ''}>${icon('left')}</button><span>第</span><input type="number" data-v-page min="1" max="${totalPages}" value="${ui.page}" aria-label="页码"><span>页</span><button data-v-action="next" title="下一页" ${ui.page >= totalPages ? 'disabled' : ''}>${icon('right')}</button><button data-v-action="last" title="末页" ${ui.page >= totalPages ? 'disabled' : ''}>${icon('last')}</button><span class="v-page-count">共${totalPages}页, ${records.length}条记录</span></div>
    </div>`;
  }
  function voucherRows(v) {
    const sums = totals(v);
    const entries = v.entries || [];
    return `<tr class="v-record-meta" data-v-id="${esc(v.id)}"><td><input type="checkbox" data-v-select="${esc(v.id)}" aria-label="选择凭证${esc(v.number)}" ${ui.selected.has(v.id) ? 'checked' : ''}></td><td colspan="4"><span>日期：${esc(v.date)}</span><span>制单人: ${esc(v.maker || '用户3355')}</span><button class="v-record-link" data-v-action="edit" data-v-id="${esc(v.id)}">凭证字号: ${esc(v.number)}</button><button class="v-record-link v-attachment" data-v-action="attachments" data-v-id="${esc(v.id)}">附单据 ${Number(v.attachments || 0)} 张</button><span class="v-paperclip">${icon('clip')}<u>${Number(v.attachments || 0)}</u></span><button class="v-edit-on-hover" data-v-action="edit" data-v-id="${esc(v.id)}">编辑凭证</button></td></tr>${entries.map((e, idx) => `<tr class="v-entry-row ${ui.selected.has(v.id) ? 'v-selected' : ''}" data-v-id="${esc(v.id)}" title="双击编辑凭证">${idx === 0 ? `<td class="v-record-gutter" rowspan="${entries.length + 1}"></td>` : ''}<td>${esc(e.summary)}</td><td>${esc(e.account)}</td><td class="v-amount">${Number(e.debit) ? amount(e.debit) : ''}</td><td class="v-amount">${Number(e.credit) ? amount(e.credit) : ''}</td></tr>`).join('')}<tr class="v-total-row"><td colspan="2">${icon('total')}总计</td><td class="v-amount">${amount(sums[0])}</td><td class="v-amount">${amount(sums[1])}</td></tr>`;
  }
  function refresh(app, focusSearch) {
    const page = document.querySelector('.voucher-page:not(.voucher-dialog)');
    if (!page) return;
    const pos = page.querySelector('[data-v-search]')?.selectionStart;
    page.outerHTML = render(app);
    bind(app);
    if (focusSearch) { const input = document.querySelector('[data-v-search]'); input?.focus(); try { input?.setSelectionRange(pos, pos); } catch (_) {} }
  }
  function say(app, message) { if (app.toast) app.toast(message); }
  function close(app) { if (app.closeModal) app.closeModal(); }
  function show(app, html, mount) {
    if (app.modal) app.modal(`<div class="voucher-page voucher-dialog">${html}</div>`, modal => mount?.(modal.querySelector('.voucher-dialog') || modal));
  }
  function bind(app) {
    const page = document.querySelector('.voucher-page:not(.voucher-dialog)');
    if (!page || page.dataset.bound) return;
    page.dataset.bound = '1';
    page.addEventListener('click', ev => {
      const button = ev.target.closest('[data-v-action]');
      if (!button) return;
      const action = button.dataset.vAction;
      const record = all(app).find(v => v.id === button.dataset.vId);
      if (action === 'search') { ui.search = page.querySelector('[data-v-search]').value; ui.page = 1; refresh(app, true); }
      else if (action === 'more') { ui.more = !ui.more; ui.batch = false; refresh(app); }
      else if (action === 'batch') { ui.batch = !ui.batch; refresh(app); }
      else if (action === 'add' || action === 'edit') editor(app, record);
      else if (action === 'delete') confirmDelete(app);
      else if (action === 'exportSelected') exportRows(app, all(app).filter(v => ui.selected.has(v.id)));
      else if (action === 'importExport') importExport(app);
      else if (action === 'print') window.print();
      else if (action === 'refresh') { ui.search = ''; ui.filters = {}; ui.page = 1; ui.selected.clear(); refresh(app); say(app, '凭证已刷新'); }
      else if (action === 'first' || action === 'prev' || action === 'next' || action === 'last') { const max = Math.max(1, Math.ceil(filtered(app).length / ui.size)); ui.page = action === 'first' ? 1 : action === 'last' ? max : Math.max(1, Math.min(max, ui.page + (action === 'prev' ? -1 : 1))); refresh(app); }
      else if (action === 'resetFilters') { ui.filters = {}; ui.page = 1; refresh(app); }
      else if (action === 'attachments') attachments(app, record);
      else if (action === 'book') book(app);
      else if (action === 'help') show(app, `<div class="v-dialog-head"><h2>凭证操作帮助</h2><button data-v-close aria-label="关闭">${icon('close')}</button></div><div class="v-dialog-content v-help-content"><p>点击“新增凭证”录入凭证，借方合计与贷方合计相等后即可保存。</p><p>点击凭证字号或双击分录可编辑凭证。勾选凭证后，可通过“批量操作”删除或导出。</p><p>支持按凭证号、摘要、科目和金额搜索；更多条件可筛选日期和金额。</p><p>数据保存在当前浏览器中，各家公司、各个期间独立保存。</p></div><div class="v-dialog-footer"><button class="v-orange" data-v-close>知道了</button></div>`, box => box.querySelectorAll('[data-v-close]').forEach(el => el.onclick = () => close(app)));
    });
    page.addEventListener('dblclick', ev => { const row = ev.target.closest('.v-entry-row'); if (row) editor(app, all(app).find(v => v.id === row.dataset.vId)); });
    let timer;
    page.querySelector('[data-v-search]').addEventListener('input', ev => { clearTimeout(timer); const value = ev.target.value; timer = setTimeout(() => { ui.search = value; ui.page = 1; refresh(app, true); }, 220); });
    page.addEventListener('change', ev => {
      const el = ev.target;
      if (el.matches('[data-v-select-all]')) { filtered(app).forEach(v => el.checked ? ui.selected.add(v.id) : ui.selected.delete(v.id)); refresh(app); }
      else if (el.matches('[data-v-select]')) { el.checked ? ui.selected.add(el.dataset.vSelect) : ui.selected.delete(el.dataset.vSelect); refresh(app); }
      else if (el.matches('[data-v-size]')) { ui.size = Number(el.value); ui.page = 1; refresh(app); }
      else if (el.matches('[data-v-page]')) { ui.page = Math.max(1, Number(el.value) || 1); refresh(app); }
    });
    page.querySelector('[data-v-filters]')?.addEventListener('submit', ev => { ev.preventDefault(); ui.filters = Object.fromEntries(new FormData(ev.target)); ui.page = 1; refresh(app); });
  }
  function editor(app, original) {
    const isEdit = !!original;
    const period = app.state.period || '202609';
    const firstDay = `${period.slice(0, 4)}-${period.slice(4, 6)}-15`;
    const record = original ? JSON.parse(JSON.stringify(original)) : { id: uid(), date: firstDay, number: '记-' + String(all(app).length + 1).padStart(3, '0'), attachments: 0, maker: '用户3355', entries: [{ summary: '', account: '', debit: '', credit: '' }, { summary: '', account: '', debit: '', credit: '' }] };
    show(app, `<div class="v-dialog-head"><h2>${isEdit ? '编辑凭证' : '新增凭证'}</h2><button data-v-close aria-label="关闭">${icon('close')}</button></div><form class="v-editor" data-v-editor><div class="v-editor-company">${esc(app.state.company.name)}</div><div class="v-editor-fields"><label>日期<input type="date" name="date" value="${esc(record.date)}" required></label><label>凭证字号<input name="number" value="${esc(record.number)}" required></label><label>附单据<input type="number" name="attachments" min="0" value="${Number(record.attachments || 0)}"><span>张</span></label></div><datalist id="v-account-list"><option value="1001 库存现金"><option value="1002 银行存款"><option value="1122 应收账款"><option value="220201 应付账款_中国电信股份有限公司北京分公司"><option value="560217 管理费用_通讯费"></datalist><div class="v-editor-table-wrap"><table class="v-editor-table"><thead><tr><th>摘要</th><th>会计科目</th><th>借方金额</th><th>贷方金额</th><th></th></tr></thead><tbody data-v-editor-rows>${record.entries.map(entryInput).join('')}</tbody><tfoot><tr><td colspan="2">合计<span data-v-balance-status></span></td><td data-v-debit-total></td><td data-v-credit-total></td><td></td></tr></tfoot></table></div><button type="button" class="v-add-entry" data-v-add-entry>＋ 添加分录</button><p class="v-editor-error" data-v-error role="alert"></p><div class="v-dialog-footer"><span class="v-maker">制单人：${esc(record.maker)}</span><button type="button" class="v-orange-outline" data-v-close>取消</button><button type="submit" class="v-orange">保存凭证</button></div></form>`, box => {
      const form = box.querySelector('form'), rows = box.querySelector('[data-v-editor-rows]');
      const calculate = () => {
        const sums = Array.from(rows.rows).reduce((s, row) => [s[0] + (+row.querySelector('[name=debit]').value || 0), s[1] + (+row.querySelector('[name=credit]').value || 0)], [0, 0]);
        box.querySelector('[data-v-debit-total]').textContent = amount(sums[0]); box.querySelector('[data-v-credit-total]').textContent = amount(sums[1]);
        const status = box.querySelector('[data-v-balance-status]'), balanced = Math.abs(sums[0] - sums[1]) < 0.005;
        status.textContent = balanced ? '借贷平衡' : `差额 ${amount(Math.abs(sums[0] - sums[1]))}`; status.className = balanced ? 'is-balanced' : 'is-unbalanced';
        return sums;
      };
      box.querySelectorAll('[data-v-close]').forEach(el => el.onclick = () => close(app));
      box.querySelector('[data-v-add-entry]').onclick = () => { rows.insertAdjacentHTML('beforeend', entryInput({})); calculate(); };
      rows.addEventListener('click', ev => { const btn = ev.target.closest('[data-v-remove-entry]'); if (btn && rows.rows.length > 2) { btn.closest('tr').remove(); calculate(); } else if (btn) say(app, '每张凭证至少保留两条分录'); });
      rows.addEventListener('input', ev => {
        if (ev.target.name === 'debit' && +ev.target.value > 0) ev.target.closest('tr').querySelector('[name=credit]').value = '';
        if (ev.target.name === 'credit' && +ev.target.value > 0) ev.target.closest('tr').querySelector('[name=debit]').value = '';
        calculate();
      });
      calculate();
      form.onsubmit = ev => {
        ev.preventDefault();
        const entries = Array.from(rows.rows).map(row => Object.fromEntries(Array.from(row.querySelectorAll('input')).map(input => [input.name, input.value.trim()]))).filter(e => e.summary || e.account || +e.debit || +e.credit).map(e => ({ ...e, debit: Math.round((+e.debit || 0) * 100) / 100, credit: Math.round((+e.credit || 0) * 100) / 100 }));
        const sums = calculate();
        const error = entries.length < 2 ? '请至少填写两条分录。' : entries.some(e => !e.summary || !e.account) ? '请填写每条分录的摘要和会计科目。' : entries.some(e => e.debit < 0 || e.credit < 0 || (!e.debit && !e.credit)) ? '每条分录请填写大于零的借方或贷方金额。' : Math.abs(sums[0] - sums[1]) > 0.005 ? '借贷金额不平衡，请核对后保存。' : !sums[0] ? '凭证金额不能为零。' : '';
        box.querySelector('[data-v-error]').textContent = error;
        if (error) return;
        const values = new FormData(form), updated = { ...record, date: values.get('date'), number: values.get('number').trim(), attachments: Number(values.get('attachments')), entries };
        if (updated.date.replaceAll('-', '').slice(0, 6) !== period) { box.querySelector('[data-v-error]').textContent = '凭证日期应在当前账期内，请调整日期或切换期间。'; return; }
        const records = all(app);
        save(app, isEdit ? records.map(v => v.id === updated.id ? updated : v) : records.concat(updated));
        close(app); refresh(app); say(app, isEdit ? '凭证已保存' : '凭证新增成功');
      };
    });
  }
  function entryInput(e) { return `<tr><td><input name="summary" aria-label="摘要" value="${esc(e.summary || '')}" placeholder="输入摘要"></td><td><input name="account" list="v-account-list" aria-label="会计科目" value="${esc(e.account || '')}" placeholder="输入科目编码或名称"></td><td><input name="debit" type="number" step="0.01" min="0" aria-label="借方金额" value="${Number(e.debit) || ''}"></td><td><input name="credit" type="number" step="0.01" min="0" aria-label="贷方金额" value="${Number(e.credit) || ''}"></td><td><button type="button" data-v-remove-entry title="删除分录" aria-label="删除分录">×</button></td></tr>`; }
  function confirmDelete(app) {
    if (!ui.selected.size) { say(app, '请先勾选要删除的凭证'); return; }
    show(app, `<div class="v-dialog-head"><h2>删除凭证</h2><button data-v-close aria-label="关闭">${icon('close')}</button></div><div class="v-dialog-content"><p>确认删除选中的 ${ui.selected.size} 张凭证？</p><p class="v-muted">删除后将从当前公司、当前账期中移除。</p></div><div class="v-dialog-footer"><button class="v-orange-outline" data-v-close>取消</button><button class="v-orange" data-v-confirm-delete>确认删除</button></div>`, box => {
      box.querySelectorAll('[data-v-close]').forEach(el => el.onclick = () => close(app));
      box.querySelector('[data-v-confirm-delete]').onclick = () => { const count = ui.selected.size; save(app, all(app).filter(v => !ui.selected.has(v.id))); ui.selected.clear(); ui.batch = false; close(app); refresh(app); say(app, `已删除 ${count} 张凭证`); };
    });
  }
  function exportRows(app, records) {
    if (!records.length) { say(app, '没有可导出的凭证'); return; }
    const rows = [['凭证ID', '日期', '凭证字号', '制单人', '附单据', '摘要', '科目', '借方金额', '贷方金额']];
    records.forEach(v => (v.entries || []).forEach(e => rows.push([v.id, v.date, v.number, v.maker, v.attachments || 0, e.summary, e.account, e.debit || '', e.credit || ''])));
    if (app.exportCSV) app.exportCSV(`凭证_${app.state.company.name}_${app.state.period}.csv`, rows);
    else { const csv = '\uFEFF' + rows.map(row => row.map(c => '"' + String(c ?? '').replaceAll('"', '""') + '"').join(',')).join('\r\n'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = `凭证_${app.state.period}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
    ui.batch = false; refresh(app); say(app, `已导出 ${records.length} 张凭证`);
  }
  function parseCSV(text) {
    const rows = [], row = []; let cell = '', quoted = false;
    text = text.replace(/^\uFEFF/, '');
    for (let i = 0; i < text.length; i++) { const ch = text[i]; if (ch === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; } else if (ch === ',' && !quoted) { row.push(cell); cell = ''; } else if ((ch === '\n' || ch === '\r') && !quoted) { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some(v => v.trim())) rows.push(row.slice()); row.length = 0; cell = ''; } else cell += ch; }
    row.push(cell); if (row.some(v => v.trim())) rows.push(row); return rows;
  }
  function importExport(app) {
    show(app, `<div class="v-dialog-head"><h2>凭证导入 / 导出</h2><button data-v-close aria-label="关闭">${icon('close')}</button></div><div class="v-dialog-content"><p>将当前查询结果导出为 CSV，或导入相同格式的凭证文件。</p><div class="v-import-actions"><button class="v-orange" data-v-export-all>导出当前凭证</button><button class="v-orange-outline" data-v-export-template>下载导入模板</button></div><label class="v-dropzone">${icon('upload')}<strong>选择 CSV 文件导入</strong><span>支持日期、凭证字号、摘要、科目、借方金额、贷方金额等字段</span><input type="file" accept=".csv,text/csv" data-v-import></label><p class="v-editor-error" data-v-import-error role="alert"></p><p class="v-muted">导入前会核对凭证的借贷平衡，已有凭证将继续保留。</p></div><div class="v-dialog-footer"><button class="v-orange-outline" data-v-close>关闭</button></div>`, box => {
      box.querySelectorAll('[data-v-close]').forEach(el => el.onclick = () => close(app));
      box.querySelector('[data-v-export-all]').onclick = () => exportRows(app, filtered(app));
      box.querySelector('[data-v-export-template]').onclick = () => exportRows(app, [{ id: '示例001', date: `${app.state.period.slice(0, 4)}-${app.state.period.slice(4, 6)}-15`, number: '记-001', maker: '用户3355', attachments: 0, entries: [{ summary: '费用支付', account: '560217 管理费用_通讯费', debit: 100, credit: 0 }, { summary: '费用支付', account: '1002 银行存款', debit: 0, credit: 100 }] }]);
      box.querySelector('[data-v-import]').onchange = async ev => {
        const file = ev.target.files[0]; if (!file) return;
        const error = box.querySelector('[data-v-import-error]');
        try {
          const rows = parseCSV(await file.text()), heads = rows.shift() || [];
          const index = name => heads.indexOf(name), get = (row, name) => row[index(name)] || '';
          const required = ['日期', '凭证字号', '摘要', '科目', '借方金额', '贷方金额'];
          if (required.some(h => index(h) === -1)) throw new Error('文件缺少必要字段，请下载导入模板并按模板填写。');
          const groups = new Map();
          rows.forEach((row, idx) => {
            const date = get(row, '日期'), number = get(row, '凭证字号'), key = (get(row, '凭证ID') || number) + ':' + date;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.replaceAll('-', '').slice(0, 6) !== app.state.period) throw new Error(`第 ${idx + 2} 行的日期应在当前账期内，格式为 YYYY-MM-DD。`);
            if (!groups.has(key)) groups.set(key, { id: uid(), date, number, maker: get(row, '制单人') || '用户3355', attachments: Number(get(row, '附单据')) || 0, entries: [] });
            const e = { summary: get(row, '摘要'), account: get(row, '科目'), debit: Number(get(row, '借方金额').replaceAll(',', '')) || 0, credit: Number(get(row, '贷方金额').replaceAll(',', '')) || 0 };
            if (!number || !e.summary || !e.account || e.debit < 0 || e.credit < 0 || (!e.debit && !e.credit) || (e.debit && e.credit)) throw new Error(`第 ${idx + 2} 行的凭证信息或金额不完整。`);
            groups.get(key).entries.push(e);
          });
          const records = Array.from(groups.values());
          if (!records.length) throw new Error('文件中没有可导入的凭证。');
          const invalid = records.find(v => v.entries.length < 2 || Math.abs(totals(v)[0] - totals(v)[1]) > 0.005);
          if (invalid) throw new Error(`凭证 ${invalid.number} 借贷不平衡，请检查文件。`);
          save(app, all(app).concat(records)); close(app); refresh(app); say(app, `成功导入 ${records.length} 张凭证`);
        } catch (err) { error.textContent = err.message || '文件导入失败，请检查 CSV 格式。'; }
      };
    });
  }
  function attachments(app, record) {
    if (!record) return;
    show(app, `<div class="v-dialog-head"><h2>凭证附件 · ${esc(record.number)}</h2><button data-v-close aria-label="关闭">${icon('close')}</button></div><div class="v-dialog-content"><p>附单据数量：${Number(record.attachments || 0)} 张</p><p class="v-muted">可编辑凭证调整附单据数量。当前示例未添加实际附件文件。</p></div><div class="v-dialog-footer"><button class="v-orange-outline" data-v-close>关闭</button><button class="v-orange" data-v-edit-attachment>编辑凭证</button></div>`, box => { box.querySelectorAll('[data-v-close]').forEach(el => el.onclick = () => close(app)); box.querySelector('[data-v-edit-attachment]').onclick = () => editor(app, record); });
  }
  function book(app) {
    const records = filtered(app), sum = records.reduce((n, v) => n + totals(v)[0], 0);
    show(app, `<div class="v-dialog-head"><h2>电子账本</h2><button data-v-close aria-label="关闭">${icon('close')}</button></div><div class="v-dialog-content"><div class="v-book-summary"><strong>${esc(app.state.company.name)}</strong><span>账期 ${esc(app.state.period)}</span><span>凭证 ${records.length} 张</span><span>借贷合计 ¥${amount(sum)}</span></div><p class="v-muted">导出当前账期的凭证记录，可供本地归档和查阅。</p></div><div class="v-dialog-footer"><button class="v-orange-outline" data-v-close>关闭</button><button class="v-orange" data-v-book-export>导出账本</button></div>`, box => { box.querySelectorAll('[data-v-close]').forEach(el => el.onclick = () => close(app)); box.querySelector('[data-v-book-export]').onclick = () => exportRows(app, records); });
  }
  window.VOUCHER_SEED = seed;
  window.Pages.vouchers = { render, bind };
})();
