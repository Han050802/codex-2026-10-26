import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {renderCompanyBalance,bindCompanyBalance} from '../../outputs/yidaizhang-local/public/company-balance.js';
import {renderCompanyWorkspace,updateCompanyReportRange} from '../../outputs/yidaizhang-local/public/company-workspace.js';

// All API responses and client records are synthetic in-memory fixtures.
// This check never opens a database or contacts the running workspace service.
const {window}=parseHTML('<html><body><main id="workspace"></main><div id="modal-root"></div></body></html>');
globalThis.window=window;
globalThis.document=window.document;
Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??'';},set(value){for(const option of this.querySelectorAll('option'))option.toggleAttribute('selected',option.value===String(value));}});
globalThis.FormData=class {
  constructor(form){this.values=[...form.querySelectorAll('input[name],select[name]')].map(el=>[el.name,el.value]);}
  entries(){return this.values[Symbol.iterator]();}
};
const host=document.querySelector('#workspace'),modalRoot=document.querySelector('#modal-root');
const $=(selector,root=host)=>root.querySelector(selector);
const $$=(selector,root=host)=>[...root.querySelectorAll(selector)];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function settle(){for(let i=0;i<6;i++)await tick();}
async function click(selector){const node=$(selector);assert.ok(node,`Missing ${selector}`);node.dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));await settle();}
const money=value=>(value/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const account={code:'1002',account_code:'1002',name:'银行存款',account_name:'银行存款',category:'asset',level:1,is_leaf:true,opening_debit_fen:10000,opening_credit_fen:0,debit_fen:1300,credit_fen:1150,closing_debit_fen:10150,closing_credit_fen:0};
const ledger=[
  {id:110,number:11,debit_fen:0,credit_fen:1100},
  {id:22,number:'2',debit_fen:0,credit_fen:50},
  {id:100,number:10,debit_fen:1000,credit_fen:0},
  {id:99,number:1,debit_fen:100,credit_fen:0},
  {id:21,number:2,debit_fen:200,credit_fen:0},
].map(line=>({...line,date:'2026-09-15',account_code:'1002',account_name:'银行存款',line_summary:`合成分录 ${line.id}`}));
function book(id){return {client:{id,name:`合成公司 ${id}`,start_period:'2026-01'},period:'2026-09',accounts:[account],trial_balance:[account],trial_balance_rollup:[account],ledger};}
function balance(start,end){return {start_period:start,end_period:end,trial_balance:[account],trial_balance_rollup:[account],ledger};}
const ranges=[],errors=[],calls=[],performed=[];
let mode='success',deferred;
const ctx={
  money,
  toast:(message,type)=>errors.push({message,type}),
  modal:(title,html)=>{modalRoot.innerHTML=`<h2>${title}</h2>${html}`;return Promise.resolve();},
  async api(path){
    calls.push(path);
    const url=new URL(path,'https://synthetic.invalid');
    const result=balance(url.searchParams.get('start'),url.searchParams.get('end'));
    if(mode==='failure')throw new Error('合成网络异常');
    if(mode==='malformed')return {...result,end_period:'1999-01'};
    if(mode==='deferred')return new Promise(resolve=>{deferred=()=>resolve(result);});
    return result;
  },
};
const actions={reportRange:(start,end)=>{assert.equal(updateCompanyReportRange(host,start,end),true);ranges.push([start,end]);},perform:action=>performed.push(action)};
async function mount(currentBook){host.innerHTML=renderCompanyWorkspace(currentBook,ctx,{view:'ledger',content:renderCompanyBalance(currentBook,ctx)});bindCompanyBalance(host,currentBook,ctx,actions);await settle();}
const railRange=()=>[$('[data-cw-range-start]').textContent,$('[data-cw-range-end]').textContent];
async function query(start,end){$('[name="start"]').value=start;$('[name="end"]').value=end;$('[data-cob-form]').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();}

const initialBook=book(99101);
await mount(initialBook);
assert.deepEqual(ranges,[['2026-09','2026-09']]);
assert.deepEqual(railRange(),['2026.09','2026.09']);
assert.equal($('.cob-subject-menu summary').title,'选择科目分类');
assert.equal($$('.cob-subject-menu summary svg').length,2);
assert.equal($('.cob-subject-menu summary').textContent,'全部科目');
assert.equal($('.cob-round-arrow'),null);
assert.ok(!/[‹›]/.test($('.cob-subject-menu summary').innerHTML));
await click('[data-cob-category="asset"]');
assert.equal($('.cob-subject-label').textContent,'资产类');
assert.equal($('.cob-subject-menu summary').getAttribute('aria-label'),'科目分类：资产类');
await click('.cob-subject-menu [data-book-action="new-account"]');
assert.deepEqual(performed,['new-account']);
console.log('PASS category control uses labelled SVG dropdown and retains account-action bridge');

await click('[data-cob-ledger="1002"]');
const lines=$$('.cob-ledger tbody tr',modalRoot).filter(row=>!row.classList.contains('cob-ledger-opening')&&!row.classList.contains('cob-ledger-total'));
assert.deepEqual(lines.map(row=>row.children[1].textContent),['记-001','记-002','记-002','记-010','记-011']);
assert.deepEqual(lines.map(row=>row.children[3].textContent),['合成分录 99','合成分录 21','合成分录 22','合成分录 100','合成分录 110']);
assert.deepEqual(lines.map(row=>row.children[6].textContent),['借 101.00','借 103.00','借 102.50','借 112.50','借 101.50']);
assert.equal($('.cob-ledger-total td:last-child',modalRoot).textContent,'借 101.50');
console.log('PASS numeric voucher ordering matches backend date/number/line-id order and running balances');

await query('2026-08','2026-10');
assert.deepEqual(ranges.at(-1),['2026-08','2026-10']);
assert.deepEqual(railRange(),['2026.08','2026.10']);
assert.equal($('.cw-period-range').getAttribute('aria-label'),'当前查询期间：2026.08至2026.10');
assert.match($('.cob-report-status').textContent,/202608 — 202610/);
const cachedCalls=calls.length,cachedReports=ranges.length;
host.innerHTML=''; // The shell has navigated home and reset its period rail.
await mount(initialBook); // Re-enter using the exact cached book object.
assert.equal(calls.length,cachedCalls,'Re-entering cached data must not request it again');
assert.equal(ranges.length,cachedReports+1,'Re-entering cached data must notify the outer period rail');
assert.deepEqual(ranges.at(-1),['2026-08','2026-10']);
assert.deepEqual(railRange(),['2026.08','2026.10']);
assert.equal($('[name="start"]').value,'2026-08');
assert.equal($('[name="end"]').value,'2026-10');
console.log('PASS returning to a cached multi-month report restores the rail range without another API request');
const rangeCount=ranges.length;
mode='failure';await query('2026-07','2026-11');
assert.equal(ranges.length,rangeCount);
assert.deepEqual(railRange(),['2026.08','2026.10'],'Failed query must retain the last successful rail range');
assert.match($('.cob-query-error').textContent,/合成网络异常/);
const failureCalls=calls.length;
host.innerHTML='';await mount(initialBook);
assert.equal(calls.length,failureCalls);
assert.equal(ranges.length,rangeCount,'Re-entering a failed report must not notify a cached or failed range');
mode='malformed';await query('2026-07','2026-12');
assert.equal(ranges.length,rangeCount);
assert.match($('.cob-query-error').textContent,/数据格式错误/);
mode='success';await click('[data-cob-action="refresh"]');
assert.deepEqual(ranges.at(-1),['2026-07','2026-12']);
assert.deepEqual(railRange(),['2026.07','2026.12']);
assert.equal($('.cob-query-error'),null);
console.log('PASS reportRange follows validated query success only; failed ranges never reach outer rail');

mode='deferred';await query('2026-06','2026-12');
const resolveOld=deferred;
mode='success';await mount(book(99102));
const countBeforeOld=ranges.length;
resolveOld();await settle();
assert.equal(ranges.length,countBeforeOld);
assert.deepEqual(ranges.at(-1),['2026-09','2026-09']);
assert.deepEqual(railRange(),['2026.09','2026.09']);
assert.equal($('.company-balance').dataset.cobCompany,'99102');
console.log('PASS changing companies discards stale responses and their reportRange notifications');

const css=await readFile(new URL('../../outputs/yidaizhang-local/public/company-balance.css',import.meta.url),'utf8');
for(const selector of ['.cob-ledger-head','.cob-ledger table','.cob-ledger th','.cob-ledger-opening td','.cob-ledger-empty']){
  const rule=css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\{([^}]*)\\}'));
  assert.ok(rule,`Missing ${selector}`);
  assert.match(rule[1],/(?:^|;)color:#000(?:;|$)/,`${selector} must use black text`);
}
assert.match(css,/\.cob-ledger th,\.cob-ledger td\{[^}]*color:#000/);
assert.doesNotMatch(css,/\.cob-round-arrow/);
console.log('PASS ledger header, body, opening row, empty message and client/period caption use black text');
console.log(JSON.stringify({ok:true,apiCalls:calls.length,reportedRanges:ranges,expectedSyntheticErrors:errors.length},null,2));
