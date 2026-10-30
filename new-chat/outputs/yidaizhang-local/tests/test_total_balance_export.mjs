// All counterparties, amounts and transaction dates in this file are synthetic.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {companyBalanceTest as balance, renderCompanyBalance, bindCompanyBalance, restoreCompanyBalanceRange} from '../public/company-balance.js';
import {createBalanceXlsx} from '../public/balance-xlsx.js';

const fields=['opening_debit_fen','opening_credit_fen','debit_fen','credit_fen','closing_debit_fen','closing_credit_fen'];
const row=(code,name,category,level,credit=0,debit=0,isCategory=false) => ({account_code:code,account_name:name,category,level,is_category:isCategory,is_leaf:isCategory,opening_debit_fen:0,opening_credit_fen:0,debit_fen:debit,credit_fen:credit,closing_debit_fen:debit,closing_credit_fen:credit});
const categoryRows=[
  row('1002','银行存款','asset',1,0,100),
  row('100201','账户验证款收款','asset',2,0,100,true),
  row('2241','其他应付款','liability',1,100),
  row('224101','账号验证款','liability',2,100),
  ...[['合成支付甲有限公司 · 企业认证测试转账',50],['合成支付乙 · 平台小额鉴权支付',25],['合成认证丙有限公司 · 企业认证小额转账',5],['合成认证丁有限公司 · 企业认证',10],['合成认证戊有限公司 · 合成企业实名验证',10]].map(([name,fen],index) => row(`2241010${index+1}`,name,'liability',3,fen,0,true)),
];
categoryRows[2].is_leaf=false;
categoryRows[3].is_leaf=false;
const accounts=categoryRows.filter(item=>!item.is_category).map(item=>({code:item.account_code,name:item.account_name,category:item.category}));
const details=[
  {source_type:'voucher',line_id:101,voucher_id:11,date:'2025-12-05',account_code:'224101',account_name:'账号验证款',category_code:'22410101',counterparty:'合成支付甲有限公司',summary:'企业认证测试转账',credit_fen:20,closing_credit_fen:20,period_bucket:'current',reviewed:false},
  {source_type:'voucher',line_id:102,voucher_id:12,date:'2026-09-07',account_code:'224101',account_name:'账号验证款',category_code:'22410101',counterparty:'合成支付甲有限公司',summary:'企业认证测试转账',credit_fen:30,closing_credit_fen:30,period_bucket:'current',reviewed:false},
  {source_type:'voucher',line_id:103,voucher_id:13,date:'2026-09-07',account_code:'224101',account_name:'账号验证款',category_code:'22410102',counterparty:'合成支付乙',summary:'平台小额鉴权支付',credit_fen:25,closing_credit_fen:25,period_bucket:'current',reviewed:false},
];
const data={basis:'standard',scope:'all',all_book:true,start_period:'2025-12',end_period:'2026-09',category_rows:categoryRows,category_accounts:categoryRows.map(item=>({...item,code:item.account_code,name:item.account_name})),trial_balance:categoryRows.filter(item=>!item.is_category),trial_balance_rollup:categoryRows.filter(item=>!item.is_category),balance_details:details};
const current={start:'2025-12',end:'2026-09',levelFrom:'1',levelTo:'6',showDisabled:true,showAuxiliary:true,showZero:false,showActivityZero:true,expanded:true,collapsed:new Set(),data,loading:false,error:''};
const book={client:{id:8181,name:'总表测试公司',start_period:'2025-12'},period:'2026-10',accounts,periods:[{period:'2026-09',voucher_count:3}]};

