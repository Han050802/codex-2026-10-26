/* Company pages share the workbench database; all amounts are integer fen. */
const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => (Number(n || 0)/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const labels = {home:'首页',vouchers:'查看凭证',ledger:'余额表',reports:'财务报表',accounts:'科目与期初',assets:'固定资产',inventory:'进销台账',payroll:'工资管理',journals:'资金日记账',period:'期末处理'};
const paths = {
 home:'m2.5 8 7.5-6 7.5 6M4.5 6.5v10a1 1 0 0 0 1 1H8v-5h4v5h2.5a1 1 0 0 0 1-1v-10',
 book:'M5.5 2.5h10a1 1 0 0 1 1 1v14h-11a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Zm1 0v12M3.5 15.5a2 2 0 0 1 2-2h11M9.5 6h4M9.5 9h4',
 chart:'M3 2.5v14a1 1 0 0 0 1 1h13.5M6.5 14V11M10.5 14V7.5M14.5 14V4M5.5 7.5l4-3 4 1 4-3',
 money:'M6 3h8l-2 3H8L6 3Zm2 3c-1.5 1.6-4.5 4-4.5 7.5 0 2.8 2 4 6.5 4s6.5-1.2 6.5-4C16.5 10 13.5 7.6 12 6M7.5 10l2.5 2 2.5-2M7.5 12.5h5M7.5 14.5h5M10 12v4',
 building:'M3.5 17.5v-13l8-2v15M11.5 7h5v10.5M2 17.5h16M6.5 6.5h2M6.5 9.5h2M6.5 12.5h2M6.5 17.5v-2h2v2M14 10h.5M14 13h.5',
 receipt:'M4 2.5h12v15l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5v-15ZM7 6h6M7 9h6M7 12h2M12 12h1',
 payroll:'M11.5 17.5h-7a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v5M6.5 6h5M6.5 9h2.5M6.5 12H8M18 14a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm-5.5-1.5L14 14l1.5-1.5M12.5 15h3M14 14v2.5',
 shield:'m10 2 6.5 2.5v5c0 4.1-3 6.9-6.5 8.5-3.5-1.6-6.5-4.4-6.5-8.5v-5L10 2ZM7 10l2 2 4-4',
 cube:'m10 2.5 7 4v7l-7 4-7-4v-7l7-4Zm-7 4 7 4 7-4M10 10.5v7M6.5 4.5l7 4v3',
 archive:'M3 3.5h14a.5.5 0 0 1 .5.5v3H2.5V4a.5.5 0 0 1 .5-.5ZM4 7v9.5a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7M7.5 10h5M8.5 13h3',
 gear:'M8.3 2.5h3.4l.4 2 1.5.9 1.9-.7 1.7 3-1.5 1.3v2l1.5 1.3-1.7 3-1.9-.7-1.5.9-.4 2H8.3l-.4-2-1.5-.9-1.9.7-1.7-3L4.3 11V9L2.8 7.7l1.7-3 1.9.7 1.5-.9.4-2ZM13 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
 video:'M3.5 4h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM14.5 8l3-2v8l-3-2M7 7l4 3-4 3V7Z',
 support:'M3.5 10V9a6.5 6.5 0 0 1 13 0v4M4 9H3a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h2V9H4Zm12 0h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-2V9h1ZM16 14v1a2 2 0 0 1-2 2h-2M9 16.5h3v1H9v-1Z',
 user:'M13.25 6.5a3.25 3.25 0 1 1-6.5 0 3.25 3.25 0 0 1 6.5 0ZM3.5 17v-1a4.5 4.5 0 0 1 4.5-4.5h4a4.5 4.5 0 0 1 4.5 4.5v1',
 clipboard:'M7 4H4.5a1 1 0 0 0-1 1v11.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H13M8 2.5h4a1 1 0 0 1 1 1V5H7V3.5a1 1 0 0 1 1-1ZM6.5 11l2.5 2.5 4.5-5',
 document:'M11.5 2.5h-7a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-9l-5-5Zm0 0v5h5M6.5 10.5h7M6.5 13.5h5',
 calendar:'M4 4h12a1 1 0 0 1 1 1v11.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM6.5 2v4M13.5 2v4M3 8h14M6.5 11h1M12.5 11h1M6.5 14h1M12.5 14h1',
 expand:'M3 7V3h4M13 3h4v4M3 13v4h4M13 17h4v-4',
 close:'m5 5 10 10M15 5 5 15',
 pie:'M8 2.5a7.5 7.5 0 1 0 9.5 9.5H8V2.5ZM11 2.5V9h6.5A7.5 7.5 0 0 0 11 2.5Z',
 bank:'m2.5 6.5 7.5-4 7.5 4v1h-15v-1ZM4.5 10v4.5M8 10v4.5M12 10v4.5M15.5 10v4.5M3 17.5h14M4 15h12',
 feather:'M3 16.5c5-1 9.5-3 12-6.5 1.5-2 2-4.5 2-8-3.5 1.2-7 3.5-9.5 6.5-2 2.5-3 5.5-2.5 7.5M2.5 18l11-11.5M6.5 13.5l5.5-.5M9 10.5l5-1M10.5 9V6',
 bell:'M6 7a4 4 0 0 1 8 0v3.5l2 3H4l2-3V7ZM8 16.5a2.2 2.2 0 0 0 4 0M10 2V1',
 collapse:'M3 3h14v14H3V3ZM13 3v14M9 6.5 5.5 10 9 13.5',
 settlement:'M13 17.5H5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1V9M7 6h6M7 9h3M11 14l2 2 4.5-5',
 member:'m10 2 2.2 4.8 5.3.7-3.9 3.7.9 5.3-4.5-2.6-4.5 2.6.9-5.3L2.5 7.5l5.3-.7L10 2Z',
 chevronUp:'m5.5 12.25 4.5-4.5 4.5 4.5',
 chevronDown:'m5.5 7.75 4.5 4.5 4.5-4.5',
 info:'M10 9v5M10 6v.1M17.5 10a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z',
 check:'m4 10 4 4 8-8',
};
export function companyIcon(name){return `<svg class="cw-icon" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${paths[name]||paths.book}"/></svg>`;}
const nav = [['快捷导航','home','quick'],['总账','book','general'],['报表中心','chart','reports'],['资金管理','money','journals'],['固定资产','building','assets'],['工资管理','payroll','payroll'],['发票管理','receipt','invoices'],['进销台账','archive','inventory'],['税务管理','money','tax'],['财税合规','shield','compliance'],['行业化','cube','industry'],['结账','settlement','period'],['归档管理','archive','archive'],['设置','gear','settings'],['新手引导','video','guide'],['畅会员','member','member']];
let collapsed=false;

function periodRail(book,view){
  const year=Number(book.period.slice(0,4)),month=Number(book.period.slice(5));
  const previousYearDisabled=year<=Number(book.client.start_period.slice(0,4));
  const range=book.period.replace('-','.');
  const months=[12,1,2,3,4,5,6,7,8,9,10,11];
  return `<aside class="cw-period-rail ${view==='ledger'?'cw-balance-rail':''}" aria-label="期间选择"><div class="cw-rail-label">期间选择</div><div class="cw-period-range" role="status" aria-live="polite" aria-atomic="true" aria-label="当前查询期间：${h(range)}至${h(range)}"><span data-cw-range-start>${h(range)}</span><span data-cw-range-end>${h(range)}</span></div><div class="cw-rail-months"><span class="cw-rail-year">${year}</span><button type="button" class="cw-arrow" data-cw-year="-1" aria-label="上一年度" title="${previousYearDisabled?'已到建账年度':'上一年度'}" ${previousYearDisabled?'disabled':''}>${companyIcon('chevronUp')}</button>${months.map(m=>{const p=`${year}-${String(m).padStart(2,'0')}`,closed=book.periods?.some(r=>r.period===p&&r.closed);return `<button type="button" data-cw-month="${p}" ${p<book.client.start_period?'disabled':''} class="${m===month?'active':''}" aria-current="${m===month?'date':'false'}">${String(m).padStart(2,'0')}月${closed?`<span class="cw-month-check" aria-label="已结账" title="已结账">${companyIcon('check')}</span>`:''}</button>`;}).join('')}<button type="button" class="cw-arrow" data-cw-year="1" aria-label="下一年度" title="下一年度">${companyIcon('chevronDown')}</button></div></aside>`;
}

export function updateCompanyReportRange(container,start,end){
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(start)||!/^\d{4}-(0[1-9]|1[0-2])$/.test(end))return false;
  const shell=container.matches?.('.cw-shell')?container:container.querySelector('.cw-shell');
  const range=shell?.querySelector('.cw-period-range');
  const startNode=range?.querySelector('[data-cw-range-start]'),endNode=range?.querySelector('[data-cw-range-end]');
  if(!startNode||!endNode)return false;
  startNode.textContent=start.replace('-','.');
  endNode.textContent=end.replace('-','.');
  range.setAttribute('aria-label',`当前查询期间：${startNode.textContent}至${endNode.textContent}`);
  return true;
}

