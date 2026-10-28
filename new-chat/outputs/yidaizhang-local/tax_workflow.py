"""Local tax preparation checks, never tax-authority authentication or filing.

Only the check action writes result fields. Read responses compare a fingerprint
of the current local sources to the last checked snapshot, so historical passes
cannot silently stand in for a fresh check after data changes.
"""
import hashlib
import json
import re
import sqlite3

from db import ApiError, audit, now
from ticket_workflow import _id, _period, _text, _version


CONFIG_DEFAULTS={'warn_unreviewed_vouchers':True,'warn_unposted_invoices':True}
AREAS=('overall','general','individual','annual')
RESULTS=('not_checked','passed','failed','not_applicable')
VERIFICATIONS=('unverified','passed','failed')


def check_config(value,previous=None):
    if not isinstance(value,dict) or set(value)-set(CONFIG_DEFAULTS):
        raise ApiError(400,'检查设置仅支持待审凭证与未制证票据的提示开关；核心核对规则不能关闭')
    result={**CONFIG_DEFAULTS,**(previous or {}),**value}
    if any(type(v) is not bool for v in result.values()):raise ApiError(400,'检查提示开关必须是布尔值')
    return result


def _config(conn):
    row=conn.execute("SELECT value FROM settings WHERE key='tax_check_config'").fetchone()
    try:return check_config(json.loads(row['value']) if row else {})
    except (ValueError,TypeError):raise ApiError(500,'检查设置格式损坏，请从备份恢复') from None


def init_schema(conn):
    conn.executescript('''
    CREATE TABLE IF NOT EXISTS tax_workflows(
      id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES clients(id),period TEXT NOT NULL,
      tax_agent_id INTEGER REFERENCES tax_agents(id),verification_status TEXT NOT NULL DEFAULT 'unverified'
        CHECK(verification_status IN ('unverified','passed','failed')),
      verification_note TEXT NOT NULL DEFAULT '',verified_by INTEGER REFERENCES users(id),verified_at TEXT,
      verification_snapshot_hash TEXT NOT NULL DEFAULT '',individual_applicable INTEGER NOT NULL DEFAULT 0 CHECK(individual_applicable IN (0,1)),
      annual_project_id INTEGER REFERENCES projects(id),note TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT 'manual' CHECK(source='manual'),
      overall_status TEXT NOT NULL DEFAULT 'not_checked',general_status TEXT NOT NULL DEFAULT 'not_checked',
      individual_status TEXT NOT NULL DEFAULT 'not_checked',annual_status TEXT NOT NULL DEFAULT 'not_checked',
      check_details TEXT NOT NULL DEFAULT '[]',checked_at TEXT,checked_by INTEGER REFERENCES users(id),checked_snapshot_hash TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),deleted_at TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),updated_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS tax_workflows_active_unique ON tax_workflows(client_id,period) WHERE deleted=0;
    ''')


def _hash(value):
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')).hexdigest()


def _one(conn,sql,args=()):
    row=conn.execute(sql,args).fetchone();return dict(row) if row else None


def _many(conn,sql,args=()):return [dict(row) for row in conn.execute(sql,args)]


