export const PROGRESS = [
  { title: '客户人工确认记录', labels: ['未登记', '待确认', '已确认'], source: '人工 / 导入' },
  { title: '票据登记进度', labels: ['未登记', '已登记·待制证', '已制证'], source: '本地票据' },
  { title: '记账进度', labels: ['未记账', '已记账', '已结账'], source: '真实账簿' },
  { title: '税务申报记录', labels: ['未登记', '已登记·准备中', '已登记申报'], source: '人工 / 导入' },
  { title: '个税申报记录', labels: ['未登记', '已登记·准备中', '已登记申报'], source: '人工 / 导入' }
];

export const PROGRESS_KEYS = ['confirmation', 'tickets', 'bookkeeping', 'filing', 'payment', 'individual'];
const individualTax = record => /个税|个人所得|^IIT$/i.test(record.tax_type);
const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function getWorkProgress(data, clientId, period) {
  const rows = key => (Array.isArray(data[key]) ? data[key] : []).filter(row => Number(row.client_id) === Number(clientId) && (row.period || String(row.date || '').slice(0, 7)) === period);
  const tax = rows('tax_records'), invoice = rows('invoices');
  const book = rows('book_periods')[0];
  const individual = tax.filter(individualTax);
  const verified = tax.length && tax.every(t => t.confirmation_status === 'confirmed') ? 2 : tax.length ? 1 : 0;
  const ticket = invoice.length ? (invoice.every(i => i.status === 'posted') ? 2 : 1) : 0;
  const ledger = book?.status === 'closed' || book?.closed ? 2 : Number(book?.voucher_count || 0) > 0 ? 1 : 0;
  const taxState = list => !list.length ? 0 : list.every(t => t.status === 'submitted') ? 2 : 1;
  return { tax, invoice, book, individual, states: [verified, ticket, ledger, taxState(tax.filter(t => !individualTax(t))), taxState(individual)] };
}

export function progressStatus(data, key) {
  if (key === 'payment') {
    const paid = data.tax.length && data.tax.every(t => t.payment_status === 'paid');
    return { label: !data.tax.length ? '未登记' : paid ? '已登记缴款' : '待缴款', className: paid ? 'good' : '' };
  }
  const index = { confirmation: 0, tickets: 1, bookkeeping: 2, filing: 3, individual: 4 }[key];
  if (index === undefined) throw new Error('未知的工作进度类型');
  const state = data.states[index];
  return { label: PROGRESS[index].labels[state], className: state === 2 ? 'good' : state === 1 ? 'info' : '' };
}

const titles = { confirmation: '人工确认记录', tickets: '票据进度', bookkeeping: '记账进度', filing: '申报记录', payment: '缴款记录', individual: '个税记录' };
const rules = {
  confirmation: '本月没有税务记录时显示“未登记”；有记录但未全部确认时显示“待确认”；全部税务记录（含个税）的“客户确认（人工）”均为“人工已确认”后，自动显示“已确认”。可在下方编辑每条记录。',
  tickets: '本月保存或导入票据后，自动显示“已登记·待制证”；本月全部票据生成凭证后，显示“已制证”。可在下方登记、编辑票据或生成凭证。',
  bookkeeping: '本月保存至少一张有效凭证后，自动显示“已记账”（未审核凭证也计入）；本期成功结账后显示“已结账”。只上传附件、登记票据或保存核对结果，尚未形成有效凭证时，仍为“未记账”。',
  filing: '只统计本月非个税记录：保存或导入记录后显示“已登记·准备中”；全部记录的申报状态为“已登记申报”后，自动更新为“已登记申报”。登记已申报需要真实回执号或证据附件。',
  payment: '统计本月全部税务记录（含个税）：有记录但未全部登记缴款时显示“待缴款”；全部记录为“已登记缴款”后自动更新。编辑记录时填写实缴金额并选择缴款状态；已缴款要求实缴与应缴金额一致。',
  individual: '税种含“个税”“个人所得”或为“IIT”的记录计入此列。保存或导入本月记录后显示“已登记·准备中”；这些记录全部登记已申报后显示“已登记申报”。登记已申报需要真实回执号或证据附件。'
};