export function renderCompanyWorkspace(book,ctx,{view='home',content=''}){
  const company=book.client,legacy=!['home','vouchers','ledger'].includes(view),rail=['vouchers','ledger'].includes(view);
  return `<section class="cw-shell ${collapsed?'cw-collapsed':''}" aria-label="企业工作台"><aside class="cw-sidebar"><div class="cw-brand">${companyIcon('feather')}<span>畅捷通易代账</span></div><nav class="cw-side-nav" aria-label="企业账套导航">${nav.map(([label,icon,key])=>`<button type="button" class="cw-nav-item" data-cw-nav="${key}">${companyIcon(icon)}<span>${label}</span></button>`).join('')}</nav><div class="cw-side-bottom"><button type="button" data-cw-nav="settings" aria-label="账套设置">${companyIcon('gear')}</button><button type="button" data-cw-action="collapse" aria-label="收起导航">${companyIcon('collapse')}</button></div></aside>
  <header class="cw-header"><button type="button" class="cw-company-button" data-cw-action="companies" aria-expanded="false"><span>${h(company.name)}</span><span class="cw-chevron">${companyIcon('chevronDown')}</span></button><button type="button" class="cw-workbench" data-cw-action="back">工作台</button><div class="cw-header-period">${companyIcon('calendar')}<span>账期</span><label class="cw-header-month"><span>${book.period.replace('-','')}</span><input type="month" data-cw-period value="${h(book.period)}" min="${h(company.start_period)}" aria-label="会计期间"></label></div><span class="cw-header-spacer"></span><button type="button" class="cw-course-link" data-cw-help="学习课程"><span class="cw-bell">${companyIcon('bell')}</span>【系列课程】让财务技能“卷”出</button><button type="button" class="cw-header-service" data-cw-help="在线客服">${companyIcon('support')}在线客服</button><button type="button" class="cw-header-user" data-cw-help="账号信息"><span class="cw-avatar">${companyIcon('user')}</span>${h(ctx.user?.name||'用户')}</button></header>
  <nav class="cw-tabs" aria-label="当前页面"><button type="button" class="cw-tab ${view==='home'?'active':''}" data-cw-view="home">首页</button>${view!=='home'?`<button type="button" class="cw-tab active" data-cw-view="${view}">${h(labels[view]||view)}<span class="cw-tab-close" data-cw-action="home" aria-label="关闭当前页面">${companyIcon('close')}</span></button>`:''}<span class="cw-tab-end">${view!=='home'?`<button type="button" data-cw-view="home" aria-label="关闭页面">${companyIcon('close')}</button>`:''}<button type="button" data-cw-action="fullscreen" aria-label="全屏显示">${companyIcon('expand')}</button></span></nav>
  <div class="cw-stage ${rail?'cw-has-period':''} ${view==='ledger'?'cw-ledger-stage':''}"><div class="cw-content book-content ${legacy?'cw-legacy':''}">${content}</div>${rail?periodRail(book,view):''}</div>${view==='home'?`<div class="cw-home-dock"><button type="button" class="cw-turq" data-cw-action="home-settings">首页<br>设置</button><button type="button" data-cw-help="关注有礼">关注<br>有礼</button><button type="button" class="cw-stack" data-cw-help="桌面快捷">桌面<br>快捷</button><button type="button" class="cw-stack" data-cw-help="立即导账">立即<br>导账</button><button type="button" class="cw-stack cw-last" data-cw-help="电脑端">电脑<br>端</button></div>`:''}</section>`;
}