def _sources(conn,workflow):
    cid=workflow['client_id'];period=workflow['period']
    client=_one(conn,'SELECT id,name,enabled,deleted,profile_json FROM clients WHERE id=?',(cid,))
    if client:
        try:
            profile=json.loads(client.pop('profile_json') or '{}')
            if not isinstance(profile,dict):raise ValueError()
        except (ValueError,TypeError):raise ApiError(500,'客户资料格式损坏，请从备份恢复') from None
        client['tax_no']=profile.get('tax_no','')
        for field in ('enterprise_name','legal_representative','legal_phone','contact_name','contact_phone'):
            client[field]=profile.get(field,'')
    agent=_one(conn,'SELECT id,name,phone,role,client_id,deleted,enabled,version FROM tax_agents WHERE id=?',(workflow['tax_agent_id'],)) if workflow.get('tax_agent_id') else None
    taxes=_many(conn,'SELECT id,client_id,period,tax_type,status,payment_status,amount_fen,paid_fen,reference,attachment_id,version,source FROM tax_records WHERE client_id=? AND period=? AND deleted=0 ORDER BY id',(cid,period))
    proofs=[]
    for ident in sorted({t['attachment_id'] for t in taxes if t['attachment_id']}):
        proofs.append(_one(conn,'SELECT id,name,size,sha256 FROM files WHERE id=?',(ident,)) or {'id':ident,'missing':True})
    vouchers=_many(conn,"SELECT id,version,reviewed FROM vouchers WHERE client_id=? AND period=? AND status='active' ORDER BY id",(cid,period))
    invoices=_many(conn,'SELECT id,version,status FROM invoices WHERE client_id=? AND period=? ORDER BY id',(cid,period))
    project=_one(conn,'SELECT id,client_id,name,status,steps,version,deleted FROM projects WHERE id=?',(workflow['annual_project_id'],)) if workflow.get('annual_project_id') else None
    identity={'client':{k:client.get(k) for k in ('id','name','tax_no','enabled','deleted','enterprise_name','legal_representative','legal_phone','contact_name','contact_phone')} if client else None,'agent':agent}
    configuration={k:workflow.get(k) for k in ('client_id','period','tax_agent_id','verification_status','verification_note','verified_by','verified_at','verification_snapshot_hash','individual_applicable','annual_project_id')}
    snapshot={'configuration':configuration,'identity':identity,'tax_records':taxes,'proofs':proofs,'vouchers':vouchers,'invoices':invoices,'annual_project':project,'rules':_config(conn)}
    return {'client':client,'agent':agent,'taxes':taxes,'proofs':proofs,'vouchers':vouchers,'invoices':invoices,'project':project,'rules':snapshot['rules'],'identity_hash':_hash(identity),'snapshot_hash':_hash(snapshot)}


def _agent_matches(agent,cid):
    return bool(agent and not agent['deleted'] and agent['enabled'] and (agent['client_id'] is None or agent['client_id']==cid))


def _validate_write(conn,workflow,validate_project=False):
    client=_one(conn,'SELECT id,enabled,deleted FROM clients WHERE id=?',(workflow['client_id'],))
    if not client or client['deleted']:raise ApiError(400,'客户不存在或已移入回收站')
    if not client['enabled']:raise ApiError(400,'客户账套已停用，请先重新启用')
    if workflow.get('tax_agent_id'):
        agent=_one(conn,'SELECT id,client_id,deleted,enabled FROM tax_agents WHERE id=?',(workflow['tax_agent_id'],))
        if not _agent_matches(agent,workflow['client_id']):raise ApiError(400,'办税人已停用、删除或不属于此客户，请重新匹配有效办税人')
    if validate_project and workflow.get('annual_project_id'):
        project=_one(conn,'SELECT client_id,deleted FROM projects WHERE id=?',(workflow['annual_project_id'],))
        if not project or project['deleted'] or project['client_id']!=workflow['client_id']:raise ApiError(400,'年度本地项目须为该客户尚未删除的项目')


def _row(conn,ident):
    row=_one(conn,'SELECT * FROM tax_workflows WHERE id=?',(ident,))
    if not row or row['deleted']:raise ApiError(404,'本地报税检查配置不存在或已删除')
    return row


