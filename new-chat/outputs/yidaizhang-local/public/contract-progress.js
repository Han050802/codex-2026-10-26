const validMonth = value => /^20\d{2}-(0[1-9]|1[0-2])$/.test(String(value || ''));
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function nextContractMonth(period) {
  const [year, month] = period.split('-').map(Number);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
}

// Only a continuous, active renewal extends the current service deadline.
export function getAgencyExpiry(contracts, clientId, period) {
  const own = (Array.isArray(contracts) ? contracts : []).filter(c => Number(c.client_id) === Number(clientId));
  const active = own.filter(c => c.status === 'active' && validMonth(c.start_period) && validMonth(c.end_period) && c.start_period <= c.end_period);
  const started = active.filter(c => c.start_period <= period).sort((a, b) => b.end_period.localeCompare(a.end_period) || Number(b.id) - Number(a.id));
  let contract = started[0] || [...active].sort((a, b) => a.start_period.localeCompare(b.start_period) || b.end_period.localeCompare(a.end_period))[0];
  if (!contract) return { contract: null, endPeriod: '', state: own.some(c => c.status === 'terminated') ? 'terminated' : 'missing' };
  let endPeriod = contract.end_period;
  for (const renewal of [...active].sort((a, b) => a.start_period.localeCompare(b.start_period))) {
    if (renewal.start_period <= nextContractMonth(endPeriod) && renewal.end_period > endPeriod) {
      contract = renewal;
      endPeriod = renewal.end_period;
    }
  }
  const state = !started.length ? 'upcoming' : endPeriod === period ? 'due' : endPeriod < period ? 'overdue' : 'active';
  return { contract, endPeriod, state };
}

export function renderAgencyExpiry(expiry, clientId) {
  const { state, endPeriod } = expiry;
  const label = state === 'missing' ? '未签合同 · 设置' : state === 'terminated' ? '已终止 · 新签合同' : `${endPeriod} 月末`;
  const hint = ({ due: '本月到期 · 请询问是否续约', overdue: '已到期 · 请跟进续约', upcoming: '服务尚未开始' })[state] || '';
  const title = state === 'missing' || state === 'terminated' ? '为此客户设置服务合同和到期月份' : '查看或修改服务合同和到期月份';
  return `<button type="button" class="agency-expiry agency-expiry-${state}" data-action="agency-contract" data-client="${Number(clientId)}" title="${title}" aria-label="${escape(`${label}，${hint || title}`)}"><span>${escape(label)}</span>${hint ? `<small>${escape(hint)}</small>` : ''}</button>`;
}

export function contractMonthField(label, name, value, locked = false) {
  return `<div class="field contract-month-field"><label for="field-${name}">${escape(label)}</label><div class="contract-month-input"><input id="field-${name}" name="${name}" type="text" value="${escape(value)}" placeholder="YYYY-MM，如 2026-10" pattern="20[0-9]{2}-(0[1-9]|1[0-2])" maxlength="7" required autocomplete="off" ${locked ? 'disabled' : ''}><button type="button" class="btn" data-contract-month-open aria-label="选择${escape(label.replace(/\s*\*/, ''))}" aria-expanded="false" aria-controls="contract-picker-${name}" ${locked ? 'disabled' : ''}>选月份</button></div><div id="contract-picker-${name}" class="contract-month-picker" data-contract-month-picker hidden><label>年份 <select aria-label="${escape(label.replace(/\s*\*/, ''))}年份" data-contract-year>${Array.from({ length: 100 }, (_, i) => `<option value="${2000 + i}">${2000 + i}年</option>`).join('')}</select></label><div class="contract-month-grid">${Array.from({ length: 12 }, (_, i) => `<button type="button" class="btn" data-contract-month="${String(i + 1).padStart(2, '0')}" aria-pressed="false">${i + 1}月</button>`).join('')}</div></div></div>`;
}

export function bindContractMonths(form) {
  if (!form) return;
  const fields = [...form.querySelectorAll('.contract-month-field')];
  const close = field => {
    field.querySelector('[data-contract-month-picker]').hidden = true;
    field.querySelector('[data-contract-month-open]').setAttribute('aria-expanded', 'false');
  };
  for (const field of fields) {
    const input = field.querySelector('input'), opener = field.querySelector('[data-contract-month-open]');
    const picker = field.querySelector('[data-contract-month-picker]'), year = field.querySelector('[data-contract-year]');
    const buttons = [...field.querySelectorAll('[data-contract-month]')];
    const highlight = () => buttons.forEach(button => button.setAttribute('aria-pressed', String(input.value === `${year.value}-${button.dataset.contractMonth}`)));
    opener.addEventListener('click', () => {
      const opening = picker.hidden;
      fields.forEach(close);
      if (!opening || input.disabled) return;
      year.value = validMonth(input.value) ? input.value.slice(0, 4) : String(new Date().getFullYear());
      highlight(); picker.hidden = false; opener.setAttribute('aria-expanded', 'true');
    });
    year.addEventListener('change', highlight);
    buttons.forEach(button => button.addEventListener('click', () => {
      input.value = `${year.value}-${button.dataset.contractMonth}`;
      input.setCustomValidity('');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      close(field); input.focus();
    }));
    input.addEventListener('input', () => input.setCustomValidity(''));
    input.addEventListener('invalid', () => input.setCustomValidity('请输入有效月份，例如 2026-10；也可点击“选月份”。'));
    input.addEventListener('blur', () => {
      const match = /^(20\d{2})-(\d{1,2})$/.exec(input.value.trim());
      if (match && Number(match[2]) >= 1 && Number(match[2]) <= 12) input.value = `${match[1]}-${match[2].padStart(2, '0')}`;
      if (validMonth(input.value)) input.setCustomValidity('');
    });
  }
  form.addEventListener('click', event => fields.forEach(field => { if (!field.contains(event.target)) close(field); }));
  form.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !fields.some(field => !field.querySelector('[data-contract-month-picker]').hidden)) return;
    event.preventDefault(); event.stopPropagation(); fields.forEach(close);
  });
}
