import { renderRuleSearch, bindRuleSearch } from './reconcile-rules.js';
import { openSourceArchive } from './source-archive.js';
const createState = () => ({transactions: [], invoices: [], receipts: [], receiptPostings: {}, account: '', accountNeedsReview:false, accountFromOCR:false, matches: null, hasMatched:false, warnings: [], sample: false, busy: false, posting: false, approvals: {}, saved: {}, clientId: '', archiveId:'', records: [], historyPostings:[],historyStatus:'idle',historyError:'',historyGeneration:0,historyClientId:'',historyTotal:0,historyTruncated:false, sourceFiles: [], progress:null, preview:null, previewError:'', evidence:[], accountNames:{}, bookAccounts:[],lastPostings:null,selectedStatement:[],selectedInvoices:[],importChanged:false});
let state = createState(), scopeClientId = '', scopeGeneration = 0;
let parseGeneration=0, activeParsePage=null;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Replace the object so an earlier company's pending callbacks retain only its old state.
export function resetReconcile(){parseGeneration++;scopeGeneration++;activeParsePage=null;state.sourceFiles.forEach(f=>URL.revokeObjectURL(f.url));state=createState();scopeClientId='';}
function reconcileScope(clients,options){
 const client=options.client||null,id=client?String(client.id):'';
 if(id!==scopeClientId){resetReconcile();scopeClientId=id;if(client)state.account=client.enterprise_name||client.name||'';}
 if(client)state.clientId=id;
 return {client,clients:client?[client]:clients,state,generation:scopeGeneration};
}
export function setReconcileCompany(client){reconcileScope([],{client});}
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
function receiptLabel(ti) {
 if(!state.receipts.length)return '';
 const m=state.matches?.receipt_matches?.matches?.find(x=>x.transaction_index===ti), r=m&&m.receipt_index!=null?state.receipts[m.receipt_index]:null;
 if(!m)return '<span class="rc-badge review">回单待核对</span>';
 if(m.status==='matched')return `<span class="rc-badge ok">回单相符</span> ${esc(r?.number||'')}`;
 return `<span class="rc-badge review">${m.status==='missing'?'无回单':'回单待确认'}</span> ${esc((m.reasons||[]).join('；'))}${r?` · ${esc(r.number)}`:''}`;
}
function receiptRows() {
 if(!state.receipts.length)return '';
 const result=state.matches?.receipt_matches, matched=new Map((result?.matches||[]).filter(m=>m.receipt_index!=null).map(m=>[m.receipt_index,m]));
 const status=(i)=>{const m=matched.get(i);if(m)return `<span class="rc-badge ${m.status==='matched'?'ok':'review'}">${m.status==='matched'?'相符':'待确认'}</span> 交易第 ${m.transaction_index+1} 条`;return result?'<span class="rc-badge review">未匹配流水</span>':'待核对';};
 const done=(result?.matches||[]).filter(m=>m.status==='matched').length;
 return `<div class="rc-subhead"><h3>银行回单 <small>${state.receipts.length} 张${result?` · 已匹配 ${done} 张`:''}</small></h3></div><div class="rc-scroll"><table class="rc-edit"><thead><tr><th>回单编号</th><th>日期</th><th>金额（元）</th><th>交易对方</th><th>摘要</th><th>匹配结果</th></tr></thead><tbody>${state.receipts.map((r,i)=>`<tr><td title="${esc(r.source)}">${esc(r.number)}</td><td>${esc(r.date)}</td><td>${esc(r.amount)}</td><td>${esc(r.counterparty||'—')}</td><td>${esc(r.note)}</td><td>${status(i)}</td></tr>`).join('')}</tbody></table></div>`;
}
const SMALL_STANDARD_SOURCE='https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852734144.pdf';
function safeSourceLink(raw, label) {
 try {const url=new URL(raw);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return '';return `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;}catch{return '';}
}
function classificationMarkup(item, standard) {
 item=item?.rule_suggestion || item;
 if(!item) return `<div class="rc-reasons"><b>流水科目建议：待确定</b><br>缺少分类结果，请重新核对。</div>`;
 const subject=item.account_code ? `${esc(item.account_code)} ${esc(item.account_name || '')}${item.sub_account?` — ${esc(item.sub_account)}`:''}` : item.account_name ? `${esc(item.account_name)}（账套末级科目待确定）` : '无法唯一确定';
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
function successFirst(rows, isSuccess) {
 const success=[], pending=[];
 for(const row of rows)(isSuccess(row)?success:pending).push(row);
 return [...success,...pending];
}
// Reorder display references only: transaction/invoice/evidence indices belong to
// the original import. A saved record awaiting review is still pending.
export function orderReconcileResults(rows, matches=[]) {
 const groups=groupReconcileResults(rows,matches);
 return [...groups.success,...groups.pending];
}
const receiptMatched=ti=>state.matches?.receipt_matches?.matches?.some(m=>m.transaction_index===ti&&m.status==='matched')||false;
function groupReconcileResults(rows, matches=[]) {
 const groups={success:[],pending:[]};
 for(const row of rows){
  const success=['posted','ready'].includes(row.status) || state.receiptPostings?.[row.transaction_index]?.status==='posted';
  groups[success?'success':'pending'].push(row);
 }
 return groups;
}
export function reconcilePostingState(row={},receipt={}) {
 const posted=row.status==='posted'?row:receipt?.status==='posted'?receipt:null;
 return {posted:Boolean(posted),reference:posted?.voucher_ref||(posted?.voucher_id?`凭证 #${posted.voucher_id}`:''),lines:posted?.posted_lines||posted?.lines||[],reason:posted?'':(receipt?.status==='review'?receipt.reason:'')||row.reason||''};
}
export function reconcileVoucherTarget(row={},clientId) {
 const voucherId=Number(row.voucher_id),cid=Number(clientId);
 const period=String(row.period||row.voucher_date||row.transaction?.date||row.date||'').slice(0,7);
 if(!Number.isSafeInteger(cid)||cid<1||!Number.isSafeInteger(voucherId)||voucherId<1||!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))throw new Error('凭证定位信息不完整，请刷新已保存记录');
 return {clientId:cid,voucherId,period};
}
export function reconcileHistoryRows(records=[],postings=[]) {
 const byVoucher=new Map(),pending=[];
 for(const record of records){
  const item={...record,record_id:record.record_id||record.id};
  if(Number(item.voucher_id)>0)byVoucher.set(String(item.voucher_id),item);else pending.push(item);
 }
 for(const posting of postings){
  if(!(Number(posting?.voucher_id)>0))continue;
  const key=String(posting.voucher_id),previous=byVoucher.get(key)||{};
  byVoucher.set(key,{...previous,...posting,record_id:posting.record_id||previous.record_id,transaction:posting.transaction||previous.transaction,invoice:posting.invoice||previous.invoice});
 }
 return [...byVoucher.values(),...pending].sort((a,b)=>String(b.voucher_date||b.transaction?.date||b.created_at||'').localeCompare(String(a.voucher_date||a.transaction?.date||a.created_at||''))||Number(b.voucher_id||b.record_id||0)-Number(a.voucher_id||a.record_id||0));
}
function viewVoucherButton(row, label='查看凭证') {
 try{const target=reconcileVoucherTarget(row,state.clientId);return `<button type="button" class="rc-secondary small" data-rc-view-voucher="${target.voucherId}" data-period="${esc(target.period)}">${label}</button>`;}catch{return '';}
}
function historyMarkup() {
 const rows=reconcileHistoryRows(state.records,state.historyPostings||[]);
 return `<section class="rc-panel rc-saved-panel" aria-label="已保存的核对凭证"><div class="rc-panel-head"><div><h2>已保存的核对凭证${rows.length?`（${rows.length}）`:''}</h2><p>包含当前客户以往月份的核对记录及回单凭证，点击查看会自动进入凭证所属月份。</p></div><button type="button" class="rc-secondary small" data-rc-action="history" ${state.historyStatus==='loading'?'disabled':''}>${state.historyStatus==='loading'?'正在读取…':'刷新已保存记录'}</button></div>${state.historyError?`<p class="rc-history-error" role="alert">读取已保存记录失败：${esc(state.historyError)}。可点击上方按钮重试。</p>`:''}${rows.length?`<div class="rc-scroll"><table class="rc-history-table"><thead><tr><th>日期 / 凭证字号</th><th>交易对方 / 摘要</th><th>金额（元）</th><th>操作</th></tr></thead><tbody>${rows.map(row=>{
  const date=row.voucher_date||row.transaction?.date||'',amount=row.transaction?.amount??row.invoice?.amount??((row.posted_lines||[]).reduce((sum,line)=>sum+Number(line.debit_fen||0),0)/100).toFixed(2);
  const posted=Number(row.voucher_id)>0;
  return `<tr><td>${esc(date)}<br><strong>${posted?esc(row.voucher_ref||'凭证 #'+row.voucher_id):'尚未生成凭证'}</strong></td><td>${esc(row.transaction?.counterparty||'—')}${row.summary||row.transaction?.note?`<br><small>${esc(row.summary||row.transaction?.note)}</small>`:''}</td><td>${esc(amount)}</td><td><div class="rc-history-actions">${posted?viewVoucherButton(row):['matched','reviewed'].includes(row.status)&&row.record_id?`<button type="button" class="rc-link" data-rc-resume="${esc(row.record_id)}">继续匹配科目</button>`:'待核对'}${posted||row.archive_id||row.archive_ids?.length?`<button type="button" class="rc-link" data-rc-source-archive="${esc(row.archive_id||row.archive_ids?.[0]||'')}" data-voucher-id="${esc(row.voucher_id||'')}" data-record-id="${esc(row.record_id||'')}">原件与依据</button>`:''}</div></td></tr>`;
 }).join('')}</tbody></table></div>`:`<div class="rc-empty" role="status">${state.historyStatus==='idle'||state.historyStatus==='loading'?'正在读取已保存记录…':state.historyError?'暂未读取到记录，请重试。':'当前客户暂无已保存的核对记录或核对凭证。'}</div>`}${state.historyTruncated?`<p class="rc-history-error">已显示最近 ${esc(state.historyPostings?.length||0)} 张核对凭证，共 ${esc(state.historyTotal)} 张。更早凭证可在账簿按月份查看。</p>`:''}</section>`;
}
function pendingPostingRows(currentState=state) {
 const state=currentState;
 const matches=state.matches?.matches||[];
 return state.transactions.map((_,ti)=>{
  const match=matches.find(m=>m.transaction_index===ti), receipt=state.receiptPostings?.[ti];
  const reason=!state.clientId?'请选择本方客户账套后自动入账。':receipt?.status==='review'?receipt.reason:state.previewError||(match?.reasons||[]).join('；')||'未收到该笔入账结果，请重新处理。';
  return {transaction_index:ti,invoice_index:match?.invoice_index??null,status:state.posting?'processing':'review',reason:state.posting?'':reason};
 });
}
function resultRows(clients) {
 if(!state.matches) return '<div class="rc-empty rc-result-empty">识别完成后将自动核对全部数据；修改数据后请重新核对。</div>';
 const matches=state.matches.matches||[];
 const groups=groupReconcileResults(state.preview?.rows || pendingPostingRows(),matches);
 const standard=clients.find(c=>String(c.id)===String(state.clientId))?.standard;
 const rowMarkup=row=>{const ti=row.transaction_index, t=state.transactions[ti]||{}, inv=state.invoices[row.invoice_index]||{}, voucher=row.voucher||{}, lines=row.status==='posted'?(row.posted_lines||[]):(voucher.lines||[]), match=matches.find(m=>m.transaction_index===ti), matched=match?.status==='matched' && match.invoice_index===row.invoice_index;
 const receiptPost=row.status==='posted'?null:state.receiptPostings?.[ti], noInvoice=!state.invoices.length, receiptOk=!matched&&receiptMatched(ti), matchLabel=matched?'核对通过':receiptOk?'回单核对通过':noInvoice?'未上传发票':'待匹配发票';
 const receiptMatch=state.matches.receipt_matches?.matches?.find(m=>m.transaction_index===ti&&m.status==='matched'), receipt=receiptMatch?state.receipts[receiptMatch.receipt_index]:null;
 const documentLabel=receiptOk?`银行回单 ${receipt?.number||''}`:inv.number||(noInvoice?'无发票':'待匹配');
 const matchReason=matched?'':receiptOk?'流水与银行回单的日期、收付款金额一致。':noInvoice?'本次未上传发票，仅按流水给出科目建议，暂不生成凭证；上传对应发票后可核对并入账。':(match?.reasons||['未找到唯一匹配发票']).join('；');
 const classification=classificationMarkup(row.classification || state.matches.classification_transactions?.[ti] || (matched ? state.matches.classification_invoices?.[row.invoice_index] : null),standard);
 const outcome=reconcilePostingState(row,receiptPost), posting=outcome.posted?'已入账 · '+outcome.reference:row.status==='ready'?'可入账（样本）':row.status==='processing'&&state.posting?'正在核对入账':'未入账';
 const receiptDone=receiptPost?.status==='posted', processReason=outcome.reason;
 const receiptLines=receiptPost?.lines?`<div><b>已入账分录（${esc(receiptPost.voucher_ref)}）</b>${receiptPost.lines.map(l=>`<div>${l.debit_fen?'借':'贷'}：${esc(l.account_code)} ${esc(l.account_name)} ¥ ${(Number(l.debit_fen||l.credit_fen)/100).toFixed(2)}</div>`).join('')}</div>`:'';
 return `<tr data-rc-transaction="${ti}"><td>${esc(t.date)}<br><b>¥ ${esc(t.amount)}</b><br>交易对方：${esc(row.counterparty||t.counterparty)}<br>${receiptLabel(ti)}</td><td>${esc(documentLabel)}<br>本方：${esc(state.account)}</td><td><span class="rc-badge ${matched||receiptOk?'ok':'review'}">${matchLabel}</span> <span class="rc-badge ${['ready','posted','expense_classified'].includes(row.status)||receiptDone?'ok':'review'}">${posting}</span><div class="rc-reasons">${esc(matchReason)}${processReason?`<br>处理结果：${esc(processReason)}`:''}${row.basis?`<br>判断依据：${esc(Array.isArray(row.basis)?row.basis.join('；'):typeof row.basis==='string'?row.basis:JSON.stringify(row.basis))}`:''}</div>${outcome.posted?`<div class="rc-history-actions">${viewVoucherButton({...row,...(receiptPost?.status==='posted'?receiptPost:{}),transaction:t})}<button type="button" class="rc-link" data-rc-source-archive="" data-voucher-id="${esc(row.voucher_id||receiptPost?.voucher_id)}">原件与凭证依据</button></div>`:''}${receiptLines}${lines.length?`<div><b>${row.status==='posted'?'已入账分录':`拟入账分录（${esc(voucher.date)}）`}</b>${lines.map(l=>`<div>${lineText(l,row)}</div>`).join('')}</div>`:''}${row.expense_classification?`<div><b>发票核对：${esc(row.expense_classification.account_code)} ${esc(row.expense_classification.account_name)} · -${(Number(row.expense_classification.amount_fen||0)/100).toFixed(2)} 元（${state.sample?'分类预览':'已归入余额表'}）</b></div>`:''}${classification}${multiInvoiceMarkup(ti)}${state.clientId && !outcome.posted && row.status!=='ready'?evidenceFields(ti):''}</td></tr>`;};
 const unmatchedIndices=state.preview?.unmatched_invoices||state.matches.unmatched_invoices||[];
 const unmatched=unmatchedIndices.map(ii=>`<tr data-rc-unmatched-invoice="${ii}"><td>无匹配流水</td><td>${esc(state.invoices[ii]?.number||'发票待确认')}</td><td><span class="rc-badge review">待匹配</span> 请核对该发票对应流水。</td></tr>`).join('');
 const groupMarkup=(kind,title,rows,extra='',extraCount=0)=>`<tbody class="rc-result-group rc-result-${kind}" data-rc-result-group="${kind}" aria-label="${title}"><tr class="rc-result-group-heading"><th colspan="3" scope="rowgroup">${title}（${rows.length+extraCount}）</th></tr>${rows.map(rowMarkup).join('')+extra||`<tr><td colspan="3" class="rc-empty">${kind==='success'?'暂无已通过的记录':'暂无待匹配 / 待处理的记录'}</td></tr>`}</tbody>`;
 return `<div class="rc-scroll"><table class="rc-results"><thead><tr><th>收支交易</th><th>发票及本方</th><th>核对状态及科目结果</th></tr></thead>${groupMarkup('success','已通过',groups.success)}${groupMarkup('pending','待匹配 / 待处理',groups.pending,unmatched,unmatchedIndices.length)}</table></div>`;
}
export function renderReconcile(clients=[],options={}){
 const scope=reconcileScope(clients,options);clients=scope.clients;
 if(activeParsePage && !activeParsePage.isConnected){parseGeneration++;activeParsePage=null;state.busy=false;}
 const identified=identifyClient(state.account,clients);
 const renderedRows=state.preview?.rows||pendingPostingRows();
 const pending=state.matches?groupReconcileResults(renderedRows).pending.length+(state.preview?.unmatched_invoices||state.matches.unmatched_invoices||[]).length:0;
 const postedCount=new Set([...renderedRows,...Object.values(state.receiptPostings||{})].filter(r=>r.status==='posted').map(r=>r.transaction_index)).size;
 return `<div class="rc-root"><div class="rc-header"><div><div class="rc-eyebrow">${scope.client?esc(scope.client.name):'票据'} / 流水发票核对</div><h1>流水发票核对 <span class="rc-version">体验版</span></h1><p>一份收支交易清单，对照多张发票。收款或付款的金额和公司名称有差异时，请人工审核。</p></div><button type="button" class="rc-secondary" data-rc-action="sample">载入样本演示</button></div>
 ${state.sample?'<div class="rc-sample">当前为合成样本演示，企业、日期、金额和发票号码均为虚构，仅供体验，不会写入业务数据。</div>':''}
 <div class="rc-steps"><span><b>1</b> 导入文件</span><i></i><span><b>2</b> 核对数据</span><i></i><span><b>3</b> 查看分类及处理结果</span></div>
 ${historyMarkup()}
 <section class="rc-panel"><div class="rc-panel-head"><div><h2>导入单据</h2><p>支持 PDF、图片或 ZIP；识别完成后自动核对和处理，无法识别的数据可以手工补充。识别成功后，原件与识别结果保存在本地；入账后可从凭证查看原件与核对依据。</p></div></div><div class="rc-upload-grid">${uploadMarkup('statement','收支交易清单','选择一份 PDF、图片或 ZIP',state.selectedStatement)}${uploadMarkup('invoices','发票文件','可多选 PDF、图片或 ZIP',state.selectedInvoices)}</div><div class="rc-selected"><span>可移除误选文件或 ZIP，重新选择后再识别。</span><button type="button" class="rc-primary" data-rc-action="parse" ${state.busy?'disabled':''}>${state.busy?'正在识别…':'识别文件'}</button></div>${state.importChanged?'<div class="rc-import-notice" role="status">文件已变更，上次识别和核对结果已清除，请重新识别。已保存或已入账的记录不会因移除文件而撤销；请在对应客户的已保存记录中查看。</div>':''}<div class="rc-warnings">${state.warnings.map(w=>`<div>⚠ ${esc(w)}</div>`).join('')}</div><div class="rc-archive-status">${state.archiveId?`<span>本批原件已归档</span><button type="button" class="rc-link" data-rc-source-archive="${esc(state.archiveId)}">查看已归档原件</button>`:''}</div><div class="rc-originals">${state.sourceFiles.map((f,i)=>`<a href="${esc(f.url)}" target="_blank" rel="noopener">查看原件：${esc(f.name)}</a>`).join('')}</div></section>
 <section class="rc-panel"><div class="rc-panel-head"><div><h2>核对数据</h2><p>识别后自动逐条核对；机器识别结果可在此修改，修改后请重新核对。请依据原件补充发票项目和实际用途，多个项目用分号分隔；未知税额留空，不要填零。</p></div><div class="rc-account"><label>本方公司名称 <input type="text" data-rc-account value="${esc(state.account)}" ${state.busy?'disabled':''} placeholder="付款核对购买方，收款核对销售方"></label></div></div><div class="rc-subhead"><h3>收支交易 <small>${state.transactions.length} 条</small></h3><button type="button" class="rc-secondary small" data-rc-add="transactions">＋ 添加交易</button></div>${editRows('transactions')}<div class="rc-subhead"><h3>发票 <small>${state.invoices.length} 张</small></h3><button type="button" class="rc-secondary small" data-rc-add="invoices">＋ 添加发票</button></div>${editRows('invoices')}${receiptRows()}<div class="rc-bottom"><span>付款金额请填写负数，收款填写正数；发票金额填写价税合计。</span><button type="button" class="rc-primary" data-rc-action="match" ${state.busy?'disabled':''} ${state.matches?'hidden':''}>${state.hasMatched?'重新核对':'开始核对'}</button></div></section>
 <section class="rc-panel"><div class="rc-panel-head"><div><h2>核对结果</h2><p>核对通过后按发票和清单推荐业务科目，并显示收支方向。发票或回单与流水匹配成功后直接生成凭证入账，不再停留在科目推荐或补资料步骤。每笔款项显示日期、交易对方、用途、金额和入账凭证。自动核对不等于查验发票真伪。<a href="https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852734144.pdf" target="_blank" rel="noopener noreferrer">小企业会计准则附录</a></p><p data-rc-preview-status aria-live="polite">${esc(state.previewError)}</p></div><div class="rc-stats"><span>已入账 <b>${postedCount}</b></span><span>待处理 <b>${pending}</b></span></div></div>${resultRows(clients)}${state.lastPostings?`<div class="notice" data-rc-postings><strong>处理结果：${esc(state.lastPostings.clientName)}</strong>${state.lastPostings.classifications.length?`<div>已归入余额表 ${state.lastPostings.classifications.length} 笔发票核对款项。</div>`:''}${state.lastPostings.postings.map(p=>`<div>凭证 #${esc(p.voucher_id)} · ${esc(p.period)} ${viewVoucherButton(p)}${(p.posted_lines||[]).map(l=>`<div>${esc(l.account_code)} ${esc(l.account_name)} · 借 ${(Number(l.debit_fen||0)/100).toFixed(2)} · 贷 ${(Number(l.credit_fen||0)/100).toFixed(2)} 元</div>`).join('')}</div>`).join('')}<button type="button" class="rc-secondary" data-rc-action="show-balance">查看余额表</button></div>`:''}<div class="rc-submit"><label class="rc-client">${scope.client?'当前账套':'保存至客户'} <select data-rc-client ${state.busy||scope.client?'disabled':''}>${scope.client?'':'<option value="">请选择客户</option>'}${clients.map(c=>`<option value="${esc(c.id)}" ${String(c.id)===String(state.clientId)?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label><span data-rc-validation-hint>${esc(identified.basis)} ${state.clientId?'所选客户用于本方账套；交易对手方另行显示。':'请先选择本方客户账套。'}匹配成功后直接入账，余额表按编号类目汇总，可导出全账套总表。</span><button type="button" class="rc-secondary" data-rc-action="preview" ${state.busy||!state.matches||!state.clientId?'disabled':''}>重新处理</button><button type="button" class="rc-secondary" data-rc-action="history">查看已保存记录</button></div></section>${renderRuleSearch()}</div>`;
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
export function bindReconcile(root, transport, clients=[], onPosted,options={}){
 const scope=reconcileScope(clients,options),state=scope.state;clients=scope.clients;
 const isCurrent=()=>scope.generation===scopeGeneration&&root.isConnected;
 const staleError=()=>Object.assign(new Error('当前公司已切换，本次处理已停止'),{staleReconcile:true});
 // Capture outgoing data and stop later posting steps if the company changed while awaiting a response.
 const api=async(path,request)=>{
  if(!isCurrent())throw staleError();
  const captured=request?.body&&typeof request.body==='object'?{...request,body:structuredClone(request.body)}:request;
  const result=await transport(path,captured);
  if(!isCurrent())throw staleError();
  return result;
 };
 const notify=message=>{if(isCurrent())alert(message);};
 const redraw=()=>{if(!isCurrent())return;root.innerHTML=renderReconcile(clients,options);bindReconcile(root,transport,clients,onPosted,options);};
 bindRuleSearch(root,api,()=>state.clientId);
 const paintHistory=()=>{if(!isCurrent())return;const panel=root.querySelector('.rc-saved-panel');if(panel)panel.outerHTML=historyMarkup();else if(!state.busy&&!state.posting)redraw();};
 const refreshHistory=async()=>{
  const clientId=state.clientId;if(!clientId)return;
  const token=++state.historyGeneration;
  state.historyClientId=clientId;state.historyStatus='loading';state.historyError='';paintHistory();
  try{
   const result=await api('/api/reconcile/records?client_id='+encodeURIComponent(clientId));
   if(!isCurrent()||state.clientId!==clientId||token!==state.historyGeneration)return;
   state.records=Array.isArray(result.records)?result.records:[];state.historyPostings=Array.isArray(result.postings)?result.postings:[];
   state.historyTotal=result.postings_total||state.historyPostings.length;state.historyTruncated=!!result.postings_truncated;state.historyStatus='loaded';
  }catch(error){
   if(!isCurrent()||state.clientId!==clientId||token!==state.historyGeneration)return;
   state.historyStatus='error';state.historyError=error.message||String(error);
  }finally{if(isCurrent()&&state.clientId===clientId&&token===state.historyGeneration)paintHistory();}
 };
 const clearResults=()=>{state.matches=null;state.preview=null;state.previewError='';state.approvals={};state.receiptPostings={};};
 const clearImportedResults=()=>{if(!state.progress&&!state.sample)return;state.sourceFiles.forEach(f=>URL.revokeObjectURL(f.url));Object.assign(state,{transactions:[],invoices:[],receipts:[],receiptPostings:{},account:scope.client?(scope.client.enterprise_name||scope.client.name||''):'',accountNeedsReview:false,accountFromOCR:false,hasMatched:false,warnings:[],sample:false,clientId:scope.client?String(scope.client.id):'',sourceFiles:[],archiveId:'',progress:null,evidence:[],accountNames:{},bookAccounts:[],lastPostings:null,importChanged:true});clearResults();};
 const invalidate=()=>{clearResults();const matchButton=root.querySelector('[data-rc-action=match]');if(matchButton){matchButton.hidden=false;matchButton.textContent=state.hasMatched?'重新核对':'开始核对';}root.querySelector('[data-rc-pending]')?.remove();const hint=root.querySelector('[data-rc-validation-hint]');if(hint)hint.textContent=(state.clientId?'数据已修改，请重新核对以校验所选客户账套科目。':'请选择客户并重新核对该账套的科目。')+'匹配成功后直接入账，余额表按编号类目汇总，可导出全账套总表。';const result=root.querySelector('.rc-results,.rc-result-empty');if(result)result.outerHTML='<div class="rc-empty rc-result-empty">数据已修改，请重新核对。</div>';root.querySelectorAll('.rc-stats b').forEach(x=>x.textContent='—');root.querySelectorAll('[data-rc-save]').forEach(x=>x.disabled=true);};
 const batchPayload=()=>({client_id:Number(state.clientId),...(state.archiveId?{archive_id:state.archiveId}:{}),account_name:state.account,account_needs_review:state.accountNeedsReview,transactions:state.transactions,invoices:state.invoices,receipts:state.receipts,evidence:state.transactions.map((_,i)=>submittedEvidence(state.evidence[i]||{}))});
 const runReceiptPost=async()=>{state.receiptPostings={};if(state.sample||!state.receipts.length||!state.matches?.receipt_matches?.matches?.some(m=>m.status==='matched'))return;try{const out=await api('/api/reconcile/receipt-post',{method:'POST',body:{client_id:Number(state.clientId),...(state.archiveId?{archive_id:state.archiveId}:{}),account_name:state.account,transactions:state.transactions,invoices:state.invoices,receipts:state.receipts}});state.receiptPostings=Object.fromEntries((out.rows||[]).map(r=>[r.transaction_index,r]));}catch(err){state.previewError='回单流水生成凭证失败：'+err.message;}};
 const runPreview=async()=>{
  state.preview=null;state.lastPostings=null;state.previewError='';state.posting=true;
  const summarize=()=>{
   const unique=new Map();
   for(const row of [...(state.preview?.rows||[]),...Object.values(state.receiptPostings||{})]){
    if(row.status!=='posted'||!row.voucher_id)continue;
    unique.set(row.voucher_id,{voucher_id:row.voucher_id,period:row.period||String(row.voucher_date||row.date||state.transactions[row.transaction_index]?.date||'').slice(0,7),posted_lines:row.posted_lines||row.lines||[]});
   }
   if(unique.size){const client=clients.find(c=>String(c.id)===String(state.clientId));state.lastPostings={clientId:Number(state.clientId),startPeriod:client?.start_period,clientName:state.preview?.client_name||client?.enterprise_name||client?.name||'',postings:[...unique.values()],classifications:[]};}
  };
  try{
   if(!state.clientId){state.previewError='请选择本方客户账套后自动入账。';return;}
   await runReceiptPost();
   if(state.invoices.length){
    try{
     const result=await processReconcileBatch(api,batchPayload(),state.sample);
     if(!Array.isArray(result?.rows)||result.rows.length!==state.transactions.length||!result.rows.every(row=>row&&Number.isInteger(row.transaction_index)&&row.transaction_index>=0&&row.transaction_index<state.transactions.length)||new Set(result.rows.map(row=>row.transaction_index)).size!==state.transactions.length)throw new Error('未收到完整的入账结果');
     state.preview=result;
     if(!state.sample){
      try{
       await api('/api/reconcile/retry-saved',{method:'POST',body:{client_id:Number(state.clientId)}});
       if(state.records.length){const history=await api('/api/reconcile/records?client_id='+encodeURIComponent(state.clientId));state.records=history.records||[];}
      }catch(err){state.previewError=[state.previewError,'历史匹配记录处理失败：'+err.message].filter(Boolean).join('；');}
     }
    }catch(err){state.previewError=[state.previewError,'自动入账失败：'+err.message+'。请重新处理。'].filter(Boolean).join('；');}
   }
  }finally{
   state.posting=false;
   const rows=new Map((state.preview?.rows||[]).map(row=>[row.transaction_index,row]));
   state.preview={...(state.preview||{}),rows:pendingPostingRows(state).map(row=>rows.get(row.transaction_index)||row)};
   if(state.preview.rows.every(row=>reconcilePostingState(row,state.receiptPostings?.[row.transaction_index]).posted||row.status==='ready'))state.previewError='';
   summarize();if(!state.sample){state.historyGeneration++;state.historyStatus='idle';}
  }
  // Optional names and evidence selectors load after the final posting result.
  // A slow display request must not keep the accounting result on a spinner.
  const period=String(state.transactions.find(t=>/^\d{4}-\d{2}/.test(t.date||''))?.date||'').slice(0,7), preview=state.preview, clientId=state.clientId;
  if(period&&state.invoices.length){
   state.bookAccounts=[];state.accountNames={};
   void api(`/api/books/${encodeURIComponent(clientId)}?period=${encodeURIComponent(period)}`).then(book=>{
    if(state.preview!==preview||state.clientId!==clientId)return;
    state.bookAccounts=book.accounts||[];state.accountNames=Object.fromEntries(state.bookAccounts.map(a=>[String(a.code),a.name]));
    if(!state.busy&&root.isConnected&&root.querySelector('.rc-root'))redraw();
   }).catch(()=>{});
  }
 };
 const runMatch=async()=>{state.matches=await api('/api/reconcile/match',{method:'POST',body:{...(state.archiveId?{archive_id:state.archiveId}:{}),transactions:state.transactions,invoices:state.invoices,receipts:state.receipts,account_name:state.account,account_needs_review:state.accountNeedsReview,...(state.clientId?{client_id:Number(state.clientId)}:{})}});state.approvals={};state.hasMatched=true;await runPreview();};

 root.querySelectorAll('[data-rc-field]').forEach(el=>el.addEventListener('input',()=>{if(state.busy)return;const row=state[el.dataset.rcField][Number(el.dataset.index)];row[el.dataset.key]=el.value;if(el.dataset.rcField==='transactions')state.evidence[Number(el.dataset.index)]={};else if(!['net_amount','tax_amount'].includes(el.dataset.key))state.evidence=[];if(el.dataset.rcField==='transactions'&&el.dataset.key==='amount'){row.direction_needs_review=false;el.closest('tr')?.querySelector('[data-rc-direction-warning]')?.remove();}invalidate();}));
 const bindEvidence=el=>el.addEventListener(el.tagName==='SELECT'?'change':'input',()=>{if(state.busy)return;const i=Number(el.dataset.index);state.evidence[i] ||= {};changeEvidence(state.evidence[i],el.dataset.rcEvidence,el.value);state.preview=null;const status=root.querySelector('[data-rc-preview-status]');if(status)status.textContent='依据已修改，请重新处理。';if(el.dataset.rcEvidence==='treatment'){const slot=el.closest('details')?.querySelector('[data-rc-funding-slot]');if(slot){slot.innerHTML=fundingMarkup(i,state.evidence[i],state.bookAccounts,state.busy?'disabled':'');slot.querySelectorAll('[data-rc-evidence]').forEach(bindEvidence);}}});
 root.querySelectorAll('[data-rc-evidence]').forEach(bindEvidence);
 root.querySelector('[data-rc-account]').addEventListener('input',e=>{if(state.busy)return;state.account=e.target.value;state.clientId=scope.client?String(scope.client.id):'';state.lastPostings=null;root.querySelector('[data-rc-postings]')?.remove();state.evidence=[];invalidate();});
 root.querySelector('[data-rc-account]').addEventListener('change',()=>{if(state.busy)return;state.clientId=scope.client?String(scope.client.id):identifyClient(state.account,clients).id;state.records=[];redraw();});
 root.querySelectorAll('[data-rc-file]').forEach(el=>el.addEventListener('change',()=>{if(!el.files.length)return;clearImportedResults();if(el.dataset.rcFile==='statement')state.selectedStatement=[...el.files];else state.selectedInvoices=[...state.selectedInvoices,...el.files];redraw();}));
 root.querySelector('[data-rc-client]').addEventListener('change',async e=>{if(state.busy||scope.client)return;const nextClient=e.target.value;if(state.archiveId&&nextClient!==state.clientId){clearImportedResults();state.clientId=nextClient;redraw();return;}state.clientId=nextClient;state.records=[];state.lastPostings=null;state.evidence=[];clearResults();if(!state.transactions.length&&!state.invoices.length){redraw();return;}state.busy=true;redraw();try{await runMatch();}catch(err){notify('客户变更后核对失败：'+err.message);}finally{state.busy=false;redraw();}});
 root.querySelectorAll('[data-rc-pair]').forEach(el=>el.addEventListener('change',async e=>{if(state.busy)return;const ti=Number(e.target.dataset.rcPair), val=e.target.value, originalMatches=state.matches, originalClient=state.clientId;try{let row={transaction_index:ti,invoice_index:null,status:'review',reasons:['未找到唯一匹配的发票']};if(val!==''){const ii=Number(val),one=await api('/api/reconcile/match',{method:'POST',body:{transactions:[state.transactions[ti]],invoices:[state.invoices[ii]],account_name:state.account,...(state.clientId?{client_id:Number(state.clientId)}:{})}});row={transaction_index:ti,invoice_index:ii,status:'review',manual_pair:true,reasons:['人工指定配对，请核对后确认',...(one.matches?.[0]?.reasons||[])]};}if(state.matches!==originalMatches||state.clientId!==originalClient)return;const old=state.matches.matches.find(m=>m.transaction_index===ti);if(state.matches.classification_transactions){for(const m of state.matches.matches)if(m.transaction_index===ti||(m.invoice_index!=null&&(m.invoice_index===old?.invoice_index||m.invoice_index===row.invoice_index)))state.matches.classification_transactions[m.transaction_index]=null;}if(state.matches.classification_invoices){if(old?.invoice_index!=null)state.matches.classification_invoices[old.invoice_index]=null;if(row.invoice_index!=null)state.matches.classification_invoices[row.invoice_index]=null;}state.matches.matches=state.matches.matches.filter(m=>m.transaction_index!==ti);state.matches.matches.push(row);delete state.approvals[ti];redraw();}catch(err){notify('配对失败：'+err.message);redraw();}}));
 root.onclick=async e=>{
  if(state.busy||!isCurrent())return;
  const viewVoucher=e.target.closest('[data-rc-view-voucher]');if(viewVoucher){try{if(typeof options.openVoucher!=='function')throw new Error('凭证查看入口不可用，请重新进入账套');await options.openVoucher(reconcileVoucherTarget({voucher_id:viewVoucher.dataset.rcViewVoucher,period:viewVoucher.dataset.period},state.clientId));}catch(error){notify('打开凭证失败：'+error.message);}return;}
  const sourceButton=e.target.closest('[data-rc-source-archive]');if(sourceButton){try{await openSourceArchive({api,modal:options.modal},{clientId:state.clientId,voucherId:sourceButton.dataset.voucherId,recordId:sourceButton.dataset.recordId,archiveId:sourceButton.dataset.rcSourceArchive});}catch(err){notify('读取原件失败：'+err.message);}return;}
  const removeFile=e.target.closest('[data-rc-remove-file]');if(removeFile){clearImportedResults();const files=removeFile.dataset.rcRemoveFile==='statement'?state.selectedStatement:state.selectedInvoices;files.splice(Number(removeFile.dataset.index),1);redraw();return;}
  const add=e.target.closest('[data-rc-add]');if(add){state[add.dataset.rcAdd].push({...initial[add.dataset.rcAdd]});state.evidence=[];clearResults();redraw();return;}
  const del=e.target.closest('[data-rc-delete]');if(del){state[del.dataset.rcDelete].splice(Number(del.dataset.index),1);state.evidence=[];clearResults();redraw();return;}
  const approve=e.target.closest('[data-rc-approve]');if(approve){const ti=Number(approve.dataset.rcApprove),note=window.prompt('请填写审核意见及确认依据：');if(note?.trim()){state.approvals[ti]=note.trim();redraw();}return;}
  const save=e.target.closest('[data-rc-save]');if(save)return;
  const resume=e.target.closest('[data-rc-resume]');if(resume){const id=resume.dataset.rcResume;state.busy=true;redraw();try{const latest=await api('/api/reconcile/records?client_id='+encodeURIComponent(state.clientId));state.records=latest.records||[];const record=state.records.find(r=>String(r.id)===id);if(!record)throw new Error('记录不存在或不属于该客户');if(record.voucher_id){notify('该记录已入账，请查看历史记录。');return;}state.archiveId=record.archive_id||record.archive_ids?.[0]||'';state.transactions=[{...record.transaction}];state.invoices=[{...record.invoice}];state.receipts=[];state.account=record.account_name||clients.find(c=>String(c.id)===String(state.clientId))?.name||'';state.accountNeedsReview=false;state.sample=false;state.evidence=[{...(record.evidence||{})}];state.lastPostings=null;clearResults();await runMatch();}catch(err){notify('继续处理失败：'+err.message);}finally{state.busy=false;redraw();}return;}
  const button=e.target.closest('[data-rc-action]');if(!button)return;
  if(button.dataset.rcAction==='show-balance'){if(state.lastPostings&&onPosted){try{await onPosted(state.lastPostings);}catch(err){notify('已保存，但打开余额表失败：'+err.message);}}return;}
  if(button.dataset.rcAction==='preview'){state.busy=true;redraw();await runPreview();state.busy=false;redraw();return;}
  if(button.dataset.rcAction==='history'){if(!state.clientId){notify('请先选择客户。');return;}await refreshHistory();return;}
  if(button.dataset.rcAction==='sample'){state.transactions=[{date:'2026-09-05',amount:'-1200.00',counterparty:'合成供应商甲有限公司',note:'服务费',source:'合成样本演示'},{date:'2026-09-16',amount:'-800.00',counterparty:'合成供应商甲有限公司',note:'服务费',source:'合成样本演示'}];state.invoices=[{date:'2026-09-04',amount:'1200.00',seller:'合成供应商甲有限公司',buyer:'合成采购方乙有限公司',number:'00000000000000000001',source:'合成样本演示'},{date:'2026-09-16',amount:'800.00',seller:'合成供应商甲有限公司',buyer:'合成采购方乙有限公司',number:'00000000000000000002',source:'合成样本演示'}];state.account=scope.client?(scope.client.enterprise_name||scope.client.name):'合成采购方乙有限公司';if(scope.client)state.invoices.forEach(invoice=>invoice.buyer=state.account);state.clientId=scope.client?String(scope.client.id):identifyClient(state.account,clients).id;state.accountNeedsReview=false;state.accountFromOCR=false;state.sample=true;state.archiveId='';state.receipts=[];state.lastPostings=null;state.evidence=[];state.warnings=[];state.progress=null;state.importChanged=false;state.selectedStatement=[];state.selectedInvoices=[];state.sourceFiles.forEach(f=>URL.revokeObjectURL(f.url));state.sourceFiles=[];clearResults();try{await runMatch();}catch(err){notify('核对失败：'+err.message);}redraw();return;}
  if(button.dataset.rcAction==='parse'){
   if(!state.clientId){notify('请先选择本方客户账套，再识别并归档原件。');return;}
   const statement=state.selectedStatement, invoices=state.selectedInvoices;
   if(!statement.length&&!invoices.length){notify('请先选择交易清单或发票文件。');return;}
   if([...statement,...invoices].reduce((sum,f)=>sum+f.size,0)>10*1024*1024){notify('文件合计超过 10 MB，请分批处理。');return;}
   const uploadClientId=state.clientId, selected=[...statement,...invoices], page=root.querySelector('.rc-root'), generation=++parseGeneration;
   activeParsePage=page;
   const current=()=>isCurrent()&&generation===parseGeneration && page.isConnected && root.contains(page);
   const controls=[...root.querySelectorAll('input,select,button')].map(el=>[el,el.disabled]);
   const restore=()=>controls.forEach(([el,disabled])=>{el.disabled=disabled;});
   state.busy=true; controls.forEach(([el])=>{el.disabled=true;});button.textContent='正在识别并核对…';
   showProgress(root,{status:'running',elapsed_seconds:0,files:[]});
   try{
    const body={client_id:Number(uploadClientId),statement:statement[0]?await fileBase64(statement[0]):null,invoices:await Promise.all(invoices.map(fileBase64))};
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
    const parsed=progress.result;state.archiveId=parsed.archive_id||'';const transactions=parsed.transactions||[], parsedInvoices=parsed.invoices||[], account=parsed.account_name||inferOwnName(transactions,parsedInvoices);
    state.clientId=uploadClientId;state.records=[];
    let matches=null,matchError=null;
    if(transactions.length||parsedInvoices.length){try{matches=await api('/api/reconcile/match',{method:'POST',body:{...(state.archiveId?{archive_id:state.archiveId}:{}),transactions,invoices:parsedInvoices,receipts:parsed.receipts||[],account_name:account,account_needs_review:!!account,...(state.clientId?{client_id:Number(state.clientId)}:{})}});}catch(err){matchError=err;}}
    if(!current())return;
    state.account=account;state.accountFromOCR=!!account;state.accountNeedsReview=!!account;
    state.transactions=transactions;state.invoices=parsedInvoices;state.receipts=parsed.receipts||[];state.evidence=[];
    state.warnings=[...(parsed.warnings||[])];
    state.sample=false;state.importChanged=false;state.lastPostings=null;state.progress=progress;state.sourceFiles.forEach(f=>URL.revokeObjectURL(f.url));state.sourceFiles=selected.filter(f=>!/\.zip$/i.test(f.name)).map(f=>({name:f.name,url:URL.createObjectURL(f)}));
    clearResults();state.matches=matches;state.hasMatched=!!matches;if(matches)await runPreview();state.busy=false;redraw();if(matchError)notify('识别完成，但自动核对失败，请点击开始核对：'+matchError.message);
   }catch(err){if(current()){state.busy=false;restore();button.textContent='识别文件';root.querySelectorAll('[data-rc-progress]').forEach(target=>{target.hidden=false;target.textContent='识别失败：'+err.message;});notify('识别失败：'+err.message);}}
   finally{if(generation===parseGeneration){if(!current())state.busy=false;activeParsePage=null;}}
   return;
  }
  if(button.dataset.rcAction==='match'){if(!state.transactions.length&&!state.invoices.length){notify('请先导入或填写交易和发票。');return;}state.busy=true;root.querySelectorAll('input,select,button').forEach(x=>x.disabled=true);button.textContent='正在核对…';try{await runMatch();state.busy=false;redraw();}catch(err){state.busy=false;notify('核对失败：'+err.message);redraw();}}
 };
 if(options.loadHistory&&state.clientId){if(state.historyClientId!==state.clientId){state.historyGeneration++;state.historyStatus='idle';state.records=[];state.historyPostings=[];state.historyError='';}if(state.historyStatus==='idle')void refreshHistory();}
}

export const reconcileIdentityTest = {identifyClient, inferOwnName};