export function renderCompanyHome(book){
  const d=book.dashboard||{},f=d.funds||{},invoices=d.invoices||{},input=invoices.input||{},output=invoices.output||{},period=book.period.replace('-','/');
  const bankRows=(book.trial_balance||[]).filter(r=>r.account_code.startsWith('1002')&&r.is_leaf&&(r.closing_debit_fen||r.closing_credit_fen)).slice(0,5);
  const bars=Array.from({length:5},(_,i)=>{const r=bankRows[i],value=r?Number(r.closing_debit_fen)-Number(r.closing_credit_fen):0;return `<div class="cw-bank-bar" title="${h(r?.account_name||'银行存款')}"><i></i><b></b><span>¥${money(value)}</span></div>`;}).join('');
  const tile=(label,value,count,caption)=>`<div class="cw-asset-tile"><div><div class="cw-asset-label">${label}</div><button type="button" class="cw-asset-amount cw-number-link" data-cw-view="ledger" aria-label="查看${label}余额表" title="点击查看余额表">¥${money(value)}</button><div class="cw-asset-caption">余额</div></div>${count!==undefined?`<div class="cw-asset-count"><button type="button" class="cw-asset-count-value cw-number-link" data-cw-view="ledger" aria-label="查看${label}往来科目余额" title="点击查看余额表">${Number(count||0)}</button><div class="cw-asset-caption">${caption}</div></div>`:''}</div>`;
  const net=Number(book.reports?.cash_flow?.net_fen||0);
  return `<div class="cw-home-page"><div class="cw-home-title">代账数据首页<button type="button" class="cw-tiny-down" data-cw-action="home-settings" aria-label="首页显示设置">${companyIcon('chevronDown')}</button></div><div class="cw-home-cards"><section class="cw-home-card"><h2 class="cw-card-title">凭证(${period})</h2><div class="cw-voucher-stats"><div><div class="cw-stat-label">总数</div><button type="button" class="cw-stat-value cw-number-link" data-cw-view="vouchers" aria-label="点击凭证总数查看凭证" title="点击查看凭证">${Number(d.voucher_count||0)}<small>张</small></button></div><div><div class="cw-stat-label">附件</div><button type="button" class="cw-stat-value cw-number-link" data-cw-view="vouchers" aria-label="点击附件张数查看凭证" title="点击查看凭证">${Number(d.attachment_count||0)}<small>张</small></button></div></div><div class="cw-home-card-actions"><button type="button" data-cw-new-voucher>新增凭证</button><button type="button" class="cw-outline" data-cw-view="ledger">余额表</button></div></section>
  <section class="cw-home-card cw-invoice-card"><h2 class="cw-card-title">发票(${period})</h2><button type="button" class="cw-invoice-line" data-cw-nav="invoices"><span>进项</span><span>${Number(input.count||0)} 张</span><span>¥${money(input.total_fen)}</span></button><button type="button" class="cw-invoice-line" data-cw-nav="invoices"><span>销项</span><span>${Number(output.count||0)} 张</span><span>¥${money(output.total_fen)}</span></button><div class="cw-taxes"><div><div class="cw-taxes-label">增值税税负</div><div class="cw-taxes-number cw-dash">--</div></div><div><div class="cw-taxes-label">应交税额</div><div class="cw-taxes-number">${money(d.tax_payable_fen)}<small>元</small></div></div></div></section>
  <section class="cw-home-card cw-help-card"><h2 class="cw-help-title">帮助中心</h2><div class="cw-help-buttons">${[['clipboard','新手入门'],['video','视频学习'],['document','帮助中心'],['support','在线客服']].map(([icon,label])=>`<button type="button" class="cw-help-button" data-cw-help="${label}"><span>${companyIcon(icon)}</span><span>${label}</span></button>`).join('')}</div></section></div>
  <section class="cw-funds-card" data-cw-card="funds"><div class="cw-funds-heading">${companyIcon('pie')}资金情况<button type="button" data-cw-help="资金情况" aria-label="资金情况说明">${companyIcon('info')}</button></div><div class="cw-funds-grid"><button type="button" class="cw-bank-summary" data-cw-view="ledger"><div class="cw-bank-total">${companyIcon('bank')} 银行存款<strong>¥${money(f.bank_fen)}</strong></div><div class="cw-bank-bars">${bars}</div></button>${tile('库存现金',f.cash_fen)}${tile('应收账款',f.receivable_fen,f.receivable_account_count,'客户数')}${tile('应付账款',f.payable_fen,f.payable_account_count,'供应商数')}</div></section>
  <section class="cw-cash-card" data-cw-card="cash"><h3>现金流&amp;应收</h3><div class="cw-cash-grid"><div><strong>现金银行(${period})</strong><div class="cw-chart-zero" data-cw-amount="¥${money(net)}"></div></div><div><strong>应收账款</strong><button type="button" class="cw-cash-value cw-number-link" data-cw-view="ledger" aria-label="查看应收账款余额表">¥${money(f.receivable_fen)}</button></div><div><strong>流动性指标(${period})</strong><button type="button" class="cw-cash-value cw-number-link" data-cw-view="ledger" aria-label="查看现金银行余额表">¥${money(Number(f.bank_fen||0)+Number(f.cash_fen||0))}</button></div></div></section></div>`;
}

