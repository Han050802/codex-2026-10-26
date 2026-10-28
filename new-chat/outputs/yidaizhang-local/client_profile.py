"""Customer profile validation and current-Windows-user DPAPI protection.

No endpoint returns decrypted private fields. UI_FORBIDDEN is always set and
LOCAL_MACHINE is never set. Reference signatures:
https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata
https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptunprotectdata
https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-localfree
"""
import base64
import binascii
import ctypes
import datetime
import json
import os
import re

from db import ApiError

PUBLIC_LIMITS = {
    'enterprise_name':200, 'tax_no':30, 'enterprise_form':30,
    'filing_type':10, 'vat_filing_frequency':7, 'mnemonic':80, 'business_status':10,
    'established_date':10, 'legal_representative':80, 'legal_phone':30,
    'contact_name':80, 'contact_phone':30, 'registered_address':100,
    'business_address':100, 'business_scope':1000, 'bookkeeper':80,
    'cashier':80, 'boss_name':80, 'boss_phone':30, 'boss_note':1000,
}
PUBLIC_ARRAY_FIELDS=('authorized_user_ids',)
PUBLIC_FIELDS=tuple(PUBLIC_LIMITS)+PUBLIC_ARRAY_FIELDS
SENSITIVE_FIELDS=('legal_id_number','contact_id_number','annual_report_password')
PRIVATE_STORAGE_FIELDS=('sensitive_json','profile_json')
ENTERPRISE_FORMS=('公司','个体工商户','个人独资企业','合伙企业','其他企业')
BUSINESS_STATUSES=('存续','在业','吊销','注销','迁入','迁出','停业','清算')
DEFAULTS={k:'' for k in PUBLIC_LIMITS}
DEFAULTS.update(enterprise_form='公司',filing_type='normal',business_status='存续',authorized_user_ids=[])
CRYPTPROTECT_UI_FORBIDDEN=0x1


class _Blob(ctypes.Structure):
    _fields_=[('cbData',ctypes.c_uint32),('pbData',ctypes.POINTER(ctypes.c_ubyte))]


def _libraries():
    if os.name!='nt':
        raise ApiError(503,'此平台不支持Windows DPAPI；敏感资料未保存，不能明文降级')
    try:
        crypt=ctypes.WinDLL('crypt32',use_last_error=True)
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        crypt.CryptProtectData.argtypes=[ctypes.POINTER(_Blob),ctypes.c_wchar_p,ctypes.POINTER(_Blob),ctypes.c_void_p,ctypes.c_void_p,ctypes.c_uint32,ctypes.POINTER(_Blob)]
        crypt.CryptProtectData.restype=ctypes.c_int
        crypt.CryptUnprotectData.argtypes=[ctypes.POINTER(_Blob),ctypes.POINTER(ctypes.c_wchar_p),ctypes.POINTER(_Blob),ctypes.c_void_p,ctypes.c_void_p,ctypes.c_uint32,ctypes.POINTER(_Blob)]
        crypt.CryptUnprotectData.restype=ctypes.c_int
        kernel.LocalFree.argtypes=[ctypes.c_void_p]
        kernel.LocalFree.restype=ctypes.c_void_p
        return crypt,kernel
    except (AttributeError,OSError):
        raise ApiError(503,'Windows DPAPI不可用；敏感资料未保存，不能明文降级') from None


def _blob(data):
    buffer=ctypes.create_string_buffer(data,len(data) or 1)
    return _Blob(len(data),ctypes.cast(buffer,ctypes.POINTER(ctypes.c_ubyte))),buffer


def protect(value,field):
    if field not in SENSITIVE_FIELDS:raise ApiError(400,'敏感资料字段无效')
    crypt,kernel=_libraries()
    encoded=json.dumps({'v':1,'field':field,'value':value},ensure_ascii=False,separators=(',',':')).encode('utf-8')
    source,buffer=_blob(encoded);entropy,entropy_buffer=_blob(('yidaizhang-local/profile/v1/'+field).encode('ascii'));output=_Blob()
    try:
        success=crypt.CryptProtectData(ctypes.byref(source),'YDZ local profile v1',ctypes.byref(entropy),None,None,CRYPTPROTECT_UI_FORBIDDEN,ctypes.byref(output))
        if not success:raise ApiError(503,'Windows DPAPI加密失败，敏感资料未保存；请使用原Windows服务账号重试')
        return 'dpapi-current-user-v1:'+base64.b64encode(ctypes.string_at(output.pbData,output.cbData)).decode('ascii')
    finally:
        ctypes.memset(buffer,0,ctypes.sizeof(buffer))
        if output.pbData:kernel.LocalFree(ctypes.cast(output.pbData,ctypes.c_void_p))


