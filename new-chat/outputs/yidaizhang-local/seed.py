"""Explicit synthetic test fixture. Application startup never calls this module.

Tests may call seed(conn,user) in a disposable database whose demo marker is true.
There is deliberately no startup/CLI auto-population of customer enterprises.
"""
import datetime as dt
import json
import business
from db import audit, now


def _seed_books(conn,user,today):
    """Build real linked sample books using domain helpers, without committing.

    Only the first three freshly generated synthetic clients reach this helper.
    Calling finance.handle would commit the surrounding initial-setup transaction;
    these same validation helpers keep the whole demo initialization atomic.
    """
    import finance
    pd=today.strftime('%Y-%m');day=today.isoformat()
    clients=[dict(r) for r in conn.execute('SELECT * FROM clients ORDER BY id LIMIT 3')]
    for index,client in enumerate(clients,1):
        cid=client['id'];small=client['standard']=='small2013'
        capital='3001' if small else '4001';income='5001' if small else '6001'
        finance._insert_voucher(conn,cid,day,'合成演示：股东投入经营资金',[
            finance._entry('1002',debit=5000000,category='financing'),
            finance._entry(capital,credit=5000000)],user,reviewed=index<=2)
        finance._insert_voucher(conn,cid,day,'合成演示：收取本月咨询服务收入',[
            finance._entry('1002',debit=1200000+index*100000,category='operating'),
            finance._entry(income,credit=1200000+index*100000)],user,reviewed=index==2)
    first,second=clients[:2]
    cid=first['id']
    finance._asset_create(conn,cid,dict(name='合成演示办公电脑',purchase_date=day,
        start_period=finance._month_add(pd,1),cost_fen=600000,residual_fen=30000,
        life_months=60,expense_account='5602',asset_account='1601',depreciation_account='1602',counter_account='1002'),user)
    item=finance._item_create(conn,cid,dict(sku='DEMO-STOCK-001',name='合成演示办公设备',unit='台',inventory_account='1405',cost_account='5401'),user)
    incoming=finance._movement(conn,cid,dict(item_id=item['id'],version=item['version'],date=day,
        direction='in',quantity='10',amount_fen=200000,counter_account='1002',cashflow_category='operating'),user)
    finance._movement(conn,cid,dict(item_id=item['id'],version=incoming['version'],date=day,
        direction='out',quantity='3'),user)
    finance._payroll_create(conn,second['id'],dict(period=pd,employee_name='合成演示员工甲',gross_fen=800000,
        withheld_tax_fen=12000,social_fen=80000,other_deduction_fen=0,expense_account='5602'),user)
    finance._payroll_post(conn,second['id'],{'period':pd},user)
    # Real sequential empty-period closes illustrate the annual matrix while
    # leaving the current period open. In January there is nothing to close.
    for month in range(1,min(today.month,3)):
        finance._close(conn,cid,{'period':f'{today.year}-{month:02d}'},user)
    # Domain-generated payroll summaries are fixed text; clearly label only these
    # newly seeded records. No existing book ever enters this initialization.
    for row in conn.execute('SELECT id,summary FROM vouchers WHERE summary NOT LIKE ?',('%合成演示%',)).fetchall():
        summary='合成演示：'+row['summary']
        conn.execute('UPDATE vouchers SET summary=?,version=version+1 WHERE id=?',(summary,row['id']))
        audit(conn,user,'label_synthetic','voucher',row['id'],{'summary':summary})


def seed(conn,user):
    mode=conn.execute("SELECT value FROM meta WHERE key='demo'").fetchone()
    if not mode or mode[0]!='true':raise RuntimeError('演示数据只能写入显式 --demo 数据目录')
    if conn.execute('SELECT COUNT(*) FROM clients').fetchone()[0]:return
    import finance
    users=[r['id'] for r in conn.execute('SELECT id FROM users ORDER BY id')]
    today=dt.date.today();pd=today.strftime('%Y-%m');start=f'{today.year}-01';end=f'{today.year}-12'
    industries=['商贸','技术服务','文化传媒','咨询','制造','餐饮']
    for i in range(1,201):
        payload=dict(name=f'演示企业{i:03d}有限公司',code=f'DEMO{i:04d}',taxpayer_type='general' if i%4==0 else 'small',
            standard='enterprise2007' if i%3==0 else 'small2013',industry=industries[(i-1)%len(industries)],region='演示地区',
            start_period=start,accountant_id=users[(i-1)%len(users)],labels=['合成数据','重点跟进'] if i%7==0 else ['合成数据'],
            note='仅为合成演示资料，不代表真实企业。' if i%5==0 else '')
        client=business.save(conn,'clients',business.client_data(conn,payload),None,user);finance.ensure_book(conn,client)
        fee=30000+(i%5)*10000
        contract=business.save(conn,'contracts',business.contract_data(conn,dict(client_id=client['id'],service='代理记账',start_period=start,end_period=end,monthly_fee_fen=fee,note='合成演示合同')),None,user)
        if i%3:
            due=business.months(start,pd)*fee
            business.save(conn,'receipts',dict(contract_id=contract['id'],client_id=client['id'],date=today.isoformat(),amount_fen=due if i%4 else fee*2,
                method='银行转账（演示）',note='合成收款，不产生真实资金变动',user_id=user['id'],created_at=now()),None,user)
        if i<=35:
            business.save(conn,'invoices',business.invoice_data(conn,dict(client_id=client['id'],period=pd,kind='input' if i%2 else 'output',
                number=f'DEMO-INV-{i:04d}',date=today.isoformat(),category='办公费' if i%2 else '服务收入',summary='合成票据用于试用',amount_fen=100000+i*1000,tax_fen=3000,total_fen=103000+i*1000)),None,user)
        if i<=20:
            business.save(conn,'tax_records',business.tax_data(conn,dict(client_id=client['id'],period=pd,tax_type='增值税',amount_fen=10000+i*100,
                status='submitted' if i%3==0 else 'pending',reference=f'DEMO-ACK-{i:03d}' if i%3==0 else '',
                confirmation_status='confirmed' if i%2 else 'pending',note='人工登记示例，未连接税局'),None,user),None,user)
        if i<=15:
            steps=[{'title':'资料收集','done':True,'note':'演示完成'}, {'title':'材料核对','done':i%2==0,'note':''}, {'title':'办理及归档','done':False,'note':''}]
            business.save(conn,'projects',business.project_data(conn,dict(client_id=client['id'],name='演示工商变更项目',type='工商变更',status='in_progress',due_date=today.isoformat(),assignee_id=users[(i-1)%3],steps=steps),None,user),None,user)
        if i<=10:
            business.save(conn,'notes',dict(client_id=client['id'],text='演示跟进：已联系客户补充本月票据，等待资料。',user_id=user['id'],created_at=now()),None,user)
        if i<=3:
            business.save(conn,'tax_agents',business.tax_agent_data(conn,dict(name='演示办税联系人'+str(i),phone='1380000000'+str(i),role='办税联系人',client_id=client['id'],note='合成联系人，勿拨打')),None,user)
        if i<=5:
            business.save(conn,'invoice_requests',business.invoice_request_data(conn,dict(client_id=client['id'],buyer_name=f'合成购方{i:03d}',content='演示服务开票申请',amount_fen=100000,tax_fen=3000,note='本地草稿，不是有效税票')),None,user)
    _seed_books(conn,user,today)
    conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('synthetic_seeded',?)",(now(),))

