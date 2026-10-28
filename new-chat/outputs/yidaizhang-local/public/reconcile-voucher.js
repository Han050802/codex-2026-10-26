// Confirm actual bookkeeping entries before a reconciliation is posted.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const amountToFen = value => {
  const text = String(value || '').trim();
  if (!text) return 0;
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('金额请填写非负数字，最多两位小数。');
  const [whole, fraction = ''] = text.split('.');
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(n)) throw new Error('金额超出允许范围。');
  return n;
};
const leafAccounts = accounts => accounts.filter(a => !accounts.some(b => b.code !== a.code && String(b.code).startsWith(String(a.code))));

// onSubmit(voucher) must post the reconciliation and return the server response.
// Resolves with that response on success, or null if the operator cancels.
export async function confirmReconcileVoucher({api, clientId, clientName, transaction, invoice, classification, onSubmit}) {
  const period = String(transaction?.date || '').slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error('请先填写有效的交易日期。');
  const book = await api(`/api/books/${encodeURIComponent(clientId)}?period=${encodeURIComponent(period)}`);
  const accounts = leafAccounts(book.accounts || []);
  if (!accounts.length) throw new Error('该账套没有可用的末级科目，请先设置科目。');
  const parentKeys = new Set(['receivable','prepaid','other_asset','payable','advance','other_liability']);
  const parents = (book.accounts || []).filter(a => String(a.code).length===4 && parentKeys.has(a.report_key));
  const options = `<option value="">请选择科目</option><optgroup label="往来公司明细（保存时查找或创建）">${parents.map(a=>`<option value="counterparty:${esc(a.code)}">${esc(a.code)} ${esc(a.name)} / ${esc(transaction.counterparty)}</option>`).join('')}</optgroup><optgroup label="现有末级科目">${accounts.map(a=>`<option value="${esc(a.code)}">${esc(a.code)} ${esc(a.name)}</option>`).join('')}</optgroup>`;
  const suggested = classification?.account_name ? `${classification.account_code ? classification.account_code + ' ' : ''}${classification.account_name}` : '待核实';
  const basis = classification?.basis || '信息不足，请结合实际业务判断';
  const review = classification?.review || '请核实实际业务性质、是否已有账及税额后选择科目。';
  const links=(classification?.source_urls || []).filter(value=>{try {const url=new URL(value);return ['https:','http:'].includes(url.protocol) && !url.username && !url.password;}catch{return false;}}).map(value=>`<a href="${esc(value)}" target="_blank" rel="noopener noreferrer">会计准则参考</a>`).join(' ');
  const taxText=String(invoice?.tax_amount ?? '').trim();
  const noTax=/^0+(?:\.0{1,2})?$/.test(taxText);
  const canSuggest=classification?.status==='suggested' && accounts.some(a=>String(a.code)===String(classification.account_code)) && noTax;
  const draftNote=canSuggest?'已根据用途建议预填业务科目，请核实是否已入账、收入费用确认时点和税额。':'业务科目未自动填入：请核实用途、税额及确认时点；税额非零或未知时需按实际分录拆分。';
  const priorFocus = document.activeElement, root = document.createElement('div');
  root.innerHTML = `<div class="modal-backdrop"><section class="modal wide-modal" role="dialog" aria-modal="true" aria-labelledby="rc-voucher-title"><div class="modal-header"><h2 id="rc-voucher-title">确认分录并记账</h2><button type="button" data-rv-cancel aria-label="关闭">×</button></div><form><div class="modal-body"><p>请核对本方账套、交易对方和会计分录。确认保存后生成凭证，余额表按凭证日期更新。</p><p><b>本方账套：${esc(clientName || book.client?.name || clientId)}</b>　交易对方：${esc(transaction.counterparty)}　交易金额：¥ ${esc(transaction.amount)}　发票：${esc(invoice?.number)}</p><p>业务科目建议：${esc(suggested)}；依据：${esc(basis)}。${esc(review)} ${links}</p><p>${esc(draftNote)}</p><p>如需按往来公司显示，请选择“往来公司明细”下的上级科目；系统将使用交易对方名称查找或创建明细。收付款方向本身不能确定业务性质，请核实是否存在原有往来、税额和业务用途。</p><div class="form-grid"><label class="field"><span>凭证日期 *</span><input type="date" name="date" value="${esc(transaction.date)}" required></label><label class="field"><span>摘要 *</span><input name="summary" maxlength="200" required></label></div><div class="rc-scroll"><table class="rc-edit"><thead><tr><th>科目</th><th>借方金额（元）</th><th>贷方金额（元）</th><th></th></tr></thead><tbody data-rv-lines></tbody></table></div><button type="button" class="btn" data-rv-add>＋ 添加分录</button><div data-rv-duplicate hidden><p data-rv-duplicate-message></p><label class="field"><span>核对说明 *</span><textarea name="duplicate_review_note" maxlength="500" placeholder="说明已核实不是重复凭证的依据"></textarea></label></div></div><div class="modal-error" data-rv-error role="alert"></div><div class="modal-footer"><button type="button" class="btn" data-rv-cancel>取消</button><button type="submit" class="btn btn-primary">确认并记账</button></div></form></section></div>`;
  document.body.append(root);
  const form = root.querySelector('form'), rows = root.querySelector('[data-rv-lines]');
  const addLine = () => { const tr=document.createElement('tr'); tr.innerHTML=`<td><select data-rv-account aria-label="科目">${options}</select></td><td><input data-rv-debit inputmode="decimal" aria-label="借方金额"></td><td><input data-rv-credit inputmode="decimal" aria-label="贷方金额"></td><td><button type="button" class="rc-link" data-rv-remove>删除</button></td>`; rows.append(tr); };
  addLine(); addLine();
  const bankAccounts=accounts.filter(a=>String(a.code).startsWith('1002'));
  const amount=String(transaction.amount || '').trim().replace(/^[+-]/,'');
  if (/^\d+(?:\.\d{1,2})?$/.test(amount) && Number(amount)>0) {
    const first=rows.children[0], second=rows.children[1], incoming=Number(transaction.amount)>0;
    if(bankAccounts.length===1) first.querySelector('[data-rv-account]').value=String(bankAccounts[0].code);
    if(canSuggest) second.querySelector('[data-rv-account]').value=String(classification.account_code);
    first.querySelector(incoming?'[data-rv-debit]':'[data-rv-credit]').value=amount;
    second.querySelector(incoming?'[data-rv-credit]':'[data-rv-debit]').value=amount;
    form.querySelector('[name="summary"]').value=(incoming?'收款 ':'付款 ')+(transaction.counterparty || '');
  }
  const allowed = new Set(accounts.map(a => String(a.code)));
  const allowedParents = new Set(parents.map(a => String(a.code)));
  return new Promise(resolve => {
    let busy = false;
    const close = result => { if (busy) return; document.removeEventListener('keydown', keyHandler); root.remove(); priorFocus?.focus?.(); resolve(result); };
    const keyHandler = event => { if(event.key==='Escape') close(null); };
    document.addEventListener('keydown', keyHandler);
    root.querySelectorAll('[data-rv-cancel]').forEach(button => button.addEventListener('click', () => close(null)));
    root.querySelector('[data-rv-add]').addEventListener('click', addLine);
    rows.addEventListener('click', event => { const button=event.target.closest('[data-rv-remove]'); if(button) button.closest('tr').remove(); });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy) return;
      const error = root.querySelector('[data-rv-error]'); error.textContent = '';
      try {
        const date = form.querySelector('[name="date"]').value, summary = form.querySelector('[name="summary"]').value.trim();
        if (!date || !summary) throw new Error('请填写凭证日期和摘要。');
        const lines = [...rows.querySelectorAll('tr')].map(row => { const selected=row.querySelector('[data-rv-account]').value; return {...(selected.startsWith('counterparty:')?{counterparty_parent_code:selected.slice(13)}:{account_code:selected}), debit_fen:amountToFen(row.querySelector('[data-rv-debit]').value), credit_fen:amountToFen(row.querySelector('[data-rv-credit]').value)}; });
        if (lines.length < 2 || lines.some(line=>!(line.counterparty_parent_code ? allowedParents.has(line.counterparty_parent_code) : allowed.has(line.account_code)) || (line.debit_fen > 0) === (line.credit_fen > 0))) throw new Error('请至少填写两条分录，每条选择末级科目并只填写一方金额。');
        const debit=lines.reduce((sum,line)=>sum+line.debit_fen,0),credit=lines.reduce((sum,line)=>sum+line.credit_fen,0);
        if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit) || debit!==credit) throw new Error('借贷金额合计必须相等。');
        const duplicateNote=form.querySelector('[name="duplicate_review_note"]').value.trim();
        if (!root.querySelector('[data-rv-duplicate]').hidden && !duplicateNote) throw new Error('请填写重复凭证核对说明。');
        const voucher={date,summary,lines,...(duplicateNote?{duplicate_review_note:duplicateNote}:{})};
        busy=true; root.querySelectorAll('button,input,select,textarea').forEach(el=>el.disabled=true);
        try { const result=await onSubmit(voucher); busy=false; close(result); }
        catch (err) {
          busy=false; root.querySelectorAll('button,input,select,textarea').forEach(el=>el.disabled=false);
          if (err.details?.code==='possible_duplicate') {
            const list=err.details.candidates || [];
            root.querySelector('[data-rv-duplicate-message]').textContent=`${err.message}：${list.map(v=>`${v.date} ${v.number} ${v.summary || ''}`).join('；')}`;
            root.querySelector('[data-rv-duplicate]').hidden=false;
            form.querySelector('[name="duplicate_review_note"]').focus();
          }
          error.textContent=err.message || '保存失败，请重试。';
        }
      } catch (err) { error.textContent=err.message; }
    });
    form.querySelector('[name="summary"]').focus();
  });
}
export const reconcileVoucherTest = {amountToFen, leafAccounts};
