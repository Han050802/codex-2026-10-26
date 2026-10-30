"""Local agency operations: validated writes, atomic imports and period receivables."""
import base64
import binascii
import csv
import datetime as dt
import decimal
import io
import json
import re
import sqlite3
from db import ApiError, amount, audit, now, industry_names, remember_industry
import client_profile

HELP = [
 {'id':'clients','title':'客户与分工','text':'在客户中新建企业，分别选择会计制度与纳税性质。三名操作员始终都可编辑；账套授权名单只记录分工，不限制访问。服务状态可选未设置、服务中、已暂停、已终止，新客户默认为未设置。客户删除后进入回收站，可恢复；账套数据保留。每次保存带版本，冲突时刷新后重试。'},
 {'id':'invoices','title':'票据录入与凭证','text':'票据可手工录入或按模板CSV导入。金额、税额、价税合计须相等，同客户发票号码不能重复。选择借贷科目后生成平衡凭证。已生成凭证的票据不能直接修改删除。本地不连接税局，不提供自动取票。客户账套的流水发票核对支持文件识别，原件与识别结果保存在本地。制证后可在凭证的“原件与依据”中查看原件、原始识别结果及制证依据；历史未留存原件无法自动补回。'},
 {'id':'ticket-workflow','title':'取票待办与人工资料核对','text':'预约取票只建立本地待办，预约到期不会自动登录或采集。待办完成表示人工完成待办，不代表取得发票；实际票据仍须登记或导入。核对状态只记录操作员对资料的人工核对，不是税局认证结果；不保存税局账号或密码。删除保留历史与审计，三名操作员均可编辑。'},
 {'id':'tax','title':'报税登记','text':'报税板块只记录人工或导入的申报、缴款与身份验证状态。提交状态代表操作员已核实登记，须填写回执编号或上传证明；本地应用不会向税局申报或缴款。'},
 {'id':'fees','title':'合同收费、欠费和冲销','text':'合同按起止月份及月服务费计算。所选月显示截止当月末累计应收和累计实收，超出应收的部分是预收。收款只能新增；登记错误通过冲销产生反向记录，保留原始记录与审计。合同终止后保留截止终止月的应收。'},
 {'id':'book','title':'做账与月结','text':'从客户或首页点击进账簿。先填写平衡期初，再录入借贷平衡凭证，查看试算、总账、明细账与报表。月结前检查余额和凭证，结账后该期停止写入；反结账从最新月份开始。'},
 {'id':'assets','title':'资产、库存和工资','text':'资产按卡片直线法计提折旧；库存采用移动加权平均，出库不能超过库存；工资实发为应发减个人扣款与人工登记的个税。系统不自动推断个税。自动记账都有来源关联并防止重复生成。'},
 {'id':'import','title':'导入和导出','text':'下载对应CSV模板，用UTF-8编码保存。金额列用元并最多两位小数。先验证整批，有错误全部不提交，按错误行修正后重新导入。导出CSV可供Excel打开，文本公式前缀会被安全转义。'},
 {'id':'backup','title':'备份与恢复','text':'设置中下载一致性ZIP备份，包含SQLite数据及附件。恢复先关闭服务，在服务器上运行 maintenance.py restore 备份.zip；程序会先备份当前数据库，验证备份后替换。请保管备份，它含业务资料。'},
 {'id':'projects','title':'工商项目步骤','text':'新建项目并设置责任人、截止日和步骤。勾选完成步骤时，服务器记录真实操作员和完成时间。未完成、处理中、已完成和终止状态由真实保存记录展示。'},
 {'id':'agents','title':'办税联系人与全局标签','text':'办税人管理保存本地联系人姓名、电话、角色及可选关联客户。客户留空代表机构通用联系人；不保存登录密码或证件号码。全局标签设置维护可选择标签，客户标签在客户档案中分别保存。'},
 {'id':'invoice-requests','title':'本地开票申请草稿','text':'开票申请仅保存待办草稿、购方信息、内容与金额，可改为已备妥或已取消。它不是有效发票，没有税局发票号码，也不会向税局申请开票。取得真实发票后在票据台账另行登记。'},
 {'id':'delete','title':'勾选删除与历史保护','text':'列表删除按勾选逐条处理，并报告成功或失败。税务登记、工商项目、跟进记录在本地软删除并保留审计；税务删除不代表撤销税局申报或缴款。已制证票据须先在账簿撤回来源凭证才能删除。有收款或冲销历史的合同须保留并终止；收款只能冲销。客户先进入回收站，只有无业务及历史的原始空账套可以彻底删除，其他账套保留以便恢复。'},
]


def period(value):
    if not isinstance(value, str) or not re.fullmatch(r'20\d{2}-(0[1-9]|1[0-2])', value):
        raise ApiError(400, '期间格式必须为YYYY-MM（2000—2099）')
    return value


def date(value):
    try:
        if not isinstance(value, str) or dt.date.fromisoformat(value).isoformat() != value:
            raise ValueError()
    except (ValueError, TypeError):
        raise ApiError(400, '日期格式必须为YYYY-MM-DD')
    if not 2000 <= int(value[:4]) <= 2099:
        raise ApiError(400, '日期年份应为2000—2099')
    return value


def textval(value, label, limit=500, required=False):
    if value is None:
        value = ''
    if not isinstance(value, str):
        raise ApiError(400, label+'必须是文本')
    value = value.strip()
    if (required and not value) or len(value) > limit or '\x00' in value:
        raise ApiError(400, label+'不能为空或超出长度限制')
    return value


