const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();

// Search the complete customer list, independently of table filters and paging.
export function findCompanies(companies, query) {
  const term = normalize(query);
  if (!term) return [];
  return companies.filter(company => !company.deleted).map((company, index) => {
    const fields = [company.name, company.enterprise_name, company.code, company.tax_no, company.mnemonic].map(normalize).filter(Boolean);
    const rank = Math.min(...fields.map(value => value === term ? 0 : value.startsWith(term) ? 1 : value.includes(term) ? 2 : 3));
    return { company, rank, index };
  }).filter(match => match.rank < 3).sort((a, b) => a.rank - b.rank || a.index - b.index).map(match => match.company);
}

export function companyHomePeriod(company, period) {
  return company.start_period && period < company.start_period ? company.start_period : period;
}

export function bindCompanySearch(form, getCompanies) {
  if (!form) return () => {};
  const input = form.querySelector('[data-company-search-input]');
  const popup = form.querySelector('[data-company-search-results]');
  const summary = form.querySelector('[data-company-search-summary]');
  const list = form.querySelector('[data-company-search-options]');
  const doc = form.ownerDocument;
  let active = -1;
  const options = () => [...list.querySelectorAll('[data-company-search-id]:not(:disabled)')];
  const close = () => {
    popup.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    list.querySelectorAll('[aria-selected="true"]').forEach(option => option.setAttribute('aria-selected', 'false'));
    active = -1;
  };
  const show = () => {
    if (!input.value.trim()) { close(); return; }
    const companies = findCompanies(getCompanies(), input.value);
    list.replaceChildren();
    active = -1;
    input.removeAttribute('aria-activedescendant');
    summary.textContent = companies.length ? `找到 ${companies.length} 家公司，点击进入公司首页` : '没有找到公司，请换个关键词，或在“客户”中录入公司。';
    for (const company of companies) {
      const option = doc.createElement('button');
      option.type = 'button';
      option.className = 'company-search-option';
      option.id = `company-search-option-${company.id}`;
      option.dataset.action = 'company-home';
      option.dataset.id = String(company.id);
      option.dataset.companySearchId = String(company.id);
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      option.disabled = company.enabled === 0 || company.enabled === false;
      const title = doc.createElement('strong');
      title.textContent = company.name || company.enterprise_name;
      const details = doc.createElement('small');
      const fullName = company.enterprise_name && company.enterprise_name !== company.name ? company.enterprise_name : '';
      details.textContent = [fullName, company.code ? `编号：${company.code}` : '', option.disabled ? '已停用，请先在客户资料中启用' : '点击进入公司首页'].filter(Boolean).join(' · ');
      option.append(title, details);
      list.append(option);
    }
    popup.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    const availableHeight = doc.defaultView.innerHeight - popup.getBoundingClientRect().top - summary.offsetHeight - 16;
    list.style.maxHeight = `${Math.max(100, Math.min(340, availableHeight))}px`;
  };
  const highlight = index => {
    const items = options();
    if (!items.length) return;
    active = (index + items.length) % items.length;
    items.forEach((item, i) => item.setAttribute('aria-selected', String(i === active)));
    input.setAttribute('aria-activedescendant', items[active].id);
    items[active].scrollIntoView({ block: 'nearest' });
  };
  const onInput = event => { if (!event.isComposing) show(); };
  const onKeydown = event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { close(); event.preventDefault(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (popup.hidden) show();
      highlight(active < 0 ? (event.key === 'ArrowDown' ? 0 : options().length - 1) : active + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter' && !popup.hidden && active >= 0) {
      event.preventDefault();
      options()[active]?.click();
    }
  };
  const onFocusOut = event => { if (!form.contains(event.relatedTarget)) close(); };
  const onOutsideClick = event => { if (!form.contains(event.target)) close(); };
  const onChoice = event => { if (event.target.closest('[data-company-search-id]:not(:disabled)')) close(); };
  input.addEventListener('input', onInput);
  input.addEventListener('compositionend', show);
  input.addEventListener('focus', show);
  input.addEventListener('keydown', onKeydown);
  form.addEventListener('focusout', onFocusOut);
  list.addEventListener('click', onChoice);
  doc.addEventListener('click', onOutsideClick);
  if (input.value.trim()) show();
  return () => {
    input.removeEventListener('input', onInput);
    input.removeEventListener('compositionend', show);
    input.removeEventListener('focus', show);
    input.removeEventListener('keydown', onKeydown);
    form.removeEventListener('focusout', onFocusOut);
    list.removeEventListener('click', onChoice);
    doc.removeEventListener('click', onOutsideClick);
  };
}
