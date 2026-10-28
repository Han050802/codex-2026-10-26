/* Account-book workspace. Money sent to the server is always integer fen. */
import { renderCompanyWorkspace, renderCompanyHome, bindCompanyWorkspace, updateCompanyReportRange } from './company-workspace.js';
import { renderCompanyVouchers, bindCompanyVouchers, focusCompanyVoucher } from './company-vouchers.js';
import { renderCompanyBalance, bindCompanyBalance } from './company-balance.js';
let book = null;
let activeView = 'home';
let requestedView = null;
let bookContext = null;
const bookBindings = new WeakSet();
export function setBookView(view) { if (['home','vouchers','ledger','reports','accounts','assets','inventory','payroll','journals','period'].includes(view)) { activeView = view; requestedView = view; } }
let ledgerAccount = '';
let activeClient = null;
let maintenanceContext = '';
let bulkBusy = false;
const maintenanceStates = new Map();
const maintenanceTables = new Map();
const maintenanceHandlers = new WeakMap();
const VIEWS = [['vouchers','凭证管理'],['ledger','账簿查询'],['reports','财务报表'],['accounts','科目与期初'],['assets','固定资产'],['inventory','库存核算'],['payroll','工资管理'],['journals','资金日记账'],['period','期末处理']];
const CF = [['unclassified','待分类'],['operating','经营活动'],['investing','投资活动'],['financing','筹资活动'],['transfer','内部资金划转']];
const STANDARD = {small2013:'2013 小企业会计准则',enterprise2007:'2007 企业会计准则'};
const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fen(value, allowNegative=false) {
  const text = String(value ?? '').trim() || '0';
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) throw new Error('金额最多保留两位小数，请勿输入千分位或其他字符');
  const negative=text.startsWith('-'), [whole,fraction='']=text.replace(/^-/,'').split('.');
  const result=(Number(whole)*100+Number(fraction.padEnd(2,'0')))*(negative?-1:1);
  if (!Number.isSafeInteger(result) || (!allowNegative && result<0)) throw new Error('金额超出允许范围');
  return result;
}
function money(n){return (Number(n||0)/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});}
function inputMoney(n){return (Number(n||0)/100).toFixed(2);}
function today(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function periodDate(){return book.period===today().slice(0,7)?today():`${book.period}-01`;}
function nextPeriod(period){const [y,m]=period.split('-').map(Number);return m===12?`${y+1}-01`:`${y}-${String(m+1).padStart(2,'0')}`;}
function field(name,label,type='text',value='',attrs=''){return `<label class="field"><span>${h(label)}</span><input name="${h(name)}" type="${type}" value="${h(value)}" ${attrs}></label>`;}
function isLeaf(a){return !book.accounts.some(b=>b.code!==a.code&&b.code.startsWith(a.code));}
function accountOptions(selected='',filter=null,blank=true){return `${blank?'<option value="">请选择科目</option>':''}${book.accounts.filter(a=>isLeaf(a)&&(!filter||filter(a))).map(a=>`<option value="${h(a.code)}" ${a.code===selected?'selected':''}>${h(a.code)} ${h(a.name)}</option>`).join('')}`;}
function accountField(name,label,selected='',filter=null){return `<label class="field"><span>${h(label)}</span><select name="${h(name)}" required>${accountOptions(selected,filter)}</select></label>`;}
function selectField(name,label,values,selected=''){return `<label class="field"><span>${h(label)}</span><select name="${h(name)}">${values.map(([v,t])=>`<option value="${h(v)}" ${v===selected?'selected':''}>${h(t)}</option>`).join('')}</select></label>`;}
function table(heads,rows,empty='本期暂无记录，可使用上方按钮新增'){return `<div class="table-wrap book-table"><table><thead><tr>${heads.map(v=>`<th>${v}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.join(''):`<tr><td colspan="${heads.length}" class="book-empty">${h(empty)}</td></tr>`}</tbody></table></div>`;}
function button(label,action,attrs='',primary=false){return `<button type="button" class="btn ${primary?'btn-primary':''}" data-book-action="${h(action)}" ${attrs}>${h(label)}</button>`;}
function statusBadge(text,kind=''){return `<span class="book-badge ${h(kind)}">${h(text)}</span>`;}
function acctDefault(key,nameFallback='',codeFallback='') {const list=book.accounts.filter(isLeaf);return list.find(a=>a.code===codeFallback)?.code || list.find(a=>a.name===nameFallback&&nameFallback)?.code || list.find(a=>a.report_key===key)?.code || list.find(a=>a.name.includes(nameFallback)&&nameFallback)?.code || '';}

function exportLink(kind,label){return `<a class="btn" href="/api/export/${h(kind)}.csv?client_id=${book.client.id}&period=${encodeURIComponent(book.period)}">${h(label)}</a>`;}
function closed(){return !!book.periods.find(p=>p.period===book.period)?.closed;}
function actionbar(title,actions,subtitle=''){return `<div class="book-section-head"><div><h2>${h(title)}</h2>${subtitle?`<p class="muted">${h(subtitle)}</p>`:''}</div><div class="book-actions print-hide">${actions}</div></div>`;}

function maintenanceState(scope){if(!maintenanceStates.has(scope))maintenanceStates.set(scope,{selected:new Set(),query:'',page:1,size:30});return maintenanceStates.get(scope);}
function maintenanceRecord(row,label,operation,extra={}){return {id:String(row.id),label,search:JSON.stringify(row).toLocaleLowerCase(),operation,selectable:true,...extra};}
function sourceOperation(v){return v?{method:v.source_type==='manual'?'DELETE':'POST',path:`vouchers/${v.id}${v.source_type==='manual'?'':'/withdraw'}`,body:{version:v.version},label:v.source_type==='manual'?'作废手工凭证（保留历史）':'撤回来源凭证（按来源依赖校验）'}:{error:'找不到关联凭证，请刷新账套后重试',label:'撤回来源凭证'};}
function maintenanceDefinitions(){
  const voucherById=new Map((book.vouchers||[]).map(v=>[Number(v.id),v]));
  return {
    vouchers:{title:'凭证',label:'作废 / 撤回选中',hint:'手工凭证作废；来源凭证撤回。已审核、锁期或存在后续依赖时保留并显示原因。',records:(book.vouchers||[]).map(v=>maintenanceRecord(v,`${v.date} · ${v.number} · ${v.summary}`,sourceOperation(v),{selectable:v.status==='active',disabledReason:'已作废凭证保留历史，不能再次删除',order:-Number(v.id)}))},
    accounts:{title:'自定义科目',label:'删除选中科目',hint:'制度预置科目保留。仅无子科目、期初、凭证及业务引用的自定义科目可以删除。',records:book.accounts.map(a=>maintenanceRecord(a,`${a.code} ${a.name}`,{method:'DELETE',path:`accounts/${a.id}`,body:{version:a.version},label:'删除未使用的自定义科目'},{selectable:!a.is_preset,disabledReason:'制度预置科目保留；可删除未使用的自定义科目',order:-a.code.length}))},
    assets:{title:'资产卡片',label:'删除 / 撤回购置选中',hint:'不物理删除资产卡片；撤回购置并保留审计。有折旧、处置、已审核或锁期依赖时须先处理来源。',records:book.assets.map(a=>maintenanceRecord(a,`${a.name} · 购置 ${a.purchase_date}`,{method:'DELETE',path:`assets/${a.id}`,body:{version:a.version},label:'撤回购置并保留已撤销卡片'},{selectable:a.status!=='cancelled',disabledReason:'购置已撤回，卡片与审计保留'}))},
    inventory_items:{title:'库存商品',label:'删除选中空商品',hint:'仅数量与金额均为0且从未发生库存流水的商品可删除；包括已撤回流水的历史仍须保留。',records:book.inventory_items.map(i=>maintenanceRecord(i,`${i.sku} ${i.name}`,{method:'DELETE',path:`inventory/items/${i.id}`,body:{version:i.version},label:'删除无库存历史的空商品'}))},
    inventory_movements:{title:'库存流水',label:'撤回选中库存流水',hint:'从所选最新流水起撤回，自动回退数量及成本。若还有未选中的后续流水、已审核凭证或锁期，操作会被阻止。',records:book.inventory_movements.map(m=>maintenanceRecord(m,`${m.date} ${m.item_name||m.item_id} ${m.direction==='in'?'入库':'出库'} ${m.quantity}`,sourceOperation(voucherById.get(Number(m.voucher_id))),{selectable:m.status!=='void',disabledReason:'已撤回流水保留历史',order:-Number(m.id)}))},
    payroll:{title:'工资记录',label:'删除选中未计提工资',hint:'仅未计提工资可删除。计提/发放凭证可能由多名员工共用，请先到凭证管理核对并撤回，再删除记录。',records:book.payroll.map(p=>maintenanceRecord(p,`${p.period} ${p.employee_name}`,{method:'DELETE',path:`payroll/${p.id}`,body:{version:p.version},label:'删除未计提工资；已计提时保留并提示'}))},
    journals:{title:'资金流水',label:'删除选中未制证流水',hint:'仅未生成凭证的流水可删除。已制证流水须先在凭证管理撤回来源，不能直接删除账务。',records:book.journals.map(j=>maintenanceRecord(j,`${j.date} ${j.summary}`,{method:'DELETE',path:`journals/${j.id}`,body:{version:j.version},label:'删除未制证流水；已制证时保留并提示'}))}
  };
}
function managedTable(original,scope,definition){
  const state=maintenanceState(scope), query=state.query.trim().toLocaleLowerCase();
  const body=/<tbody>([\s\S]*?)<\/tbody>/.exec(original)?.[1]||'';
  const rendered=body.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)||[];
  const records=definition.records.map((r,i)=>({...r,html:rendered[i]||''}));
  const filtered=records.filter(r=>!query||r.search.includes(query)||r.label.toLocaleLowerCase().includes(query));
  const eligible=new Set(filtered.filter(r=>r.selectable).map(r=>r.id));
  for(const id of state.selected)if(!eligible.has(id))state.selected.delete(id);
  const totalPages=Math.max(1,Math.ceil(filtered.length/state.size));state.page=Math.max(1,Math.min(totalPages,state.page));
  const page=filtered.slice((state.page-1)*state.size,state.page*state.size), selectable=page.filter(r=>r.selectable);
  const selectedPage=selectable.filter(r=>state.selected.has(r.id)).length;
  const heads=/<thead>([\s\S]*?)<\/thead>/.exec(original)?.[1]||'<tr></tr>';
  const count=(heads.match(/<th\b/g)||[]).length+1;
  const heading=heads.replace(/<tr>/,'<tr><th class="book-select-cell print-hide"><label><input type="checkbox" data-book-maintenance-page aria-label="全选本页" '+(!selectable.length?'disabled':'')+' '+(selectable.length&&selectedPage===selectable.length?'checked':'')+'>全选本页</label></th>');
  const rows=page.map(r=>r.html.replace(/<tr\b[^>]*>/,start=>`${start}<td class="book-select-cell print-hide"><input type="checkbox" data-book-maintenance-row value="${h(r.id)}" aria-label="选择${h(r.label)}" ${r.selectable?'':`disabled title="${h(r.disabledReason||'历史记录保留')}"`} ${state.selected.has(r.id)?'checked':''}></td>`)).join('')||`<tr><td colspan="${count}" class="book-empty">没有匹配记录</td></tr>`;
  maintenanceTables.set(scope,{original,definition,records,filtered,eligible});
  return `<section class="book-maintenance" data-book-maintenance-scope="${h(scope)}"><div class="book-selection-bar print-hide"><label class="book-maintenance-search">筛选<input data-book-maintenance-filter value="${h(state.query)}" placeholder="搜索${h(definition.title)}" aria-label="筛选${h(definition.title)}"></label><span>已选 <strong data-book-selected-count>${state.selected.size}</strong> 条</span><button type="button" class="link-btn" data-book-maintenance="all" ${!eligible.size||state.selected.size===eligible.size?'disabled':''}>全选筛选中可操作的 ${eligible.size} 条</button><button type="button" class="link-btn" data-book-maintenance="clear" ${!state.selected.size?'disabled':''}>取消全选</button><button type="button" class="btn book-delete-button" data-book-maintenance="delete" ${!state.selected.size||bulkBusy?'disabled':''}>${h(definition.label)}</button></div><p class="book-maintenance-hint muted print-hide">${h(definition.hint)}</p><div class="table-wrap book-table"><table><thead>${heading}</thead><tbody>${rows}</tbody></table></div><div class="book-maintenance-pager print-hide"><span>当前筛选 ${filtered.length} 条 / 共 ${records.length} 条</span><label>每页 <select data-book-maintenance-size>${[30,50,100].map(n=>`<option value="${n}" ${state.size===n?'selected':''}>${n}</option>`).join('')}</select> 条</label><button type="button" class="btn" data-book-maintenance="prev" ${state.page===1?'disabled':''}>上一页</button><span>${state.page} / ${totalPages}</span><button type="button" class="btn" data-book-maintenance="next" ${state.page===totalPages?'disabled':''}>下一页</button></div></section>`;
}
function enhanceMaintenance(html){
  const definitions=maintenanceDefinitions();
  const scopes={vouchers:['vouchers'],accounts:['accounts'],assets:['assets'],inventory:['inventory_items','inventory_movements'],payroll:['payroll'],journals:['journals']}[activeView];
  if(!scopes)return html;
  let index=0;
  return html.replace(/<div class="table-wrap book-table"><table>[\s\S]*?<\/table><\/div>/g,tableHtml=>{const scope=scopes[index++];return scope?managedTable(tableHtml,scope,definitions[scope]):tableHtml;});
}
function syncMaintenance(container){for(const wrapper of container.querySelectorAll('[data-book-maintenance-scope]')){const state=maintenanceState(wrapper.dataset.bookMaintenanceScope), boxes=[...wrapper.querySelectorAll('[data-book-maintenance-row]:not(:disabled)')], count=boxes.filter(x=>state.selected.has(x.value)).length,header=wrapper.querySelector('[data-book-maintenance-page]');if(header){header.indeterminate=count>0&&count<boxes.length;header.setAttribute('aria-checked',header.indeterminate?'mixed':String(Boolean(boxes.length&&count===boxes.length)));}}}
function repaintMaintenance(wrapper){const scope=wrapper.dataset.bookMaintenanceScope,entry=maintenanceTables.get(scope);if(!entry)return;const focus=wrapper.querySelector('[data-book-maintenance-filter]')===document.activeElement, caret=focus?document.activeElement.selectionStart:null;const parent=wrapper.parentElement;wrapper.outerHTML=managedTable(entry.original,scope,entry.definition);syncMaintenance(parent);if(focus){const input=parent.querySelector(`[data-book-maintenance-scope="${scope}"] [data-book-maintenance-filter]`);input?.focus();if(caret!==null)input?.setSelectionRange?.(caret,caret);}}
function bindMaintenance(container,ctx){
  if(!container)return;
  const previous=maintenanceHandlers.get(container);if(previous)for(const [type,handler] of previous)container.removeEventListener(type,handler);
  const click=event=>{const action=event.target.closest('[data-book-action]');if(action?.closest('[data-book-maintenance-scope]')){if(!action.disabled)performAction(action.dataset.bookAction,Number(action.dataset.id),ctx).catch(error=>ctx.toast(error.message,'error'));return;}const control=event.target.closest('[data-book-maintenance]');if(!control||control.disabled)return;const wrapper=control.closest('[data-book-maintenance-scope]');if(!wrapper)return;event.preventDefault();const scope=wrapper.dataset.bookMaintenanceScope,state=maintenanceState(scope),entry=maintenanceTables.get(scope);switch(control.dataset.bookMaintenance){case'all':entry.eligible.forEach(id=>state.selected.add(id));break;case'clear':state.selected.clear();break;case'prev':state.page--;break;case'next':state.page++;break;case'delete':runMaintenanceDelete(scope,ctx).catch(error=>ctx.toast(error.message,'error'));return;}repaintMaintenance(wrapper);};
  const change=event=>{const wrapper=event.target.closest('[data-book-maintenance-scope]');if(!wrapper)return;const state=maintenanceState(wrapper.dataset.bookMaintenanceScope);if(event.target.matches('[data-book-maintenance-page]')){for(const input of wrapper.querySelectorAll('[data-book-maintenance-row]:not(:disabled)')){if(event.target.checked)state.selected.add(input.value);else state.selected.delete(input.value);}}else if(event.target.matches('[data-book-maintenance-row]')){if(event.target.checked)state.selected.add(event.target.value);else state.selected.delete(event.target.value);}else if(event.target.matches('[data-book-maintenance-size]')){state.size=Number(event.target.value);state.page=1;}else return;repaintMaintenance(wrapper);};
  const filter=event=>{if(!event.target.matches('[data-book-maintenance-filter]')||event.isComposing)return;const wrapper=event.target.closest('[data-book-maintenance-scope]'),state=maintenanceState(wrapper.dataset.bookMaintenanceScope);state.query=event.target.value;state.page=1;repaintMaintenance(wrapper);};
  const handlers=[['click',click],['change',change],['input',filter],['compositionend',filter]];for(const [type,handler]of handlers)container.addEventListener(type,handler);maintenanceHandlers.set(container,handlers);syncMaintenance(container);
}
async function runMaintenanceDelete(scope,ctx){
  if(bulkBusy)throw new Error('已有批处理正在进行，请等待结果');
  const entry=maintenanceTables.get(scope),state=maintenanceState(scope);if(!entry)return;
  const selected=entry.filtered.filter(r=>r.selectable&&state.selected.has(r.id)).map(r=>({...r,operation:{...r.operation,body:{...r.operation.body}}})).sort((a,b)=>(a.order||0)-(b.order||0));
  if(!selected.length){ctx.toast('请先勾选需要处理的记录','error');return;}
  const prefix=base(),period=book.period,companyName=book.client.name,groupVersions=new Map();
  for(const item of selected)if(item.versionGroup&&!groupVersions.has(item.versionGroup))groupVersions.set(item.versionGroup,item.operation.body.version);
  bulkBusy=true;
  try{
    await ctx.modal('确认删除 / 作废 / 撤回',`<p data-book-delete-client="${book.client.id}" data-book-delete-period="${h(period)}"><strong>${h(companyName)}</strong> · ${h(period)} · 共 ${selected.length} 条</p><p class="muted">逐条按下列方式处理；已审核、锁期和依赖记录不会强行删除。成功记录保留审计，失败项保持勾选。</p><ol class="book-bulk-confirm-list" data-book-delete-scope="${h(scope)}">${selected.map(r=>`<li data-book-confirm-record="${h(r.id)}"><strong>${h(r.label)}</strong><span>${h(r.operation.label)}</span></li>`).join('')}</ol>${field('reason','删除 / 撤回原因','text','','required maxlength="500"')}`,async form=>{
      const reason=String(form.elements.reason.value||'').trim();if(!reason)throw new Error('请填写删除 / 撤回原因');
      const results=[];
      for(const item of selected){try{if(item.operation.error)throw new Error(item.operation.error);const body={...item.operation.body,reason};if(item.versionGroup)body.version=groupVersions.get(item.versionGroup);await ctx.api(`${prefix}/${item.operation.path}`,{method:item.operation.method,body});state.selected.delete(item.id);if(item.versionGroup)groupVersions.set(item.versionGroup,body.version+1);results.push({id:item.id,label:item.label,operation:item.operation.label,ok:true});}catch(error){results.push({id:item.id,label:item.label,operation:item.operation.label,ok:false,error:displayError(error)});}}
      try{await ctx.reload();}catch(error){ctx.toast(`处理已完成，列表刷新失败：${displayError(error)}`,'error');}
      const success=results.filter(r=>r.ok).length;
      setTimeout(()=>ctx.modal('批量处理结果',`<p>${h(companyName)} · ${h(period)}：成功 ${success} 条，失败 ${results.length-success} 条。失败项保留勾选，可核对原因后重试。</p>${table(['记录','操作','结果','说明'],results.map(r=>`<tr data-book-result-record="${h(r.id)}" data-book-result-status="${r.ok?'success':'failed'}"><td>${h(r.label)}</td><td>${h(r.operation)}</td><td>${r.ok?'已完成':'未处理'}</td><td>${h(r.error||'已保存，审计保留')}</td></tr>`))}`),0);
    });
  }finally{bulkBusy=false;for(const wrapper of document.querySelectorAll('[data-book-maintenance-scope]'))repaintMaintenance(wrapper);}
}

export async function renderBook(clientId,period,ctx) {
  if(activeClient!==Number(clientId)){activeView=requestedView||'home';ledgerAccount='';activeClient=Number(clientId);}
  requestedView=null;bookContext=ctx;
  book=await ctx.api(`/api/books/${Number(clientId)}?period=${encodeURIComponent(period)}`);
  const context=`${book.client.id}:${book.period}`;if(context!==maintenanceContext){maintenanceContext=context;maintenanceStates.clear();maintenanceTables.clear();}
  return renderCompanyWorkspace(book,ctx,{view:activeView,content:renderView()});
}

function renderView(){if(activeView==='home')return renderCompanyHome(book);if(activeView==='vouchers')return renderCompanyVouchers(book,bookContext);if(activeView==='ledger')return renderCompanyBalance(book,bookContext);const html=(()=>{switch(activeView){case 'ledger':return renderLedger();case 'reports':return renderReports();case 'accounts':return renderAccounts();case 'assets':return renderAssets();case 'inventory':return renderInventory();case 'payroll':return renderPayroll();case 'journals':return renderJournals();case 'period':return renderPeriod();default:return renderVouchers();}})();return enhanceMaintenance(html);}
function renderVouchers(){const vouchers=book.vouchers||[];return actionbar('记账凭证',button('新增凭证','new-voucher','',true)+exportLink('vouchers','导出凭证'),'凭证保存时校验借贷平衡；来源单据可追溯，作废记录保留。')+table(['凭证日期','凭证字号','摘要','分录 / 会计科目','借方金额','贷方金额','状态','操作'],vouchers.map(v=>`<tr class="${v.status==='void'?'book-void':''}"><td>${h(v.date)}</td><td class="mono">${h(v.number)}</td><td>${h(v.summary)}<small class="muted book-source">${h(v.source_type||'manual')}${v.source_id?' #'+h(v.source_id):''}</small></td><td>${v.lines.map(l=>`<div>${h(l.account_code)} ${h(l.account_name)}</div>`).join('')}</td><td class="number">${v.lines.map(l=>`<div>${l.debit_fen?money(l.debit_fen):'—'}</div>`).join('')}</td><td class="number">${v.lines.map(l=>`<div>${l.credit_fen?money(l.credit_fen):'—'}</div>`).join('')}</td><td>${v.status==='void'?statusBadge('已作废'):statusBadge(v.reviewed?'已审核':'待审核',v.reviewed?'success':'pending')}</td><td class="book-row-actions">${v.status==='void'?'—':`${v.source_type==='manual'?button('编辑','edit-voucher',`data-id="${v.id}"`):(!v.reviewed?button('撤回来源','withdraw-source',`data-id="${v.id}"`):'')}${button(v.reviewed?'取消审核':'审核','review-voucher',`data-id="${v.id}"`)}${button('资金分类','cashflow-voucher',`data-id="${v.id}"`)}${v.source_type==='manual'?button('作废','void-voucher',`data-id="${v.id}"`):''}`}</td></tr>`));}
function renderLedger(){const rows=(book.ledger||[]).filter(r=>!ledgerAccount||r.account_code===ledgerAccount);let debit=0,credit=0;rows.forEach(r=>{debit+=r.debit_fen;credit+=r.credit_fen;});return actionbar('科目余额表与明细账',exportLink('trial-balance','导出余额表'))+table(['科目编码','科目名称','期初借方','期初贷方','本期借方','本期贷方','期末借方','期末贷方'],(book.trial_balance||[]).map(r=>`<tr><td>${h(r.account_code)}</td><td>${h(r.account_name)}</td>${['opening_debit_fen','opening_credit_fen','debit_fen','credit_fen','closing_debit_fen','closing_credit_fen'].map(k=>`<td class="number">${money(r[k])}</td>`).join('')}</tr>`))+'<div class="book-section-gap"></div>'+actionbar('凭证明细账',`<select data-ledger-account aria-label="筛选明细账科目"><option value="">全部科目</option>${accountOptions(ledgerAccount,null,false)}</select>`)+table(['日期','凭证字号','科目','摘要','借方','贷方','该科目余额'],rows.map(r=>`<tr><td>${h(r.date)}</td><td>${h(r.number)}</td><td>${h(r.account_code)} ${h(r.account_name)}</td><td>${h(r.summary)}</td><td class="number">${money(r.debit_fen)}</td><td class="number">${money(r.credit_fen)}</td><td class="number">${money(r.balance_fen)}</td></tr>`))+`<p class="book-totals">本期明细合计：借方 ${money(debit)}　贷方 ${money(credit)}</p>`;}
function renderReports(){const r=book.reports||{},bs=r.balance_sheet||{},pl=r.profit_loss||{},cf=r.cash_flow||{};return actionbar('财务报表',button('打印报表','print'),'报表来自期初与有效凭证；本页显示所选期间。现金流必须明确活动分类。')+`<div class="book-report-grid"><section class="book-report"><h3>资产负债管理表</h3><p class="muted">${h(bs.basis||'按总账科目聚合，重分类及期末调整由会计复核。')}</p>${table(['项目','金额'],(bs.rows||[]).map(r=>`<tr><td>${h(r.name)}</td><td class="number">${money(r.amount_fen)}</td></tr>`))}<div class="book-report-total"><span>资产合计 <b>${money(bs.assets_fen)}</b></span><span>负债合计 <b>${money(bs.liabilities_fen)}</b></span><span>所有者权益合计 <b>${money(bs.equity_fen)}</b></span></div><p>${statusBadge(bs.balanced?'资产 = 负债 + 所有者权益':'资产负债不平，请检查期初及凭证',bs.balanced?'success':'danger')}</p></section><section class="book-report"><h3>利润管理表</h3>${table(['项目','金额'],(pl.rows||[]).map(r=>`<tr><td>${h(r.name)}</td><td class="number">${money(r.amount_fen)}</td></tr>`))}<div class="book-report-total"><span>收入合计 <b>${money(pl.income_fen)}</b></span><span>成本费用合计 <b>${money(pl.expense_fen)}</b></span><span>本期利润 <b>${money(pl.profit_fen)}</b></span><span>本年累计利润 <b>${money(pl.ytd_profit_fen)}</b></span></div></section></div><section class="book-report book-section-gap"><h3>现金流量汇总</h3>${table(['活动分类','流入','流出','净额'],(cf.rows||[]).map(r=>`<tr><td>${h(r.name)}</td><td class="number">${money(r.inflow_fen)}</td><td class="number">${money(r.outflow_fen)}</td><td class="number">${money(r.net_fen)}</td></tr>`))}<p class="${cf.complete?'book-ok':'book-warning'}">${cf.complete?'本期资金分录已完成分类。':`仍有 ${Number(cf.unclassified_count||0)} 条资金分录待分类，请在凭证中指定活动分类后再使用汇总。`}</p><p class="muted">按资金分录人工指定的经营、投资、筹资及内部划转分类汇总。此表是核对辅助表，法定现金流量表的行次、补充资料及行业调整须经会计复核。</p></section>`;}
function renderAccounts(){return actionbar('会计科目与期初余额',button('新增科目','new-account','',true)+button('设置期初余额','opening'),'科目按建账时选择的会计制度初始化；期初必须借贷平衡。')+table(['科目编码','科目名称','方向','类别','报表归类','期初借方','期初贷方'],book.accounts.map(a=>{const o=book.opening_balances.find(x=>x.account_code===a.code)||{};return `<tr><td class="mono">${h(a.code)}</td><td>${h(a.name)}</td><td>${a.direction==='debit'?'借':'贷'}</td><td>${h({asset:'资产',liability:'负债',equity:'权益',income:'收入',expense:'费用',cost:'成本'}[a.category]||a.category)}</td><td>${h(a.report_key||'—')}</td><td class="number">${money(o.debit_fen)}</td><td class="number">${money(o.credit_fen)}</td></tr>`;}));}
function renderAssets(){return actionbar('固定资产卡片',button('新增固定资产','new-asset','',true)+button('计提本月折旧','depreciate'),'购置次月起直线折旧，残值不计折旧；购置、折旧和清理均生成凭证。')+table(['资产名称','购置日期','开始折旧','原值','残值','折旧月数','累计折旧','账面净值','状态','操作'],book.assets.map(a=>`<tr><td>${h(a.name)}</td><td>${h(a.purchase_date)}</td><td>${h(a.start_period)}</td><td class="number">${money(a.cost_fen)}</td><td class="number">${money(a.residual_fen)}</td><td>${a.life_months}</td><td class="number">${money(a.accumulated_fen)}</td><td class="number">${money(a.net_fen)}</td><td>${statusBadge(({active:'使用中',disposed:'已清理',cancelled:'已撤销购置'})[a.status]||a.status,a.status==='active'?'success':'')}</td><td class="book-row-actions">${button('折旧明细','asset-detail',`data-id="${a.id}"`)}${a.status==='active'?button('资产清理','dispose-asset',`data-id="${a.id}"`):''}</td></tr>`));}
function renderInventory(){return actionbar('库存商品',button('新增商品','new-item','',true)+button('入库 / 出库','inventory-move'),'采用移动加权平均成本；不允许负库存，已发生后续移动的商品不接受倒序入账。')+table(['商品编码','商品名称','单位','结存数量','结存成本','存货科目','成本科目'],book.inventory_items.map(i=>`<tr><td>${h(i.sku)}</td><td>${h(i.name)}</td><td>${h(i.unit)}</td><td class="number">${h(i.quantity)}</td><td class="number">${money(i.value_fen)}</td><td>${h(i.inventory_account)}</td><td>${h(i.cost_account)}</td></tr>`))+'<div class="book-section-gap"></div>'+actionbar('库存出入库记录','')+table(['日期','商品','方向','数量','成本金额','状态','关联凭证'],book.inventory_movements.map(m=>`<tr class="${m.status==='void'?'book-void':''}"><td>${h(m.date)}</td><td>${h(m.item_name||m.item_id)}</td><td>${statusBadge(m.direction==='in'?'入库':'出库',m.direction==='in'?'success':'pending')}</td><td class="number">${h(m.quantity)}</td><td class="number">${money(m.amount_fen)}</td><td>${m.status==='void'?'已撤回':'有效'}</td><td>${m.voucher_id?`#${m.voucher_id}`:'—'}</td></tr>`));}
function renderPayroll(){let gross=0,net=0;book.payroll.forEach(p=>{gross+=p.gross_fen;net+=p.net_fen;});return actionbar('工资表',button('新增工资记录','new-payroll','',true)+button('生成工资计提凭证','post-payroll')+button('登记工资发放','pay-payroll'),'个税、社保和其他扣款由会计录入；系统计算实发，不自动推算个人所得税。')+table(['所属期间','员工姓名','应发工资','代扣个税','个人社保','其他扣款','实发工资','计提凭证','发放凭证','操作'],book.payroll.map(p=>`<tr><td>${h(p.period)}</td><td>${h(p.employee_name)}</td>${['gross_fen','withheld_tax_fen','social_fen','other_deduction_fen','net_fen'].map(k=>`<td class="number">${money(p[k])}</td>`).join('')}<td>${p.voucher_id?`#${p.voucher_id}`:statusBadge('待计提','pending')}</td><td>${p.payment_voucher_id?`#${p.payment_voucher_id}`:'未登记发放'}</td><td>${!p.voucher_id?button('删除重录','delete-payroll',`data-id="${p.id}"`):'需先撤回来源凭证后纠错'}</td></tr>`))+`<p class="book-totals">应发合计 ${money(gross)}　实发合计 ${money(net)}</p><p class="muted">计提和实发分别生成凭证。实际转账及缴纳须在外部办理；发放时生成的代扣负债，可在资金日记账继续登记缴纳。</p>`;}
function renderJournals(){return actionbar('资金日记账',button('新增流水','new-journal','',true)+button('导入流水','import-bank')+`<a class="btn" href="/api/templates/bank.csv">下载模板</a>`+exportLink('bank','导出流水'),'流水与凭证一一关联；录入流水后需确认生成凭证，支持实际资金活动分类。')+table(['日期','摘要','资金科目','对方科目','收支','金额','活动分类','凭证','操作'],book.journals.map(j=>`<tr><td>${h(j.date)}</td><td>${h(j.summary)}</td><td>${h(j.bank_account)}</td><td>${h(j.counter_account)}</td><td>${j.direction==='income'?'收入':'支出'}</td><td class="number">${money(j.amount_fen)}</td><td>${h(CF.find(x=>x[0]===j.cashflow_category)?.[1]||'待分类')}</td><td>${j.voucher_id?'#'+j.voucher_id:'待生成'}</td><td>${j.voucher_id?'—':button('生成凭证','post-journal',`data-id="${j.id}"`)}</td></tr>`));}
function renderPeriod(){return actionbar('期末检查与结账',button('重新检查','refresh')+button('本期结账','close-period','',true)+button('反结账','reopen-period'),'结账前检查借贷平衡及资料完整性，自动结转损益；结账后锁定该期间。')+table(['检查级别','检查事项'],book.checks.map(c=>`<tr><td>${statusBadge({error:'需处理',warning:'请复核',info:'提示'}[c.severity]||c.severity,c.severity==='error'?'danger':c.severity==='warning'?'pending':'success')}</td><td>${h(c.message)}</td></tr>`),'当前没有发现检查异常')+'<div class="book-section-gap"></div>'+actionbar('期间状态','')+table(['会计期间','状态'],book.periods.map(p=>`<tr><td>${h(p.period)}</td><td>${statusBadge(p.closed?'已结账':'未结账',p.closed?'success':'pending')}</td></tr>`));}

export function bindBook(container,ctx){
  const shell=container.querySelector('.cw-shell');if(!shell||bookBindings.has(shell))return;bookBindings.add(shell);
  const actions={
    perform:(action,id)=>performAction(action,Number(id),ctx),
    reportRange:(start,end)=>updateCompanyReportRange(container,start,end),
    view:view=>{if(!['home','vouchers','ledger','reports','accounts','assets','inventory','payroll','journals','period'].includes(view))return;activeView=view;repaint(container,ctx);},
    period:async period=>{if(!/^\d{4}-\d{2}$/.test(period))throw new Error('请选择有效的会计期间');if(period<book.client.start_period)throw new Error('所选期间早于建账期间');ctx.setBook(book.client.id,period);await ctx.reload();},
    company:async id=>{const client=ctx.clients.find(c=>Number(c.id)===id);const period=book.period<(client?.start_period||'')?client.start_period:book.period;ctx.setBook(id,period);await ctx.reload();},
    agency:nav=>ctx.navigateCompany?.(nav,book.client.id)
  };
  bindCompanyWorkspace(container,book,ctx,actions);
  if(activeView==='vouchers')bindCompanyVouchers(container,book,ctx,actions);
  else if(activeView==='ledger')bindCompanyBalance(container,book,ctx,actions);
  else if(activeView!=='home')bindBookContent(container,ctx);
}
function repaint(container,ctx){container.innerHTML=renderCompanyWorkspace(book,ctx,{view:activeView,content:renderView()});bindBook(container,ctx);}
function bindBookContent(container,ctx){container.querySelector('.book-content').querySelectorAll('[data-book-action]').forEach(el=>{if(!el.closest('[data-book-maintenance-scope]'))el.addEventListener('click',()=>performAction(el.dataset.bookAction,Number(el.dataset.id),ctx).catch(err=>ctx.toast(err.message,'error')));});container.querySelector('[data-ledger-account]')?.addEventListener('change',e=>{ledgerAccount=e.target.value;repaint(container,ctx);});bindMaintenance(container.querySelector('.book-content'),ctx);}
async function save(ctx,url,body,method='POST'){const r=await ctx.api(url,{method,body});ctx.toast('已保存');await ctx.reload();return r;}
function base(){return `/api/books/${book.client.id}`;}
function formObject(form){return Object.fromEntries(new FormData(form).entries());}
function displayError(error){return error?.message||String(error);}
async function confirm(ctx,title,content,fn){return ctx.modal(title,`<p>${h(content)}</p>`,async()=>{await fn();});}

async function performAction(action,id,ctx){
  switch(action){
    case 'back':if(ctx.closeBook)ctx.closeBook();else{window.dispatchEvent(new CustomEvent('close-book'));}return;
    case 'refresh':await ctx.reload();return;
    case 'print':window.print();return;
    case 'new-voucher':return voucherModal(ctx);
    case 'edit-voucher':return voucherModal(ctx,book.vouchers.find(v=>v.id===id));
    case 'review-voucher':{const v=book.vouchers.find(v=>v.id===id);return save(ctx,`${base()}/vouchers/${id}/review`,{version:v.version,reviewed:!v.reviewed});}
    case 'void-voucher':{const v=book.vouchers.find(v=>v.id===id);return confirm(ctx,'作废凭证',`确认作废 ${v.number}？记录会保留，关联业务凭证受来源规则约束。`,()=>save(ctx,`${base()}/vouchers/${id}`,{version:v.version},'DELETE'));}
    case 'cashflow-voucher':return cashflowModal(ctx,id);
    case 'withdraw-source':return withdrawSourceModal(ctx,id);
    case 'new-account':return newAccount(ctx);
    case 'opening':return openingModal(ctx);
    case 'new-asset':return assetModal(ctx);
    case 'depreciate':return confirm(ctx,'计提折旧',`为 ${book.period} 符合条件的资产计提折旧并生成凭证；已计提记录不会重复生成。`,()=>save(ctx,`${base()}/assets/depreciate`,{period:book.period}));
    case 'dispose-asset':return disposeModal(ctx,id);
    case 'asset-detail':return assetDetail(ctx,id);
    case 'new-item':return itemModal(ctx);
    case 'inventory-move':return movementModal(ctx);
    case 'new-payroll':return payrollModal(ctx);
    case 'delete-payroll':{const p=book.payroll.find(x=>x.id===id);return confirm(ctx,'删除未计提工资',`删除 ${p.employee_name} 的未计提工资后可重新录入，操作保留审计。`,()=>save(ctx,`${base()}/payroll/${id}`,{version:p.version},'DELETE'));}
    case 'post-payroll':return confirm(ctx,'工资计提',`根据 ${book.period} 工资记录生成计提凭证，已经计提的记录不会重复生成。`,()=>save(ctx,`${base()}/payroll/post`,{period:book.period}));
    case 'pay-payroll':return payPayrollModal(ctx);
    case 'new-journal':return journalModal(ctx);
    case 'post-journal':{const j=book.journals.find(j=>j.id===id);return postJournal(ctx,j);}
    case 'import-bank':return importBank(ctx);
    case 'close-period':return confirm(ctx,'本期结账',`结账 ${book.period} 并结转损益。系统会校验账务，存在阻断事项时不能结账。`,()=>save(ctx,`${base()}/close`,{period:book.period,version:book.periods.find(p=>p.period===book.period)?.version??0}));
    case 'reopen-period':return confirm(ctx,'反结账',`反结账 ${book.period}，重新开放该期间。后续已结账期间须先依次反结账；自动结转凭证按系统规则回退。`,()=>save(ctx,`${base()}/reopen`,{period:book.period,version:book.periods.find(p=>p.period===book.period)?.version??0}));
    default:throw new Error('操作入口未识别，请刷新后重试');
  }
}

function voucherLine(l={}){return `<tr class="voucher-line"><td><input class="voucher-summary" aria-label="分录摘要" maxlength="200" value="${h(l.summary||'')}" placeholder="同凭证摘要"></td><td><select class="voucher-account" aria-label="会计科目">${accountOptions(l.account_code||'')}</select></td><td><input class="voucher-debit" inputmode="decimal" aria-label="借方金额" value="${l.debit_fen?inputMoney(l.debit_fen):''}" placeholder="0.00"></td><td><input class="voucher-credit" inputmode="decimal" aria-label="贷方金额" value="${l.credit_fen?inputMoney(l.credit_fen):''}" placeholder="0.00"></td><td><select class="voucher-cf" aria-label="现金流活动">${CF.map(([v,n])=>`<option value="${v}" ${v===(l.cashflow_category||'unclassified')?'selected':''}>${n}</option>`).join('')}</select></td><td><button class="btn voucher-remove" type="button" aria-label="删除分录">移除</button></td></tr>`;}
function voucherModal(ctx,v=null){
  const prefix=base(), clientId=book.client.id, originalLines=v?.lines||[{},{}], originalPeriod=v?.date.slice(0,7);
  const dateAttrs=v?`required min="${originalPeriod}-01" max="${originalPeriod}-${new Date(Number(originalPeriod.slice(0,4)),Number(originalPeriod.slice(5)),0).getDate()}"`:'required';
  const pending=ctx.modal(v?'编辑凭证':'新增凭证',`<div class="form-grid">${field('date','凭证日期','date',v?.date||periodDate(),dateAttrs)}${field('summary','摘要','text',v?.summary||'','required maxlength="200"')}${field('attachment_count','附单据张数','number',v?.attachment_count||0,'required min="0" max="9999" step="1"')}</div>${v?'<p class="muted voucher-date-hint">编辑凭证仅限原月份；更换月份请先作废原凭证，再在目标月份新增。</p>':''}<div class="table-wrap voucher-editor"><table><colgroup><col class="voucher-col-summary"><col class="voucher-col-account"><col class="voucher-col-amount"><col class="voucher-col-amount"><col class="voucher-col-cashflow"><col class="voucher-col-actions"></colgroup><thead><tr><th>摘要</th><th>会计科目</th><th>借方金额</th><th>贷方金额</th><th>资金活动分类</th><th>操作</th></tr></thead><tbody id="voucher-lines">${originalLines.map(voucherLine).join('')}</tbody></table></div><div class="book-actions book-section-gap"><button class="btn" type="button" id="voucher-add-line">添加分录</button><span id="voucher-balance" class="muted"></span></div><p class="muted">金额保留两位小数，同一分录只填借方或贷方。现金、银行科目请选择活动分类，其他科目不参与现金流汇总。</p>`,async form=>{
    if(v&&form.elements.date.value.slice(0,7)!==originalPeriod)throw new Error('编辑凭证日期须在原月份内；如需更换月份，请先作废原凭证，再在目标月份新增');
    const lines=[...form.querySelectorAll('.voucher-line')].map(row=>({summary:row.querySelector('.voucher-summary').value.trim(),account_code:row.querySelector('.voucher-account').value,debit_fen:fen(row.querySelector('.voucher-debit').value),credit_fen:fen(row.querySelector('.voucher-credit').value),cashflow_category:row.querySelector('.voucher-cf').value})).filter(l=>l.account_code||l.debit_fen||l.credit_fen);
    if(lines.length<2)throw new Error('至少需要两条完整分录');
    if(lines.some(l=>!l.account_code||(l.debit_fen>0)===(l.credit_fen>0)))throw new Error('每条分录必须选择科目，借贷金额只能有一方大于零');
    if(lines.reduce((n,l)=>n+l.debit_fen-l.credit_fen,0)!==0)throw new Error('借贷金额不平衡，请检查后保存');
    const payload={...formObject(form),attachment_count:Number(form.elements.attachment_count.value),lines,...(v?{version:v.version}:{})};
    const saved=await ctx.api(v?`${prefix}/vouchers/${v.id}`:`${prefix}/vouchers`,{method:v?'PATCH':'POST',body:payload});
    const savedPeriod=payload.date.slice(0,7);
    focusCompanyVoucher(clientId,savedPeriod,saved.id);
    ctx.setBook(clientId,savedPeriod);
    setBookView('vouchers');
    ctx.toast('已保存');
    try{await ctx.reload();}catch(error){ctx.toast(`凭证已保存至 ${savedPeriod}，列表刷新失败，请点击刷新重新读取：${displayError(error)}`,'error');}
  },{wide:true});
  queueMicrotask(()=>{const form=document.querySelector('#app-modal-form');if(!form)return;const update=()=>{try{let d=0,c=0;form.querySelectorAll('.voucher-line').forEach(row=>{d+=fen(row.querySelector('.voucher-debit').value);c+=fen(row.querySelector('.voucher-credit').value);});const el=form.querySelector('#voucher-balance');el.textContent=`借方合计 ${money(d)}　贷方合计 ${money(c)}　差额 ${money(d-c)}`;el.className=d===c&&d>0?'book-ok':'book-warning';}catch(e){form.querySelector('#voucher-balance').textContent=displayError(e);}};form.querySelector('#voucher-add-line').addEventListener('click',()=>{form.querySelector('#voucher-lines').insertAdjacentHTML('beforeend',voucherLine());update();});form.addEventListener('click',e=>{if(e.target.closest('.voucher-remove')){if(form.querySelectorAll('.voucher-line').length<=2)return;e.target.closest('tr').remove();update();}});form.addEventListener('input',update);update();});
  return pending;
}
const REPORT_OPTIONS={asset:[['cash','货币资金'],['short_investment','短期投资'],['receivable','应收款项'],['prepaid','预付款项'],['inventory','存货'],['long_investment','长期投资'],['fixed_asset','固定资产净额'],['construction','在建工程'],['intangible','无形资产净额'],['other_asset','其他资产']],liability:[['short_debt','短期借款'],['payable','应付款项'],['advance','预收款项'],['payroll_payable','应付职工薪酬'],['tax_payable','应交税费'],['other_liability','其他负债'],['long_debt','长期负债']],equity:[['capital','实收资本及资本公积'],['retained','盈余公积及利润分配'],['current_profit','本年利润']],income:[['revenue','营业收入'],['investment_income','投资收益'],['other_income','其他收入']],expense:[['business_cost','营业成本'],['taxes','税金及附加'],['selling','销售费用'],['administration','管理费用'],['finance','财务费用'],['other_expense','其他支出'],['income_tax','所得税费用']],cost:[['inventory','存货及生产成本'],['construction','在建工程'],['other_asset','其他资产']]};
function nextChildCode(parentCode, accounts) {
  if (parentCode.length + 2 > 20) return '';
  const suffixes=accounts.map(a=>String(a.code)).filter(code=>code.startsWith(parentCode)&&code.length>parentCode.length).map(code=>code.slice(parentCode.length)).filter(suffix=>/^\d+$/.test(suffix)).map(suffix=>Number(suffix.slice(0,2).padEnd(2,'9')));
  const next=Math.max(0,...suffixes)+1;
  return next<=99 ? parentCode+String(next).padStart(2,'0') : '';
}
function newAccount(ctx){
  const parents=book.accounts.map(a=>[String(a.code),`${a.code} ${a.name}`]);
  const pending=ctx.modal('新增会计科目',`<div class="form-grid">${selectField('parent_code','上级科目',[['','请选择上级科目'],...parents,['__manual__','手工输入科目编码']])}${field('code','科目编码','text','','required pattern="[0-9]{4,20}"')}${field('name','科目名称','text','','required maxlength="80"')}${selectField('direction','余额方向',[['debit','借方'],['credit','贷方']],'debit')}${selectField('category','科目类别',[['asset','资产'],['liability','负债'],['equity','所有者权益'],['income','收入'],['cost','成本'],['expense','费用']],'asset')}${selectField('report_key','报表归类',REPORT_OPTIONS.asset,'other_asset')}</div><p class="muted" data-account-code-hint>选择上级科目后自动顺序编号，最终编码以保存结果为准。上级有业务余额或分录时禁止拆分。</p>`,async form=>{
    const parentCode=form.elements.parent_code.value;
    if(!parentCode)throw new Error('请选择上级科目或手工输入科目编码');
    if(parentCode!=='__manual__'){
      if(!form.elements.code.value)throw new Error('该上级科目的下级编码已用完或编码长度已达上限');
      const created=await ctx.api(`${base()}/accounts`,{method:'POST',body:{parent_code:parentCode,name:form.elements.name.value}});
      ctx.toast(`已保存，科目编码：${created.code}`);await ctx.reload();
    }else{
      const payload=formObject(form);delete payload.parent_code;
      await save(ctx,`${base()}/accounts`,payload);
    }
  });
  queueMicrotask(()=>{
    const form=document.querySelector('#app-modal-form');if(!form)return;
    const update=(parent=null)=>{const category=parent?.category||form.elements.category.value;form.elements.category.value=category;form.elements.report_key.innerHTML=REPORT_OPTIONS[category].map(([v,t])=>`<option value="${v}" ${v===parent?.report_key?'selected':''}>${h(t)}</option>`).join('');form.elements.direction.value=parent?.direction||(['liability','equity','income'].includes(category)?'credit':'debit');};
    const changeParent=()=>{
      const selected=form.elements.parent_code.value, manual=selected==='__manual__', parent=book.accounts.find(a=>String(a.code)===selected);
      form.elements.code.readOnly=!manual;form.elements.code.required=manual;form.elements.code.value=parent?nextChildCode(selected,book.accounts):'';
      for(const name of ['direction','category','report_key'])form.elements[name].disabled=!!parent;
      if(parent)update(parent);
      const hint=form.querySelector('[data-account-code-hint]');
      hint.textContent=parent&&!form.elements.code.value?'该上级科目的下级编码已用完或编码长度已达上限。':manual?'手工填写科目编码；明细科目应继承上级属性。':'选择上级科目后自动顺序编号，最终编码以保存结果为准。上级有业务余额或分录时禁止拆分。';
    };
    form.elements.category.addEventListener('change',()=>update());
    form.elements.code.addEventListener('change',()=>{if(form.elements.parent_code.value!=='__manual__')return;const code=form.elements.code.value;const parent=book.accounts.filter(a=>a.code!==code&&code.startsWith(a.code)).sort((a,b)=>b.code.length-a.code.length)[0];if(parent)update(parent);});
    form.elements.parent_code.addEventListener('change',changeParent);changeParent();
  });
  return pending;
}
export const subjectNumberTest={nextChildCode,newAccount};
function openingModal(ctx){const pending=ctx.modal('设置期初余额',`<p class="muted">仅用于新账套初始化。借方总额必须等于贷方总额；已有业务或已结账时按服务器锁定规则处理。</p><div class="table-wrap opening-editor"><table><thead><tr><th>科目</th><th>借方余额</th><th>贷方余额</th></tr></thead><tbody>${book.accounts.filter(isLeaf).map(a=>{const o=book.opening_balances.find(x=>x.account_code===a.code)||{};return `<tr data-opening-code="${h(a.code)}"><td>${h(a.code)} ${h(a.name)}</td><td><input class="opening-debit" inputmode="decimal" aria-label="${h(a.name)}期初借方" value="${inputMoney(o.debit_fen)}"></td><td><input class="opening-credit" inputmode="decimal" aria-label="${h(a.name)}期初贷方" value="${inputMoney(o.credit_fen)}"></td></tr>`;}).join('')}</tbody></table></div>`,async form=>{const balances=[...form.querySelectorAll('[data-opening-code]')].map(r=>({account_code:r.dataset.openingCode,debit_fen:fen(r.querySelector('.opening-debit').value),credit_fen:fen(r.querySelector('.opening-credit').value)}));if(balances.reduce((n,r)=>n+r.debit_fen-r.credit_fen,0)!==0)throw new Error('期初借贷不平衡');await save(ctx,`${base()}/opening`,{balances,version:book.opening_version});});return pending;}
function assetModal(ctx){const pending=ctx.modal('新增固定资产',`<div class="form-grid">${field('name','资产名称','text','','required')}${field('purchase_date','购置日期','date',periodDate(),'required')}${field('start_period','开始折旧期间（购置次月）','month',nextPeriod(book.period),'required readonly')}${field('cost','原值（元）','text','','required inputmode="decimal"')}${field('residual','预计净残值（元）','text','0.00','required inputmode="decimal"')}${field('life_months','使用月数','number','36','required min="1" max="1200"')}${accountField('expense_account','折旧费用科目',acctDefault('administration','管理费用'))}${accountField('asset_account','固定资产科目',acctDefault('fixed_asset','固定资产','1601'))}${accountField('depreciation_account','累计折旧科目',acctDefault('fixed_asset','累计折旧','1602'))}${accountField('counter_account','购置对方科目',acctDefault('cash','银行存款','1002'))}</div><p class="muted">保存卡片会同时生成购置凭证，请避免与手工录入凭证重复。</p>`,async form=>{const p=formObject(form);p.start_period=nextPeriod(p.purchase_date.slice(0,7));p.cost_fen=fen(p.cost);p.residual_fen=fen(p.residual);p.life_months=Number(p.life_months);delete p.cost;delete p.residual;await save(ctx,`${base()}/assets`,p);});queueMicrotask(()=>{const form=document.querySelector('#app-modal-form');if(!form)return;form.elements.purchase_date.addEventListener('change',()=>{if(/^\d{4}-\d{2}-\d{2}$/.test(form.elements.purchase_date.value))form.elements.start_period.value=nextPeriod(form.elements.purchase_date.value.slice(0,7));});});return pending;}
function disposeModal(ctx,id){const a=book.assets.find(x=>x.id===id);return ctx.modal('固定资产清理',`<p>${h(a.name)}　账面净值 ${money(a.net_fen)} 元</p><div class="form-grid">${field('date','清理日期','date',periodDate(),'required')}${field('proceeds','处置收款（元）','text','0.00','required inputmode="decimal"')}${accountField('bank_account','收款科目',acctDefault('bank','银行存款','1002'))}</div><p class="muted">自动生成原值、累计折旧及处置损益相关凭证，资产卡片保留为已清理。</p>`,async form=>{const p=formObject(form);p.proceeds_fen=fen(p.proceeds);delete p.proceeds;await save(ctx,`${base()}/assets/${id}/dispose`,{...p,version:a.version});});}
function itemModal(ctx){return ctx.modal('新增库存商品',`<div class="form-grid">${field('sku','商品编码','text','','required')}${field('name','商品名称','text','','required')}${field('unit','计量单位','text','件','required')}${accountField('inventory_account','库存科目',acctDefault('inventory','库存商品','1405'))}${accountField('cost_account','出库成本科目',acctDefault('cost','主营业务成本',book.client.standard==='small2013'?'5401':'6401'))}</div>`,async form=>save(ctx,`${base()}/inventory/items`,formObject(form)));}
function movementModal(ctx){if(!book.inventory_items.length)throw new Error('请先新增库存商品');const pending=ctx.modal('库存入库 / 出库',`<div class="form-grid">${selectField('item_id','商品',book.inventory_items.map(i=>[String(i.id),`${i.sku} ${i.name}（结存 ${i.quantity} ${i.unit}）`]))}${field('date','发生日期','date',periodDate(),'required')}${selectField('direction','业务方向',[['in','采购入库'],['out','成本出库']],'in')}${field('quantity','数量','text','','required inputmode="decimal"')}${field('amount','入库总成本（元，出库时无需填写）','text','','inputmode="decimal"')}${accountField('counter_account','入库对方科目',acctDefault('payables','应付账款','2202'))}</div><p class="muted">出库自动计算加权平均成本并结转到商品的成本科目，不处理销售收入。收入可通过销售票据或凭证另行登记。</p>`,async form=>{const p=formObject(form),item=book.inventory_items.find(i=>i.id===Number(p.item_id));p.item_id=Number(p.item_id);p.version=item.version;p.amount_fen=p.direction==='in'?fen(p.amount):0;delete p.amount;await save(ctx,`${base()}/inventory/movements`,p);});return pending;}
function payrollModal(ctx){return ctx.modal('新增工资记录',`<div class="form-grid">${field('period','所属期间','month',book.period,'required')}${field('employee_name','员工姓名','text','','required')}${field('gross','应发工资（元）','text','','required inputmode="decimal"')}${field('withheld_tax','代扣个税（元）','text','0.00','inputmode="decimal"')}${field('social','个人社保（元）','text','0.00','inputmode="decimal"')}${field('other_deduction','其他扣款（元）','text','0.00','inputmode="decimal"')}${accountField('expense_account','工资费用科目',acctDefault('admin_expense','管理费用'))}</div><p class="muted">实发 = 应发 − 代扣个税 − 个人社保 − 其他扣款。税款按会计确认金额录入。</p>`,async form=>{const p=formObject(form);for(const k of ['gross','withheld_tax','social','other_deduction']){p[`${k}_fen`]=fen(p[k]);delete p[k];}await save(ctx,`${base()}/payroll`,p);});}
async function postJournal(ctx,j){
 const url=`${base()}/journals/${j.id}/post`;
 try{return await save(ctx,url,{version:j.version});}
 catch(error){
  if(error.details?.code!=='possible_duplicate')throw error;
  const candidates=error.details.candidates||[];
  const rows=candidates.map(c=>`<tr><td>${h(c.date)}</td><td>${h(c.number)} #${h(c.voucher_id)}</td><td>${h(c.source_type)}</td><td>${h(c.summary||'—')}</td><td>${h(c.counter_accounts||'—')}</td></tr>`);
  return ctx.modal('可能存在重复流水',`<p>发现日期、金额、资金科目和收支方向相同的凭证。请先核对这些凭证，确认属于不同流水后填写说明。</p>${table(['日期','凭证','来源','摘要','对方科目'],rows)}<label class="field"><span>核验说明</span><textarea name="duplicate_review_note" required maxlength="500" rows="3"></textarea></label>`,async form=>{const note=form.elements.duplicate_review_note.value.trim();if(!note)throw new Error('请填写核验说明');await save(ctx,url,{version:j.version,duplicate_review_note:note});});
 }
}
function journalModal(ctx){return ctx.modal('新增资金流水',`<div class="form-grid">${field('date','发生日期','date',periodDate(),'required')}${field('summary','摘要','text','','required')}${selectField('direction','收支方向',[['income','收入'],['expense','支出']],'income')}${field('amount','金额（元）','text','','required inputmode="decimal"')}${accountField('bank_account','资金科目',acctDefault('bank','银行存款','1002'))}${accountField('counter_account','对方科目','')}${selectField('cashflow_category','现金流活动分类',CF,'unclassified')}</div>`,async form=>{const p=formObject(form);p.amount_fen=fen(p.amount);delete p.amount;await save(ctx,`${base()}/journals`,p);});}
async function importBank(ctx){const file=await chooseFile('.csv');if(!file)return;const b64=await fileBase64(file);const result=await ctx.api('/api/import/bank',{method:'POST',body:{client_id:book.client.id,filename:file.name,content_base64:b64}});ctx.toast(`已导入 ${Number(result.imported||0)} 条流水`);await ctx.reload();}
function chooseFile(accept){return new Promise(resolve=>{const el=document.createElement('input');el.type='file';el.accept=accept;el.addEventListener('change',()=>resolve(el.files?.[0]||null),{once:true});el.addEventListener('cancel',()=>resolve(null),{once:true});el.click();});}
function fileBase64(file){if(file.size>10*1024*1024)throw new Error('文件不得超过 10MB');return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('读取文件失败'));reader.readAsDataURL(file);});}