const menus={quick:[['公司首页','home'],['查看凭证','vouchers'],['余额表','ledger']],general:[['新增凭证','new-voucher','action'],['查看凭证','vouchers'],['余额表','ledger'],['科目与期初','accounts']],reports:[['余额表','ledger'],['财务报表','reports']],settings:[['科目与期初','accounts'],['新增会计科目','new-account','action'],['录入期初余额','opening','action']],archive:[['凭证归档与导出','vouchers'],['余额表导出','ledger']],industry:[['进销台账','inventory'],['工资管理','payroll']]};
function help(ctx,title,book){
  const messages={
    '资金情况':'银行存款、库存现金、应收及应付余额从本科目期末余额汇总。客户数、供应商数按有余额的明细往来科目统计。点击余额表可逐科目核对。',
    '账号信息':`当前操作员：${ctx.user?.name||'用户'}。账套：${book.client.name}。可从顶部“工作台”返回并在“设置”中维护账号。`,
    '桌面快捷':'可在浏览器菜单中将当前本地工作台创建为桌面快捷方式，或双击项目文件夹中的 start.cmd / demo.cmd 打开。',
    '立即导账':'凭证页“导入/导出”可下载凭证模板并导入 CSV；余额表可在“全部科目”菜单中录入期初余额。',
    '电脑端':'当前即为电脑浏览器工作台，同一局域网中的其他电脑可访问服务器地址使用。',
    '关注有礼':'本地工作台的功能已在当前页面提供，可直接使用，无需关注或领取权益。',
  };
  return ctx.modal(title,`<p>${h(messages[title]||'点击“新增凭证”录入日期、摘要、科目和借贷金额；在余额表的“全部科目”菜单新增科目、录入期初余额。点击顶部公司名称可切换账套，右侧月份栏可切换期间。')}</p>`);
}

