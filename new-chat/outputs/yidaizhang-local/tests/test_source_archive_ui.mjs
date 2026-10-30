import assert from 'node:assert/strict';
import {renderSourceArchive,openSourceArchive} from '../public/source-archive.js';
import {renderCompanyVouchers} from '../public/company-vouchers.js';

const archiveId='synthetic_archive_01234567890123';
const path=`/api/reconcile/archives/${archiveId}/files/5?client_id=71`;
const data={client_id:71,voucher_id:91,archives:[{archive_id:archiveId,created_at:'2026-10-30',files:[
  {id:5,name:'原始<发票>.pdf',source:'批次.zip/原始<发票>.pdf',size:1024,kind:'invoice',download_url:path},
  {id:6,name:'原包.zip',size:2048,is_container:true,download_url:path.replace('/5?','/6?')},
  {id:7,name:'<img src=x onerror=alert(1)>.png',size:10,download_url:'javascript:alert(1)'},
  {id:8,name:'缺失.pdf',size:1,available:false,download_url:path.replace('/5?','/8?')}
],recognized:{transactions:[{date:'2026-09-15',amount:'-99.00',source:'银行.pdf'}],invoices:[{number:'ORIGINAL-INVOICE',amount:'99.00'}]},links:[{
  record_id:61,transaction:{date:'2026-09-15',amount:'-100.00',source:'银行.pdf'},invoice:{number:'CORRECTED-INVOICE',amount:'100.00'},
  matching_basis:['金额一致','双方名称一致'],classification:{account_code:'5602',account_name:'管理费用',basis:'按实际服务用途'},evidence:{evidence_note:'人工核实说明'}
}]}]};
const html=renderSourceArchive(data);
assert.match(html,/原始&lt;发票&gt;\.pdf/);
assert.doesNotMatch(html,/<img src=x|javascript:/);
assert.match(html,/inline=1/,'PDF originals offer local preview.');
assert.doesNotMatch(html,/\/6\?client_id=71&amp;inline/,'ZIP containers are downloaded rather than embedded.');
assert.doesNotMatch(html,/\/8\?client_id/,'Missing originals never present a working-looking download.');
assert.match(html,/原件缺失/);
assert.match(html,/ORIGINAL-INVOICE/);
assert.match(html,/CORRECTED-INVOICE/);
assert.match(html,/保存时使用的数据/);
assert.match(html,/查看原始识别结果/);
assert.match(html,/金额一致；双方名称一致/);
assert.match(renderSourceArchive({archives:[]}),/尚未关联上传原件/);

const requests=[],dialogs=[];
const ctx={api:async path=>{requests.push(path);return data;},modal:async(...args)=>dialogs.push(args)};
await openSourceArchive(ctx,{clientId:71,voucherId:91});
await openSourceArchive(ctx,{clientId:71,recordId:61});
await openSourceArchive(ctx,{clientId:71,archiveId});
assert.deepEqual(requests,[`/api/books/71/vouchers/91/sources`,`/api/reconcile/records/61/sources?client_id=71`,`/api/reconcile/archives/${archiveId}?client_id=71`]);
assert.equal(dialogs[0][0],'原件与凭证依据');
await assert.rejects(openSourceArchive(ctx,{clientId:'71/../../',voucherId:91}),/选择客户/);
await assert.rejects(openSourceArchive(ctx,{clientId:71,archiveId:'../../wrong'}),/尚未关联/);

const book={client:{id:71},period:'2026-09',periods:[{period:'2026-09',closed:true}],accounts:[],vouchers:[{id:91,number:1,date:'2026-09-15',status:'void',source_type:'reconciliation',lines:[]}]};
const voucherHtml=renderCompanyVouchers(book,{});
// Void records are visible with the existing history filter; sources must remain readable when locked.
const {companyVouchersTest}=await import('../public/company-vouchers.js');
companyVouchersTest.stateFor(book).status='all';
assert.match(renderCompanyVouchers(book,{}),/data-book-action="voucher-sources" data-id="91"/);
assert.doesNotMatch(renderCompanyVouchers(book,{}),/data-book-action="voucher-sources" data-id="91" disabled/);
console.log('source archive rendering, safe local file links, snapshots, routes and historical voucher access passed');