export const financeUiTest = {fen,escape:h,selected:scope=>[...maintenanceState(scope).selected]};

function cashflowModal(ctx,id){
  const v=book.vouchers.find(x=>x.id===id), cashLines=v.lines.filter(l=>book.accounts.find(a=>a.code===l.account_code)?.report_key==='cash');
  if(!cashLines.length)throw new Error('这张凭证没有货币资金分录，无需现金流分类');
  return ctx.modal('资金活动分类',`<p>${h(v.number)} ${h(v.summary)}</p><div class="form-grid">${cashLines.map(l=>selectField('cf_'+l.id,`${l.account_code} ${l.account_name}（借 ${money(l.debit_fen)} / 贷 ${money(l.credit_fen)}）`,CF,l.cashflow_category||'unclassified')).join('')}</div><p class="muted">仅修改现金流分类，不修改会计分录金额。已结账期间不可修改。</p>`,async form=>save(ctx,`${base()}/vouchers/${id}/cashflow`,{version:v.version,classifications:cashLines.map(l=>({line_id:l.id,category:form.elements['cf_'+l.id].value}))}));
}
function payPayrollModal(ctx){return ctx.modal('登记工资发放',`<div class="form-grid">${field('period','所属期间','month',book.period,'required')}${field('date','发放日期','date',periodDate(),'required')}${accountField('bank_account','发放资金科目',acctDefault('bank','银行存款','1002'))}</div><p class="muted">为本期已计提工资生成发放凭证，实际向员工转账需在银行办理。已登记发放的记录不会重复记账。</p>`,async form=>save(ctx,`${base()}/payroll/pay`,formObject(form)));}

