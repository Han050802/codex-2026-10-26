import { taxColumns } from './tax-overview.js';

export function createTaxActions(ctx) {
  const e = ctx.escape, state = () => ctx.getState(), data = () => ctx.getData(), period = () => ctx.getPeriod(), list = key => data()[key] || [];
  const clients = () => list('clients').filter(c => !c.deleted), client = id => clients().find(c => Number(c.id) === Number(id));
  const currentWorkflow = cid => list('tax_workflows').filter(w => Number(w.client_id) === Number(cid) && w.period === period()).sort((a, b) => Number(b.id) - Number(a.id))[0];
  const selectedRows = () => ctx.getSelected().map(item => item.client && item.workflow ? item : ctx.getView().rows.find(row => Number(row.client.id) === Number(item.id))).filter(Boolean);
  const verification = w => w.verification_stale ? 'unverified' : w.derived_verification_status || w.verification_status || 'unverified';
  const checkState = (w, area = 'overall') => w.check_stale ? 'not_checked' : w[`derived_${area}_status`] || w[`${area}_status`] || 'not_checked';
  const checkNames = { not_checked: '未检查', passed: '检查通过', failed: '检查不通过', not_applicable: '不适用', warning: '提示复核', disabled: '提示已关闭' }, verificationNames = { unverified: '未验证', passed: '已人工核对通过', failed: '人工核对未通过' };
  const errorText = error => [error.message, error.details ? typeof error.details === 'string' ? error.details : JSON.stringify(error.details) : ''].filter(Boolean).join('；');
  const notice = '<div class="notice">本页仅维护本地人工匹配和资料检查，不执行税局身份认证、申报提交或实际缴款。</div>';
  const confirmList = (rows, month) => `<ol class="batch-confirm-list" data-tax-confirm-list data-period="${e(month)}">${rows.map(row => `<li data-confirm-client-id="${row.client.id}" data-workflow-id="${row.workflow.id}">${e(row.client.name)}</li>`).join('')}</ol>`;
  const validAgents = cid => list('tax_agents').filter(a => !a.deleted && a.enabled !== false && a.enabled !== 0 && (a.client_id == null || Number(a.client_id) === Number(cid)));
  function agentManager() {
    const agents = list('tax_agents'), workflows = list('tax_workflows').filter(w => w.period === period()), names = { unverified: '未验证', passed: '已人工核对通过', failed: '人工核对未通过' };
    const agentRows = agents.map(a => ctx.tr([e(a.name), e(a.phone || ''), e(a.role || ''), a.client_id == null ? '机构通用' : e(ctx.clientName(a.client_id)), a.enabled === false || a.enabled === 0 ? '已停用' : '已启用', `<div class="row-actions">${ctx.link('编辑', 'agent-edit', `data-id="${a.id}"`)}${ctx.link('删除', 'agent-delete', `data-id="${a.id}"`)}${ctx.link('配置匹配', 'tax-workflow-new', `data-agent-id="${a.id}"`)}</div>`]));
    const workflowRows = workflows.map(w => ctx.tr([e(ctx.clientName(w.client_id)), e(w.period), e(w.tax_agent_name || list('tax_agents').find(a => Number(a.id) === Number(w.tax_agent_id))?.name || '未匹配'), e(names[verification(w)] || '未验证'), e(checkNames[checkState(w)]), w.verification_stale || w.check_stale ? '资料已变化，需重新核对' : '当前记录', `<div class="row-actions">${ctx.link('修改配置 / 人工验证', 'tax-workflow-edit', `data-workflow-id="${w.id}" data-id="${w.client_id}"`)}${ctx.link('删除配置', 'tax-workflow-delete', `data-workflow-id="${w.id}"`)}</div>`]));
    return ctx.modal('办税人管理 / 本地匹配配置', `${notice}<div class="actions">${ctx.btn('新增办税联系人', 'agent-new')}${ctx.btn('新增客户匹配', 'tax-workflow-new')}</div><h3 class="small">本地办税联系人</h3>${ctx.entityTable('tax_agents', agents, ['姓名', '电话', '角色', '归属', '启用状态', '操作'], agentRows, '暂无办税联系人，请先新增')}<h3 class="small">${e(period())} 本地客户匹配（含未验证）</h3>${ctx.entityTable('tax_workflows', workflows, ['客户', '期间', '办税人', '人工验证', '本地检查', '资料状态', '操作'], workflowRows, '暂无本期匹配配置')}`);
  }
  function workflowForm(id, defaults = {}) {
    const original = id ? list('tax_workflows').find(w => Number(w.id) === Number(id)) : defaults.client_id ? currentWorkflow(defaults.client_id) : null;
    if (id && !original) throw new Error('匹配配置已变化，请刷新重试');
    const initial = { client_id: defaults.client_id || list('tax_agents').find(a => Number(a.id) === Number(defaults.tax_agent_id))?.client_id || '', period: period(), tax_agent_id: defaults.tax_agent_id || '', verification_status: 'unverified', verification_note: '', individual_applicable: false, annual_project_id: '', note: '', ...(original || {}), ...defaults };
    initial.verification_status = original ? verification(original) : initial.verification_status;
    const agentOptions = cid => { const valid = validAgents(cid), oldAgent = initial.tax_agent_id && list('tax_agents').find(a => Number(a.id) === Number(initial.tax_agent_id)); if (oldAgent && !valid.some(a => a.id === oldAgent.id)) valid.push({ ...oldAgent, name: oldAgent.name + '（已停用或归属变化，请重选）' }); return [['', '未匹配办税人'], ...valid.map(a => [a.id, `${a.name}${a.client_id == null ? '（机构通用）' : ''}`])]; };
    const projects = cid => [['', '不关联本地年度项目'], ...list('projects').filter(p => !p.deleted && Number(p.client_id) === Number(cid)).map(p => [p.id, p.name])];
    const clientField = ctx.selectField('客户 *', 'client_id', [['', '请选择客户'], ...clients().map(c => [c.id, c.name])], initial.client_id).replace('<select ', original ? '<select disabled ' : '<select ');
    const promise = ctx.modal(original ? '修改本地报税匹配 / 人工验证' : '新增本地报税匹配', `${notice}<div class="form-grid">${clientField}${ctx.field('业务期间 *', 'period', initial.period, 'month', original ? 'required readonly' : 'required')}${ctx.selectField('本地办税联系人', 'tax_agent_id', agentOptions(initial.client_id), initial.tax_agent_id)}${ctx.selectField('人工资料验证', 'verification_status', [['unverified', '未验证'], ['passed', '已人工核对通过'], ['failed', '人工核对未通过']], initial.verification_status)}${ctx.textarea('人工核对说明（通过 / 未通过时必填）', 'verification_note', initial.verification_note || '', 'maxlength="2000"')}<label class="wide inline"><input type="checkbox" name="individual_applicable" ${initial.individual_applicable ? 'checked' : ''}>将个税记录纳入本地检查（此设置不判断法定申报义务）</label>${ctx.selectField('本地年度项目', 'annual_project_id', projects(initial.client_id), initial.annual_project_id, true)}${ctx.textarea('配置备注', 'note', initial.note || '', 'maxlength="2000"')}</div>`, async form => {
      const v = ctx.formData(form), cid = Number(original?.client_id || v.client_id), month = original?.period || v.period, agentId = v.tax_agent_id ? Number(v.tax_agent_id) : null, status = v.verification_status, note = (v.verification_note || '').trim();
      if (!client(cid)) throw new Error('请选择客户'); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('请选择有效业务期间');
      if (agentId && !validAgents(cid).some(a => Number(a.id) === agentId)) throw new Error('请匹配已启用且属于此客户或机构通用的办税人');
      if (status !== 'unverified' && !note) throw new Error('人工验证通过或未通过均须填写核对说明'); if (status === 'passed' && !agentId) throw new Error('请先匹配有效办税人');
      const existing = original || list('tax_workflows').find(w => Number(w.client_id) === cid && w.period === month); if (!original && existing) throw new Error('该客户期间已有匹配配置，请从办税人管理中的“修改配置 / 人工验证”打开原记录，避免覆盖已有设置'); const payload = { client_id: cid, period: month, tax_agent_id: agentId, verification_status: status, verification_note: note, individual_applicable: Boolean(form.querySelector('[name="individual_applicable"]')?.checked), annual_project_id: v.annual_project_id ? Number(v.annual_project_id) : null, note: (v.note || '').trim(), ...(existing ? { version: existing.version } : {}) };
      await ctx.api(original ? `/api/tax-workflows/${original.id}` : '/api/tax-workflows', { method: original ? 'PATCH' : 'POST', body: payload }); await ctx.reload(); ctx.toast('本地匹配配置已保存');
    });
    const form = document.querySelector('#app-modal-form');
    form?.elements.client_id?.addEventListener('change', () => { const cid = Number(form.elements.client_id.value); form.elements.tax_agent_id.innerHTML = agentOptions(cid).map(([value, label]) => `<option value="${value}">${e(label)}</option>`).join(''); form.elements.annual_project_id.innerHTML = projects(cid).map(([value, label]) => `<option value="${value}">${e(label)}</option>`).join(''); });
    return promise;
  }
  function filterDialog(field = '') {
    const s = state(), labels = [...new Set([...(data().settings?.labels || []), ...clients().flatMap(c => c.labels || [])])].map(v => [v, v]), regions = [...new Set(clients().map(c => c.region).filter(Boolean))].map(v => [v, v]);
    const promise = ctx.modal('筛选报税检查客户', `${['switch_count'].includes(field) ? '<div class="notice">外部企业切换次数未接入，此处只筛选本地已配置并人工匹配通过的客户。</div>' : ''}<div class="form-grid">${ctx.field('客户名称 / 助记码 / 办税人 / 备注', 'search', s.search, 'text', '', true)}${ctx.selectField('员工', 'accountant', [['', '全部员工'], ...ctx.users().map(u => [u.id, u.name])], s.accountant)}${ctx.selectField('地区', 'region', [['', '全部地区'], ...regions], s.region)}${ctx.selectField('纳税性质', 'taxpayer', [['', '全部纳税性质'], ['small', '小规模纳税人'], ['general', '一般纳税人']], s.taxpayer)}${ctx.selectField('办税人', 'agentId', [['', '全部办税人'], ...list('tax_agents').filter(a => !a.deleted).map(a => [a.id, a.name])], s.agentId)}${ctx.selectField('人工验证', 'verificationStatus', [['', '全部状态'], ['unverified', '未验证'], ['passed', '已人工核对通过'], ['failed', '人工核对未通过']], s.verificationStatus)}${ctx.selectField('申报登记状态', 'submissionStatus', [['', '全部申报状态'], ['pending', '未申报'], ['in_progress', '进行中'], ['submitted', '已申报']], s.submissionStatus)}${ctx.selectField('缴款登记状态', 'paymentStatus', [['', '全部缴款状态'], ['unpaid', '未缴款'], ['in_progress', '进行中'], ['paid', '已缴款']], s.paymentStatus)}${ctx.selectField('本地汇总检查', 'checkStatus', [['', '全部检查状态'], ['not_checked', '未检查'], ['passed', '检查通过'], ['failed', '检查不通过']], s.checkStatus)}${ctx.selectField('国税检查结果', 'nationalCheckStatus', [['', '全部国税结果'], ['not_checked', '未检查'], ['passed', '检查通过'], ['failed', '检查不通过'], ['not_applicable', '不适用']], s.nationalCheckStatus)}${ctx.selectField('个税检查结果', 'individualCheckStatus', [['', '全部个税结果'], ['not_checked', '未检查'], ['passed', '检查通过'], ['failed', '检查不通过'], ['not_applicable', '不适用']], s.individualCheckStatus)}<label class="wide inline"><input type="checkbox" name="hasNote" ${s.hasNote ? 'checked' : ''}>仅显示有配置备注或人工核对说明的客户</label>${ctx.selectField('客户标签', 'label', [['', '全部标签'], ...labels], s.label)}<div class="wide actions">${ctx.btn('重置筛选', 'tax-reset-filters')}${ctx.btn('更换导入名单', 'tax-import-list')}${ctx.btn('清空导入名单', 'tax-clear-list')}</div></div>`, async form => { const v = ctx.formData(form); for (const key of ['search', 'accountant', 'region', 'taxpayer', 'agentId', 'verificationStatus', 'submissionStatus', 'paymentStatus', 'checkStatus', 'nationalCheckStatus', 'individualCheckStatus', 'label']) s[key] = (v[key] || '').trim(); s.hasNote = Boolean(form.querySelector('[name="hasNote"]')?.checked); await ctx.changed(); });
    const names = { name: 'search', tax_agent: 'agentId', verification_status: 'verificationStatus', submission_status: 'submissionStatus', payment_status: 'paymentStatus', check_status: 'checkStatus', national_check_status: 'nationalCheckStatus', individual_check_status: 'individualCheckStatus', taxpayer_type: 'taxpayer' };
    setTimeout(() => document.querySelector(`#app-modal-form [name="${names[field] || field}"]`)?.focus(), 0); return promise;
  }
  function columnsDialog() { const s = state(), columns = taxColumns(); return ctx.modal('报税检查列设置', '<div class="notice">选择、序号、客户名称和操作列保持显示。</div><div class="form-grid">' + columns.map(c => `<label class="inline"><input type="checkbox" name="visible_columns" value="${c.key}" ${!s.hiddenColumns.includes(c.key) ? 'checked' : ''} ${c.required ? 'disabled' : ''}>${e(c.label)}</label>`).join('') + '</div>', async form => { const visible = new Set([...form.querySelectorAll('[name="visible_columns"]:checked')].map(input => input.value)); s.hiddenColumns = columns.filter(c => !c.required && !visible.has(c.key)).map(c => c.key); await ctx.render(); }); }
  async function periodDialog() { let month = period(); const ok = await ctx.modal('选择报税业务月份', `<div class="form-grid">${ctx.field('业务期间', 'period', month, 'month', 'required', true)}</div>`, async form => { month = form.elements.period.value; if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('请选择有效业务期间'); }); if (ok) await ctx.setPeriod(month); }
  function checkSettings() { const config = { warn_unreviewed_vouchers: true, warn_unposted_invoices: true, ...(data().settings?.tax_check_config || {}) }, version = data().settings?.version; return ctx.modal('本地报税检查设置', `${notice}<div class="notice">税号资料、有效办税人匹配、当前人工验证、本期税务记录与回执、登记金额一致性等核心规则始终执行。以下开关仅控制资料复核提示。</div><div class="form-grid"><label class="wide inline"><input type="checkbox" name="warn_unreviewed_vouchers" ${config.warn_unreviewed_vouchers ? 'checked' : ''}>提示本期待审核凭证</label><label class="wide inline"><input type="checkbox" name="warn_unposted_invoices" ${config.warn_unposted_invoices ? 'checked' : ''}>提示本期未制证票据</label></div>`, async form => { const checked = name => Boolean(form.querySelector(`[name="${name}"]`)?.checked); await ctx.api('/api/settings', { method: 'POST', body: { version, tax_check_config: { warn_unreviewed_vouchers: checked('warn_unreviewed_vouchers'), warn_unposted_invoices: checked('warn_unposted_invoices') } } }); await ctx.reload(); ctx.toast('本地检查提示设置已保存，资料变化后请重新检查'); }); }
  function checkDialog(id) {
    let candidates;
    if (id) {
      const company = client(id), workflow = currentWorkflow(id);
      if (!company || !workflow) throw new Error('该客户本期尚无本地匹配配置，请先配置办税人');
      if (verification(workflow) !== 'passed' || !validAgents(id).some(agent => Number(agent.id) === Number(workflow.tax_agent_id))) return ctx.toast('当前资料尚未人工核对通过或办税人匹配已变化，请先重新核对', 'error');
      candidates = [{ client: company, workflow }];
    } else candidates = selectedRows();
    const rows = candidates.map(row => ({ client: { ...row.client }, workflow: { ...row.workflow } }));
    if (!rows.length) return ctx.toast('请先勾选已配置并人工匹配通过的客户', 'error');
    const month = period();
    return ctx.modal(rows.length === 1 ? '确认本地报税资料检查' : '确认批量本地报税资料检查', `${notice}<p>期间：<strong>${e(month)}</strong>，仅检查以下 ${rows.length} 家客户。结果由实际本地资料规则生成，不能手工改成通过；逐家报告完成情况。</p>${confirmList(rows, month)}`, async () => {
      const results = [];
      for (const row of rows) { try { const result = await ctx.api(`/api/tax-workflows/${row.workflow.id}/check`, { method: 'POST', body: { version: row.workflow.version } }); results.push({ id: row.client.id, workflowId: row.workflow.id, name: row.client.name, ok: true, status: checkState(result), details: result.check_details || [] }); } catch (error) { results.push({ id: row.client.id, workflowId: row.workflow.id, name: row.client.name, ok: false, error: errorText(error) }); } }
      try { await ctx.reload(); await ctx.changed(); } catch (error) { ctx.toast(`检查请求已结束，列表刷新失败：${error.message}`, 'error'); }
      setTimeout(() => ctx.modal('本地报税检查结果', `<div class="notice" data-tax-batch-results data-period="${e(month)}">本次 ${results.length} 家，完成检查 ${results.filter(r => r.ok).length} 家，未完成 ${results.filter(r => !r.ok).length} 家。完成检查不表示检查通过或已向税局申报。</div>${ctx.table(['客户', '处理结果', '本地检查结果 / 原因', '操作'], results.map(r => `<tr data-tax-result-id="${r.id}" data-result-ok="${r.ok}" data-check-status="${r.status || ''}"><td>${e(r.name)}</td><td>${r.ok ? '已完成本地检查' : '未完成'}</td><td class="wrap">${e(r.error || checkNames[r.status] || r.status)}</td><td>${r.ok ? ctx.link('检查明细', 'tax-details', `data-id="${r.id}"`) : ''}</td></tr>`))}`), 10);
    });
  }
  function details(id) {
    const w = currentWorkflow(id), c = client(id); if (!w || !c) throw new Error('本期本地配置不存在，请先配置办税人匹配');
    const taxRecords = list('tax_records').filter(t => Number(t.client_id) === Number(id) && t.period === period()), details = w.check_details || [];
    return ctx.modal(`${c.name} · 本地报税及检查详情`, `${notice}${w.verification_stale || w.check_stale ? '<div class="notice warn">资料已经变化，历史验证或检查结果已过期，请重新人工核对并运行检查。</div>' : ''}<p>期间：${e(w.period)}　人工验证：${e(verificationNames[verification(w)])}　汇总检查：${e(checkNames[checkState(w)])}</p><p>检查时间：${e(w.checked_at || '未检查')}　操作员：${e(w.checked_by_name || '—')}</p>${ctx.table(['范围', '检查项目', '当前结果', '真实资料说明'], details.map(d => ctx.tr([e(({ overall: '汇总', general: '国税', individual: '个税', annual: '年度项目' })[d.scope] || d.scope), e(d.title), e(checkNames[d.state] || d.state), e(d.detail)])), '尚未运行本地检查')}<h3 class="small">本期税务登记记录</h3>${ctx.table(['税种', '登记状态', '应缴', '实缴', '回执 / 附件', '来源'], taxRecords.map(t => ctx.tr([e(t.tax_type), e(({ pending: '未申报', preparing: '进行中', submitted: '已人工登记申报' })[t.status] || t.status), ctx.money(t.amount_fen), ctx.money(t.paid_fen), e(t.reference || (t.attachment_id ? '本地附件 #' + t.attachment_id : '未留存')), t.source === 'import' ? '文件导入' : '人工登记'])), '暂无本期本地税务记录')}<p>人工核对说明：${e(w.verification_note || '—')}<br>备注：${e(w.note || '—')}</p><div class="actions">${ctx.btn('人工匹配 / 验证', 'tax-workflow-edit', `data-workflow-id="${w.id}" data-id="${c.id}"`)}${ctx.btn('查看 / 登记税务记录', 'tax-records', `data-id="${c.id}"`)}${ctx.btn('重新本地检查', 'tax-check-one', `data-id="${c.id}"`)}</div>`);
  }
  function flowDetails(stage, status) {
    const view = ctx.getView(), all = stage === 'verification' ? view.workflowRows : view.eligibleRows, key = { verification: 'verificationStatus', submission: 'submissionStatus', payment: 'paymentStatus', check: 'checkStatus' }[stage], rows = key ? all.filter(row => !status || row[key] === status) : all;
    const maps = { verification: verificationNames, submission: { pending: '未申报', in_progress: '进行中', submitted: '已人工登记申报' }, payment: { unpaid: '未缴款', in_progress: '进行中', paid: '已人工登记缴款' }, check: checkNames };
    return ctx.modal('报税流程 · 本地记录明细', `${notice}${ctx.table(['客户', '办税人', '当前本地状态', '操作'], rows.map(row => ctx.tr([e(row.client.name), e(row.agent?.name || '未配置'), e(maps[stage]?.[row[key]] || '本地配置'), stage === 'verification' ? ctx.link('配置 / 人工验证', 'tax-workflow-edit', `data-workflow-id="${row.workflow.id}" data-id="${row.client.id}"`) : ctx.link('查看本地详情', 'tax-details', `data-id="${row.client.id}"`)])), '当前范围暂无本地记录')}<div class="actions">${ctx.btn('办税人管理 / 新增匹配', 'tax-agents')}</div>`);
  }
  function agentDetails(id, agentId) { const agent = list('tax_agents').find(a => Number(a.id) === Number(agentId || currentWorkflow(id)?.tax_agent_id)); if (!agent) return agentManager(); return ctx.modal('本地办税联系人', `${notice}<p>姓名：${e(agent.name)}<br>联系电话：${e(agent.phone || '—')}<br>角色：${e(agent.role || '—')}<br>归属：${e(agent.client_id == null ? '机构通用' : ctx.clientName(agent.client_id))}<br>备注：${e(agent.note || '—')}</p><div class="actions">${ctx.btn('编辑联系人', 'agent-edit', `data-id="${agent.id}"`)}${ctx.btn('修改客户匹配', 'tax-verification', `data-id="${id}"`)}</div>`); }
  function localAccount(id) { const c = client(id), w = currentWorkflow(id); if (!c) throw new Error('客户已变化，请刷新重试'); return ctx.modal('本地税务资料', `${notice}<p>客户：${e(c.name)}<br>本地留存税号：${e(c.tax_no || '未登记')}<br>本期人工验证：${e(w ? verificationNames[verification(w)] : '未配置')}</p><div class="actions">${ctx.btn('维护客户资料', 'tax-client-profile', `data-id="${id}"`)}${ctx.btn('本地税务记录', 'tax-records', `data-id="${id}"`)}${ctx.btn('配置 / 人工验证', 'tax-verification', `data-id="${id}"`)}</div>`); }
  function rowMore(id) { const c = client(id); if (!c) throw new Error('客户已变化，请刷新重试'); return ctx.modal(`${c.name} · 更多`, `<div class="actions">${ctx.btn('本地报税详情', 'tax-details', `data-id="${id}"`)}${ctx.btn('人工匹配 / 验证', 'tax-verification', `data-id="${id}"`)}${ctx.btn('本地报税记录', 'tax-records', `data-id="${id}"`)}${ctx.btn('新增税务登记', 'tax-record-new', `data-id="${id}"`)}${ctx.btn('本地资料检查', 'tax-check-one', `data-id="${id}"`)}${ctx.btn('客户资料', 'tax-client-profile', `data-id="${id}"`)}</div>`); }
  function exportChecks(onlySelected = false) {
    const rows = onlySelected ? selectedRows() : ctx.getView().rows; if (onlySelected && !rows.length) return ctx.toast('请先勾选需要导出的客户', 'error');
    const matrix = [['客户编码', '客户名称', '税号', '期间', '办税人', '人工验证', '验证需重核', '申报登记状态', '缴款登记状态', '汇总检查结果', '国税检查结果', '个税检查结果', '检查过期', '检查时间', '来源', '备注'], ...rows.map(row => [row.client.code, row.client.name, row.client.tax_no, row.workflow.period, row.agent?.name || row.workflow.tax_agent_name, verificationNames[verification(row.workflow)], row.workflow.verification_stale ? '是' : '否', row.submissionStatus, row.paymentStatus, checkNames[checkState(row.workflow)], checkNames[checkState(row.workflow, 'general')], checkNames[checkState(row.workflow, 'individual')], row.workflow.check_stale ? '是' : '否', row.workflow.checked_at || '', '本地人工配置 / 资料规则检查', row.workflow.note || ''])];
    const cell = value => { let text = String(value ?? ''); if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text; return '"' + text.replace(/"/g, '""') + '"'; };
    const blob = new Blob(['\ufeff' + matrix.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }), url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = `本地报税检查-${period()}-${onlySelected ? '选中' : '当前筛选'}.csv`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); ctx.toast(`已导出 ${rows.length} 家客户的本地检查记录`);
  }
  function auditDialog() { const logs = list('audit_logs').filter(log => /tax_workflows|tax_records|tax_agents/.test(log.entity || '') || log.entity === 'settings' && String(typeof log.detail === 'string' ? log.detail : JSON.stringify(log.detail || {})).includes('tax_check_config')); return ctx.modal('本地报税操作日志', ctx.table(['时间', '操作员', '操作', '对象', '真实记录详情'], logs.map(log => ctx.tr([e(log.created_at || log.timestamp || ''), e(log.user_name || ctx.users().find(u => Number(u.id) === Number(log.user_id))?.name || ''), e(log.action), e(log.entity), `<pre style="max-width:420px;white-space:pre-wrap">${e(typeof log.detail === 'string' ? log.detail : JSON.stringify(log.detail || {}, null, 2))}</pre>`])), '当前加载范围暂无报税相关日志')); }
  function chooseImportList() { ctx.closeModal(); const file = document.querySelector('[data-tax-import-file]'); if (!file) throw new Error('请返回报税总览选择名单'); file.value = ''; file.click(); }
  async function handle(action, el) {
    const id = Number(el?.dataset?.id) || null, wid = Number(el?.dataset?.workflowId) || null, aid = Number(el?.dataset?.agentId) || null;
    switch (action) {
      case 'tax-flow-toggle': state().collapsed = !state().collapsed; await ctx.render(); break;
      case 'tax-flow-details': await flowDetails(el.dataset.stage, el.dataset.status); break;
      case 'tax-agents': case 'tax-workflows': await agentManager(); break;
      case 'tax-workflow-new': await workflowForm(null, { ...(id ? { client_id: id } : {}), ...(aid ? { tax_agent_id: aid } : {}) }); break;
      case 'tax-workflow-edit': await workflowForm(wid || currentWorkflow(id)?.id); break;
      case 'tax-workflow-delete': { const w = list('tax_workflows').find(row => Number(row.id) === Number(wid)); if (!w) throw new Error('配置已变化，请刷新重试'); await ctx.workflowDelete(w); break; }
      case 'tax-verification': await workflowForm(currentWorkflow(id)?.id, { client_id: id }); break;
      case 'tax-agent-details': await agentDetails(id, aid); break;
      case 'tax-filter': await filterDialog(el.dataset.field); break;
      case 'tax-reset-filters': ctx.closeModal(); Object.assign(state(), { region: '', accountant: '', search: '', taxpayer: '', agentId: '', nationalCheckStatus: '', individualCheckStatus: '', hasNote: false, verificationStatus: '', submissionStatus: '', paymentStatus: '', checkStatus: '', label: '', mineOnly: false, importOnly: false, importIds: [], importFileName: '' }); await ctx.changed(); break;
      case 'tax-legend': { const kind = el.dataset.kind; if (kind === 'note') state().hasNote = !state().hasNote; else state().checkStatus = state().checkStatus === kind ? '' : kind; await ctx.changed(); break; }
      case 'tax-columns': await columnsDialog(); break;
      case 'tax-period': await periodDialog(); break;
      case 'tax-check-settings': await checkSettings(); break;
      case 'tax-check-batch': await checkDialog(); break;
      case 'tax-check-one': await checkDialog(id); break;
      case 'tax-details': await details(id); break;
      case 'tax-local-account': await localAccount(id); break;
      case 'tax-row-more': await rowMore(id); break;
      case 'tax-client-profile': await ctx.openClient(id); break;
      case 'tax-submission': case 'tax-payment': case 'tax-records': await ctx.openTaxRecords(id); break;
      case 'tax-record-new': await ctx.openTaxForm(null, { client_id: id, period: period() }); break;
      case 'tax-export': exportChecks(); break;
      case 'tax-export-selected': exportChecks(true); break;
      case 'tax-export-records': await ctx.exportRecords(id || ''); break;
      case 'tax-audit': await auditDialog(); break;
      case 'tax-import-list': chooseImportList(); break;
      case 'tax-clear-list': ctx.closeModal(); Object.assign(state(), { importOnly: false, importIds: [], importFileName: '' }); await ctx.changed(); break;
      default: return false;
    }
    return true;
  }
  return { handle, workflowForm, filterDialog, agentManager, checkDialog, checkSettings, details, exportChecks };
}
