import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire('C:/Users/Admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/');
const {chromium}=require('playwright');
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try {
 const page=await browser.newPage({viewport:{width:1600,height:900}});
 await page.goto('http://127.0.0.1:8765/');
 await page.setContent('<link rel="stylesheet" href="/company-balance.css"><div class="company-balance" id="root"></div>');
 await page.evaluate(async()=>{
  const {companyBalanceTest:ui}=await import('/company-balance.js?detail-test');
  const accounts=[{code:'5401',name:'主营业务成本',category:'expense'}];
  const data={expense_classifications:[{record_id:1,date:'2026-09-09',account_code:'5401',account_name:'主营业务成本',direction:'expense',amount_fen:11200000},{record_id:2,date:'2026-09-17',account_code:'5401',account_name:'主营业务成本',direction:'expense',amount_fen:10300000}],trial_balance:[{account_code:'5401',account_name:'主营业务成本',debit_fen:0,credit_fen:0}]};
  data.trial_balance_rollup=ui.rollupTrial(data.trial_balance,accounts);
  const current={showZero:false,showActivityZero:true,showAuxiliary:false,showDisabled:true,levelFrom:'1',levelTo:'6',start:'2026-09',end:'2026-09',collapsed:new Set(),expanded:true};
  document.querySelector('#root').innerHTML=ui.tableMarkup(data,current,{accounts},{});
 });
 const rows=page.locator('tr.cob-classification');
 assert.equal(await rows.count(),2);
 assert.match(await rows.nth(0).innerText(),/2026-09-09.*112,000\.00/s);
 assert.match(await rows.nth(1).innerText(),/2026-09-17.*103,000\.00/s);
 assert.doesNotMatch(await page.locator('#root').innerText(),/215,000\.00/);
 console.log('Browser: two separate dated records; no merged amount');
} finally {await browser.close();}