export function progressStatusButton(data, key, client, period) {
  const status = progressStatus(data, key);
  return `<button type="button" class="status progress-status-button ${status.className}" data-action="work-progress" data-id="${Number(client.id)}" data-progress-key="${key}" data-period="${h(period)}" aria-label="${h(client.name)} ${titles[key]}：${h(status.label)}，查看与处理" title="点击查看条件并处理${titles[key]}">${h(status.label)}</button>`;
}

export function progressDialogTitle(key) {
  if (!PROGRESS_KEYS.includes(key)) throw new Error('未知的工作进度类型');
  return `${titles[key]} · 查看与处理`;
}

export function renderProgressDetails(client, period, data, key, { money }) {
  progressDialogTitle(key);
  const attrs = `data-id="${Number(client.id)}" data-period="${h(period)}" data-progress-key="${key}"`;
  const button = (label, action, extra = '') => `<button type="button" class="btn" data-action="${action}" ${attrs} ${extra}>${label}</button>`;
  const status = progressStatus(data, key);
  const heading = `<div class="notice"><strong>${h(client.name)} · ${h(period)}</strong><br>当前状态：${h(status.label)}<br>${rules[key]}</div>`;
  const table = (headers, rows, empty) => `<div class="table-wrap progress-details-table"><table><thead><tr>${headers.map(label => `<th>${label}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.join('') : `<tr><td colspan="${headers.length}">${empty}</td></tr>`}</tbody></table></div>`;
  const row = cells => `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`;
  if (key === 'bookkeeping') {
    return `${heading}<p>本月有效凭证：<strong>${Number(data.book?.voucher_count || 0)}</strong> 张 · 期间状态：${data.states[2] === 2 ? '已结账' : '未结账'}</p><div class="actions">${button('查看 / 录入凭证', 'work-progress-book', 'data-view="vouchers"')}${button('检查与结账', 'work-progress-book', 'data-view="period"')}</div><p class="muted small">完成凭证保存或结账后，返回首页会重新计算进度。</p>`;
  }
  if (key === 'tickets') {
    const rows = data.invoice.map(i => row([h(i.date), h(i.number), h(i.summary || '—'), h(money(i.total_fen)), i.status === 'posted' ? '已制证' : '已登记·待制证', i.status === 'posted' ? button('查看凭证', 'work-progress-book', 'data-view="vouchers"') : `<span class="row-actions"><button type="button" class="link-btn" data-action="work-progress-edit-invoice" ${attrs} data-record-id="${Number(i.id)}">编辑票据</button><button type="button" class="link-btn" data-action="work-progress-post-invoice" ${attrs} data-record-id="${Number(i.id)}">生成凭证</button></span>`]));
    return `${heading}<div class="actions progress-details-actions">${button('新增票据', 'work-progress-new-invoice')}${button('打开票据列表 / 导入', 'work-progress-invoices')}</div>${table(['日期', '票据号码', '摘要', '价税合计', '状态', '操作'], rows, '本月尚未登记票据')}`;
  }
  const records = key === 'individual' ? data.individual : key === 'filing' ? data.tax.filter(t => !individualTax(t)) : data.tax;
  const rows = records.map(t => row([h(t.tax_type), t.confirmation_status === 'confirmed' ? '人工已确认' : '待确认', t.status === 'submitted' ? '已登记申报' : t.status === 'preparing' ? '准备中' : '待准备', t.payment_status === 'paid' ? '已登记缴款' : '未缴款', h(money(t.amount_fen)), h(money(t.paid_fen)), h(t.reference || '—'), `<button type="button" class="link-btn" data-action="work-progress-edit-tax" ${attrs} data-record-id="${Number(t.id)}">编辑记录</button>`]));
  return `${heading}<div class="actions progress-details-actions">${button(key === 'individual' ? '新增个税记录' : '新增税务记录', 'work-progress-new-tax')}${button('打开税务列表 / 导入', 'work-progress-tax-records')}</div>${table(['税种', '人工确认', '申报状态', '缴款状态', '应缴', '实缴', '回执 / 流水号', '操作'], rows, key === 'individual' ? '本月尚未登记个税记录' : '本月尚无对应税务记录')}<p class="muted small">保存记录后，首页和上方统计会重新汇总。本地申报、缴款记录需由你登记或导入，系统不会从税局自动同步。</p>`;
}
