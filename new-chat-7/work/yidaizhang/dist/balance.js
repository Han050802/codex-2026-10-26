(function(){
'use strict';
const SEED=[
 {code:'1001',name:'库存现金',amount:0},
 {code:'1002',name:'银行存款',amount:95105.07},
 {code:'100201',name:'银行存款_人民币基本账户',amount:95105.07,parent:'1002',auxiliary:true},
 {code:'1003',name:'存放中央银行款项',amount:0,disabled:true},
 {code:'1122',name:'应收账款',amount:1891103.04,group:true},
 {code:'112206',name:'北京城建集团有限责任公司',amount:1891103.04,parent:'1122'},
 {code:'1123',name:'预付账款',amount:255744,group:true},
 {code:'112301',name:'广州书云燕熙国际旅行社有限公司',amount:30464,parent:'1123'},
 {code:'112302',name:'中企鸿昌（北京）管理咨询有限公司',amount:4800,parent:'1123'},
 {code:'112303',name:'北京卓越蓝科商贸有限公司',amount:48130,parent:'1123'},
 {code:'112304',name:'北京望京铂林眼科诊所有限公司',amount:5400,parent:'1123'},
 {code:'112305',name:'北京慢客档管理咨询有限公司',amount:7900,parent:'1123'},
 {code:'112306',name:'北京市海淀区私立新东方学校',amount:18050,parent:'1123'},
 {code:'112307',name:'北京大雁签证科技有限公司',amount:800,parent:'1123'},
 {code:'112308',name:'北京企鸿达企业管理有限公司',amount:4000,parent:'1123'},
 {code:'112309',name:'宜昌市欧旺科技有限公司',amount:5000,parent:'1123'},
 {code:'112315',name:'北京欧亚凯盛贸易有限公司',amount:13200,parent:'1123'},
 {code:'112316',name:'北京超建邦科技有限公司',amount:118000,parent:'1123'},
 {code:'1221',name:'其他应收款',amount:10000,group:true},
 {code:'122101',name:'备用金',amount:10000,parent:'1221'},
 {code:'1601',name:'固定资产',amount:23200},
 {code:'1602',name:'累计折旧',amount:8568,credit:true},
 {code:'2202',name:'应付账款',amount:27860,credit:true,group:true},
 {code:'220201',name:'中国电信股份有限公司北京分公司',amount:27860,credit:true,parent:'2202'},
 {code:'2221',name:'应交税费',amount:1536.48,credit:true},
 {code:'4001',name:'实收资本',amount:1000000,credit:true},
 {code:'4104',name:'利润分配',amount:1237187.63,credit:true}
];
const UI={expanded:new Set(['1122','1123','1221','2202']),all:true,year:false,collapsed:false,applied:null,form:null,companyKey:null,contextPeriod:null,settings:{disabled:true,auxiliary:false,zero:false,occurred:true}};
const fields={'b-account-start':'start','b-account-end':'end','b-level-start':'levelStart','b-level-end':'levelEnd','b-period-start':'periodStart','b-period-end':'periodEnd','b-min':'min','b-max':'max'};
const svg={print:'<svg viewBox="0 0 18 18"><path d="M5 6V2h8v4M5 13H2V6h14v7h-3M5 10h8v6H5z"/><path d="M13 8h1"/></svg>',export:'<svg viewBox="0 0 18 18"><path d="M10 2H4v14h10V9M10 2v5h5M8 12l7-7M11 5h4v4"/></svg>',refresh:'<svg viewBox="0 0 18 18"><path d="M14 5a6 6 0 1 0 1 7M14 2v4h-4"/></svg>'};
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function fmt(n){return Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
function period(app){const value=String(app.state&&app.state.period||'');if(/^\d{4}(0[1-9]|1[0-2])$/.test(value))return value;const now=new Date();return String(now.getFullYear())+String(now.getMonth()+1).padStart(2,'0');}
function company(app){return (app.state&&app.state.company&&app.state.company.name)||'北京爱可优电子商务有限公司';}
function defaults(p){return {start:'',end:'',periodStart:p,periodEnd:p,min:'',max:'',levelStart:'1',levelEnd:'6'};}
function context(app){const c=app.state&&app.state.company,key=c&&c.id!=null?String(c.id):company(app),p=period(app);if(UI.companyKey!==key){UI.companyKey=key;UI.contextPeriod=p;UI.applied=null;UI.form=defaults(p);}else if(UI.contextPeriod!==p){UI.contextPeriod=p;UI.form.periodStart=p;UI.form.periodEnd=p;if(UI.applied){UI.applied.periodStart=p;UI.applied.periodEnd=p;}}return UI.form;}
function months(p){const year=p.slice(0,4);return Array.from({length:12},(_,i)=>{const v=year+String(i+1).padStart(2,'0');return '<option value="'+v+'"'+(v===p?' selected':'')+'>'+v+'</option>';}).join('');}
function levels(selected){return Array.from({length:6},(_,i)=>'<option value="'+(i+1)+'"'+(String(i+1)===String(selected)?' selected':'')+'>'+(i+1)+'级</option>').join('');}
function checked(key){return UI.settings[key]?' checked':'';}
function getRows(){let list=SEED.filter(r=>(!r.disabled||UI.settings.disabled)&&(!r.auxiliary||UI.settings.auxiliary)&&(r.amount!==0||(r.activity?UI.settings.occurred:UI.settings.zero))&&(!r.parent||UI.expanded.has(r.parent)||r.auxiliary));const f=UI.applied;if(f){list=list.filter(r=>{let match=true;const a=f.start.trim(),b=f.end.trim();if(a)match=match&&(/^\d+$/.test(a)?r.code>=a:r.code.includes(a)||r.name.includes(a));if(b)match=match&&(/^\d+$/.test(b)?r.code<=b:r.code.includes(b)||r.name.includes(b));if(f.min!=='')match=match&&r.amount>=Number(f.min);if(f.max!=='')match=match&&r.amount<=Number(f.max);const level=r.parent?2:1;match=match&&level>=Number(f.levelStart)&&level<=Number(f.levelEnd);return match;});}return list;}
function rowHtml(r,i){const isParent=!r.parent,arrow=r.group?'<button class="b-tree" data-toggle="'+r.code+'" aria-label="'+(UI.expanded.has(r.code)?'收起':'展开')+r.name+'">'+(UI.expanded.has(r.code)?'◢':'▶')+'</button>':'<span class="b-leaf-space"></span>';const amount=fmt(r.amount),debit=r.credit?'':amount,credit=r.credit?amount:'';return '<tr class="'+(isParent?'b-parent':'b-child')+'"><td class="b-idx">'+(i+1)+'</td><td class="b-code '+(r.parent?'child':'')+'">'+(r.parent?'':arrow)+esc(r.code)+'</td><td><a href="#" data-ledger="'+r.code+'" title="'+esc(r.name)+'">'+esc(r.name)+'</a></td><td class="b-number">'+debit+'</td><td class="b-number">'+credit+'</td><td class="b-number"></td><td class="b-number"></td><td class="b-number">'+debit+'</td><td class="b-number">'+credit+'</td>'+ (UI.year?'<td class="b-number"></td><td class="b-number"></td>':'')+'<td class="b-filler"></td></tr>';}
function tableHtml(){const rows=getRows();return '<table class="b-table" aria-label="科目余额表"><colgroup><col style="width:3.18%"><col style="width:12.83%"><col style="width:12.83%">'+Array.from({length:UI.year?8:6},()=>'<col style="width:'+(UI.year?'8.2':'9.63')+'%">').join('')+'<col></colgroup><thead><tr><th rowspan="2" aria-label="设置">⚙</th><th rowspan="2">科目编码</th><th rowspan="2">科目</th><th colspan="2">期初余额</th><th colspan="2">本期发生额</th><th colspan="2">期末余额</th>'+(UI.year?'<th colspan="2">本年累计</th>':'')+'<th rowspan="2"></th></tr><tr>'+Array.from({length:UI.year?4:3},()=>'<th>借方金额</th><th>贷方金额</th>').join('')+'</tr></thead><tbody>'+ (rows.length?rows.map(rowHtml).join(''):'<tr class="b-empty"><td colspan="'+(UI.year?12:10)+'">没有符合查询条件的科目</td></tr>')+'</tbody></table>';}
function render(app){const f=context(app);return `<section class="balance-page">
 <div class="b-toolbar"><button class="b-all-subjects" data-b-action="subjects"><span class="b-arrow-round">‹</span>全部科目<span class="b-arrow-round last">›</span></button><div class="b-tools"><label><input type="checkbox" data-b-year ${UI.year?'checked':''}>显示本年累计</label><button data-b-action="expand"><span class="b-switch ${UI.all?'':'off'}"></span>全部展开</button><button data-b-action="print">${svg.print}云打印<span>│⌄</span></button><button data-b-action="export">${svg.export}导出</button><button data-b-action="refresh">${svg.refresh}刷新</button></div></div>
 <div class="b-filters ${UI.collapsed?'is-collapsed':''}"><div class="b-filter-main">
 <div class="b-filter-line"><label for="b-account-start">科目</label><div class="b-account-input"><input id="b-account-start" value="${esc(f.start)}" placeholder="选择..." autocomplete="off"><button data-b-action="subject-start" aria-label="选择起始科目">···</button></div><span class="b-dash">—</span><div class="b-account-input"><input id="b-account-end" value="${esc(f.end)}" placeholder="选择..." autocomplete="off"><button data-b-action="subject-end" aria-label="选择结束科目">···</button></div></div>
 <div class="b-filter-line"><label for="b-level-start">科目级次</label><select id="b-level-start">${levels(f.levelStart)}</select><span class="b-dash">—</span><select id="b-level-end">${levels(f.levelEnd)}</select></div>
 <div class="b-filter-line"><label for="b-period-start">期间</label><select id="b-period-start">${months(f.periodStart)}</select><span class="b-dash">—</span><select id="b-period-end">${months(f.periodEnd)}</select></div>
 <div class="b-filter-line"><label for="b-min">期初余额</label><input id="b-min" value="${esc(f.min)}" type="number" step="0.01" aria-label="最小期初余额"><span class="b-dash">—</span><input id="b-max" value="${esc(f.max)}" type="number" step="0.01" aria-label="最大期初余额"></div></div>
 <div class="b-filter-actions"><button class="b-query" data-b-action="query">查询</button><button class="b-reset" data-b-action="reset">重置</button></div><div class="b-display"><span class="b-display-label">显示设置:</span><label><input type="checkbox" data-b-setting="disabled"${checked('disabled')}>显示禁用科目</label><label><input type="checkbox" data-b-setting="auxiliary"${checked('auxiliary')}>显示辅助核算</label><label><input type="checkbox" data-b-setting="zero"${checked('zero')}>显示无余额无发生科目</label><label><input type="checkbox" data-b-setting="occurred"${checked('occurred')}>显示有发生无余额科目</label></div><button class="b-filter-collapse" data-b-action="filter">${UI.collapsed?'⌄ 展开更多条件':'⌃ 收起更多条件'}</button></div>
 <div class="b-table-panel"><div class="b-table-scroll">${tableHtml()}</div><div class="b-footer"><span class="b-filter-note">${UI.applied?'查询期间：'+esc(UI.applied.periodStart)+' — '+esc(UI.applied.periodEnd):''}</span><span>共 <b data-b-count>${getRows().length}</b> 条科目记录</span><span>单位：元</span></div></div></section>`;}
function bind(app){const page=document.querySelector('.balance-page');if(!page)return;context(app);const q=s=>page.querySelector(s);function redraw(){q('.b-table-scroll').innerHTML=tableHtml();q('[data-b-count]').textContent=getRows().length;q('.b-filter-note').textContent=UI.applied?'查询期间：'+UI.applied.periodStart+' — '+UI.applied.periodEnd:'';}
 function readForm(){const result={};Object.entries(fields).forEach(([id,key])=>{result[key]=q('#'+id).value;});return result;}
 function writeForm(){Object.entries(fields).forEach(([id,key])=>{q('#'+id).value=UI.form[key];});}
 function saveForm(e){if(e.target&&fields[e.target.id])UI.form=readForm();}
 page.addEventListener('input',saveForm);page.addEventListener('change',saveForm);
 function info(msg){if(app.toast)app.toast(msg);}
 function ledger(code){const r=SEED.find(a=>a.code===code);if(!r)return;const p=period(app),date=p.slice(0,4)+'-'+p.slice(4),last=date+'-'+String(new Date(Number(p.slice(0,4)),Number(p.slice(4)),0).getDate()).padStart(2,'0');const html='<div class="b-ledger-modal"><h3>'+esc(r.code+'　'+r.name)+' · 明细账</h3><div class="b-ledger-sub">'+esc(company(app))+'　｜　会计期间：'+p+'　｜　单位：元</div><table><thead><tr><th>日期</th><th>凭证字号</th><th>摘要</th><th class="b-right">借方金额</th><th class="b-right">贷方金额</th><th>方向</th><th class="b-right">余额</th></tr></thead><tbody><tr><td>'+date+'-01</td><td></td><td>期初余额</td><td></td><td></td><td>'+(r.credit?'贷':'借')+'</td><td class="b-right">'+fmt(r.amount)+'</td></tr><tr><td>'+last+'</td><td></td><td>本期合计</td><td class="b-right">0.00</td><td class="b-right">0.00</td><td>'+(r.credit?'贷':'借')+'</td><td class="b-right">'+fmt(r.amount)+'</td></tr></tbody></table><div class="b-ledger-bottom"><span>期末余额：<strong>'+fmt(r.amount)+'</strong></span><button data-ledger-export>导出明细账</button></div></div>';app.modal(html,el=>{const root=el||document;root.querySelector('[data-ledger-export]').onclick=()=>app.exportCSV(r.name+'明细账.csv',[['日期','凭证字号','摘要','借方金额','贷方金额','方向','余额'],[date+'-01','','期初余额','','',r.credit?'贷':'借',r.amount],[last,'','本期合计',0,0,r.credit?'贷':'借',r.amount]]);});}
 function subjects(target){app.modal('<div class="b-ledger-modal"><h3>选择科目</h3><input class="b-subject-search" placeholder="输入科目编码或名称搜索" aria-label="搜索科目"><div class="b-subject-list">'+SEED.map(r=>'<div class="b-subject-row" data-subject="'+r.code+'"><span>'+r.code+'</span><span>'+esc(r.name)+'</span></div>').join('')+'</div></div>',el=>{const root=el||document;root.querySelector('.b-subject-search').oninput=e=>{root.querySelectorAll('[data-subject]').forEach(row=>row.hidden=!row.textContent.includes(e.target.value));};root.querySelectorAll('[data-subject]').forEach(row=>row.onclick=()=>{if(target){q(target).value=row.dataset.subject;UI.form=readForm();if(app.closeModal)app.closeModal();}else{if(app.closeModal)app.closeModal();ledger(row.dataset.subject);}});});}
 page.addEventListener('click',e=>{
  const toggle=e.target.closest('[data-toggle]');
  if(toggle){const code=toggle.dataset.toggle;UI.expanded.has(code)?UI.expanded.delete(code):UI.expanded.add(code);UI.all=SEED.filter(r=>r.group).every(r=>UI.expanded.has(r.code));q('.b-switch').classList.toggle('off',!UI.all);redraw();return;}
  const account=e.target.closest('[data-ledger]');if(account){e.preventDefault();ledger(account.dataset.ledger);return;}
  const button=e.target.closest('[data-b-action]');if(!button)return;const action=button.dataset.bAction;
  if(action==='expand'){UI.all=!UI.all;UI.expanded=UI.all?new Set(SEED.filter(r=>r.group).map(r=>r.code)):new Set();q('.b-switch').classList.toggle('off',!UI.all);redraw();}
  else if(action==='query'){
   UI.form=readForm();const f=UI.form;
   if(f.periodStart>f.periodEnd){info('开始期间不能晚于结束期间');return;}
   if(Number(f.levelStart)>Number(f.levelEnd)){info('起始科目级次不能大于结束科目级次');return;}
   if(f.min!==''&&f.max!==''&&Number(f.min)>Number(f.max)){info('最小余额不能大于最大余额');return;}
   UI.applied={...f};UI.contextPeriod=f.periodEnd;redraw();
   // Save and draw before setPeriod, which can replace this entire page synchronously.
   if(app.setPeriod)app.setPeriod(f.periodEnd);else if(app.state)app.state.period=f.periodEnd;
   info('查询完成');
  }
  else if(action==='reset'){UI.applied=null;UI.form=defaults(period(app));writeForm();redraw();}
  else if(action==='filter'){UI.collapsed=!UI.collapsed;q('.b-filters').classList.toggle('is-collapsed',UI.collapsed);button.textContent=(UI.collapsed?'⌄ 展开更多条件':'⌃ 收起更多条件');}
  else if(action==='export'){app.exportCSV(company(app)+'_科目余额表_'+period(app)+'.csv',[['科目编码','科目','期初借方','期初贷方','本期借方','本期贷方','期末借方','期末贷方'],...getRows().map(r=>[r.code,r.name,r.credit?'':r.amount,r.credit?r.amount:'',0,0,r.credit?'':r.amount,r.credit?r.amount:''])]);info('余额表已导出');}
  else if(action==='print'){window.print();}
  else if(action==='refresh'){redraw();info('余额表已刷新');}
  else if(action==='subjects'){subjects();}
  else if(action==='subject-start'){subjects('#b-account-start');}
  else if(action==='subject-end'){subjects('#b-account-end');}
 });
 q('[data-b-year]').onchange=e=>{UI.year=e.target.checked;redraw();};page.querySelectorAll('[data-b-setting]').forEach(box=>box.onchange=()=>{UI.settings[box.dataset.bSetting]=box.checked;redraw();});
 }
 window.Pages=window.Pages||{};window.Pages.balance={render,bind};
})();

