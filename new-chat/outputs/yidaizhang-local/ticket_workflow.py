"""Local ticket collection to-dos and explicit human check records.

No network client, tax credentials, scheduler execution or invoice issuance is
implemented here. A completed to-do is never evidence that invoices were fetched
or that a tax authority authenticated the company. Invoice counts remain owned
by the real invoice register.
"""
import datetime as dt
import re
import sqlite3

from db import ApiError, amount, audit, now


TASK_STATUSES=('scheduled','pending','completed','failed','cancelled')
CHECK_STATUSES=('unrecorded','confirmed','needs_update')
TASK_LABELS={'scheduled':'已预约（本地待办）','pending':'待处理','completed':'已完成待办','failed':'本地处理失败','cancelled':'已取消待办'}
CHECK_LABELS={'unrecorded':'未人工核对','confirmed':'已人工核对','needs_update':'资料待更新'}
TABLES={'ticket-tasks':'ticket_tasks','ticket-auth-checks':'ticket_auth_checks'}
WARNING_DEFAULTS={'quarter_limit_fen':30000000,'rolling12_limit_fen':500000000,'near_percent':90}


def warning_config(value,previous=None):
    """Validate a local, user-configured reminder rule; never infer tax owed."""
    if not isinstance(value,dict) or set(value)-set(WARNING_DEFAULTS):
        raise ApiError(400,'金额预警规则必须是受支持字段组成的对象')
    result={**WARNING_DEFAULTS,**(previous or {}),**value}
    for field in WARNING_DEFAULTS:
        number=result[field]
        if type(number) is not int or number<=0:raise ApiError(400,'预警阈值须为正整数分，比例须为1至100的整数',{'field':field})
        if field=='near_percent':
            if number>100:raise ApiError(400,'接近阈值比例须为1至100的整数',{'field':field})
        else:amount(number)
    return result


def init_schema(conn):
    conn.executescript('''
    CREATE TABLE IF NOT EXISTS ticket_tasks(
      id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES clients(id),period TEXT NOT NULL,
      scheduled_at TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('scheduled','pending','completed','failed','cancelled')),
      note TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','import')),
      version INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),deleted_at TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),updated_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS ticket_tasks_active_unique ON ticket_tasks(client_id,period) WHERE deleted=0;
    CREATE TABLE IF NOT EXISTS ticket_auth_checks(
      id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES clients(id),period TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unrecorded' CHECK(status IN ('unrecorded','confirmed','needs_update')),
      note TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT 'manual' CHECK(source='manual'),
      checked_at TEXT,checked_by INTEGER REFERENCES users(id),version INTEGER NOT NULL DEFAULT 1,
      deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),deleted_at TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),updated_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS ticket_auth_checks_active_unique ON ticket_auth_checks(client_id,period) WHERE deleted=0;
    ''')


def _id(value,label):
    if type(value) is not int or value<=0:raise ApiError(400,label+'必须是正整数')
    return value


def _period(value):
    if not isinstance(value,str) or not re.fullmatch(r'20\d{2}-(0[1-9]|1[0-2])',value):
        raise ApiError(400,'期间格式必须为YYYY-MM（2000—2099）')
    return value


def _text(value,label,limit=2000):
    if value is None:value=''
    if not isinstance(value,str):raise ApiError(400,label+'必须是文本')
    value=value.strip()
    if len(value)>limit or '\x00' in value:raise ApiError(400,label+'超出长度限制或包含无效字符')
    return value


def _schedule(value):
    if value in ('',None):return ''
    if not isinstance(value,str) or not re.fullmatch(r'20\d{2}-(0[1-9]|1[0-2])-\d{2}T\d{2}:\d{2}(?::\d{2})?',value):
        raise ApiError(400,'预约时间须为本机时间YYYY-MM-DDTHH:mm')
    try:parsed=dt.datetime.fromisoformat(value)
    except ValueError:raise ApiError(400,'预约时间无效') from None
    return parsed.isoformat(timespec='seconds' if parsed.second else 'minutes')


def _client(conn,cid):
    _id(cid,'客户编号')
    row=conn.execute('SELECT id,deleted,enabled FROM clients WHERE id=?',(cid,)).fetchone()
    if not row or row['deleted']:raise ApiError(400,'客户不存在或已移入回收站')
    if not row['enabled']:raise ApiError(400,'客户账套已停用，请先重新启用')
    return row


def _version(old,payload):
    if type(payload.get('version')) is not int or payload['version']!=old['version']:
        raise ApiError(409,'记录已被其他操作员修改，请刷新后重试',{'current_version':old['version']})


def _row(conn,table,ident):
    row=conn.execute('SELECT * FROM '+table+' WHERE id=?',(ident,)).fetchone()
    if not row or row['deleted']:raise ApiError(404,'本地待办或核对记录不存在或已删除')
    return dict(row)


def _display(conn,table,row):
    result=dict(row)
    result.update(local_only=True,external_action='none')
    result['status_label']=(TASK_LABELS if table=='ticket_tasks' else CHECK_LABELS)[result['status']]
    result['source_label']='文件导入记录' if result['source']=='import' else '人工登记'
    if table=='ticket_tasks':
        result['due']=bool(result['status']=='scheduled' and result['scheduled_at'] and dt.datetime.fromisoformat(result['scheduled_at'])<=dt.datetime.now())
    client=conn.execute('SELECT name,deleted,enabled FROM clients WHERE id=?',(result['client_id'],)).fetchone()
    result.update(client_name=client['name'] if client else '',client_deleted=bool(client and client['deleted']),client_enabled=bool(client and client['enabled']))
    for key in ('created_by','updated_by','checked_by'):
        if key in result:
            user=conn.execute('SELECT name FROM users WHERE id=?',(result[key],)).fetchone() if result[key] else None
            result[key+'_name']=user['name'] if user else ''
    return result


