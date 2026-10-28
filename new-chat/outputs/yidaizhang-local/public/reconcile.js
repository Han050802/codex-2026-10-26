import { renderRuleSearch, bindRuleSearch } from './reconcile-rules.js';
const state = {transactions: [], invoices: [], account: '', accountNeedsReview:false, accountFromOCR:false, matches: null, hasMatched:false, warnings: [], sample: false, busy: false, approvals: {}, saved: {}, clientId: '', records: [], sourceFiles: [], progress:null, preview:null, previewError:'', evidence:[], accountNames:{}, bookAccounts:[],lastPostings:null,selectedStatement:[],selectedInvoices:[],importChanged:false};
let parseGeneration=0, activeParsePage=null;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function resetReconcile(){parseGeneration++;activeParsePage=null;state.sourceFiles.forEach(f=>URL.revokeObjectURL(f.url));Object.assign(state,{transactions:[],invoices:[],account:'',accountNeedsReview:false,accountFromOCR:false,matches:null,hasMatched:false,warnings:[],sample:false,busy:false,approvals:{},saved:{},clientId:'',records:[],sourceFiles:[],progress:null,preview:null,previewError:'',evidence:[],accountNames:{},bookAccounts:[],lastPostings:null,selectedStatement:[],selectedInvoices:[],importChanged:false});}
const initial = {transactions: {date:'',amount:'',counterparty:'',note:'',source:'手工录入'}, invoices:{date:'',amount:'',seller:'',buyer:'',number:'',item_name:'',net_amount:'',tax_amount:'',business_purpose:'',source:'手工录入'}};
const savedKey = (client,t={},inv={}) => JSON.stringify([String(client),t.date,t.amount,t.counterparty,inv.number,inv.date,inv.amount,inv.seller,inv.buyer,inv.item_name||'',inv.net_amount||'',inv.tax_amount||'',inv.business_purpose||'']);
// Only an exact name match can select a book; the transaction counterparty is a different company.
function identifyClient(account, clients) {
 const name=String(account || '').trim();
 if(!name)return {id:'', basis:'未识别出本方公司名称，请核对单据并选择客户。'};
 const matches=clients.filter(c=>[c.name,c.enterprise_name].some(value=>String(value||'').trim()===name));
 if(matches.length===1)return {id:String(matches[0].id),basis:`本方名称“${name}”与客户档案名称完全一致；请核对后确认。`};
 return {id:'',basis:matches.length?'本方名称对应多个客户，请人工选择并核对。':`本方名称“${name}”未匹配到客户档案，请人工选择并核对。`};
}
// When the statement has no account name, infer it only from an unambiguous
// matching amount and counterparty on the invoice, never from the counterparty itself.
function inferOwnName(transactions, invoices) {
 const found=new Set();
 for(const t of transactions) {
  const amount=Number(String(t.amount||'').replace(/[,¥￥]/g,''));
  if(!Number.isFinite(amount)||!amount||!String(t.counterparty||'').trim())continue;
  const candidates=invoices.filter(i=>Number(String(i.amount||'').replace(/[,¥￥]/g,''))===Math.abs(amount) && String((amount>0?i.buyer:i.seller)||'').trim()===String(t.counterparty).trim());
  if(candidates.length===1) {const own=String((amount>0?candidates[0].seller:candidates[0].buyer)||'').trim();if(own)found.add(own);}
 }
 return found.size===1?[...found][0]:'';
}
const isComplete = (x,type) => Boolean(type === 'transactions' ? x.date && x.amount && x.counterparty : x.date && x.amount && x.seller && x.buyer && x.number);
function editRows(type) {
 const isT = type==='transactions', rows=state[type];
 const columns=isT?[['date','交易日期','date'],['amount','金额（元）','text'],['counterparty','对手方','text'],['note','附言','text']]:[['date','开票日期','date'],['amount','价税合计（元）','text'],['seller','销售方','text'],['buyer','购买方','text'],['number','发票号码','text'],['item_name','发票项目（多项用；分隔）','text'],['net_amount','不含税金额（元）','text'],['tax_amount','税额（元）','text'],['business_purpose','实际用途','text']];
 return `<div class="rc-scroll"><table class="rc-edit"><thead><tr><th>来源</th>${columns.map(c=>`<th>${c[1]}</th>`).join('')}<th></th></tr></thead><tbody>${rows.map((r,i)=>`<tr><td title="${esc(r.source)}">${esc(r.source||'手工录入')}${isT&&r.direction_needs_review?'<br><strong data-rc-direction-warning style="color:#bd4c19">收付款方向待确认，请编辑金额</strong>':''}</td>${columns.map(([key,label,kind])=>`<td><input type="${kind}" aria-label="${label} ${i+1}" data-rc-field="${type}" data-index="${i}" data-key="${key}" value="${esc(r[key])}" ${state.busy?'disabled':''} ${key==='amount'?'inputmode="decimal"':''}></td>`).join('')}<td><button class="rc-link" type="button" data-rc-delete="${type}" data-index="${i}">删除</button></td></tr>`).join('')||`<tr><td colspan="${columns.length+2}" class="rc-empty">暂无数据，可识别文件或手工添加</td></tr>`}</tbody></table></div>`;
}
const SMALL_STANDARD_SOURCE='https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852734144.pdf';
function safeSourceLink(raw, label) {
 try {const url=new URL(raw);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return '';return `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;}catch{return '';}
}
function classificationMarkup(item, standard) {
 item=item?.rule_suggestion || item;
 if(!item) return `<div class="rc-reasons"><b>流水科目建议：待确定</b><br>缺少分类结果，请重新核对。</div>`;
 const subject=item.account_code ? `${esc(item.account_code)} ${esc(item.account_name || '')}` : item.account_name ? `${esc(item.account_name)}（账套末级科目待确定）` : '无法唯一确定';
 const provisional=item.status==='provisional';
 const rules=Array.isArray(item.rule_ids) ? item.rule_ids.join('、') : (item.rule_id || '');
 const assumptions=Array.isArray(item.assumptions) ? item.assumptions.join('；') : (item.assumptions || item.assumption || item.review || '');
 const candidates=Array.isArray(item.candidates) ? item.candidates.map(c=>`<div>候选：${esc(c.item_name || '项目待确认')} → ${esc(c.account_code ? c.account_code+' ' : '')}${esc(c.account_name || '科目待确认')}；适用条件：${esc(c.condition || '请核实实际用途')}</div>`).join('') : '';
 const sources=Array.isArray(item.source_urls)?item.source_urls:[];
 const links=sources.map((url,i)=>safeSourceLink(url,`准则来源${sources.length>1?' '+(i+1):''}`)).filter(Boolean);
 if(!links.length && standard==='small2013')links.push(safeSourceLink(SMALL_STANDARD_SOURCE,'小企业会计准则附录（科目表参考）'));
 return `<div class="rc-reasons" data-rc-classification><b>流水科目建议：${subject}</b>${provisional?'（推荐）':item.account_code?'（建议）':''}${rules?`<br>命中规则：${esc(rules)}`:''}<br>判断依据：${esc(item.basis || '信息不足')}${assumptions?`<br>假设或待核实事项：${esc(assumptions)}`:''}${provisional?'<br>该科目为推荐结果；资料不足时请核实实际用途。':''}${candidates}${links.length?`<div>参考依据：${links.join('、')}</div>`:''}</div>`;
}
function multiInvoiceMarkup(ti) {
 const result=(state.matches?.multi_invoice_candidates||[]).find(x=>x.transaction_index===ti);
 if(!result)return '';
 const groups=(result.candidates||[]).map((group,index)=>{
  const invoices=(group.invoice_indices||[]).map(ii=>state.invoices[ii]?.number || `第 ${Number(ii)+1} 张发票`).join('、');
  const warnings=(group.date_warnings||[]).join('；');
  return `<div>候选 ${index+1}：${esc(invoices)} · 合计 ¥ ${(Number(group.amount_fen||0)/100).toFixed(2)}${warnings?` · ${esc(warnings)}`:''}</div>`;
 }).join('');
 return `<div class="rc-reasons" data-rc-multi-candidate><b>多票合计候选（仅供核对）</b><br>${esc(result.reason||'')}${groups}<div>候选不代表配对通过，也不作为自动入账依据。</div></div>`;
}
function lineText(line, row) {
 const code=line.account_code || line.counterparty_parent_code || '';
 const label=state.accountNames[code] || line.account_name || code || '待确认';
 const name=line.counterparty_parent_code ? `${label} / ${row.counterparty || '对方待确认'}` : label;
 const debit=Number(line.debit_fen||0), credit=Number(line.credit_fen||0);
 return `${esc(code)} ${esc(name)}：${debit ? '借 '+(debit/100).toFixed(2) : '贷 '+(credit/100).toFixed(2)} 元`;
}
const specialTreatments = new Set(['contract_prepayment','settle_payable','settle_receivable']);
export function fundingMarkup(ti,e,accounts,disabled='') {
 if (!specialTreatments.has(e.treatment)) return '';
 const leaf=a=>!accounts.some(b=>b.code!==a.code && String(b.code).startsWith(String(a.code)));
 const options='<option value="">请选择</option>'+accounts.filter(a=>a.report_key==='cash'&&leaf(a)).map(a=>`<option value="${esc(a.code)}" ${String(e.bank_account_code||'')===String(a.code)?'selected':''}>${esc(a.code)} ${esc(a.name)}</option>`).join('');
 return `<label>特殊业务的实际资金科目 <select data-rc-evidence="bank_account_code" data-index="${ti}" ${disabled}>${options}</select></label><span>按实际凭证依据选择；该选择仅用于本项特殊业务的会计制证。</span>`;
}
export function changeEvidence(e,key,value) {
 if(key==='treatment' && e.treatment!==value) delete e.bank_account_code;
 e[key]=value;
 return e;
}
export function submittedEvidence(e) {
 const value={...e};
 if(!specialTreatments.has(value.treatment)) delete value.bank_account_code;
 return value;
}
function evidenceFields(ti) {
 const e=state.evidence[ti] || {};
 const disabled=state.busy?'disabled':'';
 const accountOption=(current,predicate)=>'<option value="">请选择</option>'+state.bookAccounts.filter(predicate).map(a=>`<option value="${esc(a.code)}" ${String(current||'')===String(a.code)?'selected':''}>${esc(a.code)} ${esc(a.name)}</option>`).join('');
 const accounts=state.bookAccounts, leaf=a=>!accounts.some(b=>b.code!==a.code && String(b.code).startsWith(String(a.code)));
 return `<details><summary>补充业务科目及依据</summary><div style="display:grid;gap:8px;margin:8px 0;min-width:300px"><label>业务性质 <select data-rc-evidence="treatment" data-index="${ti}" ${disabled}><option value="">待确定</option>${[['contract_prepayment','合同预付款'],['settle_payable','结清已有应付'],['settle_receivable','收回已有应收'],['recognize_invoice','根据发票确认业务']].map(([v,n])=>`<option value="${v}" ${e.treatment===v?'selected':''}>${n}</option>`).join('')}</select></label><label>业务科目（自动匹配不明确时可选择） <select data-rc-evidence="business_account_code" data-index="${ti}" ${disabled}>${accountOption(e.business_account_code,a=>leaf(a)&&!['cash','tax_payable'].includes(a.report_key))}</select></label><div data-rc-funding-slot>${fundingMarkup(ti,e,accounts,disabled)}</div><label>已有往来明细科目 <select data-rc-evidence="settlement_account_code" data-index="${ti}" ${disabled}>${accountOption(e.settlement_account_code,a=>['receivable','prepaid','payable','advance','other_asset','other_liability'].includes(a.report_key)&&leaf(a))}</select></label><label>税额处理 <select data-rc-evidence="tax_treatment" data-index="${ti}" ${disabled}><option value="">待确定 / 不适用</option><option value="deductible_input" ${e.tax_treatment==='deductible_input'?'selected':''}>可抵扣进项税</option><option value="output" ${e.tax_treatment==='output'?'selected':''}>销项税</option></select></label><label>税费末级科目 <select data-rc-evidence="tax_account_code" data-index="${ti}" ${disabled}>${accountOption(e.tax_account_code,a=>a.report_key==='tax_payable'&&leaf(a))}</select></label><label>具体证据说明 <textarea data-rc-evidence="evidence_note" data-index="${ti}" ${disabled} maxlength="500" placeholder="例如合同条款、已有凭证或账款依据">${esc(e.evidence_note||'')}</textarea></label><label>重复凭证核验说明（出现重复提示时填写） <textarea data-rc-evidence="duplicate_review_note" data-index="${ti}" ${disabled} maxlength="500" placeholder="说明核对后不是重复入账的依据">${esc(e.duplicate_review_note||'')}</textarea></label></div></details>`;
}
function resultRows(clients) {
 if(!state.matches) return '<div class="rc-empty rc-result-empty">识别完成后将自动核对全部数据；修改数据后请重新核对。</div>';
 const matches=state.matches.matches||[];
 const rows=state.preview?.rows || state.transactions.map((_,ti)=>{const match=matches.find(m=>m.transaction_index===ti);return {transaction_index:ti,invoice_index:match?.invoice_index??null,status:'unprocessed',reason:(match?.reasons||[]).join('；')};});
 const standard=clients.find(c=>String(c.id)===String(state.clientId))?.standard;
 const content=rows.map(row=>{const ti=row.transaction_index, t=state.transactions[ti]||{}, inv=state.invoices[row.invoice_index]||{}, voucher=row.voucher||{}, lines=row.status==='posted'?(row.posted_lines||[]):(voucher.lines||[]), match=matches.find(m=>m.transaction_index===ti), matched=match?.status==='matched' && match.invoice_index===row.invoice_index;
 const matchReason=matched?'':(match?.reasons||['未找到唯一匹配发票']).join('；');
 const classification=classificationMarkup(row.classification || state.matches.classification_transactions?.[ti] || (matched ? state.matches.classification_invoices?.[row.invoice_index] : null),standard);
 const posting=row.status==='expense_classified'?(state.sample?'分类预览（样本）':'已分类 · 未生成凭证'):row.status==='posted'?'已自动入账':row.status==='ready'?'可入账（样本）':row.status==='unprocessed'?'尚未处理':row.status==='saved_pending'?'待人工核实':'待处理';
 return `<tr><td>${esc(t.date)}<br><b>¥ ${esc(t.amount)}</b><br>交易对方：${esc(row.counterparty||t.counterparty)}</td><td>${esc(inv.number||'待匹配')}<br>本方：${esc(state.account)}</td><td><span class="rc-badge ${matched?'ok':'review'}">${matched?'核对通过':'待匹配'}</span> <span class="rc-badge ${['ready','posted','expense_classified'].includes(row.status)?'ok':'review'}">${posting}</span><div class="rc-reasons">${esc(matchReason)}${row.reason?`<br>处理结果：${esc(row.reason)}`:''}${row.basis?`<br>判断依据：${esc(Array.isArray(row.basis)?row.basis.join('；'):typeof row.basis==='string'?row.basis:JSON.stringify(row.basis))}`:''}</div>${lines.length?`<div><b>${row.status==='posted'?'已入账分录':`拟入账分录（${esc(voucher.date)}）`}</b>${lines.map(l=>`<div>${lineText(l,row)}</div>`).join('')}</div>`:''}${row.expense_classification?`<div><b>支出分类：${esc(row.expense_classification.account_code)} ${esc(row.expense_classification.account_name)} · -${(Number(row.expense_classification.amount_fen||0)/100).toFixed(2)} 元（未生成凭证）</b></div>`:''}${classification}${multiInvoiceMarkup(ti)}${state.clientId && !['posted','ready','expense_classified'].includes(row.status)?evidenceFields(ti):''}</td></tr>`;}).join('');
 const unmatched=(state.preview?.unmatched_invoices||state.matches.unmatched_invoices||[]).map(ii=>`<tr><td>无匹配流水</td><td>${esc(state.invoices[ii]?.number||'发票待确认')}</td><td><span class="rc-badge review">待匹配</span> 请核对该发票对应流水。</td></tr>`).join('');
 return `<div class="rc-scroll"><table class="rc-results"><thead><tr><th>收支交易</th><th>发票及本方</th><th>核对状态及科目结果</th></tr></thead><tbody>${content+unmatched||'<tr><td colspan="3" class="rc-empty">没有可处理的记录</td></tr>'}</tbody></table></div>`;
}
export function renderReconcile(clients=[]){
 if(activeParsePage && !activeParsePage.isConnected){parseGeneration++;activeParsePage=null;state.busy=false;}
 const identified=identifyClient(state.account,clients);
 const pending=state.preview ? (state.preview.rows||[]).filter(r=>['review','saved_pending'].includes(r.status)).length+(state.preview.unmatched_invoices||[]).length : state.matches ? state.transactions.length+(state.matches.unmatched_invoices||[]).length : 0;
 return `<div class="rc-root"><div class="rc-header"><div><div class="rc-eyebrow">票据 / 流水发票核对</div><h1>流水发票核对 <span class="rc-version">体验版</span></h1><p>一份收支交易清单，对照多张发票。收款或付款的金额和公司名称有差异时，请人工审核。</p></div><button type="button" class="rc-secondary" data-rc-action="sample">载入样本演示</button></div>
 ${state.sample?'<div class="rc-sample">当前为样本演示数据，仅供体验，不会写入业务数据。</div>':''}
 <div class="rc-steps"><span><b>1</b> 导入文件</span><i></i><span><b>2</b> 核对数据</span><i></i><span><b>3</b> 查看分类及处理结果</span></div>
 <section class="rc-panel"><div class="rc-panel-head"><div><h2>导入单据</h2><p>支持 PDF、图片或 ZIP；识别完成后自动核对和处理，无法识别的数据可以手工补充。上传原件不会保存到凭证，请自行保管原件。</p></div></div><div class="rc-upload-grid">${uploadMarkup('statement','收支交易清单','选择一份 PDF、图片或 ZIP',state.selectedStatement)}${uploadMarkup('invoices','发票文件','可多选 PDF、图片或 ZIP',state.selectedInvoices)}</div><div class="rc-selected"><span>可移除误选文件或 ZIP，重新选择后再识别。</span><button type="button" class="rc-primary" data-rc-action="parse" ${state.busy?'disabled':''}>${state.busy?'正在识别…':'识别文件'}</button></div>${state.importChanged?'<div class="rc-import-notice" role="status">文件已变更，上次识别和核对结果已清除，请重新识别。已保存或已入账的记录不会因移除文件而撤销；请在对应客户的已保存记录中查看。</div>':''}<div class="rc-warnings">${state.warnings.map(w=>`<div>⚠ ${esc(w)}</div>`).join('')}</div><div class="rc-originals">${state.sourceFiles.map((f,i)=>`<a href="${esc(f.url)}" target="_blank" rel="noopener">查看原件：${esc(f.name)}</a>`).join('')}</div></section>
 <section class="rc-panel"><div class="rc-panel-head"><div><h2>核对数据</h2><p>识别后自动逐条核对；机器识别结果可在此修改，修改后请重新核对。请依据原件补充发票项目和实际用途，多个项目用分号分隔；未知税额留空，不要填零。</p></div><div class="rc-account"><label>本方公司名称 <input type="text" data-rc-account value="${esc(state.account)}" ${state.busy?'disabled':''} placeholder="付款核对购买方，收款核对销售方"></label></div></div><div class="rc-subhead"><h3>收支交易 <small>${state.transactions.length} 条</small></h3><button type="button" class="rc-secondary small" data-rc-add="transactions">＋ 添加交易</button></div>${editRows('transactions')}<div class="rc-subhead"><h3>发票 <small>${state.invoices.length} 张</small></h3><button type="button" class="rc-secondary small" data-rc-add="invoices">＋ 添加发票</button></div>${editRows('invoices')}<div class="rc-bottom"><span>付款金额请填写负数，收款填写正数；发票金额填写价税合计。</span><button type="button" class="rc-primary" data-rc-action="match" ${state.busy?'disabled':''} ${state.matches?'hidden':''}>${state.hasMatched?'重新核对':'开始核对'}</button></div></section>
 <section class="rc-panel"><div class="rc-panel-head"><div><h2>核对结果</h2><p>核对通过后按发票和清单推荐业务科目，并显示收支方向。已分类的支出不生成凭证，在余额表单独展示，不计入正式凭证发生额；资料不足时提示补充。自动核对不等于查验发票真伪。<a href="https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852734144.pdf" target="_blank" rel="noopener noreferrer">小企业会计准则附录</a></p><p data-rc-preview-status aria-live="polite">${esc(state.previewError)}</p></div><div class="rc-stats"><span>已分类 <b>${(state.preview?.rows||[]).filter(r=>r.status==='expense_classified').length}</b></span><span>已入账 <b>${(state.preview?.rows||[]).filter(r=>r.status==='posted').length}</b></span><span>待处理 <b>${pending}</b></span></div></div>${resultRows(clients)}${state.lastPostings?`<div class="notice" data-rc-postings><strong>处理结果：${esc(state.lastPostings.clientName)}</strong>${state.lastPostings.classifications.length?`<div>已保存 ${state.lastPostings.classifications.length} 条支出分类，未生成凭证。</div>`:''}${state.lastPostings.postings.map(p=>`<div>凭证 #${esc(p.voucher_id)} · ${esc(p.period)}${(p.posted_lines||[]).map(l=>`<div>${esc(l.account_code)} ${esc(l.account_name)} · 借 ${(Number(l.debit_fen||0)/100).toFixed(2)} · 贷 ${(Number(l.credit_fen||0)/100).toFixed(2)} 元</div>`).join('')}</div>`).join('')}<button type="button" class="rc-secondary" data-rc-action="show-balance">查看余额表</button></div>`:''}<div class="rc-submit"><label class="rc-client">保存至客户 <select data-rc-client ${state.busy?'disabled':''}><option value="">请选择客户</option>${clients.map(c=>`<option value="${esc(c.id)}" ${String(c.id)===String(state.clientId)?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label><span data-rc-validation-hint>${esc(identified.basis)} ${state.clientId?'所选客户用于本方账套；交易对手方另行显示。':'请先选择本方客户账套。'}核对后的支出分类可在余额表单独查看，未生成凭证。</span><button type="button" class="rc-secondary" data-rc-action="preview" ${state.busy||!state.matches||!state.clientId?'disabled':''}>重新处理</button><button type="button" class="rc-secondary" data-rc-action="history">查看已保存记录</button></div>${state.records.length?`<div class="rc-history"><strong>已保存的核对记录</strong>${state.records.map(r=>`<div>${esc(r.transaction?.date)} · ${esc(r.transaction?.counterparty)} · ¥ ${esc(r.invoice?.amount)} · 发票 ${esc(r.invoice?.number)} · ${esc(r.username||'')} · ${esc(r.created_at||'')} · ${r.voucher_id?`已入账 · 凭证 #${esc(r.voucher_id)}`:r.batch_metadata?.expense_classification?`已分类 · 未生成凭证：${esc(r.batch_metadata.expense_classification.account_code)} ${esc(r.batch_metadata.expense_classification.account_name)} · 支出`:['matched','reviewed'].includes(r.status)?`待人工核实：${esc(r.batch_metadata?.reason || "资料待核实")} <button type="button" class="rc-link" data-rc-resume="${esc(r.id)}" ${state.busy?'disabled':''}>继续匹配科目</button>`:'未入账 · 请重新核对数据'}</div>`).join('')}</div>`:''}</section>${renderRuleSearch()}</div>`;
}
function fileBase64(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve({name:file.name,content_base64:String(r.result).split(',')[1]});r.onerror=()=>reject(new Error('读取文件失败：'+file.name));r.readAsDataURL(file);});}
const formatSeconds = value => `${Math.max(0, Number(value) || 0).toFixed(1)} 秒`;
function progressMarkup(progress, kind) {
 const files=(progress.files||[]).filter(f=>f.kind===kind);
 const label=progress.status==='completed'?'识别完成':progress.status==='failed'?'识别中断':'正在识别';
 return `<strong>${label} · 已用 ${formatSeconds(progress.elapsed_seconds)}</strong>${files.length?`<ul>${files.map(f=>{const passes=(f.pages||[]).filter(p=>p.orientation_passes>1).length;return `<li><span>${esc(f.name)}</span><span>${f.status==='completed'?'已处理':'识别中'} · ${formatSeconds(f.elapsed_seconds)}${passes?` · ${passes} 页尝试了第二个方向`:''}</span></li>`;}).join('')}</ul>`:'<div>暂无此类文件处理记录</div>'}`;
}
function uploadMarkup(kind,title,hint,files) {
 const fileKind=kind==='statement'?'statement':'invoices', progressKind=kind==='statement'?'statement':'invoice';
 return `<div class="rc-upload-column"><label class="rc-upload"><span class="rc-upload-icon">⇧</span><strong>${title}</strong><span>${hint}</span><input type="file" data-rc-file="${fileKind}" ${state.busy?'disabled':''} accept=".pdf,.png,.jpg,.jpeg,.zip" ${kind==='invoices'?'multiple':''}></label><div class="rc-file-status" role="status" aria-live="polite"><strong>${title}：${files.length?`已选 ${files.length} 个文件`:'尚未选择文件'}</strong>${files.length?`<ul>${files.map((file,index)=>`<li><span title="${esc(file.name)}">${esc(file.name)}</span><button type="button" class="rc-link" data-rc-remove-file="${fileKind}" data-index="${index}" aria-label="移除 ${esc(file.name)}" ${state.busy?'disabled':''}>移除</button></li>`).join('')}</ul>`:''}</div><div class="rc-progress" data-rc-progress="${progressKind}" role="status" aria-live="polite" ${state.progress?'':'hidden'}>${state.progress?progressMarkup(state.progress,progressKind):''}</div></div>`;
}
function showProgress(root, progress) {
 root.querySelectorAll('[data-rc-progress]').forEach(target=>{target.hidden=false;target.innerHTML=progressMarkup(progress,target.dataset.rcProgress);});
}
const waitForProgress = () => new Promise(resolve=>setTimeout(resolve,1000));
// Automatic processing is decided and committed by the server; sample data stays read-only.
export async function processReconcileBatch(api, payload, sample=false) {
 return api(sample ? '/api/reconcile/batch-preview' : '/api/reconcile/batch-auto', {method:'POST', body:payload});
}
export function bindReconcile(root, api, clients=[], onPosted){
 const redraw=()=>{root.innerHTML=renderReconcile(clients); bindReconcile(root,api,clients,onPosted);};
 bindRuleSearch(root,api,()=>state.clientId);
 const clearResults=()=>{state.matches=null;state.preview=null;state.previewError='';state.approvals={};};
 const clearImportedResults=()=>{if(!state.progress&&!state.sample)return;state.sourceFiles.forEach(f=>URL.revokeObjectURL(f.url));Object.assign(state,{transactions:[],invoices:[],account:'',accountNeedsReview:false,accountFromOCR:false,hasMatched:false,warnings:[],sample:false,clientId:'',records:[],sourceFiles:[],progress:null,evidence:[],accountNames:{},bookAccounts:[],lastPostings:null,importChanged:true});clearResults();};
 const invalidate=()=>{clearResults();const matchButton=root.querySelector('[data-rc-action=match]');if(matchButton){matchButton.hidden=false;matchButton.textContent=state.hasMatched?'重新核对':'开始核对';}root.querySelector('[data-rc-pending]')?.remove();const hint=root.querySelector('[data-rc-validation-hint]');if(hint)hint.textContent=(state.clientId?'数据已修改，请重新核对以校验所选客户账套科目。':'请选择客户并重新核对该账套的科目。')+'核对后的支出分类可在余额表单独查看，未生成凭证。';const result=root.querySelector('.rc-results,.rc-result-empty');if(result)result.outerHTML='<div class="rc-empty rc-result-empty">数据已修改，请重新核对。</div>';root.querySelectorAll('.rc-stats b').forEach(x=>x.textContent='—');root.querySelectorAll('[data-rc-save]').forEach(x=>x.disabled=true);};
 const batchPayload=()=>({client_id:Number(state.clientId),account_name:state.account,account_needs_review:state.accountNeedsReview,transactions:state.transactions,invoices:state.invoices,evidence:state.transactions.map((_,i)=>submittedEvidence(state.evidence[i]||{}))});
 const runPreview=async()=>{state.preview=null;state.lastPostings=null;state.previewError='';if(!state.clientId)return;if(!state.invoices.length){state.previewError='未提供发票，已展示流水科目建议；暂不生成凭证。';return;}try{const period=String(state.transactions.find(t=>/^\d{4}-\d{2}/.test(t.date||''))?.date||'').slice(0,7);if(period){const book=await api(`/api/books/${encodeURIComponent(state.clientId)}?period=${encodeURIComponent(period)}`);state.bookAccounts=book.accounts||[];state.accountNames=Object.fromEntries(state.bookAccounts.map(a=>[String(a.code),a.name]));}if(!root.isConnected)return;const result=await processReconcileBatch(api,batchPayload(),state.sample);if(!state.sample){try{await api('/api/reconcile/retry-saved',{method:'POST',body:{client_id:Number(state.clientId)}});if(state.records.length){const history=await api('/api/reconcile/records?client_id='+encodeURIComponent(state.clientId));state.records=history.records||[];}}catch(err){state.previewError='已保存记录自动处理失败：'+err.message;}}const posted=(result.rows||[]).filter(row=>row.status==='posted');for(const row of posted){const t=state.transactions[row.transaction_index], inv=state.invoices[row.invoice_index];if(t&&inv)state.saved[savedKey(state.clientId,t,inv)]={id:row.id,voucher_id:row.voucher_id,posted_lines:row.posted_lines||[]};}result.rows=(result.rows||[]).map(row=>{const t=state.transactions[row.transaction_index],inv=state.invoices[row.invoice_index],saved=t&&inv&&state.saved[savedKey(state.clientId,t,inv)];return row.status==='review'&&saved&&String(row.reason||'').includes('发票已保存')?{...row,...saved,status:'posted',reason:'本次工作中已自动入账'}:row;});state.preview=result;const classified=state.sample?[]:(result.rows||[]).filter(row=>row.status==='expense_classified' && row.id);if(posted.length||classified.length){const client=clients.find(c=>String(c.id)===String(state.clientId));state.lastPostings={clientId:Number(state.clientId),clientName:result.client_name||client?.enterprise_name||client?.name||'',postings:posted.map(row=>({period:String(state.transactions[row.transaction_index]?.date||'').slice(0,7),voucher_id:row.voucher_id,posted_lines:row.posted_lines||[]})),classifications:classified.map(row=>({period:String(row.expense_classification?.date||state.transactions[row.transaction_index]?.date||'').slice(0,7),record_id:row.id}))};}}catch(err){state.previewError='自动处理失败：'+err.message+'。请查看已保存记录后重试。';}};
 const runMatch=async()=>{state.matches=await api('/api/reconcile/match',{method:'POST',body:{transactions:state.transactions,invoices:state.invoices,account_name:state.account,account_needs_review:state.accountNeedsReview,...(state.clientId?{client_id:Number(state.clientId)}:{})}});state.approvals={};state.hasMatched=true;await runPreview();};

 root.querySelectorAll('[data-rc-field]').forEach(el=>el.addEventListener('input',()=>{if(state.busy)return;const row=state[el.dataset.rcField][Number(el.dataset.index)];row[el.dataset.key]=el.value;if(el.dataset.rcField==='transactions')state.evidence[Number(el.dataset.index)]={};else if(!['net_amount','tax_amount'].includes(el.dataset.key))state.evidence=[];if(el.dataset.rcField==='transactions'&&el.dataset.key==='amount'){row.direction_needs_review=false;el.closest('tr')?.querySelector('[data-rc-direction-warning]')?.remove();}invalidate();}));
 const bindEvidence=el=>el.addEventListener(el.tagName==='SELECT'?'change':'input',()=>{if(state.busy)return;const i=Number(el.dataset.index);state.evidence[i] ||= {};changeEvidence(state.evidence[i],el.dataset.rcEvidence,el.value);state.preview=null;const status=root.querySelector('[data-rc-preview-status]');if(status)status.textContent='依据已修改，请重新处理。';if(el.dataset.rcEvidence==='treatment'){const slot=el.closest('details')?.querySelector('[data-rc-funding-slot]');if(slot){slot.innerHTML=fundingMarkup(i,state.evidence[i],state.bookAccounts,state.busy?'disabled':'');slot.querySelectorAll('[data-rc-evidence]').forEach(bindEvidence);}}});
 root.querySelectorAll('[data-rc-evidence]').forEach(bindEvidence);
 root.querySelector('[data-rc-account]').addEventListener('input',e=>{if(state.busy)return;state.account=e.target.value;state.clientId='';state.lastPostings=null;root.querySelector('[data-rc-postings]')?.remove();state.evidence=[];invalidate();});
 root.querySelector('[data-rc-account]').addEventListener('change',()=>{if(state.busy)return;state.clientId=identifyClient(state.account,clients).id;state.records=[];redraw();});
 root.querySelectorAll('[data-rc-file]').forEach(el=>el.addEventListener('change',()=>{if(!el.files.length)return;clearImportedResults();if(el.dataset.rcFile==='statement')state.selectedStatement=[...el.files];else state.selectedInvoices=[...state.selectedInvoices,...el.files];redraw();}));
 root.querySelector('[data-rc-client]').addEventListener('change',async e=>{if(state.busy)return;state.clientId=e.target.value;state.records=[];state.lastPostings=null;state.evidence=[];clearResults();if(!state.transactions.length&&!state.invoices.length){redraw();return;}state.busy=true;redraw();try{await runMatch();}catch(err){alert('客户变更后核对失败：'+err.message);}finally{state.busy=false;redraw();}});
 root.querySelectorAll('[data-rc-pair]').forEach(el=>el.addEventListener('change',async e=>{if(state.busy)return;const ti=Number(e.target.dataset.rcPair), val=e.target.value, originalMatches=state.matches, originalClient=state.clientId;try{let row={transaction_index:ti,invoice_index:null,status:'review',reasons:['未找到唯一匹配的发票']};if(val!==''){const ii=Number(val),one=await api('/api/reconcile/match',{method:'POST',body:{transactions:[state.transactions[ti]],invoices:[state.invoices[ii]],account_name:state.account,...(state.clientId?{client_id:Number(state.clientId)}:{})}});row={transaction_index:ti,invoice_index:ii,status:'review',manual_pair:true,reasons:['人工指定配对，请核对后确认',...(one.matches?.[0]?.reasons||[])]};}if(state.matches!==originalMatches||state.clientId!==originalClient)return;const old=state.matches.matches.find(m=>m.transaction_index===ti);if(state.matches.classification_transactions){for(const m of state.matches.matches)if(m.transaction_index===ti||(m.invoice_index!=null&&(m.invoice_index===old?.invoice_index||m.invoice_index===row.invoice_index)))state.matches.classification_transactions[m.transaction_index]=null;}if(state.matches.classification_invoices){if(old?.invoice_index!=null)state.matches.classification_invoices[old.invoice_index]=null;if(row.invoice_index!=null)state.matches.classification_invoices[row.invoice_index]=null;}state.matches.matches=state.matches.matches.filter(m=>m.transaction_index!==ti);state.matches.matches.push(row);delete state.approvals[ti];redraw();}catch(err){alert('配对失败：'+err.message);redraw();}}));
 root.onclick=async e=>{
  if(state.busy)return;
  const removeFile=e.target.closest('[data-rc-remove-file]');if(removeFile){clearImportedResults();const files=removeFile.dataset.rcRemoveFile==='statement'?state.selectedStatement:state.selectedInvoices;files.splice(Number(removeFile.dataset.index),1);redraw();return;}
  const add=e.target.closest('[data-rc-add]');if(add){state[add.dataset.rcAdd].push({...initial[add.dataset.rcAdd]});state.evidence=[];clearResults();redraw();return;}
  const del=e.target.closest('[data-rc-delete]');if(del){state[del.dataset.rcDelete].splice(Number(del.dataset.index),1);state.evidence=[];clearResults();redraw();return;}
  const approve=e.target.closest('[data-rc-approve]');if(approve){const ti=Number(approve.dataset.rcApprove),note=window.prompt('请填写审核意见及确认依据：');if(note?.trim()){state.approvals[ti]=note.trim();redraw();}return;}
  const save=e.target.closest('[data-rc-save]');if(save)return;
  const resume=e.target.closest('[data-rc-resume]');if(resume){const id=resume.dataset.rcResume;state.busy=true;redraw();try{const latest=await api('/api/reconcile/records?client_id='+encodeURIComponent(state.clientId));state.records=latest.records||[];const record=state.records.find(r=>String(r.id)===id);if(!record)throw new Error('记录不存在或不属于该客户');if(record.voucher_id){alert('该记录已入账，请查看历史记录。');return;}state.transactions=[{...record.transaction}];state.invoices=[{...record.invoice}];state.account=record.account_name||clients.find(c=>String(c.id)===String(state.clientId))?.name||'';state.accountNeedsReview=false;state.sample=false;state.evidence=[{...(record.evidence||{})}];state.lastPostings=null;clearResults();await runMatch();}catch(err){alert('继续处理失败：'+err.message);}finally{state.busy=false;redraw();}return;}
  const button=e.target.closest('[data-rc-action]');if(!button)return;
  if(button.dataset.rcAction==='show-balance'){if(state.lastPostings&&onPosted){try{await onPosted(state.lastPostings);}catch(err){alert('已保存，但打开余额表失败：'+err.message);}}return;}
  if(button.dataset.rcAction==='preview'){state.busy=true;redraw();await runPreview();state.busy=false;redraw();return;}
  if(button.dataset.rcAction==='history'){if(!state.clientId){alert('请先选择客户。');return;}try{const result=await api('/api/reconcile/records?client_id='+encodeURIComponent(state.clientId));state.records=result.records||[];if(!state.records.length)alert('该客户暂无已保存的核对记录。');redraw();}catch(err){alert('读取失败：'+err.message);}return;}
  if(button.dataset.rcAction==='sample'){state.transactions=[{date:'2026-09-09',amount:'-112000.00',counterparty:'北京超建邦科技有限公司',note:'服务费',source:'样本演示'},{date:'2026-09-17',amount:'-103000.00',counterparty:'北京超建邦科技有限公司',note:'服务费',source:'样本演示'}];state.invoices=[{date:'2026-09-08',amount:'112000.00',seller:'北京超建邦科技有限公司',buyer:'鸿悦盛嘉（北京）医院管理有限公司',number:'26112000003789636136',source:'样本演示'},{date:'2026-09-17',amount:'103000.00',seller:'北京超建邦科技有限公司',buyer:'鸿悦盛嘉（北京）医院管理有限公司',number:'26112000003941516416',source:'样本演示'}];state.account='鸿悦盛嘉（北京）医院管理有限公司';state.clientId=identifyClient(state.account,clients).id;state.accountNeedsReview=false;state.accountFromOCR=false;state.sample=true;state.lastPostings=null;state.evidence=[];state.warnings=[];state.progress=null;state.importChanged=false;state.selectedStatement=[];state.selectedInvoices=[];state.sourceFiles.forEach(f=>URL.revokeObjectURL(f.url));state.sourceFiles=[];clearResults();try{await runMatch();}catch(err){alert('核对失败：'+err.message);}redraw();return;}
  if(button.dataset.rcAction==='parse'){
   const statement=state.selectedStatement, invoices=state.selectedInvoices;
   if(!statement.length&&!invoices.length){alert('请先选择交易清单或发票文件。');return;}
   if([...statement,...invoices].reduce((sum,f)=>sum+f.size,0)>10*1024*1024){alert('文件合计超过 10 MB，请分批处理。');return;}
   const selected=[...statement,...invoices], page=root.querySelector('.rc-root'), generation=++parseGeneration;
   activeParsePage=page;
   const current=()=>generation===parseGeneration && page.isConnected && root.contains(page);
   const controls=[...root.querySelectorAll('input,select,button')].map(el=>[el,el.disabled]);
   const restore=()=>controls.forEach(([el,disabled])=>{el.disabled=disabled;});
   state.busy=true; controls.forEach(([el])=>{el.disabled=true;});button.textContent='正在识别并核对…';
   showProgress(root,{status:'running',elapsed_seconds:0,files:[]});
   try{
    const body={statement:statement[0]?await fileBase64(statement[0]):null,invoices:await Promise.all(invoices.map(fileBase64))};
    if(!current())return;
    const started=await api('/api/reconcile/parse/start',{method:'POST',body});
    if(!current())return;
    let progress;
    do {
     progress=await api('/api/reconcile/parse/progress?job_id='+encodeURIComponent(started.job_id));
     if(!current())return;
     showProgress(root,progress);
     if(progress.status==='failed')throw new Error(progress.error||'识别失败');
     if(progress.status==='running'){await waitForProgress();if(!current())return;}
    } while(progress.status==='running');
    if(progress.status!=='completed'||!progress.result)throw new Error('识别任务返回了无效结果');
    const parsed=progress.result, transactions=parsed.transactions||[], parsedInvoices=parsed.invoices||[], account=parsed.account_name||inferOwnName(transactions,parsedInvoices);
    const identified=identifyClient(account,clients); state.clientId=identified.id; state.records=[];
    let matches=null,matchError=null;
    if(transactions.length||parsedInvoices.length){try{matches=await api('/api/reconcile/match',{method:'POST',body:{transactions,invoices:parsedInvoices,account_name:account,account_needs_review:!!account,...(state.clientId?{client_id:Number(state.clientId)}:{})}});}catch(err){matchError=err;}}
    if(!current())return;
    state.account=account;state.accountFromOCR=!!account;state.accountNeedsReview=!!account;
    state.transactions=transactions;state.invoices=parsedInvoices;state.evidence=[];
    state.warnings=[...(parsed.warnings||[]),...(selected.some(f=>/\.zip$/i.test(f.name))?['ZIP 内文件请自行解压查看原件；原件不会保存。']:[])];
    state.sample=false;state.importChanged=false;state.lastPostings=null;state.progress=progress;state.sourceFiles.forEach(f=>URL.revokeObjectURL(f.url));state.sourceFiles=selected.filter(f=>!/\.zip$/i.test(f.name)).map(f=>({name:f.name,url:URL.createObjectURL(f)}));
    clearResults();state.matches=matches;state.hasMatched=!!matches;if(matches)await runPreview();state.busy=false;redraw();if(matchError)alert('识别完成，但自动核对失败，请点击开始核对：'+matchError.message);
   }catch(err){if(current()){state.busy=false;restore();button.textContent='识别文件';root.querySelectorAll('[data-rc-progress]').forEach(target=>{target.hidden=false;target.textContent='识别失败：'+err.message;});alert('识别失败：'+err.message);}}
   finally{if(generation===parseGeneration){if(!current())state.busy=false;activeParsePage=null;}}
   return;
  }
  if(button.dataset.rcAction==='match'){if(!state.transactions.length&&!state.invoices.length){alert('请先导入或填写交易和发票。');return;}state.busy=true;root.querySelectorAll('input,select,button').forEach(x=>x.disabled=true);button.textContent='正在核对…';try{await runMatch();state.busy=false;redraw();}catch(err){state.busy=false;alert('核对失败：'+err.message);redraw();}}
 };
}

export const reconcileIdentityTest = {identifyClient, inferOwnName};