function withdrawSourceModal(ctx,id){const v=book.vouchers.find(x=>x.id===id);return ctx.modal('撤回来源凭证',`<p>${h(v.number)} ${h(v.summary)}</p><p class="muted">仅未审核、未结账且无后续依赖的来源凭证允许撤回。原凭证和审计保留，来源记录按业务规则恢复到可处理状态。</p><label class="field"><span>撤回原因</span><textarea name="reason" required maxlength="500" rows="3"></textarea></label>`,async form=>save(ctx,`${base()}/vouchers/${id}/withdraw`,{version:v.version,reason:form.elements.reason.value}));}

function assetDetail(ctx,id){
  const a=book.assets.find(x=>x.id===id),records=a.depreciations||[],scope=`depreciations_${id}`;
  const definition={title:'折旧记录',label:'撤回选中折旧',hint:'按所选最近月份起撤回，包含0分记录。已审核、锁期、未选中的后续折旧或资产处置会阻止撤回；不会自动取消审核。',records:records.map(r=>maintenanceRecord(r,`${a.name} · ${r.period} · 折旧 ${money(r.amount_fen)} 元`,{method:'POST',path:`assets/${id}/depreciations/${r.period}/withdraw`,body:{version:a.version},label:'撤回折旧并回退对应凭证；审计保留'},{versionGroup:`asset_${id}`,order:-Number(r.period.replace('-',''))}))};
  const content=`<p>${h(a.name)} · 截至 ${h(book.period)} 的折旧记录</p>${managedTable(table(['期间','折旧额','关联凭证'],records.map(r=>`<tr><td>${h(r.period)}</td><td class="number">${money(r.amount_fen)}</td><td>${r.voucher_id?'#'+r.voucher_id:'0分折旧，无凭证'}</td></tr>`),'暂无折旧记录'),scope,definition)}`;
  const pending=ctx.modal('资产折旧明细',content);
  queueMicrotask(()=>bindMaintenance(document.querySelector('#app-modal-form'),ctx));
  return pending;
}
