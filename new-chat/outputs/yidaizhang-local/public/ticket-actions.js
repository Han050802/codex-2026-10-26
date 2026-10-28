import { ticketColumns, getTicketAmountWarnings } from './ticket-list.js';

export function createTicketActions(ctx) {
  const e = ctx.escape, state = () => ctx.getState(), data = () => ctx.getData(), period = () => ctx.getPeriod();
  const allClients = () => (data().clients || []).filter(c => !c.deleted), records = key => data()[key] || [];
  const selected = () => ctx.getSelected().map(c => ({ ...c, authorized_user_ids: [...(c.authorized_user_ids || [])] }));
  const findClient = id => allClients().find(c => Number(c.id) === Number(id));
  const nowLocal = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; };
  const errorText = error => [error.message, error.details ? typeof error.details === 'string' ? error.details : JSON.stringify(error.details) : ''].filter(Boolean).join('；');
  const checkedValues = (form, name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map(input => input.value);
  const lastRecord = (key, cid, month) => records(key).filter(r => Number(r.client_id) === Number(cid) && r.period === month).sort((a, b) => Number(b.id) - Number(a.id))[0];
  const clientsList = (companies, month = period()) => `<ol class="batch-confirm-list" data-ticket-confirm-list data-period="${e(month)}">${companies.map(c => `<li data-confirm-client-id="${c.id}">${e(c.name)}${c.code ? `<small>${e(c.code)}</small>` : ''}</li>`).join('')}</ol>`;
  const emptyNotice = message => { ctx.toast(message, 'error'); return false; };
  const batchRows = companies => companies.map(c => ({ ...c }));
  async function chooseClient(title, description, callback, explicitId) {
    if (explicitId) { const c = findClient(explicitId); if (!c) throw new Error('客户已变化，请刷新后重试'); return callback(c); }
    const choices = selected().length ? selected() : allClients();
    if (!choices.length) return emptyNotice('请先新建客户');
    if (choices.length === 1) return callback(choices[0]);
    let chosen;
    const confirmed = await ctx.modal(title, `<div class="notice">${e(description)}</div><div class="form-grid">${ctx.selectField('客户 *', 'client_id', [['', '请选择客户'], ...choices.map(c => [c.id, c.name])], '', true)}</div>`, async form => { chosen = choices.find(c => Number(c.id) === Number(form.elements.client_id.value)); if (!chosen) throw new Error('请选择客户'); });
    if (confirmed && chosen) return callback(chosen);
  }
  async function runBatch(companies, title, operation, month) {
    const results = [];
    for (const c of companies) { try { await operation(c); results.push({ id: c.id, name: c.name, ok: true }); } catch (error) { results.push({ id: c.id, name: c.name, ok: false, error: errorText(error) }); } }
    try { await ctx.reload(); await ctx.changed(); } catch (error) { ctx.toast(`处理已结束，列表刷新失败：${error.message}`, 'error'); }
    setTimeout(() => ctx.modal(`${title}结果`, `<div class="notice" data-ticket-batch-results data-period="${e(month)}">本次处理 ${results.length} 家，成功 ${results.filter(r => r.ok).length} 家，未处理 ${results.filter(r => !r.ok).length} 家。</div>${ctx.table(['客户', '结果', '说明'], results.map(r => `<tr data-ticket-result-id="${r.id}" data-result-ok="${r.ok}"><td>${e(r.name)}</td><td>${r.ok ? '已保存' : '未保存'}</td><td class="wrap">${e(r.error || '本地记录已保存')}</td></tr>`))}`), 10);
    return results;
  }
  function filterDialog(field = '') {
    const s = state(), clients = allClients(), unique = key => [...new Set(clients.map(c => c[key]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN')).map(v => [v, v]);
    const labels = [...new Set([...(data().settings?.labels || []), ...clients.flatMap(c => c.labels || [])])].map(v => [v, v]);
    const external = ['switch_count', 'login_method'].includes(field) ? '<div class="notice">企业切换次数和税局登录方式尚未接入。下方仅筛选已有本地客户、预约待办和票据记录。</div>' : '';
    const promise = ctx.modal('筛选取票客户', `${external}<div class="form-grid">${ctx.field('客户名称 / 助记码 / 随手记', 'search', s.search, 'text', '', true)}${ctx.selectField('员工', 'accountant', [['', '全部员工'], ...ctx.users().map(u => [u.id, u.name])], s.accountant)}${ctx.selectField('所属地区', 'region', [['', '全部地区'], ...unique('region')], s.region)}${ctx.selectField('申报类型', 'filingType', [['', '全部申报类型'], ['normal', '税款申报'], ['zero', '0申报']], s.filingType)}${ctx.selectField('纳税期限', 'vat_filing_frequency', [['', '全部期限'], ['month', '月'], ['quarter', '季']], s.vat_filing_frequency)}${ctx.selectField('本地取票状态', 'ticketStatus', [['', '全部取票状态'], ['empty', '未取票'], ['registered', '已登记（本地）']], s.ticketStatus)}${ctx.selectField('预约待办状态', 'appointmentStatus', [['', '全部待办状态'], ['none', '未预约'], ['scheduled', '已预约'], ['pending', '待办理'], ['completed', '待办已完成'], ['failed', '待办未完成'], ['cancelled', '已取消']], s.appointmentStatus)}${ctx.selectField('客户标签', 'label', [['', '全部标签'], ...labels], s.label)}<div class="wide actions">${ctx.btn('重置筛选', 'ticket-reset-filters')}${ctx.btn('更换导入名单', 'ticket-import-list')}${ctx.btn('清空导入名单', 'ticket-clear-list')}</div></div>`, async form => { const v = ctx.formData(form); for (const key of ['search', 'accountant', 'region', 'filingType', 'vat_filing_frequency', 'ticketStatus', 'appointmentStatus', 'label']) s[key] = (v[key] || '').trim(); await ctx.changed(); });
    const names = { name: 'search', note: 'search', filing_type: 'filingType', ticket_status: 'ticketStatus', appointment_status: 'appointmentStatus' }, focusName = names[field] || field;
    if (focusName) setTimeout(() => document.querySelector(`#app-modal-form [name="${focusName}"]`)?.focus(), 0);
    return promise;
  }
  function columnsDialog() {
    const s = state(), columns = ticketColumns(s);
    return ctx.modal('票据列表列设置', '<div class="notice">选择、序号、客户名称和操作列保持显示。</div><div class="form-grid">' + columns.map(c => `<label class="inline"><input type="checkbox" name="visible_columns" value="${c.key}" ${!s.hiddenColumns.includes(c.key) ? 'checked' : ''} ${c.required ? 'disabled' : ''}>${e(c.label)}</label>`).join('') + '</div>', async form => { const visible = new Set(checkedValues(form, 'visible_columns')); s.hiddenColumns = columns.filter(c => !c.required && !visible.has(c.key)).map(c => c.key); await ctx.render(); });
  }
  async function periodDialog() { let month = period(); const confirmed = await ctx.modal('选择业务月份', `<div class="form-grid">${ctx.field('业务月份', 'period', month, 'month', 'required', true)}</div>`, async form => { month = form.elements.period.value; if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('请选择有效业务月份'); }); if (confirmed) await ctx.setPeriod(month); }
  function guideDialog() { return ctx.modal('智能取票 · 本地操作引导', '<div class="notice">本期使用本地登记与文件导入；未连接税局、银行或自动取票服务。</div><ol style="line-height:2"><li>按纳税性质、员工或客户名称筛选，勾选需要处理的客户。</li><li>“预约取票”保存本地待办和预约时间，完成待办不会自动增加票据。</li><li>使用“更多 → 导入票据文件”导入CSV，或手工登记票据及附件。</li><li>“完善账密”打开本地客户资料；系统不保存外部税局登录密码。</li><li>“更新认证状态”仅登记人工核对记录；“发票详情”查看真实本地票据。</li></ol>'); }
  function taskManager() {
    const month = period(), clients = new Set(ctx.getView().filtered.map(c => Number(c.id))), tasks = records('ticket_tasks').filter(t => t.period === month && clients.has(Number(t.client_id))), names = { scheduled: '已预约', pending: '待办理', completed: '待办已完成', failed: '待办未完成', cancelled: '已取消' };
    return ctx.modal('本地取票任务管理', `<div class="notice">期间 ${e(month)}。任务为本地人工待办，不执行自动登录或票据采集；多条勾选后可删除。</div><div class="actions">${ctx.btn('预约选中客户', 'ticket-schedule')}${ctx.btn('新增单户待办', 'ticket-task')}</div>${ctx.entityTable('ticket_tasks', tasks, ['客户', '期间', '预约时间', '本地状态', '说明', '来源', '操作'], tasks.map(t => ctx.tr([e(ctx.clientName(t.client_id)), e(t.period), e(t.scheduled_at || '—'), e(names[t.status] || t.status), e(t.note || ''), t.source === 'import' ? '文件导入' : '人工登记', `<div class="row-actions">${ctx.link('编辑待办', 'ticket-task', `data-id="${t.client_id}" data-task-id="${t.id}"`)}${ctx.link('删除待办', 'ticket-task-delete', `data-id="${t.client_id}" data-task-id="${t.id}"`)}</div>`])), '本期当前筛选客户暂无本地待办')}`);
  }
  async function taskDialog(cid, taskId) {
    const existing = taskId ? records('ticket_tasks').find(t => Number(t.id) === Number(taskId)) : null;
    if (taskId && !existing) throw new Error('待办已变化，请刷新重试');
    return chooseClient('选择待办客户', '选择一家客户登记本地待办。', async c => {
      const month = existing?.period || period(), original = existing || lastRecord('ticket_tasks', c.id, month), initial = original || { status: 'pending', scheduled_at: '', note: '' };
      return ctx.modal(original ? '编辑本地取票待办' : '新增本地取票待办', `<div class="notice">${e(c.name)} · ${e(month)}。仅保存本地人工待办，完成待办不表示已成功取票。</div><div class="form-grid">${ctx.selectField('待办状态', 'status', [['pending', '待办理'], ['scheduled', '已预约'], ['completed', '待办已完成'], ['failed', '待办未完成'], ['cancelled', '已取消']], initial.status)}${ctx.field('预约时间', 'scheduled_at', initial.scheduled_at, 'datetime-local')}${ctx.textarea('待办说明（未完成时必填）', 'note', initial.note || '', 'maxlength="2000"')}</div>`, async form => { const v = ctx.formData(form), note = v.note.trim(); if (v.status === 'scheduled' && !v.scheduled_at) throw new Error('预约待办必须填写预约时间'); if (v.status === 'failed' && !note) throw new Error('请填写待办未完成的原因'); await ctx.api(original ? `/api/ticket-tasks/${original.id}` : '/api/ticket-tasks', { method: original ? 'PATCH' : 'POST', body: { client_id: Number(c.id), period: month, status: v.status, scheduled_at: v.scheduled_at || '', note, source: original?.source || 'manual', ...(original ? { version: original.version } : {}) } }); await ctx.reload(); ctx.toast('本地待办已保存'); });
    }, existing?.client_id || cid);
  }
  function scheduleDialog() {
    const companies = batchRows(selected()); if (!companies.length) return emptyNotice('请先勾选需要预约的客户');
    const month = period(), versions = new Map(companies.map(c => [Number(c.id), lastRecord('ticket_tasks', c.id, month)]));
    return ctx.modal('确认本地预约取票待办', `<div class="notice">将为以下 ${companies.length} 家客户保存 ${e(month)} 的本地预约待办。不会自动登录或采集税局数据；已有本期待办会按当前版本更新。</div><div class="form-grid">${ctx.field('预约时间 *', 'scheduled_at', nowLocal(), 'datetime-local', 'required', true)}${ctx.textarea('待办说明', 'note', '', 'maxlength="2000"')}</div>${clientsList(companies, month)}`, async form => { const v = ctx.formData(form); if (!v.scheduled_at) throw new Error('请填写预约时间'); await runBatch(companies, '预约待办', c => { const original = versions.get(Number(c.id)); return ctx.api('/api/ticket-tasks', { method: 'POST', body: { client_id: Number(c.id), period: month, status: 'scheduled', scheduled_at: v.scheduled_at, note: (v.note || '').trim(), source: original?.source || 'manual', ...(original ? { version: original.version } : {}) } }); }, month); });
  }
  function profileDialog(id) { return chooseClient('选择需要完善资料的客户', '打开本地客户资料。可以维护税号、联系人等资料；不收集或保存外部税局密码。', c => ctx.openClient(Number(c.id)), id); }
  function authDialog(id) {
    const companies = id ? batchRows([findClient(id)].filter(Boolean)) : batchRows(selected()); if (!companies.length) return emptyNotice('请先勾选需要人工核对的客户');
    const month = period(), versions = new Map(companies.map(c => [Number(c.id), lastRecord('ticket_auth_checks', c.id, month)]));
    return ctx.modal('更新本地人工核对状态', `<div class="notice">以下 ${companies.length} 家客户，期间 ${e(month)}。此处仅记录人工核对，不代表税局认证通过，不保存外部账号密码。</div><div class="form-grid">${ctx.selectField('人工核对状态', 'status', [['unrecorded', '未登记核对'], ['confirmed', '已人工核对'], ['needs_update', '资料待更新']], 'confirmed', true)}${ctx.textarea('核对说明', 'note', '', 'maxlength="2000"')}</div>${clientsList(companies, month)}`, async form => { const v = ctx.formData(form); await runBatch(companies, '人工核对', c => { const original = versions.get(Number(c.id)); return ctx.api('/api/ticket-auth-checks', { method: 'POST', body: { client_id: Number(c.id), period: month, status: v.status, note: (v.note || '').trim(), source: 'manual', ...(original ? { version: original.version } : {}) } }); }, month); });
  }
  function taxAccountDialog(id) {
    return chooseClient('选择本地税务资料客户', '查看本地客户税务资料和人工核对记录；不连接税局网站。', c => { const check = lastRecord('ticket_auth_checks', c.id, period()), statuses = { unrecorded: '未登记核对', confirmed: '已人工核对', needs_update: '资料待更新' }; return ctx.modal('税务数字账户 · 本地资料', `<div class="notice">原入口在本期提供本地资料查看，不执行税局登录、自动认证或取票。</div>${ctx.table(['客户', '税号', '申报类型', '纳税期限', '本期人工核对'], [ctx.tr([e(c.name), e(c.tax_no || '未登记'), c.filing_type === 'zero' ? '0申报' : '税款申报', c.vat_filing_frequency === 'month' ? '月' : c.vat_filing_frequency === 'quarter' ? '季' : '未设置', e(statuses[check?.status] || '未登记核对')])])}${check ? `<p>核对时间：${e(check.checked_at || '—')}　来源：${check.source === 'import' ? '文件导入' : '人工登记'}</p><p>${e(check.note || '')}</p>` : ''}<div class="actions">${ctx.btn('完善本地客户资料', 'ticket-profile', `data-id="${c.id}"`)}${ctx.btn('登记人工核对', 'ticket-auth', `data-id="${c.id}"`)}${ctx.btn('导入本地票据', 'ticket-import', `data-id="${c.id}"`)}${ctx.btn('发票详情', 'ticket-invoices', `data-id="${c.id}"`)}</div>`); }, id);
  }
  function rowMore(id) { const c = findClient(id); if (!c) throw new Error('客户已变化，请刷新重试'); return ctx.modal(`${c.name} · 更多操作`, `<div class="actions">${ctx.btn('本地预约待办', 'ticket-task', `data-id="${c.id}"`)}${ctx.btn('导入票据文件', 'ticket-import', `data-id="${c.id}"`)}${ctx.btn('手工登记 / 查看票据', 'ticket-invoices', `data-id="${c.id}"`)}${ctx.btn('完善本地资料', 'ticket-profile', `data-id="${c.id}"`)}${ctx.btn('人工核对状态', 'ticket-auth', `data-id="${c.id}"`)}${ctx.btn('设置纳税期限', 'ticket-frequency', `data-id="${c.id}"`)}${ctx.btn('导出本地票据', 'ticket-export', `data-id="${c.id}"`)}</div>`); }
  function frequencyDialog(id) {
    const companies = id ? batchRows([findClient(id)].filter(Boolean)) : batchRows(selected()); if (!companies.length) return emptyNotice('请先勾选需要设置纳税期限的客户');
    const month = period(), initial = companies.length === 1 ? companies[0].vat_filing_frequency || '' : '';
    return ctx.modal('设置本地纳税期限', `<div class="notice">仅维护本地客户资料，不推断税局核定期限。保存前请核对客户实际资料。</div><div class="form-grid">${ctx.selectField('纳税期限', 'vat_filing_frequency', [['', '未设置'], ['month', '月'], ['quarter', '季']], initial, true)}</div>${clientsList(companies, month)}`, async form => { const frequency = form.elements.vat_filing_frequency.value; await runBatch(companies, '纳税期限设置', c => ctx.api(`/api/clients/${c.id}`, { method: 'PATCH', body: { vat_filing_frequency: frequency, version: c.version } }), month); });
  }
  function warningContext() { const context = ctx.getContext(), config = data().settings?.ticket_warning_config || context.warningConfig || {}; return { ...context, warningConfig: { ...config, near_ratio: config.near_percent ? Number(config.near_percent) / 100 : config.near_ratio } }; }
  function cents(value) { const str = String(value || '').trim(); if (!/^\d+(\.\d{1,2})?$/.test(str)) throw new Error('阈值请输入正金额，最多两位小数'); const [whole, fraction = ''] = str.split('.'), amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')); if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('金额阈值超出有效范围'); return Number(amount); }
  function warningConfigDialog() {
    const warning = getTicketAmountWarnings(warningContext()), config = warning.config, settingsVersion = data().settings?.version;
    return ctx.modal('本地金额预警规则', `<div class="notice">默认显示来自参考页面的30万、500万提示阈值；临限默认90%，均可按本地工作需要调整。仅统计本地录入销项不含税金额，不作为正式税务计算或法定义务判断。</div><div class="form-grid">${ctx.field('季度提示阈值（元） *', 'quarter_limit', (config.quarter_limit_fen / 100).toFixed(2), 'number', 'min="0.01" step="0.01" required')}${ctx.field('滚动12月提示阈值（元） *', 'rolling12_limit', (config.rolling12_limit_fen / 100).toFixed(2), 'number', 'min="0.01" step="0.01" required')}${ctx.field('临限提醒比例（%） *', 'near_percent', Math.round(config.near_ratio * 100), 'number', 'min="1" max="100" step="1" required', true)}</div>`, async form => { const v = ctx.formData(form), near = Number(v.near_percent); if (!Number.isInteger(near) || near < 1 || near > 100) throw new Error('临限比例必须为1到100的整数'); await ctx.api('/api/settings', { method: 'POST', body: { version: settingsVersion, ticket_warning_config: { quarter_limit_fen: cents(v.quarter_limit), rolling12_limit_fen: cents(v.rolling12_limit), near_percent: near } } }); await ctx.reload(); ctx.toast('本地金额预警规则已保存'); });
  }
  function warningDetails(kind) { const warning = getTicketAmountWarnings(warningContext()), names = { near: '临限提醒', quarter: '季度超限提示', rolling12: '滚动12月超限提示' }, rows = kind === 'quarter' ? warning.overQuarter : kind === 'rolling12' ? warning.overRolling : warning.near; return ctx.modal(names[kind] || '本地金额提醒', `<div class="notice">季度累计：${e(warning.quarterStart)} 至 ${e(warning.period)}；滚动12月：${e(warning.rollingStart)} 至 ${e(warning.period)}。仅统计当前筛选小规模客户的本地销项不含税金额，不作为正式税务判断。</div>${ctx.table(['客户', '本季度截至所选月（元）', '滚动12月（元）'], rows.map(row => ctx.tr([e(row.client.name), ctx.money(row.quarter_fen), ctx.money(row.rolling12_fen)])), '当前筛选客户暂无此类本地金额提醒')}<div class="actions">${ctx.btn('调整本地提示阈值', 'ticket-warning-config')}</div>`); }
  function policyDialog() { return ctx.modal('税务政策 · 本地规则说明', '<div class="notice">此入口当前提供本地统计规则说明，不是在线税收政策查询。</div><p style="line-height:1.9">小规模页金额预警统计本地录入销项票据的不含税金额。季度范围为所选月份所在季度的首月至所选月；滚动12月范围以所选月结束。临限提醒指金额达到配置比例、且尚未超过两个配置阈值的客户。超限提示分别按季度和滚动12月统计客户数量。</p><p style="line-height:1.9">阈值和临限比例可在“金额预警”中调整；票据缺失、作废或其他税务处理应以实际资料核对，本页不推断申报义务。手工待办完成、人工资料核对均不表示税局自动取票或认证成功。</p>'); }
  function chooseImportList() { ctx.closeModal(); const file = document.querySelector('[data-ticket-import-file]'); if (!file) throw new Error('请返回智能取票页面再选择名单'); file.value = ''; file.click(); }
  async function handle(action, el) {
    const id = Number(el?.dataset?.id) || null, taskId = Number(el?.dataset?.taskId) || null;
    switch (action) {
      case 'ticket-taxpayer': state().taxpayer = el.dataset.value || ''; await ctx.changed(); break;
      case 'ticket-filter': await filterDialog(el.dataset.field); break;
      case 'ticket-reset-filters': ctx.closeModal(); Object.assign(state(), { accountant: '', search: '', region: '', filingType: '', vat_filing_frequency: '', ticketStatus: '', appointmentStatus: '', label: '', mineOnly: false, importOnly: false, importIds: [], importFileName: '' }); await ctx.changed(); break;
      case 'ticket-columns': await columnsDialog(); break;
      case 'ticket-period': await periodDialog(); break;
      case 'ticket-guide': await guideDialog(); break;
      case 'ticket-tasks': await taskManager(); break;
      case 'ticket-task': await taskDialog(id, taskId); break;
      case 'ticket-task-delete': { const task = records('ticket_tasks').find(t => Number(t.id) === Number(taskId)); if (!task) throw new Error('待办已变化，请刷新重试'); await ctx.taskDelete(task); break; }
      case 'ticket-schedule': await scheduleDialog(); break;
      case 'ticket-profile': await profileDialog(id); break;
      case 'ticket-auth': await authDialog(id); break;
      case 'ticket-tax-account': await taxAccountDialog(id); break;
      case 'ticket-row-more': await rowMore(id); break;
      case 'ticket-invoices': await chooseClient('选择票据客户', '选择一家客户查看本地票据明细。', c => ctx.openInvoices(Number(c.id)), id); break;
      case 'ticket-import': await chooseClient('选择票据归属客户', '所选客户用于补齐 CSV 中空白客户列；文件中明确填写的客户编号优先，导入前请核对。', c => ctx.importInvoices(Number(c.id)), id); break;
      case 'ticket-export': await chooseClient('选择导出票据客户', '导出所选本地客户的票据记录。', c => ctx.exportInvoices(Number(c.id)), id); break;
      case 'ticket-import-list': chooseImportList(); break;
      case 'ticket-clear-list': ctx.closeModal(); Object.assign(state(), { importOnly: false, importIds: [], importFileName: '' }); await ctx.changed(); break;
      case 'ticket-frequency': await frequencyDialog(id); break;
      case 'ticket-warning-config': await warningConfigDialog(); break;
      case 'ticket-warning': await warningDetails(el.dataset.kind); break;
      case 'ticket-policy': await policyDialog(); break;
      default: return false;
    }
    return true;
  }
  return { handle, filterDialog, columnsDialog, taskManager, taskDialog, scheduleDialog, authDialog, profileDialog, warningConfigDialog, warningDetails };
}
