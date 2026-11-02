/* Read-only details for the currently selected company's period checks. */
const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => (Number(value || 0) / 100).toLocaleString('zh-CN', {minimumFractionDigits:2,maximumFractionDigits:2});
let dispose = () => {};

export function clearPeriodCheckDetails() { dispose(); dispose = () => {}; }

export function renderPeriodCheckRows(book) {
  return (book.checks || []).map((check,index) => {
    const id = `period-check-detail-${index}`;
    const kind = {error:'danger',warning:'pending',info:'success'}[check.severity] || '';
    const level = {error:'需处理',warning:'请复核',info:'提示'}[check.severity] || check.severity;
    const detail = check.details || {};
    const columns = detail.columns || [], rows = detail.rows || [];
    const total = Number(detail.total ?? rows.length);
    const attrs = `type="button" data-period-check-trigger="${index}" aria-describedby="${id}" aria-controls="${id}" aria-expanded="false"`;
    const grid = columns.length && rows.length ? `<div class="period-check-grid" tabindex="0" aria-label="检查明细列表"><table><thead><tr>${columns.map(c=>`<th scope="col">${h(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${columns.map(c=>`<td class="${c.format==='money'?'number':''}">${c.format==='money'?h(money(row[c.key])):h(row[c.key] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '';
    return `<tr data-period-check="${index}"><td><button ${attrs} class="period-check-level"><span class="book-badge ${kind}">${h(level)}</span></button></td><td><button ${attrs} class="period-check-message">${h(check.message)} <span class="period-check-info" aria-hidden="true">ⓘ</span><span class="period-check-hint">悬停查看明细</span></button><section id="${id}" data-period-check-popup="${index}" class="period-check-popup" role="tooltip" tabindex="0" hidden><div class="period-check-heading"><strong>${h(check.message)}</strong><small>${h(book.client?.name)} · ${h(book.period)}</small></div><p class="period-check-reason">${h(detail.reason || '请点击“重新检查”读取本期最新检查明细。')}</p>${grid}<p class="period-check-next"><strong>处理方法：</strong>${h(detail.action || '核对后点击“重新检查”，查看最新结果。')}</p><div class="period-check-footer"><span>${rows.length ? (detail.truncated ? `共 ${total} 条，显示前 ${rows.length} 条；请到对应页面查看全部记录。` : `共 ${total} 条明细`) : '本公司 · 当前账期'}</span><span>移开收起 · Esc 关闭</span></div></section></td></tr>`;
  });
}

export function bindPeriodCheckDetails(content) {
  clearPeriodCheckDetails();
  if (!content?.querySelector('[data-period-check]')) return;
  const doc = content.ownerDocument, win = doc.defaultView;
  const listeners = [];
  let current = null, timer = null, pinned = false, dismissed = null, originX = null;
  const listen = (target,type,handler,options) => { target.addEventListener(type,handler,options); listeners.push(()=>target.removeEventListener(type,handler,options)); };
  const cancel = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const expanded = (row,value) => row?.querySelectorAll('[data-period-check-trigger]').forEach(el=>el.setAttribute('aria-expanded',String(value)));
  const hide = () => { cancel(); if (current) { current.querySelector('[data-period-check-popup]').hidden = true; expanded(current,false); } current = null; pinned = false; };
  const rowFor = target => { const row = target?.closest?.('[data-period-check]'); return row && content.contains(row) ? row : null; };
  const position = () => {
    if (!current) return;
    const popup = current.querySelector('[data-period-check-popup]');
    const rect = current.getBoundingClientRect(), bounds = popup.getBoundingClientRect();
    const width = win.innerWidth || 1280, height = win.innerHeight || 800;
    if (rect.bottom <= 0 || rect.top >= height) { hide(); return; }
    const popupWidth = bounds.width || Math.min(940,width-32), popupHeight = bounds.height || 300;
    const left = Math.max(16,Math.min((originX ?? (rect.left+rect.width/2))-popupWidth/2,width-popupWidth-16));
    const below = rect.bottom+6;
    const top = below+popupHeight>height-12 && rect.top>height-rect.bottom ? Math.max(12,rect.top-popupHeight-6) : Math.max(12,Math.min(below,height-popupHeight-12));
    popup.style.left = `${left}px`; popup.style.top = `${top}px`;
  };
  const show = (row,x) => {
    cancel();
    if (dismissed === row) return;
    if (current !== row) { hide(); current = row; }
    if (Number.isFinite(x) && x > 0) originX = x;
    else if (!current.querySelector('[data-period-check-popup]').hidden) { position(); return; }
    else originX = null;
    current.querySelector('[data-period-check-popup]').hidden = false;
    expanded(current,true); position();
  };
  const leave = row => {
    cancel();
    timer = setTimeout(()=>{ timer=null; if (current===row && !pinned && !row.contains(doc.activeElement)) hide(); },160);
  };
  listen(content,'mouseover',event=>{
    const row=rowFor(event.target);
    if (!row || rowFor(event.relatedTarget)===row) return;
    if (dismissed!==row) dismissed=null;
    if (!pinned || current===row) show(row,event.clientX);
  });
  listen(content,'mouseout',event=>{
    const row=rowFor(event.target);
    if (!row || rowFor(event.relatedTarget)===row) return;
    if (dismissed===row) dismissed=null;
    leave(row);
  });
  listen(content,'focusin',event=>{ const row=rowFor(event.target); if (row) { dismissed=null; if (current!==row) pinned=false; show(row); } });
  listen(content,'focusout',event=>{ const row=rowFor(event.target); if (row && rowFor(event.relatedTarget)!==row) { pinned=false; leave(row); } });
  listen(content,'click',event=>{
    const trigger=event.target.closest?.('[data-period-check-trigger]'); if (!trigger) return;
    const row=rowFor(trigger); if (!row) return;
    if (current===row && pinned) { dismissed=row; hide(); }
    else { dismissed=null; show(row,event.clientX); pinned=true; }
  });
  const outside = event => { if (current && !current.contains(event.target)) { dismissed=null; hide(); } };
  listen(doc,'pointerdown',outside);
  listen(doc,'click',outside);
  listen(doc,'keydown',event=>{ if (event.key==='Escape' && current) { const row=current; dismissed=row; hide(); if (row.querySelector('[data-period-check-popup]').contains(doc.activeElement)) { row.querySelector('[data-period-check-trigger]').focus(); dismissed=row; hide(); } event.preventDefault(); } });
  listen(win,'resize',position);
  listen(doc,'scroll',event=>{ if (current && !current.querySelector('[data-period-check-popup]').contains(event.target)) position(); },true);
  dispose = () => { hide(); listeners.forEach(remove=>remove()); };
}
