const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

// Source URLs are data, so never emit an executable or relative link.
function sourceLink(rule) {
 const title = esc(rule.source_title || '来源');
 try {
  const url = new URL(rule.source_url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return title;
  return `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${title}</a>`;
 } catch { return title; }
}

export function renderRuleSearch() {
 return `<section class="rc-panel" data-rc-rule-search><div class="rc-panel-head"><div><h2>发票科目规则查询</h2><p>输入发票项目或科目名称，查看可参考的分类规则；请结合实际用途及账套核实。</p></div></div><form data-rc-rule-form><label>查询项目 <input type="search" data-rc-rule-query maxlength="100" placeholder="例如：办公用品、广告费" aria-label="查询发票项目或科目"></label> <button type="submit" class="rc-secondary">查询规则</button></form><div data-rc-rule-result aria-live="polite" style="margin-top:12px;font-size:13px;color:#526378">输入关键词查询；留空可查看规则。</div></section>`;
}

export function ruleResultsMarkup(data) {
 if (!data || !Array.isArray(data.rules)) throw new Error('规则数据格式不正确');
 if (!data.rules.length) return '没有找到相关规则，请尝试其他关键词。';
 return data.rules.map(rule => {
  const role = rule.role === 'purchase' ? '购入' : rule.role === 'sale' ? '销售' : rule.role === 'settlement' ? '往来/资金' : '业务';
  const subject = `${rule.account_code ? esc(rule.account_code) + ' ' : ''}${esc(rule.account_name || '待核实')}`;
  return `<div style="border-top:1px solid #edf0f4;padding:10px 0;line-height:1.7"><strong>${role} · ${subject}</strong>${rule.account_code ? '' : '（账套科目待确认）'}<div>适用条件：${esc(rule.conditions || '请结合实际业务核实')}</div><div>说明：${esc(rule.explanation || '请结合原始单据核实')}</div><div>依据：${sourceLink(rule)}</div></div>`;
 }).join('');
}

export function bindRuleSearch(root, api, getClientId = () => '') {
 const section = root.querySelector('[data-rc-rule-search]');
 if (!section) return;
 const form = section.querySelector('[data-rc-rule-form]');
 const input = section.querySelector('[data-rc-rule-query]');
 const result = section.querySelector('[data-rc-rule-result]');
 let generation = 0;
 form.addEventListener('submit', async event => {
  event.preventDefault();
  const request = ++generation;
  const query = input.value.trim();
  const params = new URLSearchParams({q:query});
  const client = String(getClientId() ?? '');
  if (/^[1-9]\d*$/.test(client)) params.set('client_id', client);
  result.textContent = '正在查询规则…';
  try {
   const data = await api('/api/reconcile/account-rules?' + params.toString());
   if (request !== generation || !root.contains(section)) return;
   result.innerHTML = ruleResultsMarkup(data);
  } catch (error) {
   if (request !== generation || !root.contains(section)) return;
   result.textContent = '规则查询失败：' + (error?.message || '请稍后重试');
  }
 });
}