def enum(value, allowed, label):
    if value not in allowed:
        raise ApiError(400, label+'无效')
    return value


def ref(conn, table, value, optional=False):
    if value in (None, '') and optional:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ApiError(400, table+'编号无效')
    row = conn.execute('SELECT * FROM '+table+' WHERE id=?', (value,)).fetchone()
    if row is None or (table == 'clients' and row['deleted']):
        raise ApiError(400, table+'记录不存在或已移入回收站')
    if table!='clients' and 'deleted' in row.keys() and row['deleted']:
        raise ApiError(400,'关联记录已删除')
    if table=='clients' and not row['enabled']:
        raise ApiError(400,'客户账套已停用，请先在客户档案中重新启用')
    return row


def obj(row):
    d = dict(row)
    for k in ('labels','steps'):
        if k in d:
            d[k] = json.loads(d[k])
    if 'profile_json' in d or 'sensitive_json' in d:
        d=client_profile.expand_client(d)
    return d


def fetched(conn, table, ident):
    row = conn.execute('SELECT * FROM '+table+' WHERE id=?', (ident,)).fetchone()
    if not row:
        raise ApiError(404, '记录不存在')
    return obj(row)


def stale(old, payload):
    if payload.get('version') != old['version']:
        raise ApiError(409, '数据已被其他操作员修改，请刷新后重试', {'current_version':old['version']})


def save(conn, table, data, old, user):
    if old:
        columns = list(data)
        cur = conn.execute('UPDATE '+table+' SET '+','.join(k+'=?' for k in columns)+',version=version+1 WHERE id=? AND version=?',
                           [data[k] for k in columns]+[old['id'],old['version']])
        if cur.rowcount != 1:
            raise ApiError(409, '数据版本冲突，请刷新后重试')
        ident = old['id']
    else:
        columns = list(data)
        cur = conn.execute('INSERT INTO '+table+'('+','.join(columns)+') VALUES('+','.join('?' for _ in columns)+')',[data[k] for k in columns])
        ident = cur.lastrowid
    result=fetched(conn,table,ident)
    if table=='clients':remember_industry(conn,result['industry'])
    audit(conn,user,'update' if old else 'create',table,ident,{'fields':list(data),'before':old,'after':result})
    return result


def soft_delete(conn,table,old,user):
    values={'deleted':1,'deleted_at':now()}
    if 'updated_at' in old:values['updated_at']=now()
    result=save(conn,table,values,old,user)
    audit(conn,user,'delete',table,old['id'],{'before':old,'after':result,'local_only':True})
    if table=='tax_records':
        result['external_action']='none'
        result['message']='仅删除本地税务登记，原申报及缴款证据留存审计；没有向税局撤销申报或缴款'
    return result


def purge_client(conn,old,user):
    if not old['deleted']:raise ApiError(409,'请先将客户移入回收站，再彻底删除完全空的账套',{'blocked':True,'reason':'client_not_recycled'})
    cid=old['id'];counts={}
    for item in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall():
        table=item['name']
        if table in ('accounts','book_settings'):continue
        if 'client_id' in {r['name'] for r in conn.execute('PRAGMA table_info("'+table.replace('"','""')+'")')}:
            count=conn.execute('SELECT COUNT(*) FROM "'+table.replace('"','""')+'" WHERE client_id=?',(cid,)).fetchone()[0]
            if count:counts[table]=count
    if counts:raise ApiError(409,'该账套存在业务或历史记录，不能彻底删除；已保留在回收站',{'blocked':True,'reason':'client_has_records','counts':counts})
    import finance
    expected=[set(finance._template(old['standard'])),set(finance._legacy_template(old['standard']))]
    actual={tuple(r) for r in conn.execute('SELECT code,name,direction,category,report_key FROM accounts WHERE client_id=?',(cid,))}
    settings_row=conn.execute('SELECT opening_version FROM book_settings WHERE client_id=?',(cid,)).fetchone()
    if actual not in expected or not settings_row or settings_row['opening_version']!=1 or conn.execute('SELECT 1 FROM accounts WHERE client_id=? AND version<>1',(cid,)).fetchone():
        raise ApiError(409,'该账套的科目或期初设置曾被修改，不能视为完全空账套；已保留在回收站',{'blocked':True,'reason':'client_modified_book'})
    def related(value):
        if isinstance(value,dict):return value.get('client_id')==cid or any(related(v) for v in value.values())
        if isinstance(value,list):return any(related(v) for v in value)
        return False
    for row in conn.execute("SELECT detail FROM audit_logs WHERE detail LIKE '%\"client_id\"%'"):
        try:history=json.loads(row['detail'])
        except ValueError:continue
        if related(history):raise ApiError(409,'该账套存在已删除业务的历史审计，不能彻底删除；已保留在回收站',{'blocked':True,'reason':'client_has_audit_history'})
    conn.execute('DELETE FROM book_settings WHERE client_id=?',(cid,))
    conn.execute('DELETE FROM accounts WHERE client_id=?',(cid,))
    conn.execute('DELETE FROM clients WHERE id=? AND version=?',(cid,old['version']))
    audit(conn,user,'purge','clients',cid,{'before':old,'empty_book_only':True})
    return {'id':cid,'purged':True,'message':'已彻底删除空账套，操作审计保留'}