def _display(conn,row):
    result=dict(row);source=_sources(conn,result)
    try:details=json.loads(result['check_details'])
    except (ValueError,TypeError):raise ApiError(500,'本地检查结果格式损坏') from None
    stale=bool(result['checked_snapshot_hash'] and result['checked_snapshot_hash']!=source['snapshot_hash'])
    verification_stale=bool(result['verification_status']!='unverified' and result['verification_snapshot_hash']!=source['identity_hash'])
    result.update(individual_applicable=bool(result['individual_applicable']),check_stale=stale,verification_stale=verification_stale,
        current_verification_hash=source['identity_hash'],current_check_hash=source['snapshot_hash'],
        derived_verification_status='unverified' if verification_stale else result['verification_status'],
        client_name=(source['client'] or {}).get('name',''),client_enabled=bool((source['client'] or {}).get('enabled')),client_deleted=bool((source['client'] or {}).get('deleted')),
        tax_agent_name=(source['agent'] or {}).get('name',''),tax_agent_active=_agent_matches(source['agent'],result['client_id']),
        annual_project_name=(source['project'] or {}).get('name',''),local_only=True,external_action='none',source_label='本地人工配置',
        last_check_details=details,check_details=[{**d,'previous_state':d['state'],'state':'not_checked','stale':True} for d in details] if stale else details)
    for area in AREAS:result['derived_'+area+'_status']='not_checked' if stale else result[area+'_status']
    result['derived_status']=result['derived_overall_status']
    for field in ('created_by','updated_by','verified_by','checked_by'):
        user=_one(conn,'SELECT name FROM users WHERE id=?',(result[field],)) if result.get(field) else None
        result[field+'_name']=(user or {}).get('name','')
    return result


def bootstrap(conn):return [_display(conn,row) for row in conn.execute('SELECT * FROM tax_workflows WHERE deleted=0 ORDER BY period DESC,id DESC')]


def _prepare(conn,payload,old,user):
    allowed={'client_id','period','tax_agent_id','verification_status','verification_note','individual_applicable','annual_project_id','note','version'}
    if set(payload)-allowed:raise ApiError(400,'检查结果、操作者、核对时间及外部凭据不能由客户端写入',{'fields':sorted(set(payload)-allowed)})
    cid=_id(payload.get('client_id',(old or {}).get('client_id')),'客户编号');period=_period(payload.get('period',(old or {}).get('period')))
    if old and (old['client_id']!=cid or old['period']!=period):raise ApiError(400,'检查配置不能更改所属客户或期间')
    agent_id=payload.get('tax_agent_id',(old or {}).get('tax_agent_id'))
    project_id=payload.get('annual_project_id',(old or {}).get('annual_project_id'))
    if agent_id is not None:_id(agent_id,'办税人编号')
    if project_id is not None:_id(project_id,'本地年度项目编号')
    applicable=payload.get('individual_applicable',bool((old or {}).get('individual_applicable',0)))
    if type(applicable) is not bool:raise ApiError(400,'个税适用设置必须是布尔值')
    changed_agent=bool(old and agent_id!=old['tax_agent_id'])
    status=payload.get('verification_status','unverified' if changed_agent else (old or {}).get('verification_status','unverified'))
    if not isinstance(status,str) or status not in VERIFICATIONS:raise ApiError(400,'人工验证状态无效')
    note=_text(payload.get('verification_note','' if changed_agent else (old or {}).get('verification_note','')),'人工核对说明')
    values={'client_id':cid,'period':period,'tax_agent_id':agent_id,'annual_project_id':project_id,'individual_applicable':int(applicable),
        'verification_status':status,'verification_note':note,'note':_text(payload.get('note',(old or {}).get('note','')),'配置备注'),
        'updated_by':user['id'],'updated_at':now()}
    _validate_write(conn,values,validate_project=True)
    if not old:values.update(created_by=user['id'],created_at=values['updated_at'])
    if not old or changed_agent or 'verification_status' in payload:
        if status!='unverified' and not note:raise ApiError(400,'登记人工验证通过或失败必须填写核对说明')
        if status=='passed' and agent_id is None:raise ApiError(400,'请先匹配有效办税人再登记人工核对通过')
        values.update(verified_by=user['id'] if status!='unverified' else None,verified_at=values['updated_at'] if status!='unverified' else None,
            verification_snapshot_hash=_sources(conn,values)['identity_hash'] if status!='unverified' else '')
    return values


