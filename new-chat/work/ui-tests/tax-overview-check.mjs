import {parseHTML} from 'linkedom';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const base=process.argv[2];
assert(base,'Run with python run-checks.py tax-overview-check.mjs');
const address=new URL(base);
assert.equal(address.hostname,'127.0.0.1','Only the disposable loopback QA server is allowed');
assert(!['8765','8766'].includes(address.port),'Refusing production/demo service ports');
const root='C:/Users/Admin/Documents/Codex/2026-10-26/new-chat/outputs/yidaizhang-local';
const nativeFetch=globalThis.fetch;
let cookie='',requests=0;
const traffic=[],errors=[],scenarios=[],blobs=[];
process.on('unhandledRejection',error=>errors.push(error));
globalThis.fetch=async(path,options={})=>{
  const url=new URL(path,base);
  assert.equal(url.origin,address.origin,'Unexpected external request');
  const headers={Origin:base,Connection:'close',...options.headers};
  if(cookie)headers.Cookie=cookie;
  const entry={path:url.pathname,query:Object.fromEntries(url.searchParams),method:options.method||'GET',body:typeof options.body==='string'?JSON.parse(options.body):options.body};
  const response=await nativeFetch(url,{...options,headers});
  entry.status=response.status;traffic.push(entry);requests++;
  const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];
  return response;
};
const health=await (await fetch('/api/health')).json();assert(health.demo,'Only a synthetic demo fixture is allowed');
const login=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'demo1',password:'DemoOnly123!'})});
assert.equal(login.status,200,'Synthetic demo login failed');
const {window}=parseHTML(await readFile(root+'/public/index.html','utf8'));
globalThis.window=window;globalThis.document=window.document;globalThis.CustomEvent=window.CustomEvent;
window.location={href:base+'/',assign:path=>{window.lastDownload=String(path);}};
window.history={replaceState(){}};window.print=()=>{};window.HTMLElement.prototype.reportValidity=()=>true;
const storage=new Map();
globalThis.localStorage=window.localStorage={getItem:key=>storage.get(String(key))??null,setItem:(key,value)=>storage.set(String(key),String(value)),removeItem:key=>storage.delete(String(key)),clear:()=>storage.clear()};
Object.defineProperty(window.HTMLElement.prototype,'checked',{configurable:true,get(){return this.hasAttribute('checked');},set(value){this.toggleAttribute('checked',Boolean(value));}});
Object.defineProperty(window.HTMLElement.prototype,'elements',{configurable:true,get(){const nodes=[...this.querySelectorAll('input,select,textarea,button')];return new Proxy(nodes,{get(target,key){if(key in target)return target[key];return nodes.find(el=>el.getAttribute('name')===key);}});}});
class DOMFormData{
  constructor(form){this.list=[];for(const el of form?.querySelectorAll('input,select,textarea')||[]){const name=el.getAttribute('name');if(!name||el.disabled)continue;const type=el.getAttribute('type');if((type==='checkbox'||type==='radio')&&!el.checked)continue;if(type==='file')continue;const value=el.tagName==='SELECT'?(el.querySelector('option[selected]')||el.querySelector('option'))?.getAttribute('value')??el.textContent:el.value;this.list.push([name,String(value??'')]);}}
  entries(){return this.list[Symbol.iterator]();}
}
globalThis.FormData=DOMFormData;
URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:synthetic-selection-'+blobs.length;};
URL.revokeObjectURL=()=>{};
const $=(selector,inside=document)=>inside.querySelector(selector);
const $$=(selector,inside=document)=>[...inside.querySelectorAll(selector)];
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
async function waitFor(predicate,label){for(let i=0;i<200;i++){if(errors.length)throw errors.shift();if(await predicate())return;await delay(20);}throw new Error('Timed out: '+label+'; '+($('#main-content')?.textContent||'').slice(0,250));}
function click(el,label='button'){assert(el,'Missing '+label);assert(!el.disabled&&!el.hasAttribute('disabled'),label+' is disabled');el.dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));}
function change(el){el.dispatchEvent(new window.Event('change',{bubbles:true,cancelable:true}));}
function check(el,value=true){assert(el,'Missing checkbox');assert(!el.disabled&&!el.hasAttribute('disabled'),'Checkbox is disabled');el.checked=value;change(el);}
function setSelect(el,value,dispatch=true){assert(el,'Missing select');let found=false;for(const option of $$('option',el)){
  // Native HTMLOptionElement.value falls back to its text; linkedom returns an
  // empty string for options without value attributes. Materialize that native
  // fallback in this DOM fixture before application code reads select.value.
  if(!option.hasAttribute('value'))option.setAttribute('value',option.textContent);
  const chosen=option.getAttribute('value')===String(value);option.toggleAttribute('selected',chosen);if(chosen)found=true;
}assert(found,'Missing option '+value);if(dispatch)change(el);}
function count(scope='clients'){const el=$(`[data-selection-count="${scope}"]`);return el?Number(el.textContent.trim()):frontend.selectedCompanyIds(scope).length;}
function rows(scope){return $$(`input[data-company-select="${scope}"]`);}
function header(scope){return $(`input[data-company-select-page="${scope}"]`);}
function clear(scope){click($(`[data-action="selection-clear"][data-scope="${scope}"]`),'clear '+scope);}
function chooseAll(scope){click($(`[data-action="selection-all"][data-scope="${scope}"]`),'select all '+scope);}
async function nav(name,sub){click($(`[data-nav="${name}"]`),'nav '+name);await waitFor(()=>$(`[data-nav="${name}"].active`),'nav '+name);await delay(35);if(sub){click($(`[data-sub="${sub}"]`),'sub '+sub);await waitFor(()=>$(`[data-sub="${sub}"].active`),'sub '+sub);await delay(40);}assert(!$('.page-error'),name+'/'+sub+' failed');}
async function search(value){const form=$('[data-search-form]');assert(form,'Search form');form.elements.q.value=value;form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await delay(45);}
async function reset(){click($('[data-action="reset-filters"]'),'reset filters');await delay(45);}
async function page(scope,direction){const shell=$(`[data-selection-scope="${scope}"]`);assert(shell,'Table selection shell '+scope);const buttons=$$('[data-action="table-page"]',shell.closest('[data-customer-list],[data-bookkeeping-list],[data-tax-overview]')||shell);const button=direction==='next'?buttons.at(-1):buttons[0];click(button,'page '+direction);await delay(30);}
async function dismiss(){const close=$('#modal-root [data-close]');assert(close,'Modal close');click(close,'modal cancel');await waitFor(()=>!$('#app-modal-form'),'modal closed');}
function submitModal(){const form=$('#app-modal-form');assert(form,'Expected confirmation modal');form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));}
function assertSelectionEmpty(scope){assert.equal(count(scope),0);assert(rows(scope).every(row=>!row.checked));const h=header(scope);if(h){assert(!h.checked);assert(!h.indeterminate);}}