def client_data(conn,p,old=None):
    profile_mode=client_profile.validate_mode(p,old)
    q = {**(old or {}),**p}
    labels = q.get('labels',[])
    if not isinstance(labels,list) or len(labels)>30:
        raise ApiError(400,'客户标签必须是最多30项的数组')
    accountant = q.get('accountant_id')
    if accountant in ('',None):
        accountant = None
    else:
        ref(conn,'users',accountant)
    enabled = q.get('enabled',True)
    if enabled not in (True,False,0,1):
        raise ApiError(400,'启用状态无效')
    code=q.get('code')
    if not old and profile_mode and not code:
        code=client_profile.allocate_code(conn)
    d = dict(name=textval(q.get('name'),'客户名称',150,True), code=textval(code,'客户编码',80,True),
        taxpayer_type=enum(q.get('taxpayer_type','small'),('small','general'),'纳税性质'),
        standard=enum(q.get('standard','small2013'),('small2013','enterprise2007'),'会计制度'),
        industry=textval(q.get('industry',''),'行业',80),region=textval(q.get('region',''),'地区',100),
        start_period=period(q.get('start_period')),accountant_id=accountant,enabled=int(enabled),
        labels=json.dumps([textval(x,'标签',30,True) for x in labels],ensure_ascii=False),
        service_status=enum(q.get('service_status','unset'),('unset','active','paused','terminated'),'服务状态'),
        note=textval(q.get('note',''),'随手记',4000),updated_at=now())
    if not old:
        d['created_at']=now()
    elif any(d[k]!=old[k] for k in ('standard','start_period')):
        # Finance uses its schema and is the authority on initialized chart changes.
        raise ApiError(400,'建立账套后不能更改会计制度或启用期间，请新建正确账套')
    d.update(client_profile.prepare(conn,p,old))
    return d


def invoice_data(conn,p,old=None):
    q={**(old or {}),**p}
    ref(conn,'clients',q.get('client_id'))
    a,t,total=amount(q.get('amount_fen',0)),amount(q.get('tax_fen',0)),amount(q.get('total_fen',0))
    if a+t!=total:
        raise ApiError(400,'金额加税额必须等于价税合计')
    pd=period(q.get('period')); day=date(q.get('date'))
    if day[:7]!=pd:
        raise ApiError(400,'发票日期必须属于所选期间')
    attachment=q.get('attachment_id') or None
    if attachment: ref(conn,'files',attachment)
    d=dict(client_id=q['client_id'],period=pd,kind=enum(q.get('kind','input'),('input','output','expense'),'发票类型'),
      number=textval(q.get('number'),'票据号码',80,True),date=day,category=textval(q.get('category',''),'分类',100),
      summary=textval(q.get('summary',''),'摘要',500),amount_fen=a,tax_fen=t,total_fen=total,attachment_id=attachment,updated_at=now())
    if not old:d['created_at']=now()
    return d


def contract_data(conn,p,old=None):
    q={**(old or {}),**p}; ref(conn,'clients',q.get('client_id'))
    start,end=period(q.get('start_period')),period(q.get('end_period'))
    if end<start:raise ApiError(400,'合同结束期间不能早于开始期间')
    d=dict(client_id=q['client_id'],service=textval(q.get('service'),'服务项目',100,True),start_period=start,end_period=end,
        monthly_fee_fen=amount(q.get('monthly_fee_fen')),status=enum(q.get('status','active'),('active','terminated'),'合同状态'),
        note=textval(q.get('note',''),'合同备注',4000),updated_at=now())
    d['termination_period']=((old or {}).get('termination_period') or dt.date.today().strftime('%Y-%m')) if d['status']=='terminated' else None
    if old and conn.execute('SELECT 1 FROM receipts WHERE contract_id=? LIMIT 1',(old['id'],)).fetchone():
        if any(d[k]!=old[k] for k in ('client_id','service','start_period','monthly_fee_fen')):
            raise ApiError(400,'已有收款的合同不能修改客户、服务、起始期间和月费；请终止原合同并另建合同')
        if old['status']=='terminated' and d['status']!='terminated':
            raise ApiError(400,'已有收款的终止合同不能重新生效，请另建续费合同')
        if old['status']=='active' and d['status']=='terminated':
            # End future service at this real month; previously earned monthly
            # receivables stay intact. Never accept a backdated termination.
            cutoff=min(old['end_period'],max(old['start_period'],dt.date.today().strftime('%Y-%m')))
            if d['end_period'] not in (old['end_period'],cutoff):
                raise ApiError(400,'已有收款合同只能按当前月份终止，不能回改历史应收')
            d['end_period']=cutoff
        elif d['end_period']!=old['end_period']:
            raise ApiError(400,'已有收款的合同不能修改服务结束月份；续费请另建合同')
    if not old:d['created_at']=now()
    return d