export function bindCompanyWorkspace(container,book,ctx,actions){
  const shell=container.querySelector('.cw-shell');if(!shell)return;
  const report=e=>ctx.toast(e?.message||String(e),'error');
  shell.querySelector('[data-cw-period]')?.addEventListener('change',e=>{if(/^\d{4}-\d{2}$/.test(e.target.value))Promise.resolve(actions.period(e.target.value)).catch(report);});
  shell.addEventListener('click',event=>{
    const control=event.target.closest('[data-cw-action],[data-cw-view],[data-cw-nav],[data-cw-help],[data-cw-month],[data-cw-year],[data-cw-company],[data-cw-new-voucher]');
    if(!control||control.disabled)return;event.preventDefault();
    const run=async()=>{
      if(control.hasAttribute('data-cw-new-voucher')){actions.view('vouchers');return actions.perform('new-voucher');}
      if(control.dataset.cwAction==='home')return actions.view('home');
      if(control.dataset.cwView){shell.querySelector('.cw-nav-popover')?.remove();return actions.view(control.dataset.cwView);}
      if(control.dataset.cwHelp)return help(ctx,control.dataset.cwHelp,book);
      if(control.dataset.cwMonth)return actions.period(control.dataset.cwMonth);
      if(control.dataset.cwYear){const p=`${Number(book.period.slice(0,4))+Number(control.dataset.cwYear)}${book.period.slice(4)}`;return actions.period(p<book.client.start_period?book.client.start_period:p);}
      if(control.dataset.cwCompany)return actions.company(Number(control.dataset.cwCompany));
      if(control.dataset.cwNav){
        const key=control.dataset.cwNav;if(menus[key]){const old=shell.querySelector('.cw-nav-popover');if(old?.dataset.menu===key){old.remove();return;}old?.remove();const menu=document.createElement('div');menu.className='cw-nav-popover';menu.dataset.menu=key;menu.style.top=`${Math.min(control.getBoundingClientRect().top,window.innerHeight-240)}px`;menu.innerHTML=`<strong>${h(nav.find(r=>r[2]===key)?.[0])}</strong>${menus[key].map(([label,value,kind])=>`<button type="button" ${kind==='action'?`data-book-action="${value}"`:`data-cw-view="${value}"`}>${h(label)}</button>`).join('')}`;menu.addEventListener('click',e=>{const b=e.target.closest('[data-book-action]');if(b){e.stopPropagation();menu.remove();Promise.resolve(actions.perform(b.dataset.bookAction)).catch(report);}});shell.append(menu);return;}
        if(['invoices','tax','compliance'].includes(key))return actions.agency({invoices:'票据',tax:'报税',compliance:'合规'}[key]);
        if(['guide','member'].includes(key))return help(ctx,key==='guide'?'新手入门':'功能说明',book);
        return actions.view(key);
      }
      switch(control.dataset.cwAction){
        case 'back':return ctx.closeBook();
        case 'collapse':collapsed=!collapsed;shell.classList.toggle('cw-collapsed',collapsed);return;
        case 'fullscreen':if(document.fullscreenElement)await document.exitFullscreen();else await shell.requestFullscreen();return;
        case 'companies':{
          const existing=shell.querySelector('.cw-company-popover');if(existing){existing.remove();control.setAttribute('aria-expanded','false');return;}
          const panel=document.createElement('div');panel.className='cw-company-popover';
          panel.innerHTML='<input type="search" aria-label="搜索公司" placeholder="输入公司名称搜索"><div class="cw-company-list"></div><div class="cw-company-popover-footer"><span>切换客户账套</span><button type="button" data-cw-action="back">返回工作台</button></div>';
          const paint=q=>{const list=(ctx.clients||[]).filter(c=>!c.deleted&&c.enabled!==0&&c.name.toLowerCase().includes(q.toLowerCase()));panel.querySelector('.cw-company-list').innerHTML=list.map(c=>`<button type="button" data-cw-company="${c.id}" class="cw-company-option ${Number(c.id)===Number(book.client.id)?'selected':''}"><span>${h(c.name)}</span><small>${c.taxpayer_type==='general'?'一般纳税人':'小规模纳税人'}</small></button>`).join('')||'<p class="cw-company-empty">没有匹配的公司</p>';};
          panel.querySelector('input').addEventListener('input',e=>paint(e.target.value));shell.append(panel);paint('');control.setAttribute('aria-expanded','true');panel.querySelector('input').focus();return;
        }
        case 'home-settings':return ctx.modal('首页设置','<p>选择首页显示的内容：</p><label class="cw-setting-check"><input type="checkbox" name="funds" checked> 资金情况</label><label class="cw-setting-check"><input type="checkbox" name="cash" checked> 现金流与应收</label>',async form=>{for(const name of ['funds','cash']){const card=shell.querySelector(`[data-cw-card="${name}"]`);if(card)card.hidden=!form.elements[name].checked;}});
      }
    };Promise.resolve(run()).catch(report);
  });
  shell.addEventListener('keydown',event=>{if(event.key==='Escape'){shell.querySelector('.cw-company-popover')?.remove();shell.querySelector('.cw-nav-popover')?.remove();shell.querySelector('[data-cw-action="companies"]')?.setAttribute('aria-expanded','false');}});
}