def _run_checks(workflow,source):
    details=[]
    def add(code,title,state,detail,scope='overall',severity='error',core=True):
        details.append({'code':code,'title':title,'state':state,'detail':detail,'scope':scope,'severity':severity,'core':core})
    taxno=(source['client'] or {}).get('tax_no','')
    valid_taxno=isinstance(taxno,str) and bool(re.fullmatch(r'[A-Za-z0-9]{1,30}',taxno))
    add('client_tax_no','客户税号资料','passed' if valid_taxno else 'failed','本地留存税号格式可用，未联网核验' if valid_taxno else '请在客户资料补齐税号；本规则不验证税局真实性')
    matched=_agent_matches(source['agent'],workflow['client_id'])
    add('agent_match','办税人本地匹配','passed' if matched else 'failed','有效联系人为机构通用或归属本客户' if matched else '未匹配有效的本地办税联系人')
    verified=workflow['verification_status']=='passed' and workflow['verification_snapshot_hash']==source['identity_hash']
    add('manual_verification','人工资料核对','passed' if verified else 'failed','操作员已人工核对当前资料，不代表税局身份认证' if verified else '当前资料未人工核对通过，或资料变化后需重新核对')
    is_individual=lambda record:bool(re.search(r'个税|个人所得|^IIT$',record['tax_type'],re.I))
    proof_ids={p['id'] for p in source['proofs'] if not p.get('missing')}
    for scope,records,applicable in (
        ('general',[t for t in source['taxes'] if not is_individual(t)],True),
        ('individual',[t for t in source['taxes'] if is_individual(t)],bool(workflow['individual_applicable']))):
        label='非个税' if scope=='general' else '个税'
        if not applicable:
            add(scope+'_applicability',label+'本地检查范围','not_applicable','配置未启用此项本地检查；不据此判断法定申报义务',scope,'info')
            continue
        add(scope+'_records',label+'当期登记记录','passed' if records else 'failed',f'本期有{len(records)}条本地记录' if records else '没有本期记录，不能生成已通过结果',scope)
        if not records:continue
        unsubmitted=[t for t in records if t['status']!='submitted']
        missing=[t for t in records if not str(t['reference'] or '').strip() and t['attachment_id'] not in proof_ids]
        add(scope+'_submission_evidence',label+'提交登记与本地回执','passed' if not unsubmitted and not missing else 'failed',
            '各记录已由人工标记提交并留有回执编号或附件记录；未联网验证回执' if not unsubmitted and not missing else f'{len(unsubmitted)}条未登记提交，{len(missing)}条未留本地回执编号/附件',scope)
        invalid=[t for t in records if type(t['amount_fen']) is not int or type(t['paid_fen']) is not int or t['amount_fen']<0 or t['paid_fen']<0 or t['paid_fen']>t['amount_fen'] or t['payment_status']=='paid' and t['paid_fen']!=t['amount_fen']]
        add(scope+'_payment_consistency',label+'登记金额一致性','failed' if invalid else 'passed',f'{len(invalid)}条实缴大于应缴或已缴标记与金额不一致' if invalid else '本地应缴/实缴及已缴标记一致；不代表已向税局缴款',scope)
    if not workflow['annual_project_id']:
        add('annual_project','本地年度项目','not_applicable','未关联本地汇算/年报项目，本项未检查；不代表无需汇算或年报','annual','info')
        annual_status='not_checked'
    else:
        project=source['project'];done=False
        if project and not project['deleted'] and project['client_id']==workflow['client_id']:
            try:steps=json.loads(project['steps']);done=project['status']=='completed' and all(bool(step.get('done')) for step in steps)
            except (ValueError,TypeError,AttributeError):done=False
        add('annual_project','本地年度项目完成情况','passed' if done else 'failed','关联本地项目已完成；不代表正式汇算或年报办理成功' if done else '关联项目缺失、已删除或尚未完成；这里只核对本地项目','annual')
        annual_status='passed' if done else 'failed'
    pending=sum(not v['reviewed'] for v in source['vouchers']);unposted=sum(i['status']!='posted' for i in source['invoices'])
    for code,title,count,key in (
        ('unreviewed_vouchers','待审核活动凭证',pending,'warn_unreviewed_vouchers'),('unposted_invoices','未制证票据',unposted,'warn_unposted_invoices')):
        enabled=source['rules'][key]
        add(code,title,('warning' if count else 'passed') if enabled else 'disabled',f'本期{count}条，请会计复核' if enabled else '操作员关闭了此项资料提示，核心规则仍执行','overall','warning',False)
    states={scope:('failed' if any(d['scope']==scope and d['state']=='failed' for d in details) else 'passed') for scope in ('general','individual')}
    if not workflow['individual_applicable']:states['individual']='not_applicable'
    states['annual']=annual_status
    states['overall']='failed' if any(d['state']=='failed' and d['severity']=='error' for d in details) else 'passed'
    return states,details