// Every report category occupies the code/name columns and raw payments remain
// available only through the selected category's source ledger.
assert.deepEqual(balance.filteredRows(data,current,accounts).map(item=>item.account_code),categoryRows.map(item=>item.account_code));
const html=balance.tableMarkup(data,current,book,{});
assert.match(html,/科目及分类/);
assert.doesNotMatch(html,/class="cob-detail |data-cob-detail=/);
for (let index=1;index<=5;index++) assert.match(html,new RegExp(`data-cob-account="2241010${index}"`));
assert.match(html,/cob-category/);
assert.match(html,/合成认证丙有限公司/);
const collapsed=balance.tableMarkup(data,{...current,collapsed:new Set(['224101'])},book,{});
assert.doesNotMatch(collapsed,/data-cob-account="22410101"/);
assert.equal(balance.reportTotals(data,categoryRows).credit_fen,100,'Root totals count parents and descendants once.');
assert.equal(balance.reportTotals(data,categoryRows).debit_fen,100);
const source=balance.balanceDetailRows(data,[categoryRows[4]]);
assert.deepEqual(source.map(item=>item.voucher_id),[11,12]);
assert.equal(source[0].account_code,'224101','Original posted accounts remain intact.');
assert.equal(source[0].category_code,'22410101');
assert.ok(balance.reportAccounts(data,accounts).some(item=>item.code==='22410105'),'Subject selection includes categories.');
const exported=balance.balanceExportRows(data,categoryRows,accounts);
assert.equal(exported.at(-1).amounts[2],1.00);
assert.equal(exported.at(-1).amounts[3],1.00);
assert.ok(exported.find(item=>item.code==='22410101').isCategory);

function unzipStored(bytes) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), decoder=new TextDecoder(), files=new Map();
  let offset=0;
  while (view.getUint32(offset,true)===0x04034b50) {
    const size=view.getUint32(offset+18,true),nameLength=view.getUint16(offset+26,true),extraLength=view.getUint16(offset+28,true);
    const name=decoder.decode(bytes.subarray(offset+30,offset+30+nameLength));
    const start=offset+30+nameLength+extraLength;
    files.set(name,decoder.decode(bytes.subarray(start,start+size)));
    offset=start+size;
  }
  return files;
}
const baseline=createBalanceXlsx({scope:'all',companyName:book.client.name,startPeriod:data.start_period,endPeriod:data.end_period,showActivityZero:true,rows:exported});
const files=unzipStored(baseline),sheet=files.get('xl/worksheets/sheet1.xml');
assert.match(sheet,/余额总表/);
assert.match(sheet,/202512至202609（全账套）/);
assert.match(sheet,/累计发生额/);
assert.doesNotMatch(sheet,/本期发生额/);
assert.match(files.get('docProps/core.xml'),/<dc:title>余额总表<\/dc:title>/);
for (let index=1;index<=5;index++) assert.match(sheet,new RegExp(`2241010${index}`));
for (let index=1;index<=5;index++) assert.match(sheet,new RegExp(`<c r="B\\d+"[^>]*><is><t[^>]*>2241010${index}<\\/t>`),'Total export code cell values contain only the exact code, without indentation spaces.');
assert.match(sheet,/<c r="C\d+"[^>]*><is><t[^>]*>    合成支付甲有限公司/,'Category names retain visual indentation.');
const legacySheet=unzipStored(createBalanceXlsx({rows:exported})).get('xl/worksheets/sheet1.xml');
assert.match(legacySheet,/<c r="B\d+"[^>]*><is><t[^>]*>    22410101<\/t>/,'Monthly legacy exports keep the existing indentation.');
const sheetRows=[...sheet.matchAll(/<row r="(\d+)"[^>]*>(.*?)<\/row>/gs)].map(match=>({number:Number(match[1]),xml:match[2]}));
for (const item of sheetRows.filter(item=>item.number>=6)) assert.match(item.xml,/<c r="A\d+"[^>]*><is><t[^>]*>\d+<\/t>/,'Every exported row has a sequence number.');
assert.equal(sheetRows.filter(item=>item.number>=6).length,exported.length,'No unnumbered raw source rows are appended.');