const frontend=await import(pathToFileURL(root+'/public/app.js').href+'?tax-overview-test='+Date.now());
await waitFor(()=>$('.progress-card'),'app startup');
let boot=await frontend.api('/api/bootstrap');assert.equal(boot.clients.length,200,'Only the explicitly seeded disposable demo200 fixture is permitted');
assert(boot.tax_records.length>0,'Fixture deliberately includes old local tax records to prove these do not silently configure the new overview');
const period=$('[data-filter="period"]').value,scope='tax-overview';
const sorted=values=>[...values].map(Number).sort((a,b)=>a-b);
const byId=(data,id)=>data.clients.find(client=>Number(client.id)===Number(id));
const snapshotClients=data=>data.clients.map(client=>[client.id,client.version,client.enabled,client.deleted]);
function submit(form){assert(form,'Missing form');form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));}
function input(el,value){assert(el,'Missing input');el.value=String(value);el.dispatchEvent(new window.Event('input',{bubbles:true,cancelable:true}));}
async function refreshed(){const start=traffic.length;click($('[data-action="refresh"]'),'refresh');await waitFor(()=>traffic.slice(start).some(request=>request.path==='/api/bootstrap'&&request.method==='GET'),'tax overview bootstrap refresh');await delay(60);}
async function readBoot(){return frontend.api('/api/bootstrap?period='+period);}
async function sessionFor(username){
  const response=await nativeFetch(new URL('/api/login',base),{method:'POST',headers:{Origin:base,Connection:'close','Content-Type':'application/json'},body:JSON.stringify({username,password:'DemoOnly123!'})});requests++;assert.equal(response.status,200,'Synthetic secondary login');
  const session=await response.json(),sessionCookie=response.headers.get('set-cookie').split(';')[0];
  return async(path,{method='GET',body}={})=>{
    const response=await nativeFetch(new URL(path,base),{method,headers:{Origin:base,Connection:'close',Cookie:sessionCookie,'X-CSRF-Token':session.csrf,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});requests++;
    const value=await response.json();return {status:response.status,value};
  };
}
function csvRows(text){
  const output=[];let row=[],cell='',quoted=false;text=text.replace(/^\uFEFF/,'');
  for(let i=0;i<text.length;i++){
    const character=text[i];if(character==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(character===','&&!quoted){row.push(cell);cell='';}
    else if((character==='\r'||character==='\n')&&!quoted){if(character==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(Boolean))output.push(row);row=[];cell='';}
    else cell+=character;
  }if(cell||row.length){row.push(cell);output.push(row);}return output;
}
const post=(path,body)=>frontend.api(path,{method:'POST',body});
const patch=(path,body)=>frontend.api(path,{method:'PATCH',body});
async function workflowFor(clientId){const workflows=await frontend.api('/api/tax-workflows?period='+period+'&client_id='+clientId);assert.equal(workflows.length,1,'One local active workflow per client/period');return workflows[0];}
async function expectAPIError(path,method,body,status,label){let error=null;try{await frontend.api(path,{method,body});}catch(found){error=found;}assert(error,label+' must reject');assert.equal(error.status,status,label);}
async function prepareSyntheticClient(clientId,index){
  const data=await readBoot(),client=byId(data,clientId);return patch(`/api/clients/${clientId}`,{version:client.version,tax_no:'TAXOVQA'+String(clientId).padStart(6,'0'),region:index<20?'北京':'上海'});
}
async function configure(clientId,agentId,extra={}){return post('/api/tax-workflows',{client_id:clientId,period,tax_agent_id:agentId,verification_status:'passed',verification_note:'合成验收：操作员人工核对本地资料，未验证任何外部身份',individual_applicable:false,note:'合成本地报税检查配置',...extra});}
async function taxRecord(clientId,taxType='增值税',extra={}){return post('/api/tax-records',{client_id:clientId,period,tax_type:taxType,status:'submitted',payment_status:'paid',amount_fen:10000,paid_fen:10000,confirmation_status:'confirmed',reference:'SYNTHETIC-LOCAL-ACK-'+clientId+'-'+taxType,note:'合成本地登记与回执编号，未连接或提交税局',...extra});}

const columnKeys=['select','index','name','switch_count','tax_agent','verification_status','taxpayer_type','submission_status','payment_status','check_status','national_check_status','individual_check_status','actions'];
const row=id=>$(`[data-tax-client-id="${id}"]`),visibleIds=()=>rows(scope).map(node=>Number(node.value));
function card(stage,status){return Number($(`[data-tax-flow-card="${stage}"] ${status?`[data-status="${status}"]>span`:'.tx-card-total'}`).textContent.trim());}
async function taxSearch(value){const form=$('[data-tax-search-form]');assert(form);input(form.elements.q,value);submit(form);await delay(40);}
async function taxReset(){click($('.tx-tools-left [data-action="tax-filter"]'),'tax filters');await waitFor(()=>$('[data-action="tax-reset-filters"]'),'tax reset filter');click($('[data-action="tax-reset-filters"]'),'reset all tax filters');await waitFor(()=>!$('#app-modal-form'),'tax filters reset');await delay(40);}
async function filter(values={},field=''){
  const trigger=(field?$(`th [data-action="tax-filter"][data-field="${field}"]`):null)||$('.tx-tools-left [data-action="tax-filter"]');click(trigger,'tax filter '+field);await waitFor(()=>$('#app-modal-form [name="search"]'),'tax filter form');
  const form=$('#app-modal-form');
  for(const name of ['search','accountant','region','taxpayer','agentId','verificationStatus','submissionStatus','paymentStatus','checkStatus','nationalCheckStatus','individualCheckStatus','hasNote','label']){
    const control=$(`[name="${name}"]`,form);assert(control,'Functional filter control '+name);
    if(control.getAttribute('type')==='checkbox')check(control,Boolean(values[name]));else if(control.tagName==='SELECT')setSelect(control,values[name]??'',false);else input(control,values[name]??'');
  }
  submit(form);await waitFor(()=>!$('#app-modal-form'),'tax filters applied');await delay(40);
}
async function allFiltered(){if(!count(scope)&&rows(scope).length)check(rows(scope)[0]);const all=$(`[data-action="selection-all"][data-scope="${scope}"]`);if(!all.disabled&&!all.hasAttribute('disabled'))chooseAll(scope);await delay(20);return frontend.selectedCompanyIds(scope).map(Number);}
async function assertRange(expected,label){const expectedIds=sorted(expected);assert(visibleIds().every(id=>expectedIds.includes(id)),label+': visible ids');if(expectedIds.length){assert.deepEqual(sorted(await allFiltered()),expectedIds,label+': full filtered ids');clear(scope);}else assert.equal(rows(scope).length,0,label+': expected empty');}
async function closeResult(){if($('#app-modal-form'))await dismiss();await delay(25);}
async function visibleWorkflowEditor(workflowId){const selector=`[data-action="tax-workflow-edit"][data-workflow-id="${workflowId}"]`;if(!$(selector)){const size=$('#app-modal-form [data-selection-scope="tax_workflows"] [data-page-size]');assert(size,'Workflow manager paging');setSelect(size,'100');await delay(40);}await waitFor(()=>$(selector),'workflow editor '+workflowId);return $(selector);}
async function batchCheck(ids,{staleId=null}={}){
  if(count(scope))clear(scope);
  for(const id of ids){let found=$(`input[data-company-select="${scope}"][value="${id}"]`);for(let attempt=0;!found&&attempt<10;attempt++){await page(scope,'next');found=$(`input[data-company-select="${scope}"][value="${id}"]`);}check(found);}
  const start=traffic.length;click($('[data-action="tax-check-batch"]'),'run selected local tax checks');await waitFor(()=>$('[data-tax-confirm-list]'),'tax check confirmation');
  assert.deepEqual(sorted($$('[data-tax-confirm-list] [data-confirm-client-id]').map(node=>node.dataset.confirmClientId)),sorted(ids));assert.equal($('[data-tax-confirm-list]').dataset.period,period);
  assert.equal(traffic.slice(start).filter(request=>request.method!=='GET').length,0,'Opening confirmation cannot perform checks');
  if(staleId){const current=await workflowFor(staleId);await patch(`/api/tax-workflows/${current.id}`,{version:current.version,note:'合成并发修改：此配置已更新'});}
  submitModal();await waitFor(()=>$('[data-tax-batch-results]'),'tax batch results');
  const resultRows=$$('[data-tax-result-id]');assert.equal(resultRows.length,ids.length);
  for(const id of ids){const result=resultRows.find(node=>Number(node.dataset.taxResultId)===Number(id));assert(result,'Per-client check result');assert.equal(result.dataset.resultOk,String(id!==staleId),'Optimistic version result '+id);}
  const checks=traffic.slice(start).filter(request=>request.method==='POST'&&/\/tax-workflows\/\d+\/check$/.test(request.path));assert.equal(checks.length,ids.length);
  if(staleId){assert.equal(checks.filter(request=>request.status===409).length,1);assert.equal(checks.filter(request=>request.status===200).length,ids.length-1);}
  await closeResult();return checks;
}
async function checkOne(clientId){
  const start=traffic.length;click($(`[data-action="tax-check-one"][data-id="${clientId}"]`),'run real client check');await waitFor(()=>$('[data-tax-confirm-list]'),'single check confirmation');assert.deepEqual($$('[data-confirm-client-id]').map(node=>Number(node.dataset.confirmClientId)),[Number(clientId)]);submitModal();await waitFor(()=>$('[data-tax-batch-results]'),'single check result');assert.equal($(`[data-tax-result-id="${clientId}"]`).dataset.resultOk,'true');
  assert.equal(traffic.slice(start).filter(request=>request.method==='POST'&&/\/tax-workflows\/\d+\/check$/.test(request.path)).length,1);await closeResult();return workflowFor(clientId);
}
await nav('报税');await waitFor(()=>$('[data-tax-overview]'),'new tax overview');
assert.equal((boot.tax_workflows||[]).length,0);
assert.deepEqual($$('th[data-tax-column]').map(node=>node.dataset.taxColumn),columnKeys);assert.equal(rows(scope).length,0);
for(const stage of ['verification','submission','payment','check'])assert.equal(card(stage),0);
assert($('.tx-empty')?.textContent.includes('办税人管理'));assert($('.tx-empty [data-action="tax-agents"]'));
assert.equal($('[data-page-size]').value,'30');assert(!$('[data-tax-selection-tools]')||$('[data-tax-selection-tools]').hidden);
assert(!$('.stat-grid')&&!$('.panel-title'),'No extra generic statistics/heading added to the screenshot layout');
scenarios.push('default overview has four zero cards and the original empty guide despite 200 clients, existing local tax records and contacts');

const tabs=['报税总览','批量报税','报税设置','个税申报','报税记录','汇算清缴','工商年报','任务管理'];
assert.deepEqual($$('.side-item span').map(node=>node.textContent.trim()),tabs,'All eight original tax sidebar labels and order');
for(const label of tabs){const button=$$('.side-item').find(node=>node.querySelector('span')?.textContent.trim()===label);click(button,'tax sidebar '+label);await waitFor(()=>button.dataset.sub===$('.side-item.active')?.dataset.sub,'active sidebar '+label);await delay(35);assert(!$('.page-error'),'Working local route '+label);assert($('#main-content').textContent.trim().length>10,'Nonempty functional route '+label);}
await nav('报税','报税总览');
const zeroSnapshot=snapshotClients(await readBoot()),refreshStart=traffic.length;await refreshed();assert(traffic.slice(refreshStart).every(request=>request.method==='GET'));assert.deepEqual(snapshotClients(await readBoot()),zeroSnapshot);
scenarios.push('eight original sidebar routes resolve to working local pages and overview refresh is read-only');

const ids=boot.clients.slice().sort((a,b)=>Number(a.id)-Number(b.id)).slice(40,75).map(client=>Number(client.id));assert.equal(ids.length,35);
for(let index=0;index<ids.length;index++)await prepareSyntheticClient(ids[index],index);
const agentA=await post('/api/tax-agents',{name:'合成专项专属办税联系人',phone:'13800000001',role:'办税联系人',client_id:ids[0],note:'合成验收联系人，勿拨打'});
const agentB=await post('/api/tax-agents',{name:'合成专项机构通用办税联系人',phone:'13800000002',role:'办税联系人',client_id:null,note:'合成验收联系人，勿拨打'});
await refreshed();
setSelect($('[data-tax-filter="region"]'),'');await delay(40);
click($('.tx-empty [data-action="tax-agents"]'),'empty guide tax-agent manager');await waitFor(()=>$('[data-action="tax-workflow-new"]'),'tax-agent and mapping manager');
click($('[data-action="tax-workflow-new"]'),'new local matching configuration');await waitFor(()=>$('#app-modal-form [name="tax_agent_id"]'),'local matching form');
setSelect($('#app-modal-form [name="client_id"]'),String(ids[0]));setSelect($('#app-modal-form [name="tax_agent_id"]'),String(agentA.id),false);input($('#app-modal-form [name="note"]'),'合成UI配置：先匹配，后人工核对');submitModal();await waitFor(()=>!$('#app-modal-form'),'initial local mapping saved');await delay(40);
let firstWorkflow=await workflowFor(ids[0]);assert.equal(firstWorkflow.verification_status,'unverified');assert.equal(rows(scope).length,0);assert.equal(card('verification'),1);
await expectAPIError(`/api/tax-workflows/${firstWorkflow.id}`,'PATCH',{version:firstWorkflow.version,verification_status:'passed',verification_note:''},400,'Manual pass without an explanation');
click($('.tx-tools-right [data-action="tax-agents"]'),'manage unverified local mapping');await waitFor(()=>$(`[data-action="tax-workflow-edit"][data-workflow-id="${firstWorkflow.id}"]`),'unverified workflow editor');click($(`[data-action="tax-workflow-edit"][data-workflow-id="${firstWorkflow.id}"]`),'manual local identity verification');await waitFor(()=>$('#app-modal-form [name="verification_status"]'),'manual verification form');
setSelect($('#app-modal-form [name="verification_status"]'),'passed',false);input($('#app-modal-form [name="verification_note"]'),'合成验收：人工核对本地客户与联系人资料，不代表税局身份认证');submitModal();await waitFor(()=>!$('#app-modal-form'),'manual verification saved');await delay(40);
firstWorkflow=await workflowFor(ids[0]);assert.equal(firstWorkflow.derived_verification_status,'passed');assert.equal(rows(scope).length,1);assert.equal(row(ids[0]).querySelector('[data-tax-cell="check_status"]').textContent,'未检查');
await expectAPIError(`/api/tax-workflows/${firstWorkflow.id}`,'PATCH',{version:firstWorkflow.version,overall_status:'passed'},400,'Client cannot forge a passed check result');
scenarios.push('empty guide opens real agent matching; UI saves unverified mapping, requires a manual verification note and never treats manual verification as a completed tax check');

for(let index=1;index<ids.length;index++)await configure(ids[index],agentB.id,{individual_applicable:index===1});
await refreshed();assert.equal(rows(scope).length,30);assert.equal(card('verification'),35);assert.equal(card('verification','passed'),35);assert.equal(card('check','not_checked'),35);
check(header(scope));assert.equal(count(scope),30);const omitted=Number(rows(scope)[0].value);check(rows(scope)[0],false);assert.equal(count(scope),29);assert(header(scope).indeterminate);
await page(scope,'next');assert.equal(rows(scope).length,5);check(rows(scope)[0]);assert.equal(count(scope),30);await page(scope,'previous');assert(!rows(scope).find(node=>Number(node.value)===omitted).checked);assert(header(scope).indeterminate);
assert.deepEqual(sorted(await allFiltered()),sorted(ids));clear(scope);assertSelectionEmpty(scope);
scenarios.push('35 configured verified companies produce actual cards and support 30-row page selection, partial header, cross-page preservation and select all filtered');

await batchCheck(ids.slice(0,3));
for(const id of ids.slice(0,3)){const workflow=await workflowFor(id);assert.equal(workflow.derived_overall_status,'failed');assert(workflow.check_details.some(detail=>detail.core&&detail.state==='failed'),'No tax evidence must fail a core check');}
assert.equal(card('check','failed'),3);assert.equal(card('check','passed'),0);assert.equal(card('check','not_checked'),32);
scenarios.push('real three-company batch checks fail when evidence is absent; completing a check request never fabricates a passed result');
const recordA=await taxRecord(ids[0]);await refreshed();firstWorkflow=await workflowFor(ids[0]);assert(firstWorkflow.check_stale);assert.equal(firstWorkflow.derived_overall_status,'not_checked');
firstWorkflow=await checkOne(ids[0]);assert.equal(firstWorkflow.derived_overall_status,'passed');assert.equal(firstWorkflow.local_only,true);assert.equal(firstWorkflow.external_action,'none');assert.equal(row(ids[0]).querySelector('[data-tax-cell="check_status"]').textContent,'检查通过');
scenarios.push('adding an actual local declaration and receipt invalidates the old result, and only a new real server check produces a current pass');
await batchCheck(ids.slice(3,5),{staleId:ids[3]});assert.equal((await workflowFor(ids[3])).overall_status,'not_checked');assert.equal((await workflowFor(ids[4])).derived_overall_status,'failed');
scenarios.push('mixed optimistic versions report one genuine conflict and one independently completed check without changing the failed request');

await taxRecord(ids[1]);await refreshed();let individual=await checkOne(ids[1]);assert.equal(individual.derived_general_status,'passed');assert.equal(individual.derived_individual_status,'failed');assert.equal(individual.derived_overall_status,'failed');
await taxRecord(ids[1],'个人所得税');await refreshed();individual=await checkOne(ids[1]);assert.equal(individual.derived_individual_status,'passed');assert.equal(individual.derived_overall_status,'passed');
await taxRecord(ids[2]);const project=await post('/api/projects',{client_id:ids[2],name:'合成年报资料任务',type:'工商年报',status:'in_progress',due_date:period+'-28',assignee_id:boot.users[0].id,steps:[{title:'合成资料核对',done:false,note:''}]});
let annual=await workflowFor(ids[2]);await patch(`/api/tax-workflows/${annual.id}`,{version:annual.version,annual_project_id:project.id});await refreshed();annual=await checkOne(ids[2]);assert.equal(annual.derived_general_status,'passed');assert.equal(annual.derived_annual_status,'failed');assert.equal(annual.derived_overall_status,'failed');
await patch(`/api/projects/${project.id}`,{version:project.version,status:'completed',steps:[{title:'合成资料核对',done:true,note:'合成资料已核对'}]});assert((await workflowFor(ids[2])).check_stale);await refreshed();annual=await checkOne(ids[2]);assert.equal(annual.derived_annual_status,'passed');assert.equal(annual.derived_overall_status,'passed');
await taxRecord(ids[5],'增值税',{status:'preparing',payment_status:'unpaid',paid_fen:0,reference:''});await taxRecord(ids[6]);await taxRecord(ids[6],'企业所得税',{status:'pending',payment_status:'unpaid',paid_fen:0,reference:''});await taxRecord(ids[7]);
await refreshed();assert.equal(card('check','passed'),3);assert.equal(card('check','failed'),1);
scenarios.push('individual and annual scopes use their own real tax records/project completion; preparatory and mixed payments do not become completed declarations or checks');

for(const username of ['demo1','demo2','demo3']){
  const asUser=await sessionFor(username),read=await asUser('/api/tax-workflows?period='+period+'&client_id='+ids[0]);assert.equal(read.status,200);const current=read.value[0];
  const result=await asUser(`/api/tax-workflows/${current.id}`,{method:'PATCH',body:{version:current.version,note:'合成三人协作：'+username+'修改配置备注'}});assert.equal(result.status,200);assert.equal(result.value.updated_by,boot.users.find(user=>user.username===username).id);assert.equal(result.value.derived_verification_status,'passed');
}
await refreshed();scenarios.push('three separate real login sessions retain versioned edit access to the same local tax configuration');

boot=await readBoot();
const clientMap=new Map(boot.clients.map(client=>[Number(client.id),client])),workflowMap=new Map(boot.tax_workflows.map(workflow=>[Number(workflow.client_id),workflow]));
const localStatus=id=>{
  const records=boot.tax_records.filter(record=>Number(record.client_id)===Number(id)&&record.period===period),general=records.filter(record=>!/个税|个人所得|^IIT$/i.test(record.tax_type)),workflow=workflowMap.get(id);
  return {submission:general.length&&general.every(record=>record.status==='submitted')?'submitted':general.some(record=>['preparing','submitted'].includes(record.status))?'in_progress':'pending',payment:records.length&&records.every(record=>record.payment_status==='paid')?'paid':records.some(record=>['paid','partial','in_progress'].includes(record.payment_status))?'in_progress':'unpaid',overall:workflow.derived_overall_status,general:workflow.derived_general_status,individual:workflow.derived_individual_status};
};
const cases=[
  [{region:'北京'},ids.filter((_,index)=>index<20),'region'],
  [{accountant:String(boot.users[1].id)},ids.filter(id=>Number(clientMap.get(id).accountant_id)===Number(boot.users[1].id)),'accountant'],
  [{taxpayer:'general'},ids.filter(id=>clientMap.get(id).taxpayer_type==='general'),'taxpayer_type'],
  [{agentId:String(agentA.id)},[ids[0]],'tax_agent'],
  [{agentId:String(agentB.id)},ids.slice(1),'tax_agent'],
  [{verificationStatus:'passed'},ids,'verification_status'],
  [{verificationStatus:'unverified'},[],'verification_status'],
  [{submissionStatus:'pending'},ids.filter(id=>localStatus(id).submission==='pending'),'submission_status'],
  [{submissionStatus:'in_progress'},ids.filter(id=>localStatus(id).submission==='in_progress'),'submission_status'],
  [{submissionStatus:'submitted'},ids.filter(id=>localStatus(id).submission==='submitted'),'submission_status'],
  [{paymentStatus:'paid'},ids.filter(id=>localStatus(id).payment==='paid'),'payment_status'],
  [{paymentStatus:'in_progress'},ids.filter(id=>localStatus(id).payment==='in_progress'),'payment_status'],
  [{paymentStatus:'unpaid'},ids.filter(id=>localStatus(id).payment==='unpaid'),'payment_status'],
  [{checkStatus:'passed'},ids.filter(id=>localStatus(id).overall==='passed'),'check_status'],
  [{checkStatus:'failed'},ids.filter(id=>localStatus(id).overall==='failed'),'check_status'],
  [{nationalCheckStatus:'failed'},ids.filter(id=>localStatus(id).general==='failed'),'national_check_status'],
  [{nationalCheckStatus:'passed'},ids.filter(id=>localStatus(id).general==='passed'),'national_check_status'],
  [{individualCheckStatus:'passed'},ids.filter(id=>localStatus(id).individual==='passed'),'individual_check_status'],
  [{individualCheckStatus:'not_applicable'},ids.filter(id=>localStatus(id).individual==='not_applicable'),'individual_check_status'],
  [{label:'重点跟进'},ids.filter(id=>clientMap.get(id).labels.includes('重点跟进')),'name'],
  [{hasNote:true},ids,'name']
];
for(const [values,expected,field] of cases){await filter();if(rows(scope).length)check(rows(scope)[0]);await filter(values,field);assertSelectionEmpty(scope);await assertRange(expected,JSON.stringify(values));}
await taxReset();
for(const field of columnKeys.filter(key=>!['select','index','actions'].includes(key))){click($(`th [data-action="tax-filter"][data-field="${field}"]`),'header filter '+field);await waitFor(()=>$('#app-modal-form [name="search"]'),'functional header filter '+field);if(field==='switch_count')assert($('#app-modal-form').textContent.includes('未接入'));await dismiss();}
scenarios.push('all visible filter columns open real controls; region, employee, taxpayer, agent, verification, declaration, payment, overall/national/individual checks, labels and note filters match exact persisted ranges');

const lastClient=byId(await readBoot(),ids.at(-1));await patch(`/api/clients/${lastClient.id}`,{version:lastClient.version,authorized_user_ids:[boot.users[0].id]});await refreshed();
check($('[data-tax-mine-only]'));await delay(40);await assertRange(ids.filter(id=>Number(clientMap.get(id).accountant_id)===Number(boot.users[0].id)||id===lastClient.id),'assigned-book metadata');check($('[data-tax-mine-only]'),false);await delay(40);
setSelect($('[data-tax-filter="accountant"]'),String(boot.users[2].id));await delay(40);await assertRange(ids.filter(id=>Number(clientMap.get(id).accountant_id)===Number(boot.users[2].id)),'toolbar employee');setSelect($('[data-tax-filter="accountant"]'),'');await delay(40);
const importIds=[ids[0],ids.at(-1)],importText='客户名称\r\n'+importIds.map(id=>clientMap.get(id).name).join('\r\n'),importTraffic=traffic.length,importSnapshot=snapshotClients(await readBoot());
check($('[data-tax-import-only]'));const file=$('[data-tax-import-file]');Object.defineProperty(file,'files',{configurable:true,value:[{name:'synthetic-tax-list.csv',size:Buffer.byteLength(importText),text:async()=>importText}]});change(file);await waitFor(()=>rows(scope).length===2&&$('[data-tax-import-only]').checked,'imported tax list');assert.deepEqual(sorted(visibleIds()),sorted(importIds));
assert(traffic.slice(importTraffic).every(request=>request.method==='GET'));assert.deepEqual(snapshotClients(await readBoot()),importSnapshot);
check(rows(scope)[0]);await taxReset();assertSelectionEmpty(scope);assert(!$('[data-tax-import-only]').checked);assert(!$('[data-tax-mine-only]').checked);
const collapseTraffic=traffic.length,collapseIds=visibleIds();click($('[data-action="tax-flow-toggle"]'),'collapse flow cards');await waitFor(()=>$('.tx-flow-cards')?.hidden,'cards collapsed');assert.deepEqual(visibleIds(),collapseIds);click($('[data-action="tax-flow-toggle"]'),'expand flow cards');await waitFor(()=>$('.tx-flow-cards')&&!$('.tx-flow-cards').hidden,'cards expanded');assert(traffic.slice(collapseTraffic).every(request=>request.method==='GET'));
click($('[data-tax-flow-card="check"] [data-status="passed"]'),'passed card details');await waitFor(()=>$('#app-modal-form'),'actual passed-card detail');assert.equal($$('#app-modal-form tbody tr').length,3);for(const id of ids.slice(0,3))assert($('#app-modal-form').textContent.includes(clientMap.get(id).name));await dismiss();
scenarios.push('employee/assigned and CSV-name filters use real company membership without writes; reset clears selection and imported list; cards collapse safely and passed-card details show actual records');

function exportMenu(){const summary=$('[data-tax-menu-trigger="export"]');click(summary,'export menu');summary.closest('details').open=true;}
check($(`input[data-company-select="${scope}"][value="${ids[0]}"]`));await page(scope,'next');check($(`input[data-company-select="${scope}"][value="${ids.at(-1)}"]`));const blobStart=blobs.length;exportMenu();click($('[data-action="tax-export-selected"]'),'export selected local checks');await waitFor(()=>blobs.length===blobStart+1,'selected checks CSV');
const selectedCSV=csvRows(await blobs.at(-1).text());assert.equal(selectedCSV.length,3);const nameIndex=selectedCSV[0].indexOf('客户名称');assert.deepEqual(selectedCSV.slice(1).map(line=>line[nameIndex]).sort(),importIds.map(id=>clientMap.get(id).name).sort());assert(selectedCSV[0].includes('检查过期'));clear(scope);
await filter({agentId:String(agentA.id)});const filteredBlobStart=blobs.length;exportMenu();click($('[data-action="tax-export"]'),'export actual current filtered checks');await waitFor(()=>blobs.length===filteredBlobStart+1,'filtered checks CSV');const filteredCSV=csvRows(await blobs.at(-1).text());assert.equal(filteredCSV.length,2);assert.equal(filteredCSV[1][filteredCSV[0].indexOf('客户名称')],clientMap.get(ids[0]).name);await taxReset();
click($('[data-action="tax-columns"]'),'tax columns gear');await waitFor(()=>$('#app-modal-form input[name="visible_columns"]'),'tax column choices');for(const key of ['select','index','name','actions']){const checkbox=$(`#app-modal-form [name="visible_columns"][value="${key}"]`);assert(checkbox.checked&&(checkbox.disabled||checkbox.hasAttribute('disabled')));}
check($('#app-modal-form [name="visible_columns"][value="switch_count"]'),false);submitModal();await waitFor(()=>!$('#app-modal-form'),'tax columns saved');assert($('th[data-tax-column="switch_count"]').hidden);assert(!$('th[data-tax-column="actions"]').hidden);click($('[data-action="tax-columns"]'),'restore optional column');await waitFor(()=>$('#app-modal-form [name="visible_columns"]'),'restore tax column');check($('#app-modal-form [name="visible_columns"][value="switch_count"]'));submitModal();await waitFor(()=>!$('#app-modal-form'),'tax column restored');
scenarios.push('selected and current-filter export CSVs contain exactly the intended companies and column settings preserve required selection/name/operation controls');

await patch(`/api/tax-records/${recordA.id}`,{version:recordA.version,reference:'SYNTHETIC-LOCAL-ACK-CHANGED'});await refreshed();firstWorkflow=await workflowFor(ids[0]);assert(firstWorkflow.check_stale);assert.equal(firstWorkflow.overall_status,'passed');assert.equal(firstWorkflow.derived_overall_status,'not_checked');assert(firstWorkflow.check_details.every(detail=>detail.state==='not_checked'));assert(firstWorkflow.last_check_details.some(detail=>detail.state==='passed'));assert.equal(row(ids[0]).querySelector('[data-tax-cell="check_status"]').textContent,'未检查');
check($(`input[data-company-select="${scope}"][value="${ids[0]}"]`));const staleBlobStart=blobs.length;exportMenu();click($('[data-action="tax-export-selected"]'),'export stale current result');await waitFor(()=>blobs.length===staleBlobStart+1,'stale CSV');const staleCSV=csvRows(await blobs.at(-1).text());assert.equal(staleCSV[1][staleCSV[0].indexOf('汇总检查结果')],'未检查');assert.equal(staleCSV[1][staleCSV[0].indexOf('检查过期')],'是');clear(scope);await checkOne(ids[0]);
const latestAgent=(await readBoot()).tax_agents.find(agent=>Number(agent.id)===Number(agentA.id));await patch(`/api/tax-agents/${agentA.id}`,{version:latestAgent.version,phone:'13800000003'});await refreshed();firstWorkflow=await workflowFor(ids[0]);assert(firstWorkflow.verification_stale);assert.equal(firstWorkflow.derived_verification_status,'unverified');assert(!row(ids[0]),'Stale identity must disappear from verified eligible table');assert.equal(card('verification','passed'),34);
click($('.tx-tools-right [data-action="tax-agents"]'),'reverify changed contact identity');await waitFor(()=>$('#app-modal-form [data-selection-scope="tax_workflows"]'),'workflow manager ready');click(await visibleWorkflowEditor(firstWorkflow.id),'edit changed verification');await waitFor(()=>$('#app-modal-form [name="verification_status"]'),'reverification form');assert.equal($('#app-modal-form [name="verification_status"]').value,'unverified');setSelect($('#app-modal-form [name="verification_status"]'),'passed',false);input($('#app-modal-form [name="verification_note"]'),'合成重新人工核对：已确认修改后的联系人资料');submitModal();await waitFor(()=>!$('#app-modal-form'),'reverification saved');await delay(40);await checkOne(ids[0]);
scenarios.push('source tax evidence edits invalidate UI and CSV while preserving raw history; agent identity edits invalidate manual verification until a new explicit human confirmation and real recheck');

click($('[data-action="tax-check-settings"]'),'real local check rules');await waitFor(()=>$('#app-modal-form [name="warn_unreviewed_vouchers"]'),'rule settings');assert($('#app-modal-form').textContent.includes('核心规则始终执行'));assert.equal($$('#app-modal-form input[type="checkbox"]').length,2);check($('#app-modal-form [name="warn_unreviewed_vouchers"]'),false);submitModal();await waitFor(()=>!$('#app-modal-form'),'rules saved');await delay(50);
const ruleBoot=await readBoot();assert.equal(ruleBoot.settings.tax_check_config.warn_unreviewed_vouchers,false);assert.equal((await workflowFor(ids[0])).derived_overall_status,'not_checked');assert.equal(card('check','passed'),0);
await expectAPIError('/api/settings','POST',{version:ruleBoot.settings.version,tax_check_config:{core_identity:false}},400,'Core tax identity rules cannot be switched off');
const stillNoProof=await checkOne(ids[4]);assert.equal(stillNoProof.derived_overall_status,'failed');assert(stillNoProof.check_details.some(detail=>detail.core&&detail.code==='general_records'&&detail.state==='failed'));
click($('[data-action="tax-audit"]'),'real local tax audit');await waitFor(()=>$('#app-modal-form'),'tax audit dialog');assert($('#app-modal-form').textContent.includes('tax_workflows'));assert($('#app-modal-form').textContent.includes('tax_check_config')||$('#app-modal-form').textContent.includes('check'));await dismiss();
scenarios.push('rule settings persist only optional warnings, invalidate prior checks, cannot disable core evidence rules, and operation logs contain real workflow actions');

await taxReset();const preservedTaxIds=(await readBoot()).tax_records.filter(record=>[ids[0],ids[1]].includes(Number(record.client_id))).map(record=>Number(record.id));assert(preservedTaxIds.length>=3);
for(const id of ids.slice(0,2))check($(`input[data-company-select="${scope}"][value="${id}"]`));const recycleTraffic=traffic.length;click($(`[data-action="selection-remove"][data-scope="${scope}"]`),'recycle selected tax overview companies');await waitFor(()=>$('[data-batch-remove-list]'),'tax company recycle confirmation');assert.deepEqual(sorted($$('[data-remove-id]').map(node=>node.dataset.removeId)),sorted(ids.slice(0,2)));submitModal();await waitFor(()=>$('[data-batch-remove-results]'),'tax company recycle results');assert($$('[data-delete-result-id]').every(node=>node.dataset.resultOk==='true'));
boot=await readBoot();for(const id of ids.slice(0,2))assert.equal(byId(boot,id).deleted,1);assert.equal(byId(boot,ids[2]).deleted,0);for(const id of preservedTaxIds)assert(boot.tax_records.some(record=>Number(record.id)===id),'Tax history must survive company recycle');assert.equal(boot.tax_workflows.filter(workflow=>ids.slice(0,2).includes(Number(workflow.client_id))).length,2);assert.equal(traffic.slice(recycleTraffic).filter(request=>request.method==='DELETE').length,2);await closeResult();
for(const id of ids.slice(0,2))await post(`/api/clients/${id}/restore`,{version:byId(boot,id).version});await refreshed();assert.equal(card('verification'),35);
scenarios.push('overview delete recycles only the selected two companies, retains all original tax/workflow history and restores the same local configurations');

// The other seven entries retain useful local workflows. Exercise the newly
// added batch preparation and three task templates rather than merely counting
// sidebar labels or accepting an empty content shell.
const prepPending=await taxRecord(ids[8],'合成批量准备税种',{status:'pending',payment_status:'unpaid',paid_fen:0,reference:''}),prepSubmitted=await taxRecord(ids[8],'合成已申报保护税种');
await nav('报税','批量报税');await refreshed();const taxSize=$('[data-selection-scope="tax_records"] [data-page-size]');setSelect(taxSize,'100');await delay(40);
for(const id of [prepPending.id,prepSubmitted.id])check($(`input[data-company-select="tax_records"][value="${id}"]`));
const recordExportStart=blobs.length;click($('[data-action="local-tax-export-selected"]'),'export only selected tax registrations');await waitFor(()=>blobs.length===recordExportStart+1,'selected registration export');assert.equal(csvRows(await blobs.at(-1).text()).length,3);
const prepareTraffic=traffic.length;click($('[data-action="local-tax-prepare"]'),'prepare selected local declarations');await waitFor(()=>$('[data-tax-prepare-id]'),'prepare local confirmation');assert.deepEqual(sorted($$('[data-tax-prepare-id]').map(node=>node.dataset.taxPrepareId)),sorted([prepPending.id,prepSubmitted.id]));submitModal();await waitFor(()=>$('[data-tax-prepare-results]'),'prepare local result');
boot=await readBoot();const pendingAfter=boot.tax_records.find(record=>record.id===prepPending.id),submittedAfter=boot.tax_records.find(record=>record.id===prepSubmitted.id);assert.equal(pendingAfter.status,'preparing');assert.equal(submittedAfter.status,'submitted');assert.equal(submittedAfter.version,prepSubmitted.version);
assert.deepEqual(traffic.slice(prepareTraffic).filter(request=>request.method==='PATCH'&&request.path.startsWith('/api/tax-records/')).map(request=>Number(request.path.split('/').at(-1))),[Number(prepPending.id)]);await closeResult();
for(const id of [prepPending.id,prepSubmitted.id])check($(`input[data-company-select="tax_records"][value="${id}"]`));click($('[data-action="selection-remove"][data-scope="tax_records"]'),'remove only selected local tax registrations');await waitFor(()=>$('[data-batch-remove-list]'),'registration deletion confirmation');submitModal();await waitFor(()=>$('[data-batch-remove-results]'),'registration deletion result');await closeResult();boot=await readBoot();assert(!boot.tax_records.some(record=>[prepPending.id,prepSubmitted.id].includes(record.id)));assert(boot.tax_records.some(record=>record.id===recordA.id));
await nav('报税','个税申报');const expectedIndividual=boot.tax_records.filter(record=>record.period===period&&/个税|个人所得|^IIT$/i.test(record.tax_type));assert.deepEqual(sorted(rows('tax_records').map(node=>node.value)),sorted(expectedIndividual.map(record=>record.id)));
const individualRecord=expectedIndividual[0];click($(`[data-action="tax-edit"][data-id="${individualRecord.id}"]`),'correct individual declaration note');await waitFor(()=>$('#app-modal-form [name="tax_type"]'),'individual registration form');input($('#app-modal-form [name="note"]'),'合成个税记录：实际界面更正备注');submitModal();await waitFor(()=>!$('#app-modal-form'),'individual correction saved');assert.equal((await readBoot()).tax_records.find(record=>record.id===individualRecord.id).note,'合成个税记录：实际界面更正备注');
scenarios.push('batch declaration page prepares only pending selected registrations, preserves submitted records, exports/deletes exactly selected rows and individual page allows actual record correction');

for(const [tab,type] of [['汇算清缴','汇算清缴'],['工商年报','工商年报'],['任务管理','税务任务']]){
  await nav('报税',tab);click($('[data-action="local-tax-project-new"]'),'create local '+tab+' task');await waitFor(()=>$('#app-modal-form [name="steps"]'),'local task form '+tab);
  const taskName='合成界面任务-'+type+'-'+Date.now();setSelect($('#app-modal-form [name="client_id"]'),String(ids[9]),false);input($('#app-modal-form [name="name"]'),taskName);assert.equal($('#app-modal-form [name="type"]').value,type);assert.equal($('#app-modal-form [name="steps"]').value.trim().split('\n').length,4);submitModal();await waitFor(()=>!$('#app-modal-form'),'task saved '+tab);
  let task=(await readBoot()).projects.find(item=>item.name===taskName);assert(task);assert.equal(task.type,type);
  click($(`[data-action="local-tax-project-steps"][data-id="${task.id}"]`),'actual task steps '+tab);await waitFor(()=>$(`[data-action="local-tax-project-toggle"][data-id="${task.id}"]`),'task step controls');click($(`[data-action="local-tax-project-toggle"][data-id="${task.id}"][data-index="0"]`),'record first task step');await waitFor(()=>$(`[data-action="local-tax-project-toggle"][data-id="${task.id}"][data-index="0"]`)?.textContent==='取消完成','task completion recorded');await dismiss();
  task=(await readBoot()).projects.find(item=>item.id===task.id);assert(task.steps[0].done&&task.steps[0].completed_at);assert.equal(task.steps[0].completed_by,boot.users[0].id);
  click($(`[data-action="project-edit"][data-id="${task.id}"]`),'correct local task '+tab);await waitFor(()=>$('#app-modal-form [name="name"]'),'task correction form');input($('#app-modal-form [name="name"]'),taskName+'更正');submitModal();await waitFor(()=>!$('#app-modal-form'),'task corrected');assert.equal((await readBoot()).projects.find(item=>item.id===task.id).name,taskName+'更正');
  click($(`[data-action="local-tax-project-delete"][data-id="${task.id}"]`),'remove local task '+tab);await waitFor(()=>$('#app-modal-form'),'task deletion confirmation');submitModal();await waitFor(()=>!$('#app-modal-form'),'task deleted');assert(!(await readBoot()).projects.some(item=>item.id===task.id));
}
scenarios.push('settlement, annual-report and task-management pages each create a real typed task, record an attributed completion step, correct it and delete it locally');

// Regression: a visible row action on the settings page must use that explicit
// workflow, even while the overview retains a different region filter.
await nav('报税','报税总览');await taxReset();await filter({region:'北京'});assert(!row(ids[20]));
await nav('报税','报税设置');setSelect($('[data-selection-scope="tax_workflows"] [data-page-size]'),'100');await delay(40);
const crossRegion=await checkOne(ids[20]);assert.equal(crossRegion.client_id,ids[20]);assert.equal(crossRegion.derived_overall_status,'failed');
await nav('报税','报税总览');assert.equal($('[data-tax-filter="region"]').value,'北京');assert(!row(ids[20]));await taxReset();
scenarios.push('settings row check targets its explicit Shanghai workflow while the overview keeps a Beijing filter');

// Regression: an old generic client filter must not leak into the overview's
// record export. The export follows its own visible company set and period.
await nav('报税','报税记录');setSelect($('[data-filter="clientId"]'),String(boot.clients.find(client=>Number(client.id)===1).id));await delay(35);
click($('[data-sub="报税总览"]'),'return to overview while retaining old generic client filter');await waitFor(()=>$('[data-tax-overview]'),'overview after record client filter');await filter({agentId:String(agentA.id)});
const recordScopeBlob=blobs.length;exportMenu();click($('[data-action="tax-export-records"]'),'export overview scoped tax records');await waitFor(()=>blobs.length===recordScopeBlob+1,'scoped overview tax record CSV');
const overviewRecordsCSV=csvRows(await blobs.at(-1).text()),overviewNameIndex=overviewRecordsCSV[0].indexOf('客户'),overviewPeriodIndex=overviewRecordsCSV[0].indexOf('期间');assert(overviewNameIndex>=0&&overviewPeriodIndex>=0);
const expectedOverviewRecords=(await readBoot()).tax_records.filter(record=>Number(record.client_id)===ids[0]&&record.period===period);assert.equal(overviewRecordsCSV.length,expectedOverviewRecords.length+1);assert(overviewRecordsCSV.slice(1).every(line=>line[overviewNameIndex]===clientMap.get(ids[0]).name&&line[overviewPeriodIndex]===period));
await taxSearch('NO-SYNTHETIC-EXPORT-MATCH');assert.equal(rows(scope).length,0);const emptyBlobCount=blobs.length,oldDownload=window.lastDownload;exportMenu();click($('[data-action="tax-export-records"]'),'empty overview records export');await waitFor(()=>$$('.toast').some(node=>node.textContent.includes('当前客户筛选及期间没有本地税务记录')),'empty scoped export notice');assert.equal(blobs.length,emptyBlobCount);assert.equal(window.lastDownload,oldDownload);await taxReset();
scenarios.push('overview tax-record export ignores a stale generic client id, exports only its visible company/period, and refuses an empty scope');

// Regression: one company can have several tax types. Selecting one type must
// constrain both its rows and the selected-record CSV rather than mixing VAT.
await nav('报税','报税记录');setSelect($('[data-filter="clientId"]'),String(ids[1]));await delay(35);assert.equal(rows('tax_records').length,2);setSelect($('[data-filter="taxType"]'),'个人所得税');await delay(35);assert.deepEqual(rows('tax_records').map(node=>Number(node.value)),[Number(individualRecord.id)]);
check(header('tax_records'));const oneTypeBlob=blobs.length;click($('[data-action="local-tax-export-selected"]'),'export selected tax type');await waitFor(()=>blobs.length===oneTypeBlob+1,'one tax-type CSV');const oneTypeCSV=csvRows(await blobs.at(-1).text());assert.equal(oneTypeCSV.length,2);assert.equal(oneTypeCSV[1][oneTypeCSV[0].indexOf('税种')],'个人所得税');click($('[data-action="reset-filters"]'),'clear generic record filters');await delay(35);
scenarios.push('same-company tax-type filter and selected CSV contain only the requested individual tax record');

// Regression: undoing an already-completed step reopens the local task in the
// same PATCH, so a completed label cannot survive an incomplete checklist.
await nav('报税','工商年报');const completedBefore=(await readBoot()).projects.find(item=>Number(item.id)===Number(project.id));assert.equal(completedBefore.status,'completed');assert(completedBefore.steps[0].done);
click($(`[data-action="local-tax-project-steps"][data-id="${project.id}"]`),'completed annual task steps');await waitFor(()=>$(`[data-action="local-tax-project-toggle"][data-id="${project.id}"][data-index="0"]`)?.textContent==='取消完成','completed step cancel control');const undoTraffic=traffic.length;
click($(`[data-action="local-tax-project-toggle"][data-id="${project.id}"][data-index="0"]`),'undo completed annual step');await waitFor(()=>$(`[data-action="local-tax-project-toggle"][data-id="${project.id}"][data-index="0"]`)?.textContent==='登记完成','step reopened');await dismiss();
const reopened=(await readBoot()).projects.find(item=>Number(item.id)===Number(project.id));assert.equal(reopened.status,'in_progress');assert.equal(reopened.steps[0].done,false);const undoRequest=traffic.slice(undoTraffic).find(request=>request.method==='PATCH'&&request.path===`/api/projects/${project.id}`);assert.equal(undoRequest.body.status,'in_progress');
const annualBeforeRecheck=await workflowFor(ids[2]);assert(annualBeforeRecheck.check_stale);const annualAfterUndo=await post(`/api/tax-workflows/${annualBeforeRecheck.id}/check`,{version:annualBeforeRecheck.version});assert.equal(annualAfterUndo.derived_annual_status,'failed');assert.equal(annualAfterUndo.derived_overall_status,'failed');
scenarios.push('undoing a completed annual step atomically reopens the project and a real recheck rejects its incomplete annual scope');

assert.equal(errors.length,0,errors.map(String).join('\n'));
const report={scenarios,scenarioCount:scenarios.length,requests,allPassed:true,fixture:'fresh temporary loopback demo200 database, rejected live ports 8765/8766',limits:'Functional DOM with real HTTP and real local rule results; no tax authority access or actual system printing.'};
await writeFile('tax-overview-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));process.exit(0);

// This targeted test uses only the throwaway fixture created by run-checks.py.
// It never opens a reference website or a browser, and refuses live app ports.