def project_data(conn,p,old,user):
    q={**(old or {}),**p};ref(conn,'clients',q.get('client_id'))
    who=q.get('assignee_id') or None
    if who:ref(conn,'users',who)
    steps=q.get('steps',[])
    if not isinstance(steps,list) or len(steps)>100:raise ApiError(400,'步骤需为最多100项的数组')
    previous=(old or {}).get('steps',[]);clean=[]
    for i,s in enumerate(steps):
        if not isinstance(s,dict):raise ApiError(400,'步骤格式无效')
        done=s.get('done',False)
        if not isinstance(done,bool):raise ApiError(400,'步骤完成标志必须是布尔值')
        title=textval(s.get('title'),'步骤名称',150,True)
        prev=previous[i] if i<len(previous) and previous[i].get('title')==title else {}
        clean.append(dict(title=title,done=done,note=textval(s.get('note',''),'步骤备注',2000),
            completed_at=(prev.get('completed_at') or now()) if done else None,
            completed_by=(prev.get('completed_by') if prev.get('done') else user['id']) if done else None))
    status=enum(q.get('status','pending'),('pending','in_progress','completed','terminated'),'项目状态')
    if status=='completed' and clean and not all(x['done'] for x in clean):raise ApiError(400,'项目尚有未完成步骤')
    d=dict(client_id=q['client_id'],name=textval(q.get('name'),'项目名称',150,True),type=textval(q.get('type',''),'项目类型',80),
        status=status,due_date=date(q.get('due_date')),assignee_id=who,steps=json.dumps(clean,ensure_ascii=False),updated_at=now())
    if not old:d['created_at']=now()
    return d


def tax_data(conn,p,old,user):
    q={**(old or {}),**p};ref(conn,'clients',q.get('client_id'))
    attachment=q.get('attachment_id') or None
    if attachment:ref(conn,'files',attachment)
    status=enum(q.get('status','pending'),('pending','preparing','submitted'),'申报状态')
    reference=textval(q.get('reference',''),'回执编号',150)
    if status=='submitted' and not(reference or attachment):raise ApiError(400,'登记已申报必须填写回执编号或上传证明')
    a,paid=amount(q.get('amount_fen',0)),amount(q.get('paid_fen',0))
    if paid>a:raise ApiError(400,'缴款金额不能大于应缴金额')
    payment=enum(q.get('payment_status','unpaid'),('unpaid','paid'),'缴款状态')
    if payment=='paid' and paid!=a:raise ApiError(400,'已缴款状态要求应缴与已缴金额一致')
    return dict(client_id=q['client_id'],period=period(q.get('period')),tax_type=textval(q.get('tax_type'),'税种',80,True),
        status=status,payment_status=payment,confirmation_status=enum(q.get('confirmation_status','pending'),('pending','confirmed'),'验证状态'),
        amount_fen=a,paid_fen=paid,reference=reference,source=enum(q.get('source','manual'),('manual','import'),'来源'),
        attachment_id=attachment,note=textval(q.get('note',''),'申报备注',4000),user_id=user['id'],recorded_at=now())


def tax_agent_data(conn,p,old=None):
    q={**(old or {}),**p};cid=q.get('client_id') or None
    if cid:ref(conn,'clients',cid)
    phone=textval(q.get('phone',''),'联系电话',30)
    if phone and not re.fullmatch(r'[+0-9() -]{6,30}',phone):raise ApiError(400,'联系电话格式无效，请只填写数字、空格或常见区号符号')
    enabled=q.get('enabled',True)
    if type(enabled) not in (bool,int) or enabled not in (True,False,0,1):raise ApiError(400,'办税人启用状态无效')
    d=dict(name=textval(q.get('name'),'办税联系人姓名',80,True),phone=phone,role=textval(q.get('role','办税联系人'),'联系人角色',80),
        client_id=cid,note=textval(q.get('note',''),'联系人备注',4000),enabled=int(enabled),updated_at=now())
    if not old:d['created_at']=now()
    return d


def invoice_request_data(conn,p,old=None):
    q={**(old or {}),**p};ref(conn,'clients',q.get('client_id'))
    status=enum(q.get('status','draft'),('draft','ready','cancelled'),'开票申请状态')
    if old and old['status']=='cancelled':raise ApiError(400,'已取消的开票申请不可修改，请另建申请')
    buyer=textval(q.get('buyer_name',''),'购方名称',200,status=='ready')
    taxno=textval(q.get('buyer_tax_no',''),'购方税号',30).upper()
    if taxno and not re.fullmatch(r'[A-Z0-9]{15}|[A-Z0-9]{18}|[A-Z0-9]{20}',taxno):raise ApiError(400,'购方税号须为15、18或20位字母数字；个人购方可留空')
    content=textval(q.get('content',''),'申请开票内容',1000,status=='ready')
    a,t=amount(q.get('amount_fen',0)),amount(q.get('tax_fen',0))
    if status=='ready' and a+t<=0:raise ApiError(400,'待办理申请的金额必须大于零')
    d=dict(client_id=q['client_id'],buyer_name=buyer,buyer_tax_no=taxno,content=content,amount_fen=a,tax_fen=t,status=status,
        note=textval(q.get('note',''),'开票申请备注',4000),updated_at=now())
    if not old:d['created_at']=now()
    return d


def months(a,b):
    return max(0,(int(b[:4])-int(a[:4]))*12+int(b[5:])-int(a[5:])+1)


def contract_stats(conn,c,pd):
    c=dict(c);end=min(pd,c['end_period'],c.get('termination_period') or c['end_period']);due=months(c['start_period'],end)*c['monthly_fee_fen'] if end>=c['start_period'] else 0
    received=conn.execute('SELECT COALESCE(SUM(amount_fen),0) FROM receipts WHERE contract_id=? AND substr(date,1,7)<=?',(c['id'],pd)).fetchone()[0]
    c.update(value_fen=months(c['start_period'],c['end_period'])*c['monthly_fee_fen'],due_fen=due,received_fen=received,
             debt_fen=max(0,due-received),prepaid_fen=max(0,received-due))
    return c