// Exercise the actual export action after a monthly query and asset-only,
// collapsed, YTD view. The export independently requests all-book coverage.
const priorDocument=globalThis.document,priorSetTimeout=globalThis.setTimeout;
const priorCreate=URL.createObjectURL,priorRevoke=URL.revokeObjectURL;
let downloaded,blob,clicks=0;
const button={disabled:false,innerHTML:''};
const host={matches:()=>true,parentNode:null,isConnected:false,querySelectorAll:selector=>selector==='[data-cob-action="export"]'?[button]:[],handlers:new Map(),addEventListener(event,handler){this.handlers.set(event,handler);}};
const monthly={...data,scope:'range',all_book:false,start_period:'2026-09',end_period:'2026-09'};
const requests=[];
let finishExport;
const context={api:async url=>{requests.push(url);return url.endsWith('?scope=all&basis=standard')?new Promise(resolve=>{finishExport=resolve;}):{...monthly,basis:url.endsWith('basis=actual')?'actual':'standard'};},toast(){}};
try {
  restoreCompanyBalanceRange({clientId:book.client.id,start:'2026-09',end:'2026-09'});
  renderCompanyBalance(book,context);
  bindCompanyBalance(host,book,context);
  await new Promise(resolve=>setTimeout(resolve,0));
  let ledger;
  await balance.showLedger('22410101',book,{...context,modal:(title,content)=>{ledger={title,content};}});
  assert.match(ledger.title,/^22410101/);
  assert.match(ledger.content,/224101 账号验证款/,'Ledger keeps the actual posted account code.');
  assert.match(ledger.content,/&quot;voucher_id&quot;:11/);
  assert.match(ledger.content,/&quot;voucher_id&quot;:12/);
  assert.doesNotMatch(ledger.content,/&quot;voucher_id&quot;:13/,'Category ledger must not include a sibling category source.');
  assert.match(ledger.content,/data-cob-delete-reviewed="0"/);
  const click=host.handlers.get('click'),change=host.handlers.get('change');
  click({target:{closest:selector=>selector==='[data-cob-category]'?{dataset:{cobCategory:'asset'}}:null}});
  change({target:{closest:()=>({dataset:{cobCheck:'expanded'},checked:false})}});
  change({target:{closest:()=>({dataset:{cobCheck:'ytd'},checked:true})}});
  change({target:{closest:()=>({dataset:{cobCheck:'standardBasis'},checked:false})}});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.match(renderCompanyBalance(book,context),/data-cob-category="asset" class="selected"/);
  assert.doesNotMatch(renderCompanyBalance(book,context),/data-cob-check="standardBasis" checked/);
  globalThis.document={createElement:()=>({click(){clicks++;downloaded=this.download;},remove(){}}),body:{appendChild(){}}};
  URL.createObjectURL=value=>{blob=value;return 'blob:test-total';};
  URL.revokeObjectURL=()=>{};
  globalThis.setTimeout=callback=>{callback();return 0;};
  const first=balance.exportExcel(book,context);
  assert.equal(button.disabled,true);
  assert.match(button.innerHTML,/导出中/);
  await balance.exportExcel(book,context);
  assert.equal(requests.filter(url=>url.endsWith('?scope=all&basis=standard')).length,1,'Concurrent clicks do not create duplicate exports.');
  finishExport(data);
  await first;
  assert.equal(button.disabled,false);
  assert.match(button.innerHTML,/导出总表/);
  assert.equal(clicks,1);
  assert.match(downloaded,/_余额总表_202512-202609\+/);
  assert.equal(requests.at(-1),'/api/books/8181/balance?scope=all&basis=standard');
  const downloadedBytes=new Uint8Array(await blob.arrayBuffer());
  const exportedSheet=unzipStored(downloadedBytes).get('xl/worksheets/sheet1.xml');
  assert.match(exportedSheet,/22410105/,'Asset-only UI must still export liabilities and all category descendants.');
  assert.match(exportedSheet,/<c r="B\d+"[^>]*><is><t[^>]*>22410101<\/t>/,'The actual total export action also writes exact account code values.');
  assert.match(exportedSheet,/202512至202609（全账套）/);
  assert.match(exportedSheet,/损益结转口径/);
  assert.doesNotMatch(exportedSheet,/本年累计/,'Monthly YTD toggle does not change total export columns.');
  assert.match(renderCompanyBalance(book,context),/name="start" type="month" value="2026-09"/,'Export must preserve the monthly view.');
  if (process.env.BALANCE_EXPORT_TEST_ARTIFACT) await writeFile(process.env.BALANCE_EXPORT_TEST_ARTIFACT,downloadedBytes);
  context.api=async()=>({...data,scope:'month'});
  await assert.rejects(balance.exportExcel(book,context),/余额总表数据格式错误/,'A monthly response cannot masquerade as the total report.');
  assert.equal(clicks,1);
  assert.equal(button.disabled,false,'Failed exports release the busy state.');
  context.api=async()=>({...data,basis:'actual'});
  await assert.rejects(balance.exportExcel(book,context),/余额总表数据格式错误/,'An actual-ledger response cannot masquerade as standard basis.');
  context.api=async()=>({...data,basis:undefined});
  await assert.rejects(balance.exportExcel(book,context),/余额总表数据格式错误/,'A response without basis cannot masquerade as standard basis.');
  context.api=async()=>{throw new Error('模拟总表网络错误');};
  await assert.rejects(balance.exportExcel(book,context),/模拟总表网络错误/);
  assert.equal(button.disabled,false);
} finally {
  if (priorDocument===undefined) delete globalThis.document; else globalThis.document=priorDocument;
  globalThis.setTimeout=priorSetTimeout;
  URL.createObjectURL=priorCreate;URL.revokeObjectURL=priorRevoke;
}

// Deleting a category source still addresses its real voucher; the string '0'
// in a DOM dataset must not be mistaken for an audited voucher.
let deletion;
const removeButton={dataset:{cobDelete:'{"voucher_id":11}',cobDeleteReviewed:'0',cobDeleteLabel:'测试凭证'}};
await balance.deleteEntry(removeButton,null,book,{modal:async(title,html,submit)=>submit({elements:{reason:{value:'保存错误，删除'}}}),api:async(url,options)=>{deletion={url,options};},toast(){}},{});
assert.equal(deletion.url,'/api/books/8181/balance-entries/delete');
assert.equal(deletion.options.body.voucher_id,11);
await assert.rejects(balance.deleteEntry({dataset:{...removeButton.dataset,cobDeleteReviewed:'1'}},null,book,{},{}),/凭证已审核/);
assert.equal(fields.every(field=>typeof categoryRows[4][field]==='number'),true);
console.log('total balance export uses all-book coverage, coded category hierarchy, nonduplicated totals, original source IDs, and safe busy/error handling');