def _unprotect(ciphertext,field):
    """Internal validation/roundtrip only. Never expose through an API."""
    crypt,kernel=_libraries()
    try:
        if not isinstance(ciphertext,str) or not ciphertext.startswith('dpapi-current-user-v1:'):raise ValueError()
        raw=base64.b64decode(ciphertext.split(':',1)[1],validate=True)
        if not raw or len(raw)>8192:raise ValueError()
    except (ValueError,binascii.Error):raise ApiError(400,'加密资料格式损坏，请从原账号的完整备份恢复或明确清空后重录') from None
    source,buffer=_blob(raw);entropy,entropy_buffer=_blob(('yidaizhang-local/profile/v1/'+field).encode('ascii'));output=_Blob()
    try:
        if not crypt.CryptUnprotectData(ctypes.byref(source),None,ctypes.byref(entropy),None,None,CRYPTPROTECT_UI_FORBIDDEN,ctypes.byref(output)):
            raise ApiError(400,'当前Windows账号或电脑无法读取这些加密资料；请使用原服务账号及原电脑恢复，或明确清空后重录')
        try:
            decoded=json.loads(ctypes.string_at(output.pbData,output.cbData).decode('utf-8'))
            if decoded.get('v')!=1 or decoded.get('field')!=field or not isinstance(decoded.get('value'),str):raise ValueError()
            return decoded['value']
        except (ValueError,UnicodeDecodeError,AttributeError):
            raise ApiError(400,'加密资料完整性验证失败，请从完整备份恢复或明确清空后重录') from None
    finally:
        if output.pbData:
            ctypes.memset(output.pbData,0,output.cbData)
            kernel.LocalFree(ctypes.cast(output.pbData,ctypes.c_void_p))


def _load(value,label):
    try:
        parsed=json.loads(value or '{}') if isinstance(value,str) else value or {}
        if not isinstance(parsed,dict):raise ValueError()
        return parsed
    except (ValueError,TypeError):raise ApiError(500,label+'格式损坏，请从备份恢复') from None


def expand_client(row):
    d=dict(row)
    public=_load(d.pop('profile_json','{}'),'客户资料')
    private=_load(d.pop('sensitive_json','{}'),'加密资料')
    profile={**DEFAULTS,**{k:v for k,v in public.items() if k in PUBLIC_FIELDS}}
    if not isinstance(profile['authorized_user_ids'],list):raise ApiError(500,'客户分工名单格式损坏，请从备份恢复')
    profile['authorized_user_ids']=list(profile['authorized_user_ids'])
    if not profile['enterprise_name']:profile['enterprise_name']=d.get('name','')
    d.update(profile)
    flags={};unavailable=False
    for field in SENSITIVE_FIELDS:
        present=bool(private.get(field));available=None
        if present:
            try:_unprotect(private[field],field);available=True
            except ApiError:available=False;unavailable=True
        flags[field]={'set':present,'masked':'********' if present else '', 'available':available}
        d['has_'+field]=present;d[field+'_masked']=flags[field]['masked']
        d.pop(field,None)
    d['private_fields']=flags
    if unavailable:d['private_fields_notice']='部分加密资料无法由当前Windows账号读取；请在原服务账号及原电脑恢复，或明确清空后重新填写。'
    return d


def validate_mode(payload,old):
    mode=payload.get('profile_mode',False)
    if not isinstance(mode,bool):raise ApiError(400,'资料表单模式必须是布尔值')
    if mode and old is None:
        for field in ('name','enterprise_name','tax_no','industry','region','enterprise_form','filing_type','accountant_id','start_period','standard','taxpayer_type'):
            value=payload.get(field)
            if value is None or value=='' or isinstance(value,str) and not value.strip():
                raise ApiError(400,'新建客户资料缺少必填字段',{'field':field})
    return mode