def settings(conn):
    data={r['key']:json.loads(r['value']) for r in conn.execute('SELECT key,value FROM settings')}
    data.setdefault('labels',[])
    import ticket_workflow
    data['ticket_warning_config']=ticket_workflow.warning_config(data.get('ticket_warning_config',{}))
    import tax_workflow
    data['tax_check_config']=tax_workflow.check_config(data.get('tax_check_config',{}))
    data['version']=int(conn.execute("SELECT value FROM meta WHERE key='settings_version'").fetchone()[0]) if conn.execute("SELECT 1 FROM meta WHERE key='settings_version'").fetchone() else 1
    return data


def bootstrap(conn,pd,demo):
    pd=period(pd); data={}
    clients=[obj(r) for r in conn.execute('SELECT * FROM clients ORDER BY id')]
    users=[dict(r) for r in conn.execute('SELECT id,username,name,version,enabled FROM users ORDER BY id')]
    cm={x['id']:x['name'] for x in clients};um={x['id']:x['name'] for x in users}
    data.update(clients=clients,users=users,industries=industry_names(conn))
    for table in ('invoices','notes','contracts','receipts','projects','tax_records','tax_agents','invoice_requests'):
        rows=[obj(r) for r in conn.execute('SELECT * FROM '+table+(' WHERE deleted=0' if table in ('tax_agents','notes','contracts','projects','tax_records') else '')+' ORDER BY id DESC')]
        for r in rows:
            r['client_name']=cm.get(r.get('client_id'),'')
            if 'user_id' in r:r['user_name']=um.get(r['user_id'],'')
            if table=='contracts':r.update(contract_stats(conn,r,pd))
            if table=='invoice_requests':r['valid_invoice']=False;r['source']='local_request'
        if table=='receipts':
            reversals={r['reversal_of']:r['id'] for r in rows if r.get('reversal_of')}
            for r in rows:
                r['reversed']=r['id'] in reversals
                r['reversal_id']=reversals.get(r['id'])
        data[table]=rows
    tables={r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    pt='book_periods' if 'book_periods' in tables else 'periods' if 'periods' in tables else None
    data['book_periods']=[dict(r) for r in conn.execute('SELECT * FROM '+pt)] if pt else []
    periods_map={(x['client_id'],x['period']):x for x in data['book_periods']}
    if 'vouchers' in tables:
        for r in conn.execute("SELECT client_id,period,COUNT(*) AS voucher_count,SUM(CASE WHEN reviewed=0 THEN 1 ELSE 0 END) AS unreviewed_count FROM vouchers WHERE status='active' GROUP BY client_id,period"):
            x=periods_map.setdefault((r['client_id'],r['period']),{'client_id':r['client_id'],'period':r['period'],'closed':0,'version':0})
            x.update(voucher_count=r['voucher_count'],unreviewed_count=r['unreviewed_count'])
    data['book_periods']=sorted(periods_map.values(),key=lambda x:(x['client_id'],x['period']))
    for x in data['book_periods']:
        if 'status' not in x:x['status']='closed' if x.get('closed') or x.get('is_closed') else 'open'
        x.setdefault('voucher_count',0);x.setdefault('unreviewed_count',0)
    data.update(settings=settings(conn),audit_logs=[dict(r) for r in conn.execute('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200')],help_articles=HELP,demo=demo,period=pd)
    import ticket_workflow
    data.update(ticket_workflow.bootstrap(conn))
    import tax_workflow
    data['tax_workflows']=tax_workflow.bootstrap(conn)
    return data


def handle(conn,method,path,payload,user,query,demo=False):
    if path.startswith('/api/tax-workflows'):
        import tax_workflow
        return tax_workflow.handle(conn,method,path,payload,user,query)
    if path.startswith(('/api/ticket-tasks','/api/ticket-auth-checks')):
        import ticket_workflow
        return ticket_workflow.handle(conn,method,path,payload,user,query)
    if method=='GET' and path=='/api/bootstrap':return bootstrap(conn,query.get('period',dt.date.today().strftime('%Y-%m')),demo)
    if method=='GET' and path=='/api/industries':return {'industries':industry_names(conn)}
    if method=='GET' and path=='/api/help':
        term=query.get('q','').lower().strip()
        return {'articles':[h for h in HELP if not term or term in (h['title']+h['text']).lower()],'source':'local_help'}
    if method=='GET' and path=='/api/audit':return [dict(r) for r in conn.execute('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 1000')]
    if path=='/api/settings' and method=='POST':
        allowed={'company_name','basic_policy','contact_phone','invoice_note','receipt_title','labels','ticket_warning_config','tax_check_config'}
        if set(payload)-allowed-{'version'}:raise ApiError(400,'设置字段无效')
        with conn:
            old=settings(conn)
            if type(payload.get('version')) is not int or payload['version']!=old['version']:raise ApiError(409,'设置已更新，请刷新')
            for k,v in payload.items():
                if k!='version':
                    if k=='ticket_warning_config':
                        import ticket_workflow
                        v=ticket_workflow.warning_config(v,old['ticket_warning_config'])
                    elif k=='tax_check_config':
                        import tax_workflow
                        v=tax_workflow.check_config(v,old['tax_check_config'])
                    elif k=='labels':
                        if not isinstance(v,list) or len(v)>100:raise ApiError(400,'全局标签应为最多100项的数组')
                        v=[textval(x,'标签',30,True) for x in v]
                        if len(set(v))!=len(v):raise ApiError(400,'全局标签不能重复')
                    else:v=textval(v,k,4000 if k=='basic_policy' else 200)
                    conn.execute('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,version=settings.version+1',(k,json.dumps(v,ensure_ascii=False)))
            conn.execute("INSERT INTO meta(key,value) VALUES('settings_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(str(old['version']+1),))
            detail={'fields':list(payload)}
            if 'ticket_warning_config' in payload:
                detail['ticket_warning_config']={'before':old['ticket_warning_config'],'after':settings(conn)['ticket_warning_config']}
            if 'tax_check_config' in payload:
                detail['tax_check_config']={'before':old['tax_check_config'],'after':settings(conn)['tax_check_config']}
            audit(conn,user,'update','settings','company',detail)
        return settings(conn)
    match=re.fullmatch(r'/api/(clients|invoices|contracts|projects|tax-records|tax-agents|invoice-requests)(?:/(\d+))?(?:/(restore|post|purge))?',path)
    if match:
        kind,ident,action=match.groups();table=kind.replace('-','_');ident=int(ident) if ident else None
        if method=='GET' and ident and not action:
            result=fetched(conn,table,ident)
            if kind!='clients' and result.get('deleted'):raise ApiError(404,'记录已删除')
            return result
        with conn:
            if action=='purge' and not conn.in_transaction:conn.execute('BEGIN IMMEDIATE')
            old=fetched(conn,table,ident) if ident else None
            if old and method in ('PATCH','DELETE','POST'):stale(old,payload)
            if old and kind!='clients' and old.get('deleted'):raise ApiError(404,'记录已删除')
            if old and kind!='clients' and method in ('PATCH','DELETE','POST'):
                if old.get('client_id'):ref(conn,'clients',old['client_id'])
            if old and kind=='tax-agents' and old['deleted']:raise ApiError(404,'办税联系人已经删除')
            if method=='DELETE' and kind=='tax-agents' and ident and not action:
                return save(conn,table,{'deleted':1,'updated_at':now()},old,user)
            if method=='DELETE' and kind=='invoice-requests' and ident and not action:
                return save(conn,table,{'status':'cancelled','updated_at':now()},old,user)
            if method=='DELETE' and kind in ('tax-records','projects','contracts') and ident and not action:
                if kind=='contracts' and conn.execute('SELECT 1 FROM receipts WHERE contract_id=? LIMIT 1',(ident,)).fetchone():
                    raise ApiError(409,'该合同已有收款或冲销历史，不能直接删除；请保留并终止合同，错误收款使用冲销处理',
                        {'blocked':True,'reason':'contract_has_receipts','next_action':'terminate_contract'})
                return soft_delete(conn,table,old,user)
            if method=='DELETE' and kind=='clients' and not action:
                return save(conn,table,{'deleted':1,'updated_at':now()},old,user)
            if method=='POST' and kind=='clients' and action=='purge':
                return purge_client(conn,old,user)
            if method=='POST' and kind=='clients' and action=='restore':
                return save(conn,table,{'deleted':0,'updated_at':now()},old,user)
            if method=='DELETE' and kind=='invoices' and not action:
                if old['status']=='posted':raise ApiError(409,'已制证票据不能直接删除；请先在账簿中按业务来源撤回凭证，再删除票据',
                    {'blocked':True,'reason':'invoice_posted','next_action':'withdraw_source','voucher_id':old['voucher_id']})
                conn.execute('DELETE FROM invoices WHERE id=?',(ident,));audit(conn,user,'delete',table,ident,old)
                return {'ok':True}
            if method=='POST' and kind=='invoices' and action=='post':
                if old['status']=='posted':raise ApiError(409,'票据已经生成凭证，禁止重复记账')
                import finance
                vid=finance.create_invoice_voucher(conn,old,payload,user)
                return save(conn,table,{'status':'posted','voucher_id':vid,'updated_at':now()},old,user)
            if (method=='POST' and not ident and not action) or (method=='PATCH' and ident and not action):
                if old and kind=='invoices' and old['status']=='posted':raise ApiError(400,'已记账票据不能修改')
                if kind=='clients':d=client_data(conn,payload,old)
                elif kind=='invoices':d=invoice_data(conn,payload,old)
                elif kind=='contracts':d=contract_data(conn,payload,old)
                elif kind=='projects':d=project_data(conn,payload,old,user)
                elif kind=='tax-agents':d=tax_agent_data(conn,payload,old)
                elif kind=='invoice-requests':d=invoice_request_data(conn,payload,old)
                else:d=tax_data(conn,payload,old,user)
                result=save(conn,table,d,old,user)
                if kind=='clients' and not old:
                    import finance
                    finance.ensure_book(conn,result)
                return result
        return None
    match=re.fullmatch(r'/api/notes/(\d+)',path)
    if match and method=='DELETE':
        with conn:
            old=fetched(conn,'notes',int(match.group(1)));stale(old,payload)
            if old.get('deleted'):raise ApiError(404,'跟进记录已删除')
            ref(conn,'clients',old['client_id'])
            return soft_delete(conn,'notes',old,user)
    if method=='POST' and path=='/api/notes':
        ref(conn,'clients',payload.get('client_id'))
        with conn:return save(conn,'notes',dict(client_id=payload['client_id'],text=textval(payload.get('text'),'跟进记录',10000,True),user_id=user['id'],created_at=now()),None,user)
    if method=='POST' and path=='/api/receipts':
        with conn:
            c=ref(conn,'contracts',payload.get('contract_id'));ref(conn,'clients',c['client_id'])
            value=amount(payload.get('amount_fen'))
            if value<=0:raise ApiError(400,'收款金额必须大于零')
            return save(conn,'receipts',dict(contract_id=c['id'],client_id=c['client_id'],date=date(payload.get('date')),amount_fen=value,
               method=textval(payload.get('method',''),'收款方式',80),note=textval(payload.get('note',''),'收款备注',4000),user_id=user['id'],created_at=now()),None,user)
    match=re.fullmatch(r'/api/receipts/(\d+)',path)
    if match and method=='DELETE':
        old=fetched(conn,'receipts',int(match.group(1)));stale(old,payload)
        raise ApiError(409,'收款记录不能直接删除，请使用冲销保留回款历史',{'blocked':True,'reason':'receipt_immutable','next_action':'reverse_receipt'})
    match=re.fullmatch(r'/api/receipts/(\d+)/reverse',path)
    if match and method=='POST':
        with conn:
            old=fetched(conn,'receipts',int(match.group(1)));stale(old,payload)
            ref(conn,'clients',old['client_id'])
            if old['reversal_of'] or conn.execute('SELECT 1 FROM receipts WHERE reversal_of=?',(old['id'],)).fetchone():raise ApiError(409,'该收款不可重复冲销')
            day=date(payload.get('date',dt.date.today().isoformat()))
            if day<old['date']:raise ApiError(400,'冲销日期不能早于原收款日期')
            note=textval(payload.get('note'),'冲销原因',4000,True)
            result=save(conn,'receipts',dict(contract_id=old['contract_id'],client_id=old['client_id'],date=day,amount_fen=-old['amount_fen'],method=old['method'],note=note,
                reversal_of=old['id'],user_id=user['id'],created_at=now()),None,user)
            conn.execute('UPDATE receipts SET version=version+1 WHERE id=?',(old['id'],))
            audit(conn,user,'reverse','receipts',old['id'],{'reversal_id':result['id'],'reason':note})
            return result
    return None


TEMPLATES={
 'clients':['name','code','taxpayer_type','standard','industry','region','start_period','accountant_id','labels','note'],
 'invoices':['client_id','period','kind','number','date','category','summary','amount','tax','total'],
 'tax-records':['client_id','period','tax_type','status','payment_status','confirmation_status','amount','paid','reference','note'],
 'bank':['date','summary','bank_account','counter_account','direction','amount'],
}


def money_from_csv(value):
    try:
        n=decimal.Decimal(str(value).strip())
        if not n.is_finite() or n<0 or n.as_tuple().exponent < -2:raise ValueError()
        return amount(int(n*100))
    except (decimal.InvalidOperation,ValueError,TypeError):raise ApiError(400,'金额必须为非负数字，最多两位小数（元）')


def csv_id(value,label='编号'):
    try:
        if not re.fullmatch(r'[1-9]\d*',str(value).strip()):raise ValueError()
        return int(value)
    except (TypeError,ValueError):raise ApiError(400,label+'必须是正整数')


def import_csv(conn,kind,payload,user):
    if kind not in TEMPLATES:raise ApiError(404,'导入类型不存在')
    filename=textval(payload.get('filename','import.csv'),'文件名',200)
    if not filename.lower().endswith('.csv'):raise ApiError(400,'请将表格另存为UTF-8 CSV后导入')
    try:
        raw=base64.b64decode(payload.get('content_base64',''),validate=True)
        if len(raw)>10*1024*1024:raise ApiError(413,'导入文件不能超过10MB')
        content=raw.decode('utf-8-sig')
    except (binascii.Error,UnicodeDecodeError,TypeError):raise ApiError(400,'CSV必须是UTF-8编码且base64完整')
    reader=csv.DictReader(io.StringIO(content,newline=''))
    if not reader.fieldnames or len(reader.fieldnames)!=len(set(reader.fieldnames)) or any(x not in reader.fieldnames for x in TEMPLATES[kind]):
        raise ApiError(400,'CSV列名不符合模板',{'required_columns':TEMPLATES[kind]})
    rows=list(reader)
    if not rows or len(rows)>10000:raise ApiError(400,'每次导入1—10000行')
    errors=[];prepared=[];seen=set()
    for i,r in enumerate(rows,2):
        try:
            if None in r:raise ApiError(400,'CSV列数不一致')
            if kind=='clients':
                p={**r,'accountant_id':csv_id(r['accountant_id']) if r.get('accountant_id') else None,'labels':[x.strip() for x in r.get('labels','').split('|') if x.strip()]}
                if 'authorized_user_ids' in r:
                    try:p['authorized_user_ids']=json.loads(r['authorized_user_ids']) if r['authorized_user_ids'].strip() else []
                    except (ValueError,TypeError):raise ApiError(400,'CSV账套分工名单须为JSON用户编号数组，例如[1,2]') from None
                d=client_data(conn,p)
                key=d['code']
                if key in seen or conn.execute('SELECT 1 FROM clients WHERE code=?',(key,)).fetchone():raise ApiError(400,'客户编码重复')
            elif kind=='invoices':
                row_client=r.get('client_id')
                p={**r,'client_id':csv_id(row_client if row_client is not None and str(row_client).strip() else payload.get('client_id')),'amount_fen':money_from_csv(r['amount']),'tax_fen':money_from_csv(r['tax']),'total_fen':money_from_csv(r['total'])}
                d=invoice_data(conn,p);key=(d['client_id'],d['number'])
                if key in seen or conn.execute('SELECT 1 FROM invoices WHERE client_id=? AND number=?',key).fetchone():raise ApiError(400,'同客户票据号码重复')
            elif kind=='tax-records':
                row_client=r.get('client_id')
                p={**r,'client_id':csv_id(row_client if row_client is not None and str(row_client).strip() else payload.get('client_id')),'amount_fen':money_from_csv(r['amount']),'paid_fen':money_from_csv(r['paid']),'source':'import'}
                d=tax_data(conn,p,None,user);key=(d['client_id'],d['period'],d['tax_type'])
                if key in seen or conn.execute('SELECT 1 FROM tax_records WHERE client_id=? AND period=? AND tax_type=? AND deleted=0',key).fetchone():raise ApiError(400,'该客户期间税种已存在')
            else:
                cid=payload.get('client_id');ref(conn,'clients',cid)
                d=dict(date=date(r['date']),summary=textval(r['summary'],'摘要',500,True),bank_account=textval(r['bank_account'],'银行科目',30,True),
                    counter_account=textval(r['counter_account'],'对方科目',30,True),direction=enum(r['direction'],('income','expense'),'收支方向'),amount_fen=money_from_csv(r['amount']))
                if d['amount_fen']==0:raise ApiError(400,'流水金额必须大于零')
                key=(d['date'],d['summary'],d['bank_account'],d['direction'],d['amount_fen'])
                if key in seen:raise ApiError(400,'批次内存在重复银行流水')
            seen.add(key);prepared.append((i,d))
        except ApiError as e:errors.append({'row':i,'error':e.message})
    if errors:raise ApiError(400,'整批验证失败，未导入任何记录',{'rows':errors[:100]})
    # Every prepared row is validated before beginning the transaction. Finance's
    # additional chart/period validations also run inside this atomic transaction.
    try:
        with conn:
            import finance
            for i,d in prepared:
                if kind=='bank':finance.create_bank_journal(conn,payload['client_id'],d,user)
                else:
                    table=kind.replace('-','_');item=save(conn,table,d,None,user)
                    if kind=='clients':finance.ensure_book(conn,item)
            audit(conn,user,'import',kind,'batch',{'count':len(prepared),'filename':filename})
    except ApiError as e:raise ApiError(e.status,'整批未导入：'+e.message,{'rows':[{'row':i,'error':e.message}]})
    except sqlite3.IntegrityError as e:raise ApiError(400,'整批未导入：重复编号或引用无效',{'rows':[{'row':i,'error':'重复编号或引用无效'}]}) from e
    return {'imported':len(prepared)}


def safe_csv(headers,rows):
    out=io.StringIO(newline='');writer=csv.writer(out,lineterminator='\r\n');writer.writerow(headers)
    for row in rows:
        safe=[]
        for v in row:
            if v is None:v=''
            if isinstance(v,str) and v.lstrip().startswith(('=','+','-','@','\t','\r','\n')):v="'"+v
            safe.append(v)
        writer.writerow(safe)
    return ('\ufeff'+out.getvalue()).encode('utf-8')


def export_csv(conn,kind,query):
    pd=period(query.get('period',dt.date.today().strftime('%Y-%m')))
    cid=csv_id(query['client_id']) if query.get('client_id') else None
    if kind in ('bank','vouchers','trial-balance'):
        if not cid:raise ApiError(400,'请先选择客户')
        ref(conn,'clients',cid)
        import finance
        return safe_csv(*finance.export_rows(conn,cid,kind,pd))
    table=kind.replace('-','_')
    if table not in ('clients','invoices','contracts','receipts','tax_records'):raise ApiError(404,'导出类型不存在')
    where=[];args=[]
    if table in ('contracts','tax_records'):where.append('deleted=0')
    if cid:
        where.append('id=?' if table=='clients' else 'client_id=?');args.append(cid)
    if table in ('invoices','tax_records'):where.append('period=?');args.append(pd)
    if table=='receipts':where.append('substr(date,1,7)<=?');args.append(pd)
    rows=[obj(r) for r in conn.execute('SELECT * FROM '+table+(' WHERE '+' AND '.join(where) if where else '')+' ORDER BY id',args)]
    if table=='contracts':rows=[contract_stats(conn,r,pd) for r in rows]
    if table=='clients':
        headers=['id','name','code','taxpayer_type','standard','industry','region','start_period','accountant_id','enabled','labels','service_status','note','version','deleted','created_at','updated_at',*client_profile.PUBLIC_FIELDS]
    else:
        headers=list(rows[0]) if rows else [r['name'] for r in conn.execute('PRAGMA table_info('+table+')')]
    for r in rows:
        for k,v in list(r.items()):
            if k.endswith('_fen'):r[k]=f'{v/100:.2f}'
            elif isinstance(v,(list,dict)):r[k]=json.dumps(v,ensure_ascii=False)
    return safe_csv([k.replace('_fen','_yuan') for k in headers],[[r.get(k,'') for k in headers] for r in rows])