def bootstrap(conn):
    return {table:[_display(conn,table,row) for row in conn.execute('SELECT * FROM '+table+' WHERE deleted=0 ORDER BY period DESC,id DESC')] for table in TABLES.values()}


def _prepare(table,payload,old,user):
    permitted={'client_id','period','status','note','source','version'}
    if table=='ticket_tasks':permitted.add('scheduled_at')
    if set(payload)-permitted:raise ApiError(400,'本地票据工作流包含不支持的字段',{'fields':sorted(set(payload)-permitted)})
    cid=_id(payload.get('client_id',(old or {}).get('client_id')),'客户编号')
    period=_period(payload.get('period',(old or {}).get('period')))
    if old and (cid!=old['client_id'] or period!=old['period']):raise ApiError(400,'不能更改记录所属客户或期间，请删除本地记录后另建')
    source=payload.get('source',(old or {}).get('source','manual'))
    if source not in (('manual','import') if table=='ticket_tasks' else ('manual',)):
        raise ApiError(400,'来源无效，核对记录只能人工登记')
    if old and source!=old['source']:raise ApiError(400,'记录来源不能更改')
    status=payload.get('status',(old or {}).get('status','pending' if table=='ticket_tasks' else 'unrecorded'))
    if not isinstance(status,str) or status not in (TASK_STATUSES if table=='ticket_tasks' else CHECK_STATUSES):raise ApiError(400,'本地工作流状态无效')
    stamp=now()
    result={'client_id':cid,'period':period,'status':status,'note':_text(payload.get('note',(old or {}).get('note','')),'备注'),'source':source,'updated_by':user['id'],'updated_at':stamp}
    if not old:result.update(created_by=user['id'],created_at=stamp)
    if table=='ticket_tasks':
        result['scheduled_at']=_schedule(payload.get('scheduled_at',(old or {}).get('scheduled_at','')))
        if status=='scheduled' and not result['scheduled_at']:raise ApiError(400,'预约待办必须填写预约时间')
        if status=='failed' and not result['note']:raise ApiError(400,'请在备注中填写本地处理失败原因')
    elif not old or 'status' in payload:
        result.update(checked_at=stamp if status!='unrecorded' else None,checked_by=user['id'] if status!='unrecorded' else None)
    return result


def handle(conn,method,path,payload,user,query):
    match=re.fullmatch(r'/api/(ticket-tasks|ticket-auth-checks)(?:/([1-9]\d*))?',path)
    if not match:return None
    table=TABLES[match[1]];ident=int(match[2]) if match[2] else None
    if method not in ('GET','POST','PATCH','DELETE'):return None
    if not isinstance(payload,dict):raise ApiError(400,'请求内容必须是对象')
    if method=='GET':
        if ident:return _display(conn,table,_row(conn,table,ident))
        rows=bootstrap(conn)[table]
        if query.get('client_id'):
            value=str(query['client_id'])
            if not re.fullmatch(r'[1-9]\d*',value):raise ApiError(400,'客户编号无效')
            rows=[r for r in rows if r['client_id']==int(value)]
        if query.get('period'):
            period=_period(query['period']);rows=[r for r in rows if r['period']==period]
        return rows
    if method in ('PATCH','DELETE') and not ident:return None
    if method=='POST' and ident:return None
    try:
        with conn:
            if not conn.in_transaction:conn.execute('BEGIN IMMEDIATE')
            if ident:old=_row(conn,table,ident)
            else:
                cid=_id(payload.get('client_id'),'客户编号');period=_period(payload.get('period'))
                row=conn.execute('SELECT * FROM '+table+' WHERE client_id=? AND period=? AND deleted=0',(cid,period)).fetchone()
                old=dict(row) if row else None
            if old:_version(old,payload)
            elif payload.get('version') is not None and (type(payload['version']) is not int or payload['version']!=0):
                raise ApiError(409,'该客户期间尚无活动记录，请刷新后新建')
            _client(conn,old['client_id'] if old else payload['client_id'])
            if method=='DELETE':
                if set(payload)-{'version','reason'}:raise ApiError(400,'删除只接受版本与原因')
                values={'deleted':1,'deleted_at':now(),'updated_at':now(),'updated_by':user['id']}
                if table=='ticket_tasks':values['status']='cancelled'
                reason=_text(payload.get('reason',''),'删除原因',500)
            else:values=_prepare(table,payload,old,user)
            if old:
                keys=list(values)
                changed=conn.execute('UPDATE '+table+' SET '+','.join(k+'=?' for k in keys)+',version=version+1 WHERE id=? AND version=?',[values[k] for k in keys]+[old['id'],old['version']])
                if changed.rowcount!=1:raise ApiError(409,'记录版本冲突，请刷新')
                ident=old['id']
            else:
                keys=list(values)
                inserted=conn.execute('INSERT INTO '+table+'('+','.join(keys)+') VALUES('+','.join('?' for _ in keys)+')',[values[k] for k in keys]);ident=inserted.lastrowid
            saved=dict(conn.execute('SELECT * FROM '+table+' WHERE id=?',(ident,)).fetchone())
            audit(conn,user,'delete' if method=='DELETE' else 'update' if old else 'create',table,ident,{'before':old,'after':saved,'local_only':True,'external_action':'none',**({'reason':reason} if method=='DELETE' else {})})
            return _display(conn,table,saved)
    except sqlite3.IntegrityError as error:
        raise ApiError(409,'记录重复或关联约束冲突，请刷新后重试') from error