def allocate_code(conn):
    # Acquire a write reservation before reading the sequence, including callers
    # outside the HTTP server's in-process mutation lock.
    if not conn.in_transaction:conn.execute('BEGIN IMMEDIATE')
    row=conn.execute("SELECT value FROM meta WHERE key='client_code_sequence'").fetchone()
    sequence=int(row[0]) if row else 0
    while True:
        sequence+=1;code='KH'+str(sequence).zfill(6)
        if not conn.execute('SELECT 1 FROM clients WHERE code=?',(code,)).fetchone():break
    conn.execute("INSERT INTO meta(key,value) VALUES('client_code_sequence',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(str(sequence),))
    return code


def prepare(conn,payload,old=None):
    public={k:(old or {}).get(k,DEFAULTS[k]) for k in PUBLIC_FIELDS}
    if 'vat_filing_frequency' in payload and not isinstance(payload['vat_filing_frequency'],str):
        raise ApiError(400,'增值税纳税期限须为空、month或quarter',{'field':'vat_filing_frequency'})
    for field in PUBLIC_LIMITS:
        if field not in payload:continue
        value=payload[field]
        if value is None:value=''
        if not isinstance(value,str):raise ApiError(400,field+'必须为文本')
        value=value.strip()
        if len(value)>PUBLIC_LIMITS[field] or '\x00' in value:raise ApiError(400,field+'超出长度限制或包含无效字符')
        public[field]=value
    if 'authorized_user_ids' in payload:
        assignments=payload['authorized_user_ids']
        if not isinstance(assignments,list) or any(isinstance(uid,bool) or not isinstance(uid,int) or uid<=0 for uid in assignments):
            raise ApiError(400,'账套分工名单必须是用户编号数组',{'field':'authorized_user_ids'})
        assignments=list(dict.fromkeys(assignments))
        if len(assignments)>3:raise ApiError(400,'账套分工名单最多选择三名用户',{'field':'authorized_user_ids'})
        for uid in assignments:
            if not conn.execute('SELECT 1 FROM users WHERE id=? AND enabled=1',(uid,)).fetchone():
                raise ApiError(400,'分工名单包含不存在或已停用的用户',{'field':'authorized_user_ids'})
        public['authorized_user_ids']=assignments
    else:
        public['authorized_user_ids']=list((old or {}).get('authorized_user_ids',[]))
    if public['enterprise_form'] not in ENTERPRISE_FORMS:raise ApiError(400,'企业类型无效')
    if public['filing_type'] not in ('normal','zero'):raise ApiError(400,'报税类型须为正常申报或零申报')
    if public['vat_filing_frequency'] not in ('','month','quarter'):
        raise ApiError(400,'增值税纳税期限须为空、month或quarter',{'field':'vat_filing_frequency'})
    if public['business_status'] not in BUSINESS_STATUSES:raise ApiError(400,'经营状态无效')
    if public['tax_no']:
        if not re.fullmatch(r'[A-Za-z0-9]{1,30}',public['tax_no']):raise ApiError(400,'税号仅支持最多30位字母或数字')
        public['tax_no']=public['tax_no'].upper()
    if public['established_date']:
        try:
            day=datetime.date.fromisoformat(public['established_date'])
            if day.isoformat()!=public['established_date'] or not 1900<=day.year<=2099:raise ValueError()
        except ValueError:raise ApiError(400,'成立日期须为1900—2099年间的YYYY-MM-DD') from None
    for field in ('legal_phone','contact_phone','boss_phone'):
        if public[field] and not re.fullmatch(r'[+0-9() -]{6,30}',public[field]):raise ApiError(400,field+'联系电话格式无效')
    row=conn.execute('SELECT sensitive_json FROM clients WHERE id=?',(old['id'],)).fetchone() if old else None
    private=_load(row['sensitive_json'] if row else '{}','加密资料')
    clear=payload.get('clear_sensitive',[])
    if not isinstance(clear,list) or any(not isinstance(k,str) or k not in SENSITIVE_FIELDS for k in clear) or len(set(clear))!=len(clear):
        raise ApiError(400,'明确清空的敏感字段列表无效')
    for field in SENSITIVE_FIELDS:
        value=payload.get(field)
        if value is not None and not isinstance(value,str):raise ApiError(400,'敏感资料必须是文本')
        if field in clear:
            if value:raise ApiError(400,'同一敏感字段不能同时修改和清空')
            private.pop(field,None);continue
        if value not in ('',None):
            if field.endswith('_id_number'):
                value=value.strip().upper()
                if not re.fullmatch(r'\d{15}|\d{17}[0-9X]',value):raise ApiError(400,'身份证号格式须为15位数字或18位数字/X')
            elif len(value)>256 or '\x00' in value:raise ApiError(400,'年报登录密码超出256位或包含无效字符')
            private[field]=protect(value,field)
        elif private.get(field):
            # A restored backup must never silently carry unreadable secrets into
            # further edits under a different service account.
            _unprotect(private[field],field)
    return {'profile_json':json.dumps(public,ensure_ascii=False,separators=(',',':')),
            'sensitive_json':json.dumps(private,ensure_ascii=False,separators=(',',':'))}


def scrub_audit(value):
    """Defense in depth, including generic before/after snapshots and imports."""
    blocked=set(SENSITIVE_FIELDS)|set(PRIVATE_STORAGE_FIELDS)|{'password','password_hash','current_password','clear_sensitive'}
    if isinstance(value,dict):return {str(k):scrub_audit(v) for k,v in value.items() if str(k).lower() not in blocked}
    if isinstance(value,(list,tuple)):
        return [scrub_audit(v) for v in value if not isinstance(v,str) or v.lower() not in blocked]
    return value
