"""Check a failed post-save navigation can recover without posting again."""
from pathlib import Path
import sys, tempfile, threading
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[2]/'outputs'/'yidaizhang-local'
sys.path.insert(0,str(ROOT))
import server

with tempfile.TemporaryDirectory(prefix='ydz-batch-browser-') as folder:
    app=server.Application(folder,demo=True)
    http=server.make_server('127.0.0.1',0,app)
    thread=threading.Thread(target=http.serve_forever,daemon=True); thread.start()
    base=f'http://127.0.0.1:{http.server_address[1]}'
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe')
            context=browser.new_context(viewport={'width':1440,'height':900})
            auth=context.request.post(base+'/api/login',data={'username':'demo1','password':'DemoOnly123!'})
            assert auth.ok,auth.text()
            csrf=auth.json()['csrf']
            client=context.request.post(base+'/api/clients',headers={'X-CSRF-Token':csrf},data={
                'name':'合成测试账套','code':'BROWSER-BATCH','taxpayer_type':'general','standard':'enterprise2007',
                'start_period':'2026-01','industry':'商务服务','region':'本地','accountant_id':1,'enabled':True})
            assert client.ok,client.text()
            page=context.new_page();page.set_default_timeout(12000)
            errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
            page.goto(base+'/');page.locator('[data-nav="票据"]').click();page.locator('[data-sub="流水发票核对"]').click()
            page.locator('[data-rc-account]').fill('合成测试账套');page.locator('[data-rc-account]').press('Tab')
            page.locator('[data-rc-add="transactions"]').click();page.locator('[data-rc-add="invoices"]').click()
            for typ,key,value in [('transactions','date','2026-09-01'),('transactions','amount','-100.00'),
                                  ('transactions','counterparty','合成供应商'),('transactions','note','合同预付款'),
                                  ('invoices','date','2026-09-01'),('invoices','amount','100.00'),
                                  ('invoices','seller','合成供应商'),('invoices','buyer','合成测试账套'),('invoices','number','BROWSER-001')]:
                page.locator(f'[data-rc-field="{typ}"][data-index="0"][data-key="{key}"]').fill(value)
            page.locator('[data-rc-action="match"]').click()
            expect(page.locator('[data-rc-action="save-all"]')).to_be_enabled()
            expect(page.locator('.rc-results')).to_contain_text('预付账款')
            expect(page.locator('.rc-results')).to_contain_text('银行存款')
            page.on('dialog', lambda dialog: dialog.dismiss())
            page.route('**/api/books/*?*', lambda route: route.fulfill(status=503, body='temporarily unavailable'))
            page.locator('[data-rc-action="save-all"]').click()
            expect(page.locator('.page-error')).to_contain_text('已保存并记账')
            expect(page.locator('[data-action="reconcile-balance-retry"]')).to_be_visible()
            page.locator('[data-action="reconcile-balance-return"]').click()
            expect(page.locator('.notice')).to_contain_text('已保存并记账')
            expect(page.locator('[data-rc-action="show-balance"]')).to_be_visible()
            page.locator('[data-rc-action="show-balance"]').click()
            expect(page.locator('[data-action="reconcile-balance-retry"]')).to_be_visible()
            page.unroute_all()
            page.locator('[data-action="reconcile-balance-retry"]').click()
            expect(page.locator('.company-balance')).to_be_visible()
            expect(page.locator('.cob-posting-summary')).to_contain_text('合成测试账套')
            expect(page.locator('.company-balance')).to_contain_text('合成供应商')
            expect(page.locator('body')).to_contain_text('112301')
            expect(page.locator('body')).to_contain_text('100.00')
            assert not page.locator('[role="dialog"]').count(), 'Should not prompt for a voucher dialog'
            assert not errors, errors
            print('PASS: saved state survives failed navigation; returning and retrying opens the balance')
            browser.close()
    finally:
        http.shutdown();http.server_close();thread.join(timeout=3)
