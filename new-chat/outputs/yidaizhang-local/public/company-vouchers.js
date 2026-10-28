/* Screenshot-style voucher list. All accounting data comes from the book API. */
const states = new Map();
const handlers = new WeakMap();
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => (Number(value || 0) / 100).toLocaleString('zh-CN', {minimumFractionDigits:2, maximumFractionDigits:2});
const icons = {
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  filter:'<path d="M4 5h16l-6 7v7l-4-2v-5z"/>',
  help:'<circle cx="12" cy="12" r="8"/><path d="M10 9a2 2 0 1 1 3 2c-1 .5-1 1-1 2m0 3v.1"/>',
  transfer:'<path d="M8 3H4v18h12v-4M8 7h12m-3-3 3 3-3 3M8 15h12m-3-3 3 3-3 3"/>',
  print:'<path d="M7 8V3h10v5M7 16H4V9h16v7h-3M7 13h10v8H7z"/><path d="M17 11h.1"/>',
  book:'<path d="M5 3h14v18H5zM8 6h8M8 10h8M8 14h5M8 18h5"/>',
  refresh:'<path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7"/>',
  first:'<path d="M6 5v14m11-14-7 7 7 7"/>',
  prev:'<path d="m15 5-7 7 7 7"/>',
  next:'<path d="m9 5 7 7-7 7"/>',
  last:'<path d="M18 5v14M7 5l7 7-7 7"/>',
  total:'<path d="M8 5H5v16h14V5h-3M9 3h6v5H9zM8 13h8M8 17h5"/>',
  clip:'<path d="m9 13 5-5a3 3 0 0 1 4 4l-7 7a5 5 0 0 1-7-7l8-8a3 3 0 0 1 4 4l-8 8a1 1 0 0 1-1-1l7-7"/>'
};
const icon = name => `<svg class="cv-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${icons[name] || ''}</svg>`;
function stateFor(book) {
  const key = `${book.client.id}:${book.period}`;
  if (!states.has(key)) states.set(key,{query:'',status:'active',source:'',dateFrom:'',dateTo:'',min:'',max:'',page:1,size:500,selected:new Set(),busy:false});
  return states.get(key);
}
export function focusCompanyVoucher(clientId,period,voucherId) {
  if(!/^\d+$/.test(String(clientId))||!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)||!/^\d+$/.test(String(voucherId)))return false;
  const state=stateFor({client:{id:clientId},period});
  Object.assign(state,{query:'',status:'active',source:'',dateFrom:'',dateTo:'',min:'',max:'',page:1,focusId:String(voucherId),scrollToSaved:null});
  state.selected.clear();
  return true;
}
const isActive = v => v.status !== 'void';
const isClosed = book => (book.periods || []).some(p => p.period === book.period && p.closed);
const voucherNumber = v => typeof v.number === 'number' || /^\d+$/.test(String(v.number)) ? `记-${String(v.number).padStart(3,'0')}` : String(v.number || '—');
const sum = (lines,key) => (lines || []).reduce((n,l) => n + Number(l[key] || 0),0);
function getRows(book,state) {
  const query=state.query.trim().toLocaleLowerCase();
  return (book.vouchers || []).filter(v => {
    if(state.status === 'active' && !isActive(v) || state.status === 'void' && isActive(v) || state.status === 'reviewed' && (!isActive(v)||!v.reviewed) || state.status === 'unreviewed' && (!isActive(v)||v.reviewed))return false;
    if(state.source && (v.source_type || 'manual') !== state.source)return false;
    if(state.dateFrom && v.date < state.dateFrom || state.dateTo && v.date > state.dateTo)return false;
    const debit=sum(v.lines,'debit_fen');
    if(state.min && debit < parseAmount(state.min) || state.max && debit > parseAmount(state.max))return false;
    const searchable=[v.date,v.number,voucherNumber(v),v.summary,v.created_by_name,...(v.lines||[]).flatMap(l=>[l.summary,l.account_code,l.account_name,money(l.debit_fen),money(l.credit_fen),String(Number(l.debit_fen||0)/100),String(Number(l.credit_fen||0)/100)])].join(' ').toLocaleLowerCase();
    return !query || searchable.includes(query);
  });
}
function pageRows(book,state) {
  if(![20,50,100,500].includes(state.size))state.size=500;
  const rows=getRows(book,state),pages=Math.max(1,Math.ceil(rows.length/state.size));
  if(state.focusId){const index=rows.findIndex(v=>String(v.id)===state.focusId);if(index>=0){state.page=Math.floor(index/state.size)+1;state.scrollToSaved=state.focusId;}delete state.focusId;}
  state.page=Number.isFinite(Number(state.page))?Math.max(1,Math.min(Math.trunc(Number(state.page)),pages)):1;
  return {rows,pages,page:rows.slice((state.page-1)*state.size,state.page*state.size)};
}
function rowHtml(v,book,state,h,m) {
  const lines=v.lines||[],active=isActive(v),locked=isClosed(book),selectable=active&&!locked;
  const edit=active&&(v.source_type||'manual')==='manual';
  const id=h(v.id),amount=n=>n?m(n):'';
  const action=(label,name,disabled=false)=>`<button type="button" data-book-action="${name}" data-id="${id}" ${disabled?'disabled':''}>${label}</button>`;
  return `<tbody class="cv-voucher ${active?'':'cv-void'}" data-cv-voucher="${id}"><tr class="cv-meta-row"><td class="cv-select" rowspan="${lines.length+2}"><input type="checkbox" data-cv-row="${id}" aria-label="选择凭证 ${h(voucherNumber(v))}" ${state.selected.has(String(v.id))?'checked':''} ${selectable?'':'disabled'}></td><td colspan="4"><div class="cv-meta"><span>日期：${h(v.date)}</span><span>制单人：${h(v.created_by_name||v.preparer||'—')}</span><span>凭证字号：<button type="button" class="cv-voucher-number" ${edit&&!locked&&!v.reviewed?`data-book-action="edit-voucher" data-id="${id}"`:''}>${h(voucherNumber(v))}</button></span><span class="cv-attachments">附单据 <u>${Number(v.attachment_count||0)} 张</u></span><span class="cv-file-count" title="附件数量为手工记录的单据张数">${icon('clip')}<u>${Number(v.attachment_count||0)}</u></span>${!active?'<span class="cv-state">已作废</span>':v.reviewed?'<span class="cv-state">已审核</span>':''}<span class="cv-row-actions">${active?(edit?action('编辑','edit-voucher',locked||v.reviewed):action('撤回来源','withdraw-source',locked||v.reviewed))+action(v.reviewed?'取消审核':'审核','review-voucher',locked)+action('资金分类','cashflow-voucher',locked)+(edit?action('作废','void-voucher',locked||v.reviewed):''):''}</span></div></td></tr>${lines.map(l=>`<tr class="cv-line"><td title="${h(l.summary||v.summary)}">${h(l.summary||v.summary)}</td><td title="${h(l.account_code)} ${h(l.account_name)}">${h(l.account_code)} ${h(l.account_name)}</td><td class="cv-amount">${amount(l.debit_fen)}</td><td class="cv-amount">${amount(l.credit_fen)}</td></tr>`).join('')}<tr class="cv-total"><td colspan="2">${icon('total')}<strong>总计</strong></td><td class="cv-amount"><strong>${m(sum(lines,'debit_fen'))}</strong></td><td class="cv-amount"><strong>${m(sum(lines,'credit_fen'))}</strong></td></tr></tbody>`;
}
export function renderCompanyVouchers(book,ctx={}) {
  const h=ctx.escape||esc,m=ctx.money||money,state=stateFor(book),{rows,pages,page}=pageRows(book,state);
  const validIds=new Set((book.vouchers||[]).filter(v=>isActive(v)&&!isClosed(book)).map(v=>String(v.id)));for(const id of state.selected)if(!validIds.has(id))state.selected.delete(id);
  const eligible=page.filter(v=>isActive(v)&&!isClosed(book));
  const checked=eligible.length>0&&eligible.every(v=>state.selected.has(String(v.id)));
  const sources=[...new Set((book.vouchers||[]).map(v=>v.source_type||'manual'))];
  const names={manual:'手工凭证',invoice:'发票生成',journal:'资金流水',payroll:'工资计提',payroll_payment:'工资发放',asset_purchase:'资产购置',asset_depreciation:'资产折旧',closing:'损益结转'};
  return `<section class="cv-root" aria-label="查看凭证"><div class="cv-toolbar print-hide"><label class="cv-search"><input data-cv-query value="${h(state.query)}" placeholder="可输入凭证号/摘要/科目/金额..." aria-label="搜索凭证">${icon('search')}</label><details class="cv-filter"><summary>${icon('filter')}更多条件<span class="cv-chevron"></span></summary><div class="cv-filter-panel"><label>凭证状态<select data-cv-filter="status">${[['active','有效凭证'],['all','全部凭证'],['unreviewed','未审核'],['reviewed','已审核'],['void','已作废']].map(([v,n])=>`<option value="${v}" ${v===state.status?'selected':''}>${n}</option>`).join('')}</select></label><label>凭证来源<select data-cv-filter="source"><option value="">全部来源</option>${sources.map(v=>`<option value="${h(v)}" ${v===state.source?'selected':''}>${h(names[v]||v)}</option>`).join('')}</select></label><label>开始日期<input type="date" data-cv-filter="dateFrom" value="${h(state.dateFrom)}"></label><label>结束日期<input type="date" data-cv-filter="dateTo" value="${h(state.dateTo)}"></label><label>最低金额（元）<input inputmode="decimal" data-cv-filter="min" value="${h(state.min)}" placeholder="0.00"></label><label>最高金额（元）<input inputmode="decimal" data-cv-filter="max" value="${h(state.max)}" placeholder="不限"></label><div class="cv-filter-buttons"><button type="button" data-cv-do="reset">重置</button><button type="button" class="cv-orange" data-cv-do="apply">查询</button></div></div></details><button type="button" class="cv-help" data-cv-do="help" aria-label="凭证帮助">${icon('help')}</button><div class="cv-toolbar-right"><button type="button" class="cv-add cv-orange" data-book-action="new-voucher" ${isClosed(book)?'disabled':''}>＋ 新增凭证</button><details class="cv-batch"><summary>批量操作<span class="cv-chevron"></span></summary><div class="cv-menu"><button type="button" data-cv-do="select-all">全选筛选结果</button><button type="button" data-cv-do="select-none">取消选择</button><button type="button" data-cv-do="bulk-review" ${!state.selected.size||state.busy?'disabled':''}>审核选中凭证</button><button type="button" data-cv-do="bulk-void" ${!state.selected.size||state.busy?'disabled':''}>作废 / 撤回选中</button><button type="button" data-cv-do="export-selected" ${!state.selected.size?'disabled':''}>导出选中凭证</button></div></details><details class="cv-import-menu"><summary>${icon('transfer')}导入/导出</summary><div class="cv-menu"><button type="button" data-cv-do="import" ${isClosed(book)?'disabled':''}>导入凭证 CSV</button><button type="button" data-cv-do="template">下载导入模板</button><button type="button" data-cv-do="export">导出筛选结果</button><a href="/api/export/vouchers.csv?client_id=${encodeURIComponent(book.client.id)}&period=${encodeURIComponent(book.period)}">导出本期全部凭证</a></div></details><button type="button" class="cv-plain" data-book-action="print">${icon('print')}打印</button><button type="button" class="cv-plain" data-cv-do="ledger">${icon('book')}电子账本</button><button type="button" class="cv-plain" data-book-action="refresh">${icon('refresh')}刷新</button></div></div>${state.selected.size?`<div class="cv-selection-bar print-hide">已选择 <strong>${state.selected.size}</strong> 张凭证<button type="button" data-cv-do="select-none">取消选择</button><button type="button" data-cv-do="bulk-void" ${state.busy?'disabled':''}>作废 / 撤回选中</button></div>`:''}<div class="cv-table-scroll"><table class="cv-table"><colgroup><col class="cv-col-check"><col class="cv-col-summary"><col class="cv-col-account"><col class="cv-col-money"><col class="cv-col-money"></colgroup><thead><tr><th class="cv-select"><input type="checkbox" data-cv-page aria-label="全选本页凭证" ${checked?'checked':''} ${eligible.length?'':'disabled'}></th><th>摘要</th><th>科目</th><th>借方金额</th><th>贷方金额</th></tr></thead>${page.length?page.map(v=>rowHtml(v,book,state,h,m)).join(''):`<tbody><tr><td colspan="5" class="cv-empty"><div class="cv-empty-icon">${icon('book')}</div><p>${(book.vouchers||[]).length?'没有符合条件的凭证':'本期暂无凭证'}</p><span>${(book.vouchers||[]).length?'调整搜索条件后重新查询':'点击“新增凭证”，手工录入公司的第一张凭证'}</span>${(book.vouchers||[]).length?'':`<button type="button" class="cv-orange" data-book-action="new-voucher" ${isClosed(book)?'disabled':''}>＋ 新增凭证</button>`}</td></tr></tbody>`}</table></div><div class="cv-pager print-hide"><span class="cv-page-selection">${state.selected.size?`已选 ${state.selected.size} 张`:''}</span><label>每页显示 <select data-cv-size aria-label="每页显示凭证数">${[20,50,100,500].map(n=>`<option value="${n}" ${n===state.size?'selected':''}>${n}</option>`).join('')}</select></label><button type="button" data-cv-do="first" aria-label="第一页" ${state.page===1?'disabled':''}>${icon('first')}</button><button type="button" data-cv-do="prev" aria-label="上一页" ${state.page===1?'disabled':''}>${icon('prev')}</button><span>第</span><input type="number" data-cv-page-input min="1" max="${pages}" value="${state.page}" aria-label="当前页"><span>页</span><button type="button" data-cv-do="next" aria-label="下一页" ${state.page>=pages?'disabled':''}>${icon('next')}</button><button type="button" data-cv-do="last" aria-label="最后一页" ${state.page>=pages?'disabled':''}>${icon('last')}</button><span class="cv-page-count">共${pages}页, ${rows.length}条记录</span></div></section>`;
}
function rerender(container,book,ctx) {
  const root=container.querySelector('.cv-root');if(!root)return;
  const search=root.querySelector('[data-cv-query]'),focused=search===document.activeElement,start=search?.selectionStart,end=search?.selectionEnd;
  const scroll=root.querySelector('.cv-table-scroll'),scrollTop=scroll?.scrollTop||0,scrollLeft=scroll?.scrollLeft||0;
  const active=document.activeElement,focusKey=['data-cv-row','data-cv-page','data-cv-size','data-cv-page-input'].find(key=>root.contains(active)&&active?.hasAttribute(key)),focusValue=focusKey?active.getAttribute(focusKey):null;
  root.outerHTML=renderCompanyVouchers(book,ctx);
  if(focused){const input=container.querySelector('[data-cv-query]');input?.focus();if(start!==null)input?.setSelectionRange(start,end);}
  else if(focusKey){[...container.querySelectorAll(`[${focusKey}]`)].find(el=>el.getAttribute(focusKey)===focusValue)?.focus({preventScroll:true});}
  const nextScroll=container.querySelector('.cv-table-scroll');if(nextScroll){nextScroll.scrollTop=scrollTop;nextScroll.scrollLeft=scrollLeft;}
  syncSelection(container,book);
}
function syncSelection(container,book) {
  const state=stateFor(book),boxes=[...container.querySelectorAll('[data-cv-row]:not(:disabled)')],checked=boxes.filter(x=>state.selected.has(x.dataset.cvRow)).length;
  const head=container.querySelector('[data-cv-page]');if(head){head.indeterminate=checked>0&&checked<boxes.length;head.setAttribute('aria-checked',head.indeterminate?'mixed':String(Boolean(boxes.length&&checked===boxes.length)));}
}
export function bindCompanyVouchers(container,book,ctx,actions={}) {
  const old=handlers.get(container);if(old)old.forEach(([type,fn])=>container.removeEventListener(type,fn));
  const state=stateFor(book),report=e=>ctx.toast(e?.message||String(e),'error');
  if(state.scrollToSaved){const savedRow=container.querySelector(`[data-cv-voucher="${state.scrollToSaved}"]`);if(savedRow){savedRow.scrollIntoView?.({block:'nearest'});state.scrollToSaved=null;}}
  const paint=()=>rerender(container,book,ctx);
  const click=event=>{
    const action=event.target.closest('[data-book-action]');
    if(action&&container.contains(action)&&action.closest('.cv-root')&&typeof actions.perform==='function'){
      if(action.disabled)return;event.preventDefault();event.stopPropagation();
      Promise.resolve().then(()=>actions.perform(action.dataset.bookAction,Number(action.dataset.id)||0)).catch(report);return;
    }
    const control=event.target.closest('[data-cv-do]');if(!control||!container.contains(control)||control.disabled)return;
    event.preventDefault();
    const run=async()=>{
      const command=control.dataset.cvDo;
      if(command==='help'){await ctx.modal('查看凭证', '<p>支持按凭证字号、摘要、科目和金额搜索。点击凭证字号或悬停后点击“编辑”可修改手工凭证。</p><p>“批量操作”处理已勾选凭证；作废与来源撤回会保留账务历史。已审核、已结账或存在后续业务依赖时，系统会校验并提示原因。</p>');return;}
      if(command==='ledger'){actions.view?.('ledger');return;}
      if(command==='bulk-void'||command==='bulk-review'){await bulkOperation(book,ctx,command==='bulk-review');return;}
      if(command==='import'){await importVouchers(book,ctx);return;}
      if(command==='template'){downloadCsv('凭证导入模板.csv',[IMPORT_HEADERS]);return;}
      if(command==='export'||command==='export-selected'){const rows=command==='export'?getRows(book,state):(book.vouchers||[]).filter(v=>state.selected.has(String(v.id)));if(!rows.length)throw new Error('没有可导出的凭证');downloadCsv(`${book.client.name}_${book.period}_凭证.csv`,exportRows(rows));return;}
      if(command==='apply'){
        const panel=control.closest('.cv-filter-panel'),next={};for(const el of panel.querySelectorAll('[data-cv-filter]')){if(['min','max'].includes(el.dataset.cvFilter)&&el.value)parseAmount(el.value);next[el.dataset.cvFilter]=el.value;}
        if(next.dateFrom&&next.dateTo&&next.dateFrom>next.dateTo)throw new Error('开始日期不能晚于结束日期');
        if(next.min&&next.max&&parseAmount(next.min)>parseAmount(next.max))throw new Error('最低金额不能大于最高金额');Object.assign(state,next,{page:1});
      } else if(command==='reset'){Object.assign(state,{query:'',status:'active',source:'',dateFrom:'',dateTo:'',min:'',max:'',page:1});}
      else if(command==='select-all'){getRows(book,state).filter(v=>isActive(v)&&!isClosed(book)).forEach(v=>state.selected.add(String(v.id)));}
      else if(command==='select-none')state.selected.clear();
      else if(command==='first')state.page=1;
      else if(command==='prev')state.page--;
      else if(command==='next')state.page++;
      else if(command==='last')state.page=pageRows(book,state).pages;
      paint();
    };
    run().catch(report);
  };
  const change=event=>{const target=event.target;if(!target.closest('.cv-root'))return;
    if(target.matches('[data-cv-row]')){target.checked?state.selected.add(target.dataset.cvRow):state.selected.delete(target.dataset.cvRow);}
    else if(target.matches('[data-cv-page]')){container.querySelectorAll('[data-cv-row]:not(:disabled)').forEach(el=>target.checked?state.selected.add(el.dataset.cvRow):state.selected.delete(el.dataset.cvRow));}
    else if(target.matches('[data-cv-size]')){state.size=Number(target.value);state.page=1;}
    else if(target.matches('[data-cv-page-input]')){state.page=Number(target.value)||1;}
    else return;paint();
  };
  const search=event=>{if(!event.target.matches('[data-cv-query]')||event.isComposing)return;state.query=event.target.value;state.page=1;paint();};
  const list=[['click',click],['change',change],['input',search],['compositionend',search]];list.forEach(([type,fn])=>container.addEventListener(type,fn));handlers.set(container,list);syncSelection(container,book);
}
async function bulkOperation(book,ctx,review) {
  const state=stateFor(book);if(state.busy)throw new Error('批量处理正在进行，请稍候');
  const rows=(book.vouchers||[]).filter(v=>state.selected.has(String(v.id))&&isActive(v));
  if(!rows.length)throw new Error('请先勾选凭证');
  if(isClosed(book))throw new Error('本期已结账，请先按期间顺序反结账');
  state.busy=true;
  try{await ctx.modal(review?'审核选中凭证':'作废 / 撤回选中凭证',`<p><strong>${esc(book.client.name)}</strong>　${esc(book.period)}　共 ${rows.length} 张凭证</p><p class="muted">${review?'逐张审核有效凭证。':'手工凭证作废，来源凭证撤回；已审核、已结账或存在后续依赖时会保留并提示原因。'}</p><ol class="cv-confirm-list">${rows.map(v=>`<li>${esc(v.date)}　${esc(voucherNumber(v))}　${esc(v.summary)}</li>`).join('')}</ol>${review?'':'<label class="field"><span>作废 / 撤回原因</span><textarea name="reason" required maxlength="500" rows="3"></textarea></label>'}`,async form=>{
    const reason=review?'':String(form.elements.reason.value||'').trim();if(!review&&!reason)throw new Error('请填写作废 / 撤回原因');
    const failures=[];let saved=0;
    for(const v of [...rows].sort((a,b)=>Number(b.id)-Number(a.id))){
      if(!state.selected.has(String(v.id)))continue;
      if(review&&v.reviewed){state.selected.delete(String(v.id));continue;}
      try{if(!review&&v.reviewed)throw new Error('请先取消审核');const manual=(v.source_type||'manual')==='manual';const path=`/api/books/${book.client.id}/vouchers/${v.id}${review?'/review':manual?'':'/withdraw'}`;
        await ctx.api(path,{method:review||!manual?'POST':'DELETE',body:{version:v.version,...(review?{reviewed:true}:{reason})}});state.selected.delete(String(v.id));saved++;
      }catch(error){failures.push(`${voucherNumber(v)}：${error.message||String(error)}`);}
    }
    state.busy=false;
    await ctx.reload();ctx.toast(`已${review?'审核':'处理'} ${saved} 张${failures.length?`，${failures.length} 张未处理`:''}`,failures.length?'error':'success');
    if(failures.length)throw new Error(failures.join('；'));
  });}finally{state.busy=false;}
}
const IMPORT_HEADERS=['分组编号','日期','摘要','科目编码','借方金额','贷方金额','分录摘要','附件数','资金活动'];
function csvCell(value){let text=String(value??'');if(/^[=+@\-\t\r]/.test(text))text=`'${text}`;return `"${text.replace(/"/g,'""')}"`;}
function exportRows(rows) {return [['日期','凭证字号','摘要','科目编码','科目名称','借方金额','贷方金额','分录摘要','附件数','制单人','状态','资金活动'],...rows.flatMap(v=>(v.lines||[]).map(l=>[v.date,voucherNumber(v),v.summary,l.account_code,l.account_name,(Number(l.debit_fen||0)/100).toFixed(2),(Number(l.credit_fen||0)/100).toFixed(2),l.summary||v.summary,Number(v.attachment_count||0),v.created_by_name||'',v.status==='void'?'已作废':v.reviewed?'已审核':'未审核',l.cashflow_category||'unclassified']))];}
function downloadCsv(filename,rows) {const url=URL.createObjectURL(new Blob(['\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function parseCsv(source) {
  const text=String(source||'').replace(/^\uFEFF/,''),rows=[];let row=[],cell='',quoted=false,afterQuote=false;
  for(let i=0;i<text.length;i++){const ch=text[i];if(ch==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else if(!cell||quoted){quoted=!quoted;afterQuote=!quoted;}else throw new Error('CSV 引号格式错误');}
    else if(ch===','&&!quoted){row.push(cell);cell='';afterQuote=false;}else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(v=>v.trim()))rows.push(row);row=[];cell='';afterQuote=false;}else if(afterQuote){if(ch!==' '&&ch!=='\t')throw new Error('CSV 引号结束后只能填写分隔符');}else cell+=ch;
  }
  if(quoted)throw new Error('CSV 引号未闭合');row.push(cell);if(row.some(v=>v.trim()))rows.push(row);return rows;
}
function parseAmount(value) {const text=String(value??'').trim()||'0';if(!/^\d+(\.\d{1,2})?$/.test(text))throw new Error('金额须为非负数字，最多保留两位小数，不含千分位');const [whole,decimal='']=text.split('.'),result=Number(whole)*100+Number(decimal.padEnd(2,'0'));if(!Number.isSafeInteger(result))throw new Error('金额超出允许范围');return result;}
function importGroups(text,book) {
  const rows=parseCsv(text);if(rows.length<2)throw new Error('请填写 CSV 表头和至少两条借贷分录');
  const headers=rows.shift().map(x=>x.trim()==='凭证字号'?'分组编号':x.trim()),required=IMPORT_HEADERS.slice(0,6);for(const name of required)if(!headers.includes(name))throw new Error(`缺少列：${name}`);
  if(new Set(headers).size!==headers.length)throw new Error('CSV 表头不能重复，请使用导入模板中的列名');
  const index=name=>headers.indexOf(name),get=(row,name)=>String(row[index(name)]??'').trim(),groups=new Map();
  const leafCodes=new Set((book.accounts||[]).filter(a=>!book.accounts.some(b=>b.code!==a.code&&b.code.startsWith(a.code))).map(a=>a.code));
  rows.forEach((row,i)=>{
    const number=get(row,'分组编号'),date=get(row,'日期'),summary=get(row,'摘要'),code=get(row,'科目编码'),attachment=get(row,'附件数')||'0',cf=get(row,'资金活动')||'unclassified';
    if(!number||!summary||summary.length>200)throw new Error(`第 ${i+2} 行：分组编号和摘要必填，摘要最多 200 字`);
    const timestamp=Date.parse(`${date}T00:00:00Z`);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date.slice(0,7)!==book.period||!Number.isFinite(timestamp)||new Date(timestamp).toISOString().slice(0,10)!==date)throw new Error(`第 ${i+2} 行：日期须为本期有效日期 YYYY-MM-DD`);
    if(!leafCodes.has(code))throw new Error(`第 ${i+2} 行：科目 ${code} 不存在或不是明细科目`);
    if(!/^\d+$/.test(attachment)||Number(attachment)>9999)throw new Error(`第 ${i+2} 行：附件数须为 0 至 9999 的整数`);
    const debit=parseAmount(get(row,'借方金额')),credit=parseAmount(get(row,'贷方金额'));if((debit>0)===(credit>0))throw new Error(`第 ${i+2} 行：借方和贷方只能有一方大于零`);
    const lineSummary=get(row,'分录摘要')||summary;if(lineSummary.length>200)throw new Error(`第 ${i+2} 行：分录摘要最多 200 字`);
    if(!['unclassified','operating','investing','financing','transfer'].includes(cf))throw new Error(`第 ${i+2} 行：资金活动须填写 unclassified、operating、investing、financing 或 transfer`);
    if(!groups.has(number))groups.set(number,{group:number,date,summary,attachment_count:Number(attachment),lines:[]});
    const group=groups.get(number);if(group.date!==date||group.summary!==summary||group.attachment_count!==Number(attachment))throw new Error(`分组 ${number} 的日期、摘要和附件数须保持一致`);
    group.lines.push({account_code:code,debit_fen:debit,credit_fen:credit,summary:lineSummary,cashflow_category:cf});
  });
  for(const group of groups.values()){
    if(group.lines.length<2||group.lines.length>500)throw new Error(`分组 ${group.group} 需要 2 至 500 条分录`);
    if(sum(group.lines,'debit_fen')!==sum(group.lines,'credit_fen'))throw new Error(`分组 ${group.group} 至少需要两条分录，且借贷合计必须相等`);
    const cashLines=group.lines.filter(line=>(book.accounts||[]).find(account=>account.code===line.account_code)?.report_key==='cash');
    if(cashLines.some(line=>line.cashflow_category==='transfer')&&(cashLines.length!==group.lines.length||group.lines.some(line=>line.cashflow_category!=='transfer')))
      throw new Error(`分组 ${group.group} 的内部转账只能包含全部标为 transfer 的货币资金分录`);
  }
  if(groups.size>500)throw new Error('一次最多导入 500 张凭证，请拆分文件');return [...groups.values()];
}
async function importVouchers(book,ctx) {
  if(isClosed(book))throw new Error('本期已结账');
  const imported=new Set();
  const pending=ctx.modal('导入手工凭证',`<p>先下载工具栏中的 CSV 模板。同一张凭证的分录使用相同“分组编号”，日期必须属于 ${esc(book.period)}。实际凭证字号由系统连续分配。</p><p class="muted">金额单位为元，不填千分位。资金活动可留空，或填写 operating（经营）、investing（投资）、financing（筹资）、transfer（内部转账）。附件数只记录单据张数。</p><label class="field"><span>选择 CSV 文件</span><input type="file" name="voucher_csv_file" accept=".csv,text/csv"></label><label class="field"><span>CSV 内容（可直接粘贴）</span><textarea name="voucher_csv_text" rows="10" spellcheck="false" required placeholder="${esc(IMPORT_HEADERS.join(','))}"></textarea></label><p data-cv-import-preview class="muted">全部分录校验通过后逐张写入；请勿重复导入同一批数据。</p>`,async form=>{
    const groups=importGroups(form.elements.voucher_csv_text.value,book);let saved=0;
    for(const group of groups){const fingerprint=JSON.stringify(group);if(imported.has(fingerprint))continue;try{const {group:label,...payload}=group;await ctx.api(`/api/books/${book.client.id}/vouchers`,{method:'POST',body:payload});imported.add(fingerprint);saved++;}
      catch(error){await ctx.reload();throw new Error(`已导入 ${saved} 张；分组 ${group.group} 未保存：${error.message||String(error)}。请移除已成功分组后再重试剩余内容。`);}}
    await ctx.reload();ctx.toast(`已导入 ${saved} 张凭证`,'success');
  });
  queueMicrotask(()=>{const form=document.querySelector('#app-modal-form'),file=form?.elements.voucher_csv_file,area=form?.elements.voucher_csv_text;if(!form||!file||!area)return;
    const preview=()=>{const output=form.querySelector('[data-cv-import-preview]');if(!area.value.trim()){output.textContent='请上传 CSV 或粘贴内容';return;}try{const groups=importGroups(area.value,book);output.textContent=`校验通过：${groups.length} 张凭证，${groups.reduce((n,g)=>n+g.lines.length,0)} 条分录`;output.className='book-ok';}catch(error){output.textContent=error.message;output.className='book-warning';}};
    file.addEventListener('change',async()=>{const selected=file.files?.[0];if(!selected)return;if(selected.size>5*1024*1024){ctx.toast('CSV 文件不得超过 5MB','error');return;}try{area.value=await selected.text();preview();}catch(error){ctx.toast(`CSV 文件读取失败：${error.message||String(error)}`,'error');}});area.addEventListener('input',preview);
  });return pending;
}
export const companyVouchersTest={parseCsv,parseAmount,importGroups,getRows,exportRows,voucherNumber,stateFor};
