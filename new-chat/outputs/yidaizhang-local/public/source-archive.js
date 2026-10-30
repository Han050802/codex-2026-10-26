// Read-only, company-scoped evidence shared by reconciliation and voucher views.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const amount = value => value === undefined || value === null || value === '' ? '—' : String(value);
const labels = {date:'日期',amount:'金额（元）',counterparty:'交易对方',note:'附言',source:'来源',number:'单据号码',seller:'销售方',buyer:'购买方',item_name:'发票项目',net_amount:'不含税金额（元）',tax_amount:'税额（元）',business_purpose:'实际用途',basis:'判断依据',reason:'处理说明',reasons:'核对依据',status:'核对状态',rule_id:'命中规则',rule_ids:'命中规则',evidence_note:'证据说明',duplicate_review_note:'重复核验说明',account_code:'科目编码',account_name:'科目名称',treatment:'业务性质',tax_treatment:'税额处理',transaction_index:'交易序号',invoice_index:'发票序号',receipt_index:'回单序号',automatic_posting:'自动制证依据',classification:'科目判断',matching_basis:'匹配依据',rule_suggestion:'科目建议',funding_account_code:'资金科目',subject_account_code:'业务科目',subject_name:'业务科目名称',subject_source:'科目确定方式',funding_source:'资金科目确定方式',matched_source:'匹配单据',tax_mode:'金额与税额处理',source_net_amount:'原始不含税金额',source_tax_amount:'原始税额',tax_account_code:'税费科目',bank_account_code:'资金科目',business_account_code:'业务科目',settlement_account_code:'往来科目',amount_fen:'入账金额（元）'};
const statusNames = {invoice:'发票',receipt:'银行回单',explicit:'人工选择',default:'账套默认科目',selected_account:'人工指定科目',recommendation:'依据科目建议',other_receivable_fallback:'暂记其他应收款',other_payable_fallback:'暂记其他应付款',gross:'按总额入账',split:'价税分开',gross_small_ordinary:'按总额入账',gross_unreliable_or_missing_tax:'税额不完整，按总额入账',gross_no_unique_tax_account:'未确定唯一税费科目，按总额入账',suggested:'科目建议',matched:'核对相符',review:'待核实',reviewed:'已核实',posted:'已入账',ready:'可入账',missing:'未匹配',provisional:'暂定建议',recognize_invoice:'根据发票确认业务',contract_prepayment:'合同预付款',settle_payable:'结清已有应付',settle_receivable:'收回已有应收',deductible_input:'可抵扣进项税',output:'销项税'};
const displayTime = value => {const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):String(value||'—');};
const present = value => value !== undefined && value !== null && value !== '';
function detailText(value) {
  if(Array.isArray(value))return value.map(detailText).filter(Boolean).join('；');
  if(value&&typeof value==='object')return Object.entries(value).filter(([key,v])=>labels[key]&&present(v)).map(([key,v])=>`${labels[key]}：${key==='amount_fen'?(Number(v)/100).toFixed(2):detailText(v)}`).filter(Boolean).join('；');
  return present(value) ? statusNames[value] || String(value) : '';
}
function fields(value, keys=['date','amount','counterparty','note','number','seller','buyer','item_name','net_amount','tax_amount','business_purpose','source']) {
  if(!value||typeof value!=='object')return '';
  const rows=keys.filter(key=>present(value[key])).map(key=>`<dt>${esc(labels[key]||key)}</dt><dd>${esc(amount(value[key]))}</dd>`).join('');
  return rows?`<dl class="sa-fields">${rows}</dl>`:'';
}
function downloadUrl(raw) {
  const value=String(raw||'');
  return /^\/api\/reconcile\/archives\/[A-Za-z0-9_-]+\/files\/\d+\?client_id=\d+$/.test(value)?value:'';
}
function fileMarkup(file) {
  const url=file.available===false?'':downloadUrl(file.download_url), preview=/\.(pdf|png|jpe?g|webp)$/i.test(file.name||'')&&!file.is_container;
  const size=Number(file.size||0), sizeText=size>=1024*1024?`${(size/1024/1024).toFixed(2)} MB`:size>=1024?`${Math.ceil(size/1024)} KB`:`${size} B`;
  const kind=file.is_container?'ZIP 原包':file.kind==='statement'?'交易清单':file.kind==='receipt'?'银行回单':file.kind==='invoice'?'发票':'原始文件';
  return `<tr><td><strong>${esc(file.name)}</strong>${file.source&&file.source!==file.name?`<small>${esc(file.source)}</small>`:''}</td><td>${kind}</td><td>${esc(sizeText)}</td><td>${url?`${preview?`<a href="${esc(url+'&inline=1')}" target="_blank" rel="noopener noreferrer">查看原件</a>`:''}<a href="${esc(url)}" download>下载</a>`:'原件缺失，请核对备份'}</td></tr>`;
}
function recognizedMarkup(recognized={}) {
  const groups=[['transactions','原始识别交易'],['invoices','原始识别发票'],['receipts','原始识别回单']];
  const sections=groups.filter(([key])=>Array.isArray(recognized[key])&&recognized[key].length).map(([key,title])=>`<h4>${title}（${recognized[key].length} 条）</h4>${recognized[key].map((row,index)=>`<section class="sa-document"><strong>第 ${index+1} 条</strong>${fields(row)}</section>`).join('')}`).join('');
  return sections?`<details class="sa-recognized"><summary>查看原始识别结果</summary><p class="sa-muted">保留识别时的结果，可与下方实际制证使用的数据核对。</p>${sections}</details>`:'';
}
function linkMarkup(link) {
  const basis=detailText(link.matching_basis), classification=detailText(link.classification), evidence=detailText(link.evidence), posting=detailText(link.automatic_posting);
  return `<section class="sa-link"><h4>保存时使用的数据${link.record_id?` · 核对记录 ${esc(link.record_id)}`:''}</h4>${link.transaction?`<h5>交易</h5>${fields(link.transaction)}`:''}${link.invoice?`<h5>发票</h5>${fields(link.invoice)}`:''}${link.receipt?`<h5>回单</h5>${fields(link.receipt)}`:''}${basis?`<p><b>匹配依据：</b>${esc(basis)}</p>`:''}${classification?`<p><b>科目判断：</b>${esc(classification)}</p>`:''}${evidence?`<p><b>补充依据：</b>${esc(evidence)}</p>`:''}${posting?`<p><b>制证依据：</b>${esc(posting)}</p>`:''}</section>`;
}
export function renderSourceArchive(data={}) {
  const archives=Array.isArray(data.archives)?data.archives:[];
  if(!archives.length)return '<div class="sa-empty"><strong>这张凭证尚未关联上传原件</strong><p>历史上传的原件无法自动补回。启用归档后识别并保存的单据，会在此显示原件及核对依据。</p></div>';
  return `<div class="sa-root"><p class="sa-muted">原件保存在本地工作台，随数据备份保留。${data.voucher_id?'以下为该凭证关联的来源资料。':'以下为本次识别批次的来源资料。'}</p>${archives.map((archive,index)=>`<section class="sa-archive"><h3>来源资料${archives.length>1?' '+(index+1):''}</h3><p class="sa-muted">保存时间：${esc(displayTime(archive.created_at))}</p><div class="sa-table-wrap"><table class="sa-files"><thead><tr><th>原件名称与来源</th><th>类型</th><th>大小</th><th>操作</th></tr></thead><tbody>${(archive.files||[]).map(fileMarkup).join('')||'<tr><td colspan="4">本批次没有可读取的原件</td></tr>'}</tbody></table></div>${(archive.links||[]).map(linkMarkup).join('')}${recognizedMarkup(archive.recognized)}</section>`).join('')}</div>`;
}
export async function openSourceArchive(ctx,{clientId,voucherId,recordId,archiveId}) {
  if(!/^\d+$/.test(String(clientId)))throw new Error('请先选择客户账套');
  let path;
  if(voucherId&&/^\d+$/.test(String(voucherId)))path=`/api/books/${encodeURIComponent(clientId)}/vouchers/${encodeURIComponent(voucherId)}/sources`;
  else if(recordId&&/^\d+$/.test(String(recordId)))path=`/api/reconcile/records/${encodeURIComponent(recordId)}/sources?client_id=${encodeURIComponent(clientId)}`;
  else if(archiveId&&/^[A-Za-z0-9_-]+$/.test(String(archiveId)))path=`/api/reconcile/archives/${encodeURIComponent(archiveId)}?client_id=${encodeURIComponent(clientId)}`;
  else throw new Error('该记录尚未关联上传原件');
  const data=await ctx.api(path);
  if(typeof ctx.modal!=='function')throw new Error('原件查看窗口不可用，请重新进入账套');
  return ctx.modal('原件与凭证依据',renderSourceArchive(data),null,{wide:true});
}
