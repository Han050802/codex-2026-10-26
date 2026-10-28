import {parseHTML} from 'linkedom';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createTaxOverviewState,getTaxOverviewData,renderTaxOverview,taxColumns} from '../../outputs/yidaizhang-local/public/tax-overview.js';

const client={id:101,name:'合成渲染审查客户',code:'TX-RENDER',region:'北京',start_period:'2026-01',accountant_id:1,taxpayer_type:'small',authorized_user_ids:[],deleted:0,labels:[]};
const agent={id:7,name:'合成通用办税人',client_id:null,deleted:0};
const base={state:createTaxOverviewState(),clients:[client],users:[{id:1,name:'合成操作员'}],user:{id:1},period:'2026-10',taxAgents:[agent],taxWorkflows:[],taxRecords:[{id:51,client_id:101,period:'2026-10',tax_type:'增值税',status:'submitted',payment_status:'paid',deleted:0}],selected:new Set()};
const workflow={id:9,client_id:101,period:'2026-10',tax_agent_id:7,verification_status:'passed',derived_verification_status:'passed',verification_stale:false,overall_status:'passed',general_status:'passed',individual_status:'not_applicable',derived_overall_status:'passed',derived_general_status:'passed',derived_individual_status:'not_applicable',check_stale:false};
const scenarios=[];
const empty=getTaxOverviewData(base);assert.equal(empty.rows.length,0);assert(Object.values(empty.flow).every(stage=>stage.total===0));
const emptyDOM=parseHTML(renderTaxOverview(base,empty)).document;
assert.equal(emptyDOM.querySelectorAll('th[data-tax-column]').length,13);assert(emptyDOM.querySelector('.tx-empty'));assert.equal(emptyDOM.querySelectorAll('.tx-card-total').length,4);assert([...emptyDOM.querySelectorAll('.tx-card-total')].every(node=>node.textContent==='0'));
assert.deepEqual([...emptyDOM.querySelectorAll('th[data-tax-column]')].map(node=>node.dataset.taxColumn),['select','index','name','switch_count','tax_agent','verification_status','taxpayer_type','submission_status','payment_status','check_status','national_check_status','individual_check_status','actions']);
scenarios.push('old tax records alone cannot configure the overview; zero cards, original guide and thirteen exact columns');

const passed=getTaxOverviewData({...base,taxWorkflows:[workflow]});assert.equal(passed.rows.length,1);assert.equal(passed.rows[0].checkStatus,'passed');assert.equal(passed.flow.verification.total,1);assert.equal(passed.flow.submission.submitted,1);assert.equal(passed.flow.payment.paid,1);
scenarios.push('configured valid agent, explicit manual verification and persisted derived check results yield one correctly counted row');
const invalid=getTaxOverviewData({...base,taxWorkflows:[workflow],taxAgents:[{...agent,client_id:999}]});assert.equal(invalid.rows.length,0);assert.equal(invalid.flow.verification.total,0);
scenarios.push('a tax agent bound to another client cannot silently configure or verify this client');

const stale=getTaxOverviewData({...base,taxWorkflows:[{...workflow,check_stale:true}]});assert.equal(stale.rows[0].checkStatus,'not_checked');assert.equal(stale.rows[0].nationalCheckStatus,'not_checked');assert.equal(stale.flow.check.passed,0);
scenarios.push('stale check history never renders a current passed result');
const staleIdentity=getTaxOverviewData({...base,taxWorkflows:[{...workflow,verification_stale:true,derived_verification_status:'unverified'}]});assert.equal(staleIdentity.rows.length,0,'A stale raw verification pass must not enter the eligible table');assert.equal(staleIdentity.flow.verification.passed,0);
scenarios.push('stale identity verification uses the derived unverified state and cannot appear as verified');

const preparing=getTaxOverviewData({...base,taxWorkflows:[workflow],taxRecords:[{...base.taxRecords[0],status:'preparing',payment_status:'unpaid'}]});assert.equal(preparing.rows[0].submissionStatus,'in_progress','The existing backend preparing enum must show declaration in progress');assert.equal(preparing.flow.submission.in_progress,1);
scenarios.push('the persisted preparing declaration status is displayed as in progress');
const partial=getTaxOverviewData({...base,taxWorkflows:[workflow],taxRecords:[base.taxRecords[0],{...base.taxRecords[0],id:52,tax_type:'企业所得税',status:'pending',payment_status:'unpaid'}]});assert.equal(partial.rows[0].submissionStatus,'in_progress');assert.equal(partial.rows[0].paymentStatus,'in_progress');
scenarios.push('mixed declaration/payment records produce truthful in-progress aggregates');

const failed=getTaxOverviewData({...base,taxWorkflows:[{...workflow,verification_status:'failed',derived_verification_status:'failed'}]});assert.equal(failed.rows.length,0);assert.equal(failed.flow.verification.failed,1);
const safe=parseHTML(renderTaxOverview({...base,clients:[{...client,name:'<img src=x onerror=alert(1)>'}],taxWorkflows:[workflow]})).document;assert.equal(safe.querySelectorAll('img').length,0);assert(safe.querySelector('[data-tax-cell="name"]').textContent.includes('<img'));
for(const key of ['select','index','name','actions'])assert(taxColumns().find(column=>column.key===key).required);
scenarios.push('failed verification stays outside eligible rows, required columns preserve controls and client text is escaped');

const collapsed={...base,state:{...createTaxOverviewState(),collapsed:true},taxWorkflows:[workflow]};assert(parseHTML(renderTaxOverview(collapsed)).document.querySelector('.tx-flow-cards').hidden);
scenarios.push('collapse state hides only the flow cards while preserving the data table');
const report={scenarios,scenarioCount:scenarios.length,allPassed:true,note:'Independent synthetic render review only; no server or runtime data.'};
await writeFile('tax-overview-render-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
