import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire('C:/Users/Admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/');
const {chromium}=require('playwright');
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const page=await browser.newPage();
try {
 await page.goto('http://127.0.0.1:9877/work/ui-tests/reconcile-visual-harness.html');
 await page.evaluate(async()=>{const m=await import('/outputs/yidaizhang-local/public/reconcile.js');m.resetReconcile(); const root=document.querySelector('#root');root.innerHTML=m.renderReconcile([]);window.payload=null;const api=async(path,opts)=>{if(path.endsWith('/start')){window.payload=opts.body;return {job_id:'1'};}if(path.includes('/progress'))return {status:'completed',elapsed_seconds:2,files:[{name:'bank-inner.jpg',kind:'statement',status:'completed'},{name:'invoice-inner.jpg',kind:'invoice',status:'completed'}],result:{transactions:[],invoices:[]}};throw Error(path);};m.bindReconcile(root,api,[]);});
 const upload=(name)=>({name,mimeType:'image/jpeg',buffer:Buffer.from('test')});
 await page.locator('[data-rc-file="statement"]').setInputFiles(upload('bank.jpg'));
 await page.locator('[data-rc-file="invoices"]').setInputFiles([upload('invoice1.jpg'),upload('invoice2.jpg')]);
 await page.locator('[data-rc-add="transactions"]').click();
 assert.match(await page.locator('.rc-file-status').nth(0).innerText(),/bank.jpg/);
 assert.doesNotMatch(await page.locator('.rc-file-status').nth(0).innerText(),/invoice/);
 assert.match(await page.locator('.rc-file-status').nth(1).innerText(),/invoice1.jpg/);
 await page.locator('[data-rc-remove-file="invoices"]').first().click();
 assert.doesNotMatch(await page.locator('.rc-file-status').nth(1).innerText(),/invoice1.jpg/);
 await page.locator('[data-rc-action="parse"]').click();
 await page.locator('[data-rc-progress="invoice"]:visible').waitFor();
 assert.match(await page.locator('[data-rc-progress="statement"]').innerText(),/bank-inner.jpg/);
 assert.doesNotMatch(await page.locator('[data-rc-progress="statement"]').innerText(),/invoice-inner.jpg/);
 assert.match(await page.locator('[data-rc-progress="invoice"]').innerText(),/invoice-inner.jpg/);
 const payload=await page.evaluate(()=>window.payload);assert.equal(payload.statement.name,'bank.jpg');assert.deepEqual(payload.invoices.map(x=>x.name),['invoice2.jpg']);
 await page.locator('[data-rc-remove-file="statement"]').click();
 assert.match(await page.locator('.rc-file-status').nth(0).innerText(),/尚未选择文件/);
 console.log('independent selections, redraw persistence, removal, submission and separated progress passed');
} finally {await browser.close();}
