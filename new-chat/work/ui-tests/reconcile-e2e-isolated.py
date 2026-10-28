from playwright.sync_api import sync_playwright, expect
import json
url='http://127.0.0.1:53863/e2e.html'
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe',args=['--no-sandbox'])
 page=browser.new_page();page.set_default_timeout(7000);page.on('dialog',lambda d:d.accept()); page.on('pageerror',lambda e:print('PAGE ERROR',str(e)))
 page.goto(url);page.wait_for_selector('[data-rc-action="match"]')
 for i in range(3):page.click('[data-rc-add="transactions"]');page.click('[data-rc-add="invoices"]')
 page.fill('[data-rc-account]','合成客户公司')
 data=[('2026-09-01','-100.00','合成供应商','合成供应商','合成客户公司','E2E-1'),('2026-09-02','200.00','合成购买方','合成客户公司','合成购买方','E2E-2'),('2026-09-03','-50.00','合成供应商二','合成供应商二','合成客户公司','E2E-3')]
 for i,(date,amount,counter,seller,buyer,num) in enumerate(data):
  for typ,key,val in [('transactions','date',date),('transactions','amount',amount),('transactions','counterparty',counter),('invoices','date',date),('invoices','amount',amount.lstrip('-')),('invoices','seller',seller),('invoices','buyer',buyer),('invoices','number',num)]:page.locator(f'[data-rc-field="{typ}"][data-index="{i}"][data-key="{key}"]').fill(val)
 page.click('[data-rc-action="match"]');expect(page.locator('.rc-badge.ok')).to_have_count(3)
 page.select_option('[data-rc-client]','1');page.wait_for_selector('[data-rc-bank] option[value="1002"]',state="attached");page.select_option('[data-rc-bank]','1002')
 csrf=page.request.get('http://127.0.0.1:53863/api/session').json()['csrf']
 def api(path,body=None):
  r=page.request.post('http://127.0.0.1:53863'+path,data=body,headers={'X-CSRF-Token':csrf}) if body is not None else page.request.get('http://127.0.0.1:53863'+path)
  assert r.ok,(r.status,r.text());return r.json()
 api('/api/books/1/vouchers',{'date':'2026-09-03','summary':'合成可能重复','lines':[{'account_code':'1001','debit_fen':5000,'credit_fen':0},{'account_code':'1002','debit_fen':0,'credit_fen':5000}]})
 page.click('[data-rc-action="save-all"]');expect(page.locator('[data-rc-post-review]')).to_have_count(1)
 assert page.locator('.rc-results').inner_text().count('已入账')==2
 assert '合成可能重复' in page.locator('.rc-results').inner_text()
 page.fill('[data-rc-duplicate-note]','已核实是另一笔测试流水');page.click('[data-rc-post-review]');expect(page.locator('.rc-results .rc-badge.approved')).to_have_count(3);expect(page.locator('.rc-results')).not_to_contain_text('待入账')
 balance=api('/api/books/1/balance?start=2026-09&end=2026-09')
 rows={r['account_code']:r for r in balance['trial_balance_rollup']}
 assert rows['112201']['credit_fen']==20000 and rows['220201']['debit_fen']==10000 and rows['220202']['debit_fen']==5000
 book=api('/api/books/1?period=2026-09');assert len(book['vouchers'])==4
 j=api('/api/books/1/journals',{'date':'2026-09-01','summary':'日记账重复测试','bank_account':'1002','counter_account':'1001','direction':'expense','amount_fen':10000,'cashflow_category':'operating'})
 page.click('#test-journals');page.wait_for_selector(f'[data-book-action="post-journal"][data-id="{j["id"]}"]');page.click(f'[data-book-action="post-journal"][data-id="{j["id"]}"]');page.wait_for_selector('#modal textarea[name="duplicate_review_note"]')
 assert '合成供应商' in page.locator('#modal').inner_text()
 page.fill('#modal textarea','确认与既有流水不同');page.click('#modal button[type=submit]');expect(page.locator('#modal')).to_be_empty()
 book2=api('/api/books/1?period=2026-09');assert len(book2['vouchers'])==5
 print(json.dumps({'result':'PASS','matched':3,'posted':3,'reconcile_duplicate_blocked_and_reviewed':True,'journal_duplicate_blocked_and_reviewed':True,'receivable_credit_fen':rows['112201']['credit_fen'],'payable_debit_fen':rows['220201']['debit_fen']+rows['220202']['debit_fen'],'vouchers_after_journal':len(book2['vouchers'])},ensure_ascii=False))
 browser.close()
