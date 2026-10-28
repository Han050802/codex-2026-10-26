import {parseHTML} from 'linkedom';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

// Independent module-only checks: synthetic memory objects, no HTTP or DB.
const root='C:/Users/Admin/Documents/Codex/2026-10-26/new-chat/outputs/yidaizhang-local';
const mod=await import(pathToFileURL(root+'/public/customer-list.js').href+'?layout-review='+Date.now());
const {window}=parseHTML('<html><body><main></main></body></html>');
const document=window.document;
Object.defineProperty(window.HTMLElement.prototype,'checked',{configurable:true,get(){return this.hasAttribute('checked');},set(v){this.toggleAttribute('checked',Boolean(v));}});
const $=(s,el=document)=>el.querySelector(s),$$=(s,el=document)=>[...el.querySelectorAll(s)];
const clients=[
 {id:1,name:'甲合成公司',enterprise_name:'甲合成公司',code:'QA-A',tax_no:'QA111',mnemonic:'alpha',industry:'技术推广和应用服务业（仅合成字段）',region:'北京',taxpayer_type:'small',standard:'small2013',start_period:'2026-01',accountant_id:1,authorized_user_ids:[],service_status:'unset',enabled:1,deleted:0,labels:['合成']},
 {id:2,name:'乙合成公司',enterprise_name:'乙合成公司',code:'QA-B',tax_no:'QA222',mnemonic:'beta',industry:'批发业',region:'天津',taxpayer_type:'general',standard:'enterprise2007',start_period:'2026-02',accountant_id:2,authorized_user_ids:[1],service_status:'paused',enabled:0,deleted:0,labels:[]},
 {id:3,name:'<img src=x onerror=alert(1)> 丙合成公司',code:'QA-C',industry:'零售业',region:'北京',taxpayer_type:'small',standard:'small2013',start_period:'2026-03',accountant_id:2,authorized_user_ids:[],service_status:'active',enabled:1,deleted:0,labels:[]},
 {id:4,name:'已回收合成公司',code:'QA-D',industry:'零售业',region:'北京',taxpayer_type:'small',standard:'small2013',start_period:'2026-04',accountant_id:1,authorized_user_ids:[1],service_status:'unset',enabled:1,deleted:1,labels:[]}
];
const periods=[{client_id:1,period:'2026-07',closed:1,voucher_count:2},{client_id:1,period:'2026-09',closed:0,voucher_count:1},{client_id:2,period:'2026-07',status:'closed',voucher_count:0},{client_id:3,period:'2026-10',closed:0,voucher_count:0}];
const ctx={state:mod.createCustomerListState(),clients,users:[{id:1,name:'合成人员1'},{id:2,name:'合成人员2'},{id:3,name:'合成人员3'}],user:{id:1},bookPeriods:periods,accountant:'',taxpayer:'',label:'',search:'',selected:new Set(),paging:{page:1,size:500}};
const data=mod.getCustomerListData(ctx);
assert.deepEqual(data.filtered.map(c=>c.id),[1,2,3]);assert.equal(data.enabledCount,2);assert.equal(data.disabledCount,1);
assert.deepEqual(mod.customerBookStatus(clients[0],periods),{period:'2026-09',state:'working',label:'202609进行中'});
assert.deepEqual(mod.customerBookStatus(clients[1],periods),{period:'2026-07',state:'closed',label:'202607已完成'});
assert.deepEqual(mod.customerBookStatus(clients[2],periods),{period:'2026-03',state:'empty',label:'202603未记账'});
ctx.state.mineOnly=true;assert.deepEqual(mod.getCustomerListData(ctx).filtered.map(c=>c.id),[1,2]);ctx.state.mineOnly=false;
for(const [field,value,ids] of [['industry','批发业',[2]],['region','北京',[1,3]],['standard','enterprise2007',[2]],['book_status','empty',[3]],['service_status','unset',[1]],['enabled','0',[2]]]){ctx.state[field]=value;assert.deepEqual(mod.getCustomerListData(ctx).filtered.map(c=>c.id),ids,field);ctx.state[field]='';}
ctx.accountant='2';assert.deepEqual(mod.getCustomerListData(ctx).filtered.map(c=>c.id),[2,3]);ctx.accountant='';
ctx.search='ALPHA';assert.deepEqual(mod.getCustomerListData(ctx).filtered.map(c=>c.id),[1]);ctx.search='';
assert.deepEqual(mod.parseCustomerImport('\ufeff客户名称,税号\r\n"甲合成公司",QA111\r\n"乙合成公司",QA222',clients),[1,2]);
assert.deepEqual(mod.parseCustomerImport('QA-D\nNO-MATCH',clients),[]);assert.throws(()=>mod.parseCustomerImport('"未闭合',clients));
const main=$('main');main.innerHTML=mod.renderCustomerList(ctx,data);
const keys=['select','index','name','industry','region','taxpayer_type','standard','book_status','accountant_id','authorized_user_ids','service_status','enabled','actions'];
assert.deepEqual($$('thead th').map(el=>el.dataset.customerColumn),keys);
assert(mod.customerColumns().find(c=>c.key==='index').required,'Column settings entry must not be hideable with its index column');
assert.equal($$('tbody tr[data-customer-id]').length,3);assert.equal($$('img').length,0,'Untrusted names must remain text');
assert($('[data-customer-selection-tools]').hidden,'Unselected default must preserve the single-row toolbar');
assert.equal($('[data-customer-id="1"] [data-customer-cell="authorized_user_ids"]').textContent,'','Empty assignment must not invent three authorized users');
assert.equal($('[data-customer-id="1"] [data-customer-cell="service_status"]').textContent,'未设置');
assert.equal($('[data-customer-id="2"] [data-customer-cell="enabled"]').textContent,'已禁用');
assert.equal($('[data-customer-id="2"] [data-customer-cell="service_status"]').textContent,'已暂停','Service and enable flags must stay independent');
for(const row of $$('tbody tr[data-customer-id]')){const id=row.dataset.customerId;const actions=$$('.cl-row-actions button',row);assert.equal(actions.length,3);assert.deepEqual(actions.map(b=>b.dataset.action),['client-row-refresh','client-edit','client-delete']);for(const action of actions){assert.equal(action.dataset.id,id);assert(action.getAttribute('title')&&action.getAttribute('aria-label'));assert($('svg',action));}assert.equal($('[data-action="open-book"]',row).dataset.id,id);assert.equal($('[data-action="client-enable-settings"]',row).dataset.id,id);assert.equal($('[data-action="client-service-settings"]',row).dataset.id,id);}
assert.equal($('[data-customer-id="1"] [data-customer-cell="industry"] span').getAttribute('title'),clients[0].industry);
assert.equal($$('.cl-tools-right>[data-action]').map(el=>el.dataset.action).join(','),'client-new,customer-industry,import,customer-tags,refresh');
assert.equal($$('[data-customer-cell="name"] [data-action="open-book"]').length,3);
assert.equal($('[data-page-size] option[selected]').value,'500');
ctx.state.hiddenColumns=['industry'];ctx.selected.add(2);ctx.paging.page=99;ctx.paging.size=2;main.innerHTML=mod.renderCustomerList(ctx,mod.getCustomerListData(ctx));assert.equal(ctx.paging.page,2);assert(!$('[data-customer-selection-tools]').hidden);assert($('th[data-customer-column="industry"]').hidden);assert.equal($$('[data-customer-id]').length,1);
ctx.state.hiddenColumns=[];ctx.paging={page:1,size:500};main.innerHTML=mod.renderCustomerList(ctx,data);
const events=[];mod.bindCustomerList(main,{...ctx,onMine:value=>events.push(['mine',value]),onImportToggle:value=>events.push(['import',value]),onImportFile:file=>events.push(['file',file.name])});
const mine=$('[data-cl-mine-only]');mine.checked=true;mine.dispatchEvent(new window.Event('change',{bubbles:true}));assert.deepEqual(events,[['mine',true]]);
const importToggle=$('[data-cl-import-only]');ctx.state.importFileName='合成名单.csv';importToggle.checked=true;importToggle.dispatchEvent(new window.Event('change',{bubbles:true}));assert.deepEqual(events.at(-1),['import',true]);
ctx.state.importOnly=false;$('#customer-list-import').dispatchEvent(new window.Event('cancel'));assert(!importToggle.checked);
const css=await readFile(root+'/public/customer-list.css','utf8');assert(css.includes('padding:19px 28px 10px 30px'));assert(css.includes('height:37px'));assert(css.includes('min-width:1762px'));assert(css.includes('text-overflow:ellipsis'));assert(css.includes('overflow-y:scroll'));
console.log(JSON.stringify({ok:true,scope:'pure DOM and declared CSS; rendered geometry reviewed separately by root',scenarios:15,rows:3,columns:13}));