def _save(conn,values,old,user,action,extra=None):
    keys=list(values)
    if old:
        cur=conn.execute('UPDATE tax_workflows SET '+','.join(k+'=?' for k in keys)+',version=version+1 WHERE id=? AND version=?',[values[k] for k in keys]+[old['id'],old['version']])
        if cur.rowcount!=1:raise ApiError(409,'检查配置版本冲突，请刷新')
        ident=old['id']
    else:
        cur=conn.execute('INSERT INTO tax_workflows('+','.join(keys)+') VALUES('+','.join('?' for _ in keys)+')',[values[k] for k in keys]);ident=cur.lastrowid
    saved=_one(conn,'SELECT * FROM tax_workflows WHERE id=?',(ident,))
    audit(conn,user,action,'tax_workflows',ident,{'before':old,'after':saved,'local_only':True,'external_action':'none',**(extra or {})})
    return _display(conn,saved)


def handle(conn,method,path,payload,user,query):
    match=re.fullmatch(r'/api/tax-workflows(?:/([1-9]\d*))?(?:/(check))?',path)
    if not match:return None
    ident=int(match[1]) if match[1] else None;action=match[2]
    if not isinstance(payload,dict):raise ApiError(400,'请求须为对象')
    if method=='GET' and not action:
        if ident:return _display(conn,_row(conn,ident))
        rows=bootstrap(conn)
        if query.get('period'):
            period=_period(query['period']);rows=[r for r in rows if r['period']==period]
        if query.get('client_id'):
            value=str(query['client_id'])
            if not re.fullmatch(r'[1-9]\d*',value):raise ApiError(400,'客户编号无效')
            rows=[r for r in rows if r['client_id']==int(value)]
        return rows
    if method not in ('POST','PATCH','DELETE') or action and (method!='POST' or not ident) or method in ('PATCH','DELETE') and not ident:return None
    if method=='POST' and ident and not action:return None
    try:
        with conn:
            if not conn.in_transaction:conn.execute('BEGIN IMMEDIATE')
            if ident:old=_row(conn,ident)
            else:
                cid=_id(payload.get('client_id'),'客户编号');period=_period(payload.get('period'))
                old=_one(conn,'SELECT * FROM tax_workflows WHERE client_id=? AND period=? AND deleted=0',(cid,period))
            if old:_version(old,payload)
            elif payload.get('version') is not None and (type(payload['version']) is not int or payload['version']!=0):raise ApiError(409,'尚无活动配置，请刷新后新建')
            if action=='check':
                if set(payload)-{'version'}:raise ApiError(400,'检查仅接受当前版本，结果由服务端生成')
                _validate_write(conn,old);source=_sources(conn,old);states,details=_run_checks(old,source)
                values={area+'_status':states[area] for area in AREAS}
                values.update(check_details=json.dumps(details,ensure_ascii=False),checked_at=now(),checked_by=user['id'],checked_snapshot_hash=source['snapshot_hash'],updated_at=now(),updated_by=user['id'])
                return _save(conn,values,old,user,'check')
            if method=='DELETE':
                if set(payload)-{'version','reason'}:raise ApiError(400,'删除只接受版本与原因')
                _validate_write(conn,old);reason=_text(payload.get('reason',''),'删除原因',500)
                values={'deleted':1,'deleted_at':now(),'updated_at':now(),'updated_by':user['id']}
                return _save(conn,values,old,user,'delete',{'reason':reason})
            values=_prepare(conn,payload,old,user)
            return _save(conn,values,old,user,'update' if old else 'create')
    except sqlite3.IntegrityError as error:raise ApiError(409,'检查配置重复或关联约束冲突，请刷新') from error
