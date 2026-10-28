import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire('C:/Users/Admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/');
const {chromium}=require('playwright');
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const page=await browser.newPage({viewport:{width:1280,height:800}});
try {
 await page.goto('http://127.0.0.1:9876/work/ui-tests/reconcile-visual-harness.html');
 await page.locator('[data-rc-add="transactions"]').click();await page.locator('[data-rc-add="invoices"]').click();
 for(const [selector,value] of [['[data-rc-field="transactions"][data-key="date"]','2026-09-01'],['[data-rc-field="transactions"][data-key="amount"]','100.00'],['[data-rc-field="transactions"][data-key="counterparty"]','合成客户'],['[data-rc-field="invoices"][data-key="date"]','2026-09-01'],['[data-rc-field="invoices"][data-key="amount"]','100.00'],['[data-rc-field="invoices"][data-key="seller"]','合成公司'],['[data-rc-field="invoices"][data-key="buyer"]','合成客户'],['[data-rc-field="invoices"][data-key="number"]','测试发票'],['[data-rc-account]','合成公司']])await page.locator(selector).fill(value);
 await page.locator('[data-rc-client]').selectOption('7');await page.locator('[data-rc-save]').first().waitFor();
 assert.equal(await page.locator('[data-rc-save]').count(),1,'通过项目不应重复显示在待处理区');
 await page.locator('[data-rc-save]').first().click();await page.locator('[data-rv-lines]').waitFor();
 await page.screenshot({path:'reconcile-voucher-visual.png'});
 const box=await page.locator('.modal').boundingBox();const body=await page.locator('.modal-body').boundingBox();
 console.log('modal bounds',box,'body bounds',body);
 assert(await page.locator('[data-rv-account]').count()===2);
 await page.locator('[name="summary"]').fill('合成收款');await page.locator('[data-rv-account]').nth(0).selectOption('100201');await page.locator('[data-rv-account]').nth(1).selectOption('5001');
 await page.locator('[data-rv-debit]').nth(0).fill('100');await page.locator('[data-rv-credit]').nth(1).fill('100');await page.setViewportSize({width:800,height:600});await page.getByRole('button',{name:'确认并记账'}).click();
 await page.locator('[data-rv-duplicate]').waitFor({state:'visible'});assert((await page.locator('[data-rv-duplicate]').innerText()).includes('记-001'));
 await page.screenshot({path:'reconcile-voucher-duplicate-visual.png'});
 await page.locator('[name="duplicate_review_note"]').fill('已核对为另一笔业务');await page.getByRole('button',{name:'确认并记账'}).click();
 await page.locator('[data-rv-lines]').waitFor({state:'detached'});
 assert((await page.evaluate(()=>calls)).some(x=>x.path==='/api/reconcile/save'&&x.body.voucher.lines[0].account_code==='100201'));
 assert((await page.locator('body').innerText()).includes('已保存并记账'));
 await page.locator('[data-rc-action="history"]').click();await page.locator('[data-rc-post]').click();await page.locator('[data-rv-lines]').waitFor();await page.locator('[data-rv-cancel]').last().click();
 assert(!(await page.evaluate(()=>calls)).some(x=>x.path.endsWith('/post')));
 console.log('synthetic integrated save and history cancellation passed');
} finally {await browser.close();}
