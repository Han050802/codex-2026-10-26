"""Local, auditable double-entry accounting. Money is integer fen, quantity Decimal.

Templates: small2013 includes 66 standard accounts and two supplied extensions;
enterprise2007 is a common non-financial subset of 财会[2006]18号, not an
assertion of support for every later standard, special industry or disclosure.
Sources: https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852734144.pdf
https://czj.sh.gov.cn/zys_8908/zcfg_8983/zcfb_8985/hj_9035/cwhjjbzdgf/20061201/0017-156907.html

Reports are ledger-derived management statements. Cash flows require explicit
classification; an incomplete report is never labelled an accurate statement.
"""
import calendar
import datetime as dt
import hashlib
import json
import re
import sqlite3
from contextlib import contextmanager
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from db import ApiError, amount, audit, now
from client_profile import expand_client


CASH_CATEGORIES = ('operating', 'investing', 'financing', 'transfer', 'unclassified')
CATEGORIES = ('asset', 'liability', 'equity', 'income', 'expense', 'cost')
REPORT_KEYS = {
    'cash': '货币资金', 'short_investment': '短期投资/交易性金融资产',
    'receivable': '应收款项', 'prepaid': '预付款项', 'inventory': '存货及生产成本',
    'long_investment': '长期投资', 'fixed_asset': '固定资产净额',
    'construction': '在建工程及工程物资', 'intangible': '无形资产净额',
    'other_asset': '其他资产', 'short_debt': '短期借款', 'payable': '应付款项',
    'advance': '预收款项', 'payroll_payable': '应付职工薪酬', 'tax_payable': '应交税费',
    'other_liability': '其他负债', 'long_debt': '长期借款及应付款',
    'capital': '实收资本及资本公积', 'retained': '盈余公积及利润分配',
    'current_profit': '本年利润', 'revenue': '营业收入', 'investment_income': '投资收益',
    'other_income': '营业外及其他收益', 'business_cost': '营业成本',
    'taxes': '税金及附加', 'selling': '销售费用', 'administration': '管理费用',
    'finance': '财务费用', 'other_expense': '营业外及其他损失', 'income_tax': '所得税费用',
    'prior_adjustment': '以前年度损益调整（暂不支持记账）',
}


def _legacy_template(standard):
    common = [
        ('1001','库存现金','debit','asset','cash'), ('1002','银行存款','debit','asset','cash'),
        ('1012','其他货币资金','debit','asset','cash'), ('1121','应收票据','debit','asset','receivable'),
        ('1122','应收账款','debit','asset','receivable'), ('1123','预付账款','debit','asset','prepaid'),
        ('1131','应收股利','debit','asset','receivable'), ('1132','应收利息','debit','asset','receivable'),
        ('1221','其他应收款','debit','asset','receivable'),
        ('1401','材料采购','debit','asset','inventory'), ('1402','在途物资','debit','asset','inventory'),
        ('1403','原材料','debit','asset','inventory'), ('1404','材料成本差异','debit','asset','inventory'),
        ('1405','库存商品','debit','asset','inventory'), ('1407','商品进销差价','credit','asset','inventory'),
        ('1408','委托加工物资','debit','asset','inventory'), ('1411','周转材料','debit','asset','inventory'),
        ('1601','固定资产','debit','asset','fixed_asset'), ('1602','累计折旧','credit','asset','fixed_asset'),
        ('1604','在建工程','debit','asset','construction'), ('1605','工程物资','debit','asset','construction'),
        ('1606','固定资产清理','debit','asset','fixed_asset'),
        ('1701','无形资产','debit','asset','intangible'), ('1702','累计摊销','credit','asset','intangible'),
        ('1801','长期待摊费用','debit','asset','other_asset'), ('1901','待处理财产损溢','debit','asset','other_asset'),
        ('2001','短期借款','credit','liability','short_debt'), ('2201','应付票据','credit','liability','payable'),
        ('2202','应付账款','credit','liability','payable'), ('2203','预收账款','credit','liability','advance'),
        ('2211','应付职工薪酬','credit','liability','payroll_payable'), ('2221','应交税费','credit','liability','tax_payable'),
        ('2231','应付利息','credit','liability','other_liability'), ('2241','其他应付款','credit','liability','other_liability'),
        ('2401','递延收益','credit','liability','other_liability'), ('2501','长期借款','credit','liability','long_debt'),
        ('2701','长期应付款','credit','liability','long_debt'),
    ]
    if standard == 'small2013':
        extra = [
            ('1101','短期投资','debit','asset','short_investment'),
            ('1421','消耗性生物资产','debit','asset','inventory'),
            ('1501','长期债券投资','debit','asset','long_investment'), ('1511','长期股权投资','debit','asset','long_investment'),
            ('1621','生产性生物资产','debit','asset','fixed_asset'), ('1622','生产性生物资产累计折旧','credit','asset','fixed_asset'),
            ('2232','应付利润','credit','liability','other_liability'),
            ('3001','实收资本','credit','equity','capital'), ('3002','资本公积','credit','equity','capital'),
            ('3101','盈余公积','credit','equity','retained'), ('3103','本年利润','credit','equity','current_profit'),
            ('3104','利润分配','credit','equity','retained'),
            ('4001','生产成本','debit','cost','inventory'), ('4101','制造费用','debit','cost','inventory'),
            ('4301','研发支出','debit','cost','other_asset'), ('4401','工程施工','debit','cost','inventory'),
            ('4403','机械作业','debit','cost','inventory'),
            ('5001','主营业务收入','credit','income','revenue'), ('5051','其他业务收入','credit','income','revenue'),
            ('5111','投资收益','credit','income','investment_income'), ('5301','营业外收入','credit','income','other_income'),
            ('5401','主营业务成本','debit','expense','business_cost'), ('5402','其他业务成本','debit','expense','business_cost'),
            ('5403','营业税金及附加','debit','expense','taxes'), ('5601','销售费用','debit','expense','selling'),
            ('5602','管理费用','debit','expense','administration'), ('5603','财务费用','debit','expense','finance'),
            ('5711','营业外支出','debit','expense','other_expense'), ('5801','所得税费用','debit','expense','income_tax'),
        ]
    elif standard == 'enterprise2007':
        extra = [
            ('1101','交易性金融资产','debit','asset','short_investment'), ('1231','坏账准备','credit','asset','receivable'),
            ('1406','发出商品','debit','asset','inventory'), ('1471','存货跌价准备','credit','asset','inventory'),
            ('1501','持有至到期投资','debit','asset','long_investment'), ('1502','持有至到期投资减值准备','credit','asset','long_investment'),
            ('1503','可供出售金融资产','debit','asset','long_investment'), ('1511','长期股权投资','debit','asset','long_investment'),
            ('1512','长期股权投资减值准备','credit','asset','long_investment'), ('1521','投资性房地产','debit','asset','long_investment'),
            ('1603','固定资产减值准备','credit','asset','fixed_asset'), ('1703','无形资产减值准备','credit','asset','intangible'),
            ('1811','递延所得税资产','debit','asset','other_asset'), ('2232','应付股利','credit','liability','other_liability'),
            ('2502','应付债券','credit','liability','long_debt'), ('2711','专项应付款','credit','liability','long_debt'),
            ('2801','预计负债','credit','liability','other_liability'), ('2901','递延所得税负债','credit','liability','other_liability'),
            ('4001','实收资本','credit','equity','capital'), ('4002','资本公积','credit','equity','capital'),
            ('4101','盈余公积','credit','equity','retained'), ('4103','本年利润','credit','equity','current_profit'),
            ('4104','利润分配','credit','equity','retained'), ('4201','库存股','debit','equity','capital'),
            ('5001','生产成本','debit','cost','inventory'), ('5101','制造费用','debit','cost','inventory'),
            ('5201','劳务成本','debit','cost','inventory'), ('5301','研发支出','debit','cost','other_asset'),
            ('5401','工程施工','debit','cost','inventory'), ('5403','机械作业','debit','cost','inventory'),
            ('6001','主营业务收入','credit','income','revenue'), ('6051','其他业务收入','credit','income','revenue'),
            ('6101','公允价值变动损益','credit','income','other_income'), ('6111','投资收益','credit','income','investment_income'),
            ('6301','营业外收入','credit','income','other_income'), ('6401','主营业务成本','debit','expense','business_cost'),
            ('6402','其他业务成本','debit','expense','business_cost'), ('6403','营业税金及附加','debit','expense','taxes'),
            ('6601','销售费用','debit','expense','selling'), ('6602','管理费用','debit','expense','administration'),
            ('6603','财务费用','debit','expense','finance'), ('6701','资产减值损失','debit','expense','other_expense'),
            ('6711','营业外支出','debit','expense','other_expense'), ('6801','所得税费用','debit','expense','income_tax'),
        ]
    else:
        raise ApiError(400, '不支持的会计制度')
    return sorted(common + extra)


def _template(standard):
    rows = _legacy_template(standard)
    if standard == 'small2013':
        rows = [(code, '税金及附加' if code == '5403' else name, direction, category, report_key)
                for code, name, direction, category, report_key in rows]
        rows += [('1133','应收出口退税款','debit','asset','receivable'),
                 ('5901','以前年度损益调整','debit','expense','prior_adjustment')]
    return sorted(rows)


def init_schema(conn):
    conn.executescript('''
    CREATE TABLE IF NOT EXISTS accounts(id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES clients(id),code TEXT NOT NULL,name TEXT NOT NULL,direction TEXT NOT NULL,category TEXT NOT NULL,report_key TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,UNIQUE(client_id,code));
    CREATE TABLE IF NOT EXISTS book_settings(client_id INTEGER PRIMARY KEY REFERENCES clients(id),opening_version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS opening_balances(client_id INTEGER NOT NULL,account_code TEXT NOT NULL,debit_fen INTEGER NOT NULL DEFAULT 0 CHECK(debit_fen>=0),credit_fen INTEGER NOT NULL DEFAULT 0 CHECK(credit_fen>=0),PRIMARY KEY(client_id,account_code),FOREIGN KEY(client_id,account_code) REFERENCES accounts(client_id,code));
    CREATE TABLE IF NOT EXISTS vouchers(id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES clients(id),date TEXT NOT NULL,period TEXT NOT NULL,number INTEGER NOT NULL,summary TEXT NOT NULL,source_type TEXT NOT NULL DEFAULT 'manual',source_id TEXT,status TEXT NOT NULL DEFAULT 'active',reviewed INTEGER NOT NULL DEFAULT 0,reviewed_by INTEGER REFERENCES users(id),reviewed_at TEXT,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,created_by INTEGER REFERENCES users(id),UNIQUE(client_id,period,number));
    CREATE UNIQUE INDEX IF NOT EXISTS voucher_active_source ON vouchers(client_id,source_type,source_id) WHERE source_id IS NOT NULL AND status='active';
    CREATE INDEX IF NOT EXISTS voucher_period ON vouchers(client_id,period,status);
    CREATE TABLE IF NOT EXISTS voucher_lines(id INTEGER PRIMARY KEY,voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,client_id INTEGER NOT NULL,account_code TEXT NOT NULL,debit_fen INTEGER NOT NULL DEFAULT 0 CHECK(debit_fen>=0),credit_fen INTEGER NOT NULL DEFAULT 0 CHECK(credit_fen>=0),cashflow_category TEXT NOT NULL DEFAULT 'unclassified',FOREIGN KEY(client_id,account_code) REFERENCES accounts(client_id,code));
    CREATE INDEX IF NOT EXISTS voucher_line_account ON voucher_lines(client_id,account_code,voucher_id);
    CREATE TABLE IF NOT EXISTS book_periods(client_id INTEGER NOT NULL REFERENCES clients(id),period TEXT NOT NULL,closed INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,closed_at TEXT,closed_by INTEGER REFERENCES users(id),closing_voucher_id INTEGER REFERENCES vouchers(id),PRIMARY KEY(client_id,period));
    CREATE TABLE IF NOT EXISTS assets(id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES clients(id),name TEXT NOT NULL,purchase_date TEXT NOT NULL,start_period TEXT NOT NULL,cost_fen INTEGER NOT NULL,residual_fen INTEGER NOT NULL,life_months INTEGER NOT NULL,expense_account TEXT NOT NULL,asset_account TEXT NOT NULL,depreciation_account TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',purchase_voucher_id INTEGER REFERENCES vouchers(id),disposal_voucher_id INTEGER REFERENCES vouchers(id),disposal_date TEXT,version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS asset_depreciations(id INTEGER PRIMARY KEY,asset_id INTEGER NOT NULL REFERENCES assets(id),period TEXT NOT NULL,amount_fen INTEGER NOT NULL,voucher_id INTEGER REFERENCES vouchers(id),UNIQUE(asset_id,period));
    CREATE TABLE IF NOT EXISTS inventory_items(id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES clients(id),sku TEXT NOT NULL,name TEXT NOT NULL,unit TEXT NOT NULL,inventory_account TEXT NOT NULL,cost_account TEXT NOT NULL,quantity TEXT NOT NULL DEFAULT '0',value_fen INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,UNIQUE(client_id,sku));
    CREATE TABLE IF NOT EXISTS inventory_movements(id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES clients(id),item_id INTEGER NOT NULL REFERENCES inventory_items(id),date TEXT NOT NULL,direction TEXT NOT NULL,quantity TEXT NOT NULL,amount_fen INTEGER NOT NULL,voucher_id INTEGER REFERENCES vouchers(id),status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payroll(id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES clients(id),period TEXT NOT NULL,employee_name TEXT NOT NULL,gross_fen INTEGER NOT NULL,withheld_tax_fen INTEGER NOT NULL DEFAULT 0,social_fen INTEGER NOT NULL DEFAULT 0,other_deduction_fen INTEGER NOT NULL DEFAULT 0,net_fen INTEGER NOT NULL,expense_account TEXT NOT NULL,voucher_id INTEGER REFERENCES vouchers(id),payment_voucher_id INTEGER REFERENCES vouchers(id),version INTEGER NOT NULL DEFAULT 1,UNIQUE(client_id,period,employee_name));
    CREATE TABLE IF NOT EXISTS journals(id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES clients(id),date TEXT NOT NULL,period TEXT NOT NULL,summary TEXT NOT NULL,bank_account TEXT NOT NULL,counter_account TEXT NOT NULL,direction TEXT NOT NULL,amount_fen INTEGER NOT NULL,cashflow_category TEXT NOT NULL DEFAULT 'unclassified',fingerprint TEXT NOT NULL,voucher_id INTEGER REFERENCES vouchers(id),version INTEGER NOT NULL DEFAULT 1,UNIQUE(client_id,fingerprint));
    ''')
    if 'status' not in {x[1] for x in conn.execute('PRAGMA table_info(inventory_movements)')}:
        conn.execute("ALTER TABLE inventory_movements ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
    # Additive migrations keep existing vouchers, line ids and audit history intact.
    if 'attachment_count' not in {x[1] for x in conn.execute('PRAGMA table_info(vouchers)')}:
        conn.execute('ALTER TABLE vouchers ADD COLUMN attachment_count INTEGER NOT NULL DEFAULT 0 CHECK(attachment_count>=0 AND attachment_count<=9999)')
    if 'summary' not in {x[1] for x in conn.execute('PRAGMA table_info(voucher_lines)')}:
        conn.execute("ALTER TABLE voucher_lines ADD COLUMN summary TEXT NOT NULL DEFAULT ''")


def ensure_book(conn, client):
    client = dict(client)
    if conn.execute('SELECT 1 FROM accounts WHERE client_id=? LIMIT 1',(client['id'],)).fetchone():
        return
    conn.executemany('INSERT INTO accounts(client_id,code,name,direction,category,report_key) VALUES(?,?,?,?,?,?)',
                     [(client['id'],)+row for row in _template(client['standard'])])
    conn.execute('INSERT OR IGNORE INTO book_settings(client_id) VALUES(?)',(client['id'],))


def apply_subject_list_to_book(conn, cid, expected_name, user=None):
    """Apply the supplied 68-item list only to a specified, unchanged small book.

    Refuse customized or already changed records rather than overwrite them. Caller
    controls the transaction. Repeat runs are harmless. No vouchers are changed.
    """
    client = conn.execute('SELECT id,name,standard FROM clients WHERE id=? AND deleted=0',(cid,)).fetchone()
    if not client or client['name'] != expected_name or client['standard'] != 'small2013':
        raise ApiError(409,'账套身份或会计制度不匹配，未修改科目')
    existing = {row['code']:dict(row) for row in conn.execute('SELECT * FROM accounts WHERE client_id=?',(cid,))}
    expected = {row[0]:row[1:] for row in _legacy_template('small2013')}
    additions = {'1133':('应收出口退税款','debit','asset','receivable'),
                 '5901':('以前年度损益调整','debit','expense','prior_adjustment')}
    if set(existing) - (set(expected) | set(additions)):
        raise ApiError(409,'账套包含清单外科目，未自动覆盖')
    for code, values in expected.items():
        row=existing.get(code)
        if not row:
            raise ApiError(409,f'账套缺少原有科目 {code}，未自动覆盖')
        actual=tuple(row[k] for k in ('name','direction','category','report_key'))
        permitted = [values]
        if code=='5403': permitted.append(('税金及附加',)+values[1:])
        if actual not in permitted:
            raise ApiError(409,f'科目 {code} 已被修改，未自动覆盖')
    for code, values in additions.items():
        row=existing.get(code)
        if row and tuple(row[k] for k in ('name','direction','category','report_key')) != values:
            raise ApiError(409,f'科目 {code} 已存在且内容不同，未自动覆盖')
    if conn.execute("SELECT 1 FROM voucher_lines WHERE client_id=? AND account_code LIKE '5901%' LIMIT 1",(cid,)).fetchone():
        raise ApiError(409,'以前年度损益调整已有凭证引用，须先核对，未自动修改')
    changed=[]
    for code, values in additions.items():
        if code not in existing:
            conn.execute('INSERT INTO accounts(client_id,code,name,direction,category,report_key) VALUES(?,?,?,?,?,?)',(cid,code,*values))
            changed.append(code)
    if existing['5403']['name'] != '税金及附加':
        conn.execute("UPDATE accounts SET name='税金及附加',version=version+1 WHERE client_id=? AND code='5403'",(cid,))
        changed.append('5403')
    if changed:
        audit(conn,user,'apply_subject_list','book',cid,{'changed_codes':changed,'source':'科目清单.xlsx'})
    return {'client_id':cid,'count':68,'changed_codes':changed}


def reconcile_small_subject_template(conn, cid, apply=False, user=None):
    """Preview or add missing small-book template accounts without changing existing rows.

    A same-code customization or incompatible descendant is reported for review.
    Caller controls the write transaction, including audit logging, when applying.
    """
    client = conn.execute('SELECT id,standard,deleted FROM clients WHERE id=?',(cid,)).fetchone()
    if not client or client['deleted'] or client['standard'] != 'small2013':
        raise ApiError(409,'仅支持未删除的小企业会计准则账套')
    existing = {row['code']:dict(row) for row in conn.execute('SELECT * FROM accounts WHERE client_id=?',(cid,))}
    additions, conflicts = [], []
    for code, name, direction, category, report_key in _template('small2013'):
        row = existing.get(code)
        expected = (name,direction,category,report_key)
        if row:
            actual = tuple(row[k] for k in ('name','direction','category','report_key'))
            if actual != expected:
                conflicts.append({'code':code,'reason':'已有科目内容不同，保留原内容'})
            continue
        descendants = [r for child,r in existing.items() if child.startswith(code) and child != code]
        if any(tuple(r[k] for k in ('direction','category','report_key')) != (direction,category,report_key) for r in descendants):
            conflicts.append({'code':code,'reason':'现有明细科目的方向或归类与模板不一致'})
            continue
        additions.append((code,name,direction,category,report_key))
    if apply and additions:
        conn.executemany('INSERT INTO accounts(client_id,code,name,direction,category,report_key) VALUES(?,?,?,?,?,?)',
                         [(cid,)+row for row in additions])
        audit(conn,user,'reconcile_small_subject_template','book',cid,
              {'added_codes':[row[0] for row in additions],'conflicts':conflicts})
    return {'client_id':cid,'existing_count':len(existing),'added_codes':[row[0] for row in additions],
            'conflicts':conflicts,'applied':bool(apply)}


@contextmanager
def _write(conn):
    with conn:
        if not conn.in_transaction:
            conn.execute('BEGIN IMMEDIATE')
        yield


def _period(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d{2}',value):
        raise ApiError(400,'会计期间必须为 YYYY-MM')
    try:
        dt.date.fromisoformat(value+'-01')
    except ValueError:
        raise ApiError(400,'会计期间无效')
    return value


def _date(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',value):
        raise ApiError(400,'日期必须为 YYYY-MM-DD')
    try:
        dt.date.fromisoformat(value)
    except ValueError:
        raise ApiError(400,'日期无效')
    return value


def _month_add(period,n):
    y,m=map(int,period.split('-')); z=y*12+m-1+n
    return f'{z//12:04d}-{z%12+1:02d}'


def _last_date(period):
    y,m=map(int,period.split('-'))
    return f'{period}-{calendar.monthrange(y,m)[1]:02d}'


def _text(value,name,maximum=200):
    if not isinstance(value,str) or not value.strip() or len(value.strip())>maximum:
        raise ApiError(400,f'{name}必填且不能超过{maximum}字')
    return value.strip()


def _positive(value):
    value=amount(value)
    if value==0:
        raise ApiError(400,'金额必须大于零')
    return value


def _quantity(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d{1,15}(?:\.\d{1,6})?',value):
        raise ApiError(400,'数量须为最多6位小数的正数字符串')
    try:
        q=Decimal(value)
    except InvalidOperation:
        raise ApiError(400,'数量无效')
    if q<=0:
        raise ApiError(400,'数量必须大于零')
    return q


def _version(row,payload):
    if type(payload.get('version')) is not int or payload['version']!=row['version']:
        raise ApiError(409,'数据已被修改，请刷新后重试',{'current_version':row['version']})


def _client(conn,cid):
    row=conn.execute('SELECT * FROM clients WHERE id=? AND deleted=0',(cid,)).fetchone()
    if not row:
        raise ApiError(404,'账套不存在或已回收')
    if not row['enabled']:
        raise ApiError(409,'账套已停用')
    return expand_client(row)


def _open(conn,cid,period):
    _period(period)
    c=_client(conn,cid)
    if period<c['start_period']:
        raise ApiError(409,'不能在建账月份之前记账')
    closed=conn.execute('SELECT period FROM book_periods WHERE client_id=? AND closed=1 AND period>=? ORDER BY period LIMIT 1',(cid,period)).fetchone()
    if closed:
        raise ApiError(409,f'{closed["period"]}已结账，须按最近月份起依次反结账后操作')
    return c


def _account(conn,cid,code):
    row=conn.execute('SELECT * FROM accounts WHERE client_id=? AND code=?',(cid,str(code))).fetchone()
    if not row:
        raise ApiError(400,f'科目不存在：{code}')
    return dict(row)


def _cash(account):
    return account['report_key']=='cash'


def _lines(conn,cid,lines):
    if not isinstance(lines,list) or not 2<=len(lines)<=500:
        raise ApiError(400,'凭证需要2至500条分录')
    validated=[]; cashnet=0
    for line in lines:
        if not isinstance(line,dict):
            raise ApiError(400,'凭证分录格式错误')
        a=_account(conn,cid,line.get('account_code',''))
        if a['report_key']=='prior_adjustment':
            raise ApiError(409,'以前年度损益调整科目暂不支持记账，请勿作为本期损益处理')
        # A parent cannot be posted once it has subaccounts.
        if conn.execute('SELECT 1 FROM accounts WHERE client_id=? AND code LIKE ? AND code<>? LIMIT 1',(cid,a['code']+'%',a['code'])).fetchone():
            raise ApiError(400,f'请选末级科目：{a["code"]}')
        debit=amount(line.get('debit_fen',0)); credit=amount(line.get('credit_fen',0))
        if (debit>0)==(credit>0):
            raise ApiError(400,'每条分录必须仅借方或贷方有正金额')
        cat=line.get('cashflow_category') or 'unclassified'
        if cat not in CASH_CATEGORIES:
            raise ApiError(400,'现金流分类无效')
        if _cash(a):
            cashnet+=debit-credit
        summary=line.get('summary','')
        if not isinstance(summary,str) or len(summary.strip())>200:
            raise ApiError(400,'分录摘要须为不超过200字的文本')
        validated.append({'account_code':a['code'],'debit_fen':debit,'credit_fen':credit,
                          'cashflow_category':cat,'is_cash':_cash(a),'summary':summary.strip()})
    if sum(x['debit_fen'] for x in validated)!=sum(x['credit_fen'] for x in validated):
        raise ApiError(400,'借贷不平衡，凭证未保存')
    if any(x['is_cash'] and x['cashflow_category']=='transfer' for x in validated):
        if cashnet or any(not x['is_cash'] or x['cashflow_category']!='transfer' for x in validated):
            raise ApiError(400,'内部转账只能包含同张凭证内净额为零且全部标为转账的货币资金分录')
    return validated


def _attachment_count(value):
    if type(value) is not int or not 0<=value<=9999:
        raise ApiError(400,'附件张数须为0至9999的整数')
    return value


def _insert_voucher(conn,cid,date,summary,lines,user,source_type='manual',source_id=None,reviewed=False,attachment_count=0):
    _date(date); _open(conn,cid,date[:7]); summary=_text(summary,'摘要')
    lines=_lines(conn,cid,lines); attachment_count=_attachment_count(attachment_count)
    if source_id is not None:
        existing=conn.execute("SELECT id FROM vouchers WHERE client_id=? AND source_type=? AND source_id=? AND status='active'",(cid,source_type,str(source_id))).fetchone()
        if existing:
            raise ApiError(409,'该业务已生成凭证',{'voucher_id':existing['id']})
    number=conn.execute('SELECT COALESCE(MAX(number),0)+1 FROM vouchers WHERE client_id=? AND period=?',(cid,date[:7])).fetchone()[0]
    uid=(user or {}).get('id')
    cur=conn.execute('INSERT INTO vouchers(client_id,date,period,number,summary,source_type,source_id,reviewed,reviewed_by,reviewed_at,created_at,created_by,attachment_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        (cid,date,date[:7],number,summary,source_type,str(source_id) if source_id is not None else None,int(reviewed),uid if reviewed else None,now() if reviewed else None,now(),uid,attachment_count))
    vid=cur.lastrowid
    conn.executemany('INSERT INTO voucher_lines(voucher_id,client_id,account_code,debit_fen,credit_fen,cashflow_category,summary) VALUES(?,?,?,?,?,?,?)',
        [(vid,cid,x['account_code'],x['debit_fen'],x['credit_fen'],x['cashflow_category'],x['summary'] or summary) for x in lines])
    conn.execute('INSERT OR IGNORE INTO book_periods(client_id,period) VALUES(?,?)',(cid,date[:7]))
    audit(conn,user,'create','voucher',vid,{'client_id':cid,'source_type':source_type,'source_id':source_id,'summary':summary,'attachment_count':attachment_count,'lines':lines})
    return vid


def _entry(code,debit=0,credit=0,category='unclassified'):
    return {'account_code':code,'debit_fen':debit,'credit_fen':credit,'cashflow_category':category}


def create_invoice_voucher(conn,invoice,payload,user):
    """Caller owns transaction; returns voucher_id. No tax rate is inferred."""
    invoice=dict(invoice); cid=invoice['client_id']
    if invoice.get('status')=='posted' or invoice.get('voucher_id'):
        raise ApiError(409,'发票已生成凭证')
    debit=payload.get('debit_account'); credit=payload.get('credit_account')
    _account(conn,cid,debit); _account(conn,cid,credit)
    total=amount(invoice['total_fen']); net=amount(invoice['amount_fen']); tax=amount(invoice['tax_fen'])
    if total!=net+tax or total<=0:
        raise ApiError(400,'发票价税合计无效')
    cashcat=payload.get('cashflow_category','unclassified')
    if invoice['kind']=='output':
        lines=[_entry(debit,total,category=cashcat)]
        if net: lines.append(_entry(credit,credit=net))
        if tax:
            ta=payload.get('tax_account')
            if not ta: raise ApiError(400,'有税额时须明确选择应交税费科目')
            lines.append(_entry(ta,credit=tax))
    else:
        lines=[_entry(credit,credit=total,category=cashcat)]
        if tax and payload.get('tax_account'):
            if net: lines.append(_entry(debit,net))
            lines.append(_entry(payload['tax_account'],tax))
        else:
            lines.append(_entry(debit,total))
    return _insert_voucher(conn,cid,invoice['date'],invoice.get('summary') or f'发票 {invoice["number"]}',lines,user,'invoice',invoice['id'])


def create_bank_journal(conn,client_id,row,user):
    """Full validation without commit so imports are all-or-nothing."""
    cid=int(client_id); date=_date(row.get('date')); _open(conn,cid,date[:7])
    summary=_text(row.get('summary'),'摘要')
    bank=_account(conn,cid,row.get('bank_account')); counter=_account(conn,cid,row.get('counter_account'))
    if not _cash(bank): raise ApiError(400,'银行/现金账户须为货币资金科目')
    if bank['code']==counter['code']: raise ApiError(400,'收付账户与对方科目不能相同')
    direction=row.get('direction')
    if direction not in ('income','expense'): raise ApiError(400,'收支方向无效')
    cashcat=row.get('cashflow_category') or 'unclassified'
    if cashcat not in CASH_CATEGORIES: raise ApiError(400,'现金流分类无效')
    if cashcat=='transfer' and not _cash(counter): raise ApiError(400,'转账的对方也须为货币资金科目')
    value=_positive(row.get('amount_fen'))
    fingerprint=hashlib.sha256(json.dumps([date,summary,bank['code'],counter['code'],direction,value],ensure_ascii=False).encode()).hexdigest()
    if conn.execute('SELECT 1 FROM journals WHERE client_id=? AND fingerprint=?',(cid,fingerprint)).fetchone():
        raise ApiError(409,'相同银行日记账已存在，请核实重复导入')
    cur=conn.execute('INSERT INTO journals(client_id,date,period,summary,bank_account,counter_account,direction,amount_fen,cashflow_category,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?)',
        (cid,date,date[:7],summary,bank['code'],counter['code'],direction,value,cashcat,fingerprint))
    audit(conn,user,'create','journal',cur.lastrowid,{'client_id':cid,'date':date,'amount_fen':value,'source':row.get('source','manual')})
    return dict(conn.execute('SELECT * FROM journals WHERE id=?',(cur.lastrowid,)).fetchone())


def _voucher(conn,cid,vid):
    row=conn.execute('SELECT v.*,u.name created_by_name FROM vouchers v LEFT JOIN users u ON u.id=v.created_by WHERE v.id=? AND v.client_id=?',(vid,cid)).fetchone()
    if not row: raise ApiError(404,'凭证不存在')
    d=dict(row)
    d['lines']=[dict(x) for x in conn.execute('SELECT l.*,a.name account_name FROM voucher_lines l JOIN accounts a ON a.client_id=l.client_id AND a.code=l.account_code WHERE voucher_id=? ORDER BY l.id',(vid,))]
    return d


def withdraw_source(conn,cid,vid,user,reason,version):
    """Undo an unreviewed, open-period source posting, preserving audit/voucher.

    No commit: the HTTP route and any calling invoice route own the transaction.
    Dependent subledger postings must be withdrawn newest-first.
    """
    reason=_text(reason,'撤回原因',500); row=_voucher(conn,cid,vid)
    _version(row,{'version':version}); _open(conn,cid,row['period'])
    if row['status']!='active': raise ApiError(409,'凭证已作废')
    if row['reviewed']: raise ApiError(409,'须先取消凭证审核，再撤回来源业务')
    source=row['source_type']; sid=row['source_id']; before=None
    if source=='invoice':
        record=conn.execute('SELECT * FROM invoices WHERE client_id=? AND id=? AND voucher_id=?',(cid,sid,vid)).fetchone()
        if not record: raise ApiError(409,'发票与凭证关联不一致，不能撤回')
        before=dict(record)
        conn.execute("UPDATE invoices SET status='unprocessed',voucher_id=NULL,version=version+1,updated_at=? WHERE id=?",(now(),record['id']))
    elif source=='reconciliation':
        record=conn.execute('SELECT * FROM reconciliation_records WHERE client_id=? AND id=?',(cid,sid)).fetchone()
        if not record: raise ApiError(409,'核对记录与凭证关联不一致，不能撤回')
        before=dict(record)
    elif source=='bank':
        record=conn.execute('SELECT * FROM journals WHERE client_id=? AND id=? AND voucher_id=?',(cid,sid,vid)).fetchone()
        if not record: raise ApiError(409,'日记账与凭证关联不一致')
        before=dict(record); conn.execute('UPDATE journals SET voucher_id=NULL,version=version+1 WHERE id=?',(record['id'],))
    elif source=='inventory':
        record=conn.execute("SELECT * FROM inventory_movements WHERE client_id=? AND id=? AND voucher_id=? AND status='active'",(cid,sid,vid)).fetchone()
        if not record: raise ApiError(409,'库存流水与凭证关联不一致')
        latest=conn.execute("SELECT MAX(id) FROM inventory_movements WHERE item_id=? AND status='active'",(record['item_id'],)).fetchone()[0]
        if latest!=record['id']: raise ApiError(409,'存货成本已有后续依赖，须从该商品最近流水起逐笔撤回')
        item=conn.execute('SELECT * FROM inventory_items WHERE id=?',(record['item_id'],)).fetchone()
        sign=1 if record['direction']=='in' else -1
        qty=Decimal(item['quantity'])-Decimal(record['quantity'])*sign
        value=item['value_fen']-record['amount_fen']*sign
        if qty<0 or value<0: raise ApiError(409,'回滚库存将出现负数，不能撤回')
        before={'movement':dict(record),'item':dict(item)}
        conn.execute("UPDATE inventory_movements SET status='void' WHERE id=?",(record['id'],))
        conn.execute('UPDATE inventory_items SET quantity=?,value_fen=?,version=version+1 WHERE id=?',(format(qty,'f'),value,item['id']))
    elif source=='asset_purchase':
        record=conn.execute('SELECT * FROM assets WHERE client_id=? AND id=? AND purchase_voucher_id=?',(cid,sid,vid)).fetchone()
        if not record or record['status']!='active': raise ApiError(409,'资产购置状态不允许撤回')
        if conn.execute('SELECT 1 FROM asset_depreciations WHERE asset_id=?',(record['id'],)).fetchone() or record['disposal_voucher_id']:
            raise ApiError(409,'该资产已有折旧或处置，请先从最近来源业务起撤回')
        before=dict(record); conn.execute("UPDATE assets SET status='cancelled',version=version+1 WHERE id=?",(record['id'],))
    elif source=='depreciation':
        record=conn.execute('SELECT d.*,a.disposal_voucher_id,a.client_id FROM asset_depreciations d JOIN assets a ON a.id=d.asset_id WHERE d.voucher_id=? AND a.client_id=?',(vid,cid)).fetchone()
        if not record: raise ApiError(409,'折旧与凭证关联不一致')
        if record['disposal_voucher_id']: raise ApiError(409,'资产已处置，请先撤回处置')
        if conn.execute('SELECT 1 FROM asset_depreciations WHERE asset_id=? AND period>?',(record['asset_id'],record['period'])).fetchone():
            raise ApiError(409,'请从该资产最近折旧月份起撤回')
        before=dict(record)
        conn.execute('DELETE FROM asset_depreciations WHERE id=?',(record['id'],))
        conn.execute('UPDATE assets SET version=version+1 WHERE id=?',(record['asset_id'],))
    elif source=='asset_disposal':
        record=conn.execute('SELECT * FROM assets WHERE client_id=? AND id=? AND disposal_voucher_id=?',(cid,sid,vid)).fetchone()
        if not record or record['status']!='disposed': raise ApiError(409,'资产处置与凭证关联不一致')
        before=dict(record)
        conn.execute("UPDATE assets SET status='active',disposal_date=NULL,disposal_voucher_id=NULL,version=version+1 WHERE id=?",(record['id'],))
    elif source=='payroll':
        records=conn.execute('SELECT * FROM payroll WHERE client_id=? AND period=? AND voucher_id=?',(cid,sid,vid)).fetchall()
        if not records: raise ApiError(409,'工资计提与凭证关联不一致')
        if any(x['payment_voucher_id'] for x in records): raise ApiError(409,'该期工资已发放，请先撤回发放凭证')
        before=[dict(x) for x in records]
        conn.execute('UPDATE payroll SET voucher_id=NULL,version=version+1 WHERE client_id=? AND period=? AND voucher_id=?',(cid,sid,vid))
    elif source=='payroll_payment':
        records=conn.execute('SELECT * FROM payroll WHERE client_id=? AND period=? AND payment_voucher_id=?',(cid,sid,vid)).fetchall()
        if not records: raise ApiError(409,'工资发放与凭证关联不一致')
        before=[dict(x) for x in records]
        conn.execute('UPDATE payroll SET payment_voucher_id=NULL,version=version+1 WHERE client_id=? AND period=? AND payment_voucher_id=?',(cid,sid,vid))
    else:
        raise ApiError(409,'该来源不能在此撤回；手工凭证使用作废，损益结转使用反结账')
    conn.execute("UPDATE vouchers SET status='void',version=version+1 WHERE id=?",(vid,))
    audit(conn,user,'withdraw_source','voucher',vid,{'reason':reason,'source_type':source,'source_id':sid,'source_before':before,'voucher_before':row})
    return {'id':vid,'status':'void','source_type':source,'source_id':sid,'withdrawn':True,'version':row['version']+1}


def _trial(conn,cid,period):
    return _trial_range(conn,cid,period,period)


def _trial_range(conn,cid,start,end):
    """Raw per-account values; parent display totals must never feed reports."""
    accounts=[dict(a) for a in conn.execute('SELECT * FROM accounts WHERE client_id=? ORDER BY code',(cid,))]
    opening={x['account_code']:x['debit_fen']-x['credit_fen'] for x in conn.execute('SELECT * FROM opening_balances WHERE client_id=?',(cid,))}
    before={x['account_code']:x['balance'] for x in conn.execute("SELECT l.account_code,SUM(l.debit_fen-l.credit_fen) balance FROM voucher_lines l JOIN vouchers v ON v.id=l.voucher_id WHERE v.client_id=? AND v.status='active' AND v.period<? GROUP BY l.account_code",(cid,start))}
    current={x['account_code']:(x['debit'],x['credit']) for x in conn.execute("SELECT l.account_code,SUM(l.debit_fen) debit,SUM(l.credit_fen) credit FROM voucher_lines l JOIN vouchers v ON v.id=l.voucher_id WHERE v.client_id=? AND v.status='active' AND v.period BETWEEN ? AND ? GROUP BY l.account_code",(cid,start,end))}
    ytd={x['account_code']:(x['debit'],x['credit']) for x in conn.execute("SELECT l.account_code,SUM(l.debit_fen) debit,SUM(l.credit_fen) credit FROM voucher_lines l JOIN vouchers v ON v.id=l.voucher_id WHERE v.client_id=? AND v.status='active' AND v.period BETWEEN ? AND ? GROUP BY l.account_code",(cid,end[:4]+'-01',end))}
    hierarchy={}
    for a in accounts:
        code=a['code']; parents=[p['code'] for p in accounts if len(p['code'])<len(code) and code.startswith(p['code'])]
        parent=max(parents,key=len) if parents else None
        hierarchy[code]={'parent_code':parent,'level':len(parents)+1,
                         'is_leaf':not any(p['code']!=code and p['code'].startswith(code) for p in accounts)}
    rows=[]
    for a in accounts:
        code=a['code']; begin=opening.get(code,0)+before.get(code,0); d,c=current.get(code,(0,0)); finish=begin+d-c; yd,yc=ytd.get(code,(0,0))
        rows.append({'account_code':code,'account_name':a['name'],'category':a['category'],'direction':a['direction'],'report_key':a['report_key'],
                     'opening_debit_fen':max(begin,0),'opening_credit_fen':max(-begin,0),'debit_fen':d,'credit_fen':c,
                     'closing_debit_fen':max(finish,0),'closing_credit_fen':max(-finish,0),
                     'ytd_debit_fen':yd,'ytd_credit_fen':yc,**hierarchy[code]})
    return rows


def _trial_rollup(trial):
    """Display hierarchy including every descendant exactly once per ancestor."""
    rows=[]
    for row in trial:
        children=[r for r in trial if r['account_code'].startswith(row['account_code'])]
        begin=sum(r['opening_debit_fen']-r['opening_credit_fen'] for r in children)
        end=sum(r['closing_debit_fen']-r['closing_credit_fen'] for r in children)
        item=dict(row,opening_debit_fen=max(begin,0),opening_credit_fen=max(-begin,0),
                  closing_debit_fen=max(end,0),closing_credit_fen=max(-end,0))
        for key in ('debit_fen','credit_fen','ytd_debit_fen','ytd_credit_fen'):
            item[key]=sum(r[key] for r in children)
        rows.append(item)
    return rows


def _ledger(conn,cid,start,end,trial):
    balances={x['account_code']:x['opening_debit_fen']-x['opening_credit_fen'] for x in trial}
    result=[]
    for row in conn.execute("SELECT l.*,l.summary line_summary,a.name account_name,v.date,v.number,v.summary voucher_summary FROM voucher_lines l JOIN vouchers v ON v.id=l.voucher_id JOIN accounts a ON a.client_id=l.client_id AND a.code=l.account_code WHERE v.client_id=? AND v.period BETWEEN ? AND ? AND v.status='active' ORDER BY v.date,v.number,l.id",(cid,start,end)):
        x=dict(row); x['summary']=x['line_summary'] or x['voucher_summary']
        balances[x['account_code']]+=x['debit_fen']-x['credit_fen']; x['balance_fen']=balances[x['account_code']]; result.append(x)
    return result


def balance_bundle(conn,cid,start,end):
    client=_client(conn,cid); start=_period(start); end=_period(end)
    if end<start: raise ApiError(400,'结束期间不能早于开始期间')
    if start<client['start_period']: raise ApiError(400,'查询期间不能早于建账月份')
    trial=_trial_range(conn,cid,start,end)
    classified=[]
    for row in conn.execute("""SELECT r.id,r.batch_metadata_json,r.transaction_json FROM reconciliation_records r
        WHERE r.client_id=? AND r.status IN ('matched','reviewed') AND NOT EXISTS
        (SELECT 1 FROM vouchers v WHERE v.client_id=r.client_id AND v.source_type='reconciliation'
         AND v.source_id=CAST(r.id AS TEXT) AND v.status='active')""",(cid,)):
        try:
            entry=json.loads(row['batch_metadata_json'] or '{}').get('expense_classification')
            if (not isinstance(entry,dict) or entry.get('direction')!='expense' or
                not isinstance(entry.get('date'),str) or not start<=entry['date'][:7]<=end or
                not isinstance(entry.get('account_code'),str) or not entry['account_code'] or
                type(entry.get('amount_fen')) is not int or entry['amount_fen']<=0): continue
            # The saved transaction is the source of the other party's name.  Old
            # records may have missing or invalid transaction data; keep their
            # classification visible without guessing from the account or invoice.
            try:
                transaction=json.loads(row['transaction_json'] or '{}')
                counterparty=transaction.get('counterparty') if isinstance(transaction,dict) else ''
                counterparty=counterparty.strip() if isinstance(counterparty,str) else ''
            except (ValueError,TypeError):
                counterparty=''
            classified.append({**entry,'record_id':row['id'],'status':'expense_classified','counterparty':counterparty})
        except (ValueError,TypeError,AttributeError): continue
    classified.sort(key=lambda x:(x['date'],x['record_id']))
    keys=('opening_debit_fen','opening_credit_fen','debit_fen','credit_fen','closing_debit_fen','closing_credit_fen','ytd_debit_fen','ytd_credit_fen')
    return {'start_period':start,'end_period':end,'trial_balance':trial,'trial_balance_rollup':_trial_rollup(trial),'expense_classifications':classified,
            'ledger':_ledger(conn,cid,start,end,trial),'totals':{key:sum(r[key] for r in trial) for key in keys}}


def _dashboard(conn,cid,period,trial):
    vouchers=conn.execute("SELECT COUNT(*) count,COALESCE(SUM(attachment_count),0) attachment_count FROM vouchers WHERE client_id=? AND period=? AND status='active'",(cid,period)).fetchone()
    invoices={kind:{'count':0,'total_fen':0,'tax_fen':0} for kind in ('input','output','expense')}
    for row in conn.execute('SELECT kind,COUNT(*) count,SUM(total_fen) total_fen,SUM(tax_fen) tax_fen FROM invoices WHERE client_id=? AND period=? GROUP BY kind',(cid,period)):
        if row['kind'] in invoices: invoices[row['kind']]={key:row[key] for key in ('count','total_fen','tax_fen')}
    def net(prefix,credit=False):
        result=sum(r['closing_debit_fen']-r['closing_credit_fen'] for r in trial if r['account_code'].startswith(prefix))
        return -result if credit else result
    funds={'bank_fen':net('1002'),'cash_fen':net('1001'),'receivable_fen':net('1122'),'payable_fen':net('2202',True)}
    for prefix,key in (('1122','receivable_account_count'),('2202','payable_account_count')):
        funds[key]=sum(1 for r in trial if r['account_code'].startswith(prefix) and len(r['account_code'])>len(prefix) and r['is_leaf'] and (r['closing_debit_fen'] or r['closing_credit_fen']))
    return {'voucher_count':vouchers['count'],'attachment_count':vouchers['attachment_count'],'invoices':invoices,
            'funds':funds,'tax_payable_fen':net('2221',True)}


def _reports(conn,cid,period,trial):
    bs={}; income=expense=unclosed=0
    for row in trial:
        net=row['closing_debit_fen']-row['closing_credit_fen']; category=row['category']; key=row['report_key']
        if category in ('income','expense'):
            unclosed-=net
        else:
            val=net if category in ('asset','cost') else -net
            bs[key]=bs.get(key,0)+val
    assets=sum(r['closing_debit_fen']-r['closing_credit_fen'] for r in trial if r['category'] in ('asset','cost'))
    liabilities=sum(r['closing_credit_fen']-r['closing_debit_fen'] for r in trial if r['category']=='liability')
    equity=sum(r['closing_credit_fen']-r['closing_debit_fen'] for r in trial if r['category']=='equity')+unclosed
    pl={}; ytd={}
    for row in conn.execute("SELECT a.category,a.report_key,SUM(l.debit_fen-l.credit_fen) net FROM voucher_lines l JOIN vouchers v ON v.id=l.voucher_id JOIN accounts a ON a.client_id=l.client_id AND a.code=l.account_code WHERE v.client_id=? AND v.status='active' AND v.source_type<>'closing' AND v.period=? AND a.category IN ('income','expense') GROUP BY a.category,a.report_key",(cid,period)):
        val=-row['net'] if row['category']=='income' else row['net']; pl[row['report_key']]=pl.get(row['report_key'],0)+val
        if row['category']=='income': income+=val
        else: expense+=val
    yi=ye=0
    for row in conn.execute("SELECT a.category,a.report_key,SUM(l.debit_fen-l.credit_fen) net FROM voucher_lines l JOIN vouchers v ON v.id=l.voucher_id JOIN accounts a ON a.client_id=l.client_id AND a.code=l.account_code WHERE v.client_id=? AND v.status='active' AND v.source_type<>'closing' AND v.period BETWEEN ? AND ? AND a.category IN ('income','expense') GROUP BY a.category,a.report_key",(cid,period[:4]+'-01',period)):
        val=-row['net'] if row['category']=='income' else row['net']; ytd[row['report_key']]=ytd.get(row['report_key'],0)+val
        if row['category']=='income': yi+=val
        else: ye+=val
    cash={c:{'key':c,'name':{'operating':'经营活动','investing':'投资活动','financing':'筹资活动','transfer':'内部转账','unclassified':'未分类'}[c],
             'inflow_fen':0,'outflow_fen':0,'net_fen':0} for c in CASH_CATEGORIES}
    unclassified=0
    for row in conn.execute("SELECT l.debit_fen,l.credit_fen,l.cashflow_category FROM voucher_lines l JOIN vouchers v ON v.id=l.voucher_id JOIN accounts a ON a.client_id=l.client_id AND a.code=l.account_code WHERE v.client_id=? AND v.status='active' AND v.period=? AND a.report_key='cash'",(cid,period)):
        cat=row['cashflow_category']; x=cash[cat]; x['inflow_fen']+=row['debit_fen']; x['outflow_fen']+=row['credit_fen']; x['net_fen']+=row['debit_fen']-row['credit_fen']
        if cat=='unclassified': unclassified+=1
    bsrows=[{'key':k,'name':REPORT_KEYS.get(k,k),'amount_fen':v} for k,v in bs.items()]
    if unclosed: bsrows.append({'key':'unclosed_profit','name':'未结转损益','amount_fen':unclosed})
    plkeys=list(dict.fromkeys(list(pl)+list(ytd)))
    plrows=[{'key':k,'name':REPORT_KEYS.get(k,k),'amount_fen':pl.get(k,0),'ytd_fen':ytd.get(k,0)} for k in plkeys]
    return {'balance_sheet':{'rows':bsrows,'assets_fen':assets,'liabilities_fen':liabilities,'equity_fen':equity,'unclosed_profit_fen':unclosed,'balanced':assets==liabilities+equity,
                'basis':'科目余额管理报表；往来重分类、减值/递延税等调整须由会计录入并复核，不替代法定列报。'},
            'profit_loss':{'rows':plrows,'income_fen':income,'expense_fen':expense,'profit_fen':income-expense,'ytd_profit_fen':yi-ye},
            'cash_flow':{'rows':list(cash.values()),'net_fen':sum(x['net_fen'] for x in cash.values()),'unclassified_count':unclassified,'complete':unclassified==0,
                'basis':'人工逐笔分类的货币资金收支汇总，内部转账净额必须为零；未分类时不能作为完整现金流量表。'}}


def _asset_rows(conn,cid,period):
    rows=[dict(x) for x in conn.execute('''SELECT a.*,COALESCE(d.total,0) accumulated_fen,a.cost_fen-COALESCE(d.total,0) net_fen FROM assets a
        LEFT JOIN (SELECT ad.asset_id,SUM(ad.amount_fen) total FROM asset_depreciations ad JOIN vouchers v ON v.id=ad.voucher_id WHERE ad.period<=? AND v.status='active' GROUP BY ad.asset_id) d ON d.asset_id=a.id WHERE a.client_id=? AND substr(a.purchase_date,1,7)<=? ORDER BY a.id''',(period,cid,period))]
    for row in rows:
        row['depreciations']=[dict(x) for x in conn.execute('SELECT id,period,amount_fen,voucher_id FROM asset_depreciations WHERE asset_id=? AND period<=? ORDER BY period',(row['id'],period))]
        if row['status']=='cancelled':
            row['net_fen']=0
            continue
        disposed=bool(row['disposal_date'] and row['disposal_date'][:7]<=period)
        row['status']='disposed' if disposed else 'active'
        if disposed: row['net_fen']=0
    return rows


def _checks(conn,cid,period,trial=None,reports=None):
    trial=trial if trial is not None else _trial(conn,cid,period)
    reports=reports if reports is not None else _reports(conn,cid,period,trial)
    checks=[]
    if sum(x['closing_debit_fen']-x['closing_credit_fen'] for x in trial):
        checks.append({'code':'trial','severity':'error','message':'科目余额试算不平，不能结账'})
    unreviewed=conn.execute("SELECT COUNT(*) FROM vouchers WHERE client_id=? AND period=? AND status='active' AND reviewed=0",(cid,period)).fetchone()[0]
    if unreviewed: checks.append({'code':'review','severity':'error','message':f'{unreviewed}张凭证未审核，须先审核后结账'})
    pending=conn.execute('SELECT COUNT(*) FROM journals WHERE client_id=? AND period=? AND voucher_id IS NULL',(cid,period)).fetchone()[0]
    if pending: checks.append({'code':'journal','severity':'warning','message':f'{pending}条银行日记账尚未生成凭证'})
    missing=conn.execute('SELECT COUNT(*) FROM payroll WHERE client_id=? AND period=? AND voucher_id IS NULL',(cid,period)).fetchone()[0]
    if missing: checks.append({'code':'payroll','severity':'error','message':f'{missing}条工资尚未计提'})
    cf=reports['cash_flow']['unclassified_count']
    if cf: checks.append({'code':'cashflow','severity':'warning','message':f'{cf}条货币资金分录未分类，现金流报告不完整'})
    due=[]
    for a in _asset_rows(conn,cid,period):
        if a['status']=='active' and a['start_period']<=period and (not a['disposal_date'] or a['disposal_date'][:7]>=period) and a['net_fen']>a['residual_fen']:
            if not conn.execute('SELECT 1 FROM asset_depreciations WHERE asset_id=? AND period=?',(a['id'],period)).fetchone(): due.append(a['name'])
    if due: checks.append({'code':'depreciation','severity':'error','message':f'{len(due)}项资产本月尚未计提折旧'})
    # Reconcile supported inventory subledger with its aggregate GL controls.
    controls={r['inventory_account'] for r in conn.execute('SELECT inventory_account FROM inventory_items WHERE client_id=?',(cid,))}
    for code in controls:
        value=conn.execute("SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount_fen ELSE -amount_fen END),0) FROM inventory_movements m JOIN inventory_items i ON i.id=m.item_id WHERE i.client_id=? AND i.inventory_account=? AND m.status='active' AND substr(m.date,1,7)<=?",(cid,code,period)).fetchone()[0]
        gl=sum(x['closing_debit_fen']-x['closing_credit_fen'] for x in trial if x['account_code']==code)
        if gl!=value: checks.append({'code':'inventory','severity':'error','message':f'存货科目{code}总账与数量台账相差{gl-value}分，须核对后结账'})
    asset_cards=_asset_rows(conn,cid,period)
    asset_controls={a[k] for a in asset_cards for k in ('asset_account','depreciation_account')}
    for code in asset_controls:
        expected=sum((a['cost_fen'] if a['asset_account']==code else 0)-(a['accumulated_fen'] if a['depreciation_account']==code else 0) for a in asset_cards if a['status']=='active')
        gl=sum(r['closing_debit_fen']-r['closing_credit_fen'] for r in trial if r['account_code']==code)
        if gl!=expected: checks.append({'code':'asset_balance','severity':'error','message':f'资产科目{code}总账与资产卡片相差{gl-expected}分，须核对后结账'})
    if not checks: checks.append({'code':'ok','severity':'info','message':'本地账务检查通过；不代表税局或外部机构审核'})
    return checks


def bundle(conn,cid,period):
    client=_client(conn,cid); _period(period)
    if period < client['start_period']:
        raise ApiError(400,'所选期间早于建账期间')
    accounts=[dict(x) for x in conn.execute('SELECT * FROM accounts WHERE client_id=? ORDER BY code',(cid,))]
    preset_codes={row[0] for row in _template(client['standard'])}
    for account in accounts: account['is_preset']=account['code'] in preset_codes
    trial=_trial(conn,cid,period); reports=_reports(conn,cid,period,trial)
    vouchers=[_voucher(conn,cid,x['id']) for x in conn.execute('SELECT id FROM vouchers WHERE client_id=? AND period=? ORDER BY number',(cid,period))]
    ledger=_ledger(conn,cid,period,period,trial)
    periods=[]
    for m in range(1,13):
        p=period[:4]+f'-{m:02d}'
        existing=conn.execute('SELECT * FROM book_periods WHERE client_id=? AND period=?',(cid,p)).fetchone()
        item=dict(existing) if existing else {'client_id':cid,'period':p,'closed':0,'version':0,'closing_voucher_id':None}
        counts=conn.execute("SELECT COUNT(*) n,COALESCE(SUM(CASE WHEN reviewed=0 THEN 1 ELSE 0 END),0) u FROM vouchers WHERE client_id=? AND period=? AND status='active'",(cid,p)).fetchone()
        item.update(status='closed' if item['closed'] else 'open',voucher_count=counts['n'],unreviewed_count=counts['u']); periods.append(item)
    inventory=[]
    for item in conn.execute('SELECT * FROM inventory_items WHERE client_id=? ORDER BY sku',(cid,)):
        x=dict(item); q=Decimal(0); val=0
        for m in conn.execute("SELECT * FROM inventory_movements WHERE item_id=? AND status='active' AND substr(date,1,7)<=? ORDER BY date,id",(x['id'],period)):
            sign=1 if m['direction']=='in' else -1; q+=Decimal(m['quantity'])*sign; val+=m['amount_fen']*sign
        x['quantity']=format(q,'f'); x['value_fen']=val; inventory.append(x)
    settings=conn.execute('SELECT opening_version FROM book_settings WHERE client_id=?',(cid,)).fetchone()
    return {'client':client,'period':period,'accounts':accounts,'opening_balances':[dict(x) for x in conn.execute('SELECT * FROM opening_balances WHERE client_id=? ORDER BY account_code',(cid,))],
            'opening_version':settings[0] if settings else 1,'vouchers':vouchers,'trial_balance':trial,'trial_balance_rollup':_trial_rollup(trial),'ledger':ledger,'reports':reports,'dashboard':_dashboard(conn,cid,period,trial),
            'assets':_asset_rows(conn,cid,period),'inventory_items':inventory,'inventory_movements':[dict(x) for x in conn.execute('SELECT m.*,i.name item_name FROM inventory_movements m JOIN inventory_items i ON i.id=m.item_id WHERE m.client_id=? AND substr(m.date,1,7)=? ORDER BY m.date,m.id',(cid,period))],
            'payroll':[dict(x) for x in conn.execute('SELECT * FROM payroll WHERE client_id=? AND period=? ORDER BY employee_name',(cid,period))],
            'periods':periods,'checks':_checks(conn,cid,period,trial,reports),'journals':[dict(x) for x in conn.execute('SELECT * FROM journals WHERE client_id=? AND period=? ORDER BY date,id',(cid,period))]}


def _opening(conn,cid,payload,user):
    c=_client(conn,cid)
    if conn.execute('SELECT 1 FROM vouchers WHERE client_id=? LIMIT 1',(cid,)).fetchone() or conn.execute('SELECT 1 FROM book_periods WHERE client_id=? AND closed=1',(cid,)).fetchone():
        raise ApiError(409,'已发生凭证或结账，期初锁定；请用调整凭证更正')
    rows=payload.get('balances'); version=conn.execute('SELECT opening_version FROM book_settings WHERE client_id=?',(cid,)).fetchone()[0]
    if type(payload.get('version')) is not int or payload['version']!=version:
        raise ApiError(409,'期初版本已变化，请刷新',{'current_version':version})
    if not isinstance(rows,list) or len(rows)>5000: raise ApiError(400,'期初余额格式错误')
    vals=[]; codes=set()
    for x in rows:
        a=_account(conn,cid,x.get('account_code'))
        if a['code'] in codes: raise ApiError(400,'期初科目不能重复')
        codes.add(a['code']); d=amount(x.get('debit_fen',0)); cr=amount(x.get('credit_fen',0))
        if d and cr: raise ApiError(400,'科目期初不能同时有借方与贷方余额')
        if a['category'] in ('income','expense') and (d or cr):
            raise ApiError(400,'本系统无历史迁移：损益科目期初须为零，请先完成上期结转')
        if conn.execute('SELECT 1 FROM accounts WHERE client_id=? AND code LIKE ? AND code<>?',(cid,a['code']+'%',a['code'])).fetchone() and (d or cr):
            raise ApiError(400,'期初余额须填写末级科目')
        vals.append((cid,a['code'],d,cr))
    if sum(x[2] for x in vals)!=sum(x[3] for x in vals): raise ApiError(400,'期初试算不平，未保存')
    conn.execute('DELETE FROM opening_balances WHERE client_id=?',(cid,)); conn.executemany('INSERT INTO opening_balances(client_id,account_code,debit_fen,credit_fen) VALUES(?,?,?,?)',vals)
    conn.execute('UPDATE book_settings SET opening_version=opening_version+1 WHERE client_id=?',(cid,))
    audit(conn,user,'opening','book',cid,{'balances':rows,'previous_version':version})
    return {'balanced':True,'version':version+1}


def _close(conn,cid,payload,user):
    p=_period(payload.get('period')); c=_open(conn,cid,p)
    if payload.get('version') is not None:
        current=conn.execute('SELECT version FROM book_periods WHERE client_id=? AND period=?',(cid,p)).fetchone()
        _version({'version':current[0] if current else 0},payload)
    if p>c['start_period']:
        prev=conn.execute('SELECT closed FROM book_periods WHERE client_id=? AND period=?',(cid,_month_add(p,-1))).fetchone()
        if not prev or not prev[0]: raise ApiError(409,'请按建账月份起顺序结账')
    checks=_checks(conn,cid,p)
    errors=[x for x in checks if x['severity']=='error']
    if errors: raise ApiError(409,'结账检查未通过',errors)
    trial=_trial(conn,cid,p); lines=[]
    for row in trial:
        if row['category'] in ('income','expense'):
            balance=row['closing_debit_fen']-row['closing_credit_fen']
            if balance>0: lines.append(_entry(row['account_code'],credit=balance))
            elif balance<0: lines.append(_entry(row['account_code'],-balance))
    vid=None
    diff=sum(x['debit_fen']-x['credit_fen'] for x in lines)
    profit='3103' if c['standard']=='small2013' else '4103'
    if lines:
        if diff>0: lines.append(_entry(profit,credit=diff))
        elif diff<0: lines.append(_entry(profit,-diff))
    if p.endswith('-12'):
        previous_profit=sum(r['closing_credit_fen']-r['closing_debit_fen'] for r in trial if r['account_code']==profit)
        annual=previous_profit+diff
        retained='3104' if c['standard']=='small2013' else '4104'
        if annual>0: lines.extend([_entry(profit,annual),_entry(retained,credit=annual)])
        elif annual<0: lines.extend([_entry(profit,credit=-annual),_entry(retained,-annual)])
    if lines:
        # An exact zero monthly result still has opposite profit/loss entries.
        vid=_insert_voucher(conn,cid,_last_date(p),'期末损益结转',lines,user,'closing',p,True)
    conn.execute('INSERT OR IGNORE INTO book_periods(client_id,period) VALUES(?,?)',(cid,p))
    conn.execute('UPDATE book_periods SET closed=1,version=version+1,closed_at=?,closed_by=?,closing_voucher_id=? WHERE client_id=? AND period=?',(now(),(user or {}).get('id'),vid,cid,p))
    audit(conn,user,'close','book',cid,{'period':p,'closing_voucher_id':vid,'checks':checks})
    return {'period':p,'closed':True,'closing_voucher_id':vid,'checks':checks}


def _reopen(conn,cid,payload,user):
    p=_period(payload.get('period')); row=conn.execute('SELECT * FROM book_periods WHERE client_id=? AND period=?',(cid,p)).fetchone()
    if not row or not row['closed']: raise ApiError(409,'该期间未结账')
    if conn.execute('SELECT 1 FROM book_periods WHERE client_id=? AND period>? AND closed=1',(cid,p)).fetchone():
        raise ApiError(409,'必须先反结账最近月份')
    if payload.get('version') is not None: _version(row,payload)
    if row['closing_voucher_id']:
        conn.execute("UPDATE vouchers SET status='void',version=version+1 WHERE id=?",(row['closing_voucher_id'],))
        audit(conn,user,'void_on_reopen','voucher',row['closing_voucher_id'],{'period':p})
    conn.execute('UPDATE book_periods SET closed=0,version=version+1,closed_at=NULL,closed_by=NULL,closing_voucher_id=NULL WHERE client_id=? AND period=?',(cid,p))
    audit(conn,user,'reopen','book',cid,{'period':p})
    return {'period':p,'closed':False}


def _asset_create(conn,cid,payload,user):
    name=_text(payload.get('name'),'资产名称'); date=_date(payload.get('purchase_date')); _open(conn,cid,date[:7])
    start=_period(payload.get('start_period'))
    # Fixed assets in this scoped implementation start depreciation next month.
    if start!=_month_add(date[:7],1): raise ApiError(400,'直线法资产从购置次月计提，请将起提月份设为购置次月')
    cost=_positive(payload.get('cost_fen')); residual=amount(payload.get('residual_fen',0))
    if residual>=cost: raise ApiError(400,'残值须小于资产原值')
    life=payload.get('life_months')
    if type(life) is not int or not 1<=life<=1200: raise ApiError(400,'使用月数须为1至1200的整数')
    expense=_account(conn,cid,payload.get('expense_account')); asset=_account(conn,cid,payload.get('asset_account','1601')); dep=_account(conn,cid,payload.get('depreciation_account','1602')); counter=_account(conn,cid,payload.get('counter_account','1002'))
    if expense['category'] not in ('expense','cost'): raise ApiError(400,'折旧借方须选费用或成本科目')
    if asset['category']!='asset' or dep['category']!='asset' or asset['direction']!='debit' or dep['direction']!='credit': raise ApiError(400,'资产与累计折旧科目属性不匹配')
    cur=conn.execute('INSERT INTO assets(client_id,name,purchase_date,start_period,cost_fen,residual_fen,life_months,expense_account,asset_account,depreciation_account) VALUES(?,?,?,?,?,?,?,?,?,?)',(cid,name,date,start,cost,residual,life,expense['code'],asset['code'],dep['code']))
    aid=cur.lastrowid
    vid=_insert_voucher(conn,cid,date,'购入固定资产 '+name,[_entry(asset['code'],cost),_entry(counter['code'],credit=cost,category='investing')],user,'asset_purchase',aid)
    conn.execute('UPDATE assets SET purchase_voucher_id=? WHERE id=?',(vid,aid)); audit(conn,user,'create','asset',aid,payload)
    return {'id':aid,'voucher_id':vid}


def _depreciate(conn,cid,payload,user):
    p=_period(payload.get('period')); _open(conn,cid,p); results=[]
    for a in conn.execute("SELECT * FROM assets WHERE client_id=? AND status<>'cancelled' AND start_period<=? AND (disposal_date IS NULL OR substr(disposal_date,1,7)>=?) ORDER BY id",(cid,p,p)).fetchall():
        a=dict(a)
        exists=conn.execute('SELECT voucher_id,amount_fen FROM asset_depreciations WHERE asset_id=? AND period=?',(a['id'],p)).fetchone()
        if exists:
            results.append({'asset_id':a['id'],'voucher_id':exists['voucher_id'],'amount_fen':exists['amount_fen'],'already_posted':True}); continue
        elapsed=(int(p[:4])-int(a['start_period'][:4]))*12+int(p[5:])-int(a['start_period'][5:])
        previous=conn.execute('SELECT COUNT(*) n,COALESCE(SUM(amount_fen),0) total FROM asset_depreciations WHERE asset_id=? AND period<?',(a['id'],p)).fetchone()
        base=a['cost_fen']-a['residual_fen']; remaining=base-previous['total']
        if remaining<=0: continue
        if previous['n']<min(elapsed,a['life_months']): raise ApiError(409,f'{a["name"]}存在未计提的以前月份，请按月计提')
        if elapsed>=a['life_months']: continue
        monthly=int((Decimal(base)/Decimal(a['life_months'])).quantize(Decimal('1'),rounding=ROUND_HALF_UP))
        val=remaining if elapsed==a['life_months']-1 else min(monthly,remaining)
        if val<=0:
            # A sub-fen monthly allocation still needs a period record so that
            # a tiny asset can reach its final-month cent without a false gap.
            conn.execute('INSERT INTO asset_depreciations(asset_id,period,amount_fen,voucher_id) VALUES(?,?,0,NULL)',(a['id'],p))
            conn.execute('UPDATE assets SET version=version+1 WHERE id=?',(a['id'],))
            audit(conn,user,'zero_depreciation','asset',a['id'],{'period':p,'amount_fen':0})
            results.append({'asset_id':a['id'],'voucher_id':None,'amount_fen':0,'already_posted':False})
            continue
        vid=_insert_voucher(conn,cid,_last_date(p),'计提折旧 '+a['name'],[_entry(a['expense_account'],val),_entry(a['depreciation_account'],credit=val)],user,'depreciation',f'{a["id"]}:{p}')
        conn.execute('INSERT INTO asset_depreciations(asset_id,period,amount_fen,voucher_id) VALUES(?,?,?,?)',(a['id'],p,val,vid))
        conn.execute('UPDATE assets SET version=version+1 WHERE id=?',(a['id'],)); audit(conn,user,'depreciate','asset',a['id'],{'period':p,'amount_fen':val,'voucher_id':vid})
        results.append({'asset_id':a['id'],'voucher_id':vid,'amount_fen':val,'already_posted':False})
    return {'period':p,'results':results}


def _dispose(conn,cid,aid,payload,user):
    a=conn.execute('SELECT * FROM assets WHERE client_id=? AND id=?',(cid,aid)).fetchone()
    if not a: raise ApiError(404,'资产不存在')
    _version(a,payload)
    if a['status']!='active': raise ApiError(409,'资产已处置')
    date=_date(payload.get('date')); _open(conn,cid,date[:7])
    if date<a['purchase_date']: raise ApiError(400,'处置日期不能早于购置日期')
    if conn.execute('SELECT 1 FROM asset_depreciations WHERE asset_id=? AND period>?',(aid,date[:7])).fetchone(): raise ApiError(409,'已计提后续月份折旧，不能追溯处置')
    total=conn.execute('SELECT COALESCE(SUM(amount_fen),0) FROM asset_depreciations WHERE asset_id=?',(aid,)).fetchone()[0]
    if date[:7]>=a['start_period'] and total<a['cost_fen']-a['residual_fen'] and not conn.execute('SELECT 1 FROM asset_depreciations WHERE asset_id=? AND period=?',(aid,date[:7])).fetchone():
        raise ApiError(409,'须先计提处置月份折旧')
    proceeds=amount(payload.get('proceeds_fen',0)); bank=_account(conn,cid,payload.get('bank_account','1002'))
    if not _cash(bank): raise ApiError(400,'处置收款请选择货币资金科目')
    c=_client(conn,cid); gain='5301' if c['standard']=='small2013' else '6301'; loss='5711' if c['standard']=='small2013' else '6711'
    lines=[_entry(a['asset_account'],credit=a['cost_fen'])]
    if total: lines.append(_entry(a['depreciation_account'],total))
    if proceeds: lines.append(_entry(bank['code'],proceeds,category='investing'))
    difference=proceeds-(a['cost_fen']-total)
    if difference>0: lines.append(_entry(gain,credit=difference))
    elif difference<0: lines.append(_entry(loss,-difference))
    vid=_insert_voucher(conn,cid,date,'处置固定资产 '+a['name'],lines,user,'asset_disposal',aid)
    conn.execute("UPDATE assets SET status='disposed',disposal_date=?,disposal_voucher_id=?,version=version+1 WHERE id=?",(date,vid,aid))
    audit(conn,user,'dispose','asset',aid,{'date':date,'proceeds_fen':proceeds,'accumulated_fen':total,'voucher_id':vid})
    return {'id':aid,'voucher_id':vid}


def _item_create(conn,cid,payload,user):
    sku=_text(payload.get('sku'),'商品编码',50); name=_text(payload.get('name'),'商品名称'); unit=_text(payload.get('unit'),'计量单位',20)
    c=_client(conn,cid); inv=_account(conn,cid,payload.get('inventory_account','1405')); cost=_account(conn,cid,payload.get('cost_account','5401' if c['standard']=='small2013' else '6401'))
    if inv['category']!='asset' or inv['report_key']!='inventory': raise ApiError(400,'存货控制科目须为资产类存货科目')
    if cost['category']!='expense': raise ApiError(400,'出库成本须为损益费用科目')
    cur=conn.execute('INSERT INTO inventory_items(client_id,sku,name,unit,inventory_account,cost_account) VALUES(?,?,?,?,?,?)',(cid,sku,name,unit,inv['code'],cost['code']))
    audit(conn,user,'create','inventory_item',cur.lastrowid,payload)
    return dict(conn.execute('SELECT * FROM inventory_items WHERE id=?',(cur.lastrowid,)).fetchone())


def _create_account(conn,cid,payload,user):
    name=_text(payload.get('name'),'科目名称',80)
    parent_code=payload.get('parent_code')
    if parent_code is not None:
        parent_code=_text(parent_code,'上级科目编码',20)
        parent=_account(conn,cid,parent_code)
        if len(parent_code)>18: raise ApiError(400,'上级科目编码过长，无法再增加两位下级编码')
        # Reserve an occupied branch even when older, manually entered
        # codes have an intermediate level missing or only one digit.
        suffixes=[]
        for row in conn.execute('SELECT code FROM accounts WHERE client_id=? AND code LIKE ? AND code<>?',(cid,parent_code+'%',parent_code)):
            suffix=row['code'][len(parent_code):]
            if suffix.isdigit(): suffixes.append(int(suffix[:2].ljust(2,'9')))
        sequence=max(suffixes,default=0)+1
        if sequence>99: raise ApiError(409,'该上级科目的两位下级编码已用完')
        code=parent_code+f'{sequence:02d}'
        direction=parent['direction']; category=parent['category']; key=parent['report_key']
    else:
        code=_text(payload.get('code'),'科目编码',20)
        direction=payload.get('direction'); category=payload.get('category'); key=payload.get('report_key')
    if not re.fullmatch(r'\d{4,20}',code): raise ApiError(400,'科目编码必须为4至20位数字')
    if direction not in ('debit','credit') or category not in CATEGORIES: raise ApiError(400,'科目方向或类别无效')
    parents=[dict(x) for x in conn.execute('SELECT * FROM accounts WHERE client_id=? AND length(code)<length(?) AND ? LIKE code||\'%\' ORDER BY length(code) DESC',(cid,code,code))]
    if len(code)>4:
        if not parents: raise ApiError(400,'新增明细科目须先建立上级科目')
        parent=parents[0]
        if category!=parent['category'] or direction!=parent['direction']: raise ApiError(400,'明细科目类别及方向须与上级一致')
        if conn.execute('SELECT 1 FROM voucher_lines WHERE client_id=? AND account_code=?',(cid,parent['code'])).fetchone() or conn.execute('SELECT 1 FROM opening_balances WHERE client_id=? AND account_code=? AND (debit_fen<>0 OR credit_fen<>0)',(cid,parent['code'])).fetchone():
            raise ApiError(409,'上级科目已使用，不能直接转为非末级科目')
        key=parent['report_key']
    if not key: key={'asset':'other_asset','liability':'other_liability','equity':'retained','income':'other_income','expense':'other_expense','cost':'inventory'}[category]
    valid_keys={
        'asset':{'cash','short_investment','receivable','prepaid','inventory','long_investment','fixed_asset','construction','intangible','other_asset'},
        'cost':{'inventory','construction','other_asset'},'liability':{'short_debt','payable','advance','payroll_payable','tax_payable','other_liability','long_debt'},
        'equity':{'capital','retained','current_profit'},'income':{'revenue','investment_income','other_income'},
        'expense':{'business_cost','taxes','selling','administration','finance','other_expense','income_tax'}}
    if key not in valid_keys[category]: raise ApiError(400,'报表分类与科目类别不符')
    cur=conn.execute('INSERT INTO accounts(client_id,code,name,direction,category,report_key) VALUES(?,?,?,?,?,?)',(cid,code,name,direction,category,key)); audit(conn,user,'create','account',cur.lastrowid,{**payload,'code':code})
    return dict(conn.execute('SELECT * FROM accounts WHERE id=?',(cur.lastrowid,)).fetchone())


def _delete_account(conn,cid,aid,payload,user):
    row=conn.execute('SELECT * FROM accounts WHERE id=? AND client_id=?',(aid,cid)).fetchone()
    if not row: raise ApiError(404,'科目不存在')
    _version(row,payload)
    if row['code'] in {a[0] for a in _template(_client(conn,cid)['standard'])}:
        raise ApiError(409,'会计制度预置科目保留；仅未使用的自定义末级科目可以删除')
    if conn.execute('SELECT 1 FROM accounts WHERE client_id=? AND code LIKE ? AND code<>?',(cid,row['code']+'%',row['code'])).fetchone():
        raise ApiError(409,'该科目存在下级科目，请先处理下级科目')
    if conn.execute('SELECT 1 FROM voucher_lines WHERE client_id=? AND account_code=?',(cid,row['code'])).fetchone():
        raise ApiError(409,'该科目已有凭证引用（包括作废凭证），需保留历史，不能删除')
    if conn.execute('SELECT 1 FROM opening_balances WHERE client_id=? AND account_code=? AND (debit_fen<>0 OR credit_fen<>0)',(cid,row['code'])).fetchone():
        raise ApiError(409,'该科目有期初余额，不能删除；新账套可先在期初设置中更正')
    references=[
        ('assets','asset_account=? OR depreciation_account=? OR expense_account=?',3,'资产卡片'),
        ('inventory_items','inventory_account=? OR cost_account=?',2,'库存商品'),
        ('payroll','expense_account=?',1,'工资记录'),
        ('journals','bank_account=? OR counter_account=?',2,'资金流水'),
    ]
    for table,condition,n,label in references:
        if conn.execute(f'SELECT 1 FROM {table} WHERE client_id=? AND ({condition}) LIMIT 1',[cid]+[row['code']]*n).fetchone():
            raise ApiError(409,f'该科目被{label}使用，请先处理来源记录')
    conn.execute('DELETE FROM opening_balances WHERE client_id=? AND account_code=?',(cid,row['code']))
    conn.execute('DELETE FROM accounts WHERE id=? AND client_id=?',(aid,cid))
    audit(conn,user,'delete','account',aid,{'before':dict(row),'reason':payload.get('reason','')})
    return {'id':aid,'deleted':True}


def _delete_item(conn,cid,iid,payload,user):
    row=conn.execute('SELECT * FROM inventory_items WHERE id=? AND client_id=?',(iid,cid)).fetchone()
    if not row: raise ApiError(404,'库存商品不存在')
    _version(row,payload)
    if Decimal(row['quantity'])!=0 or row['value_fen']!=0:
        raise ApiError(409,'该商品仍有结存数量或金额，不能删除')
    if conn.execute('SELECT 1 FROM inventory_movements WHERE item_id=?',(iid,)).fetchone():
        raise ApiError(409,'该商品存在库存历史流水（包括撤回记录），须保留追溯，不能物理删除')
    conn.execute('DELETE FROM inventory_items WHERE id=? AND client_id=?',(iid,cid))
    audit(conn,user,'delete','inventory_item',iid,{'before':dict(row),'reason':payload.get('reason','')})
    return {'id':iid,'deleted':True}


def _delete_asset(conn,cid,aid,payload,user):
    row=conn.execute('SELECT * FROM assets WHERE id=? AND client_id=?',(aid,cid)).fetchone()
    if not row: raise ApiError(404,'资产不存在')
    _version(row,payload)
    if row['status']=='cancelled': raise ApiError(409,'购置已撤回，资产卡片与审计保留，无需重复删除')
    if row['status']!='active' or row['disposal_voucher_id']:
        raise ApiError(409,'资产已有处置，请先撤回处置及最近折旧，再撤回购置')
    if conn.execute('SELECT 1 FROM asset_depreciations WHERE asset_id=?',(aid,)).fetchone():
        raise ApiError(409,'资产已有折旧，请从最近月份起撤回折旧，再撤回购置')
    if not row['purchase_voucher_id']: raise ApiError(409,'资产购置凭证缺失，不能直接删除')
    voucher=_voucher(conn,cid,row['purchase_voucher_id'])
    result=withdraw_source(conn,cid,voucher['id'],user,payload.get('reason'),voucher['version'])
    return {'id':aid,'deleted':False,'withdrawn':True,'status':'cancelled','voucher_id':result['id']}


def _movement(conn,cid,payload,user):
    row=conn.execute('SELECT * FROM inventory_items WHERE client_id=? AND id=?',(cid,payload.get('item_id'))).fetchone()
    if not row: raise ApiError(404,'商品不存在')
    _version(row,payload); date=_date(payload.get('date')); _open(conn,cid,date[:7]); qty=_quantity(payload.get('quantity'))
    if conn.execute("SELECT 1 FROM inventory_movements WHERE item_id=? AND status='active' AND date>?",(row['id'],date)).fetchone(): raise ApiError(409,'移动平均法禁止插入早于已有流水的日期')
    oldqty=Decimal(row['quantity']); oldval=row['value_fen']; direction=payload.get('direction')
    if direction=='in':
        val=_positive(payload.get('amount_fen')); counter=_account(conn,cid,payload.get('counter_account','2202'))
        if counter['code']==row['inventory_account']: raise ApiError(400,'入库对方科目不能为同一存货控制科目')
        lines=[_entry(row['inventory_account'],val),_entry(counter['code'],credit=val,category=payload.get('cashflow_category','unclassified'))]
        newqty=oldqty+qty; newval=oldval+val
    elif direction=='out':
        if qty>oldqty: raise ApiError(409,'库存数量不足，不允许负库存')
        if oldqty<=0: raise ApiError(409,'没有可用库存')
        val=oldval if qty==oldqty else int((Decimal(oldval)*qty/oldqty).quantize(Decimal('1'),rounding=ROUND_HALF_UP))
        if val<=0: raise ApiError(400,'本次出库成本不足一分，请合并数量后出库')
        lines=[_entry(row['cost_account'],val),_entry(row['inventory_account'],credit=val)]; newqty=oldqty-qty; newval=oldval-val
    else: raise ApiError(400,'出入库方向无效')
    amount(newval)
    if newqty>Decimal('999999999999999.999999'):
        raise ApiError(400,'累计库存数量超出15位整数及6位小数的限额')
    cur=conn.execute('INSERT INTO inventory_movements(client_id,item_id,date,direction,quantity,amount_fen,created_at) VALUES(?,?,?,?,?,?,?)',(cid,row['id'],date,direction,format(qty,'f'),val,now())); mid=cur.lastrowid
    vid=_insert_voucher(conn,cid,date,('采购入库 ' if direction=='in' else '销售出库结转成本 ')+row['name'],lines,user,'inventory',mid)
    conn.execute('UPDATE inventory_movements SET voucher_id=? WHERE id=?',(vid,mid)); conn.execute('UPDATE inventory_items SET quantity=?,value_fen=?,version=version+1 WHERE id=?',(format(newqty,'f'),newval,row['id']))
    audit(conn,user,'movement','inventory_item',row['id'],{'direction':direction,'quantity':str(qty),'amount_fen':val,'voucher_id':vid})
    return {'id':mid,'voucher_id':vid,'amount_fen':val,'quantity':format(newqty,'f'),'value_fen':newval,'version':row['version']+1}


def _payroll_create(conn,cid,payload,user):
    p=_period(payload.get('period')); _open(conn,cid,p); name=_text(payload.get('employee_name'),'员工姓名',80)
    gross=_positive(payload.get('gross_fen')); tax=amount(payload.get('withheld_tax_fen',0)); social=amount(payload.get('social_fen',0)); other=amount(payload.get('other_deduction_fen',0))
    if tax+social+other>gross: raise ApiError(400,'工资扣款合计不能超过应发工资')
    a=_account(conn,cid,payload.get('expense_account'))
    if a['category'] not in ('expense','cost'): raise ApiError(400,'工资借方须为成本费用科目')
    cur=conn.execute('INSERT INTO payroll(client_id,period,employee_name,gross_fen,withheld_tax_fen,social_fen,other_deduction_fen,net_fen,expense_account) VALUES(?,?,?,?,?,?,?,?,?)',(cid,p,name,gross,tax,social,other,gross-tax-social-other,a['code']))
    audit(conn,user,'create','payroll',cur.lastrowid,payload)
    return dict(conn.execute('SELECT * FROM payroll WHERE id=?',(cur.lastrowid,)).fetchone())


def _payroll_post(conn,cid,payload,user):
    p=_period(payload.get('period')); _open(conn,cid,p)
    rows=conn.execute('SELECT * FROM payroll WHERE client_id=? AND period=? ORDER BY id',(cid,p)).fetchall()
    if not rows: raise ApiError(400,'本月没有工资记录')
    existing={x['voucher_id'] for x in rows if x['voucher_id']}
    if existing and any(not x['voucher_id'] for x in rows): raise ApiError(409,'本期已计提，不能追加工资；请在下一期间录入调整工资')
    if existing: return {'period':p,'voucher_id':next(iter(existing)),'already_posted':True}
    by={}
    for r in rows: by[r['expense_account']]=by.get(r['expense_account'],0)+r['gross_fen']
    total=sum(by.values()); lines=[_entry(k,v) for k,v in by.items()]; lines.append(_entry('2211',credit=total))
    vid=_insert_voucher(conn,cid,_last_date(p),'计提应付工资（个税由人工录入）',lines,user,'payroll',p)
    conn.execute('UPDATE payroll SET voucher_id=?,version=version+1 WHERE client_id=? AND period=?',(vid,cid,p)); audit(conn,user,'post','payroll',p,{'client_id':cid,'voucher_id':vid,'gross_fen':total})
    return {'period':p,'voucher_id':vid,'already_posted':False}


def _payroll_pay(conn,cid,payload,user):
    p=_period(payload.get('period')); date=_date(payload.get('date')); _open(conn,cid,date[:7])
    if date[:7]<p: raise ApiError(400,'发薪日期不能早于工资期间')
    rows=conn.execute('SELECT * FROM payroll WHERE client_id=? AND period=?',(cid,p)).fetchall()
    if not rows or any(not x['voucher_id'] for x in rows): raise ApiError(409,'须先计提工资')
    if any(x['payment_voucher_id'] for x in rows): raise ApiError(409,'该期工资已发放')
    bank=_account(conn,cid,payload.get('bank_account','1002'))
    if not _cash(bank): raise ApiError(400,'请选择货币资金账户')
    gross=sum(x['gross_fen'] for x in rows); tax=sum(x['withheld_tax_fen'] for x in rows); other=sum(x['social_fen']+x['other_deduction_fen'] for x in rows); net=sum(x['net_fen'] for x in rows)
    lines=[_entry('2211',gross)]
    if net: lines.append(_entry(bank['code'],credit=net,category='operating'))
    if tax: lines.append(_entry('2221',credit=tax))
    if other: lines.append(_entry('2241',credit=other))
    vid=_insert_voucher(conn,cid,date,'发放工资及转列人工代扣款',lines,user,'payroll_payment',p)
    conn.execute('UPDATE payroll SET payment_voucher_id=?,version=version+1 WHERE client_id=? AND period=?',(vid,cid,p)); audit(conn,user,'pay','payroll',p,{'client_id':cid,'voucher_id':vid,'net_fen':net})
    return {'period':p,'voucher_id':vid}


def _yuan(fen):
    return ('-' if fen<0 else '')+f'{abs(fen)//100}.{abs(fen)%100:02d}'


def export_rows(conn,client_id,kind,period):
    _client(conn,client_id); _period(period)
    if kind=='bank':
        headers=['日期','摘要','银行科目','对方科目','方向','金额','现金流分类','凭证号']
        rows=[[r['date'],r['summary'],r['bank_account'],r['counter_account'],r['direction'],_yuan(r['amount_fen']),r['cashflow_category'],r['voucher_id'] or ''] for r in conn.execute('SELECT * FROM journals WHERE client_id=? AND period=? ORDER BY date,id',(client_id,period))]
    elif kind=='vouchers':
        headers=['日期','凭证号','摘要','科目编码','科目名称','借方','贷方','状态','已审核','现金流分类']
        rows=[]
        for r in conn.execute('''SELECT v.date,v.number,COALESCE(NULLIF(l.summary,''),v.summary),l.account_code,a.name,l.debit_fen,l.credit_fen,v.status,v.reviewed,l.cashflow_category FROM vouchers v JOIN voucher_lines l ON l.voucher_id=v.id JOIN accounts a ON a.client_id=l.client_id AND a.code=l.account_code WHERE v.client_id=? AND v.period=? ORDER BY v.number,l.id''',(client_id,period)):
            rows.append([r[0],r[1],r[2],r[3],r[4],_yuan(r[5]),_yuan(r[6]),r[7],r[8],r[9]])
    elif kind=='trial-balance':
        headers=['科目编码','科目名称','期初借方','期初贷方','本期借方','本期贷方','期末借方','期末贷方']
        keys=['opening_debit_fen','opening_credit_fen','debit_fen','credit_fen','closing_debit_fen','closing_credit_fen']
        rows=[[r['account_code'],r['account_name']]+[_yuan(r[k]) for k in keys] for r in _trial(conn,client_id,period)]
    else: raise ApiError(400,'不支持的财务导出类型')
    return headers,rows


def handle(conn,method,path,payload,user,query):
    match=re.fullmatch(r'/api/books/(\d+)(?:/(.*))?',path)
    if not match: return None
    cid=int(match[1]); route=match[2] or ''; payload=payload or {}; query=query or {}; _client(conn,cid)
    if method=='GET' and route=='balance':
        end=_period(query.get('end',query.get('period',dt.date.today().isoformat()[:7])))
        start=_period(query.get('start',end))
        with conn:
            if not conn.in_transaction: conn.execute('BEGIN')
            return balance_bundle(conn,cid,start,end)
    if method=='GET' and not route:
        p=_period(query.get('period',dt.date.today().isoformat()[:7]))
        # One read transaction prevents a report composed from different commits.
        with conn:
            if not conn.in_transaction: conn.execute('BEGIN')
            return bundle(conn,cid,p)
    if method not in ('POST','PATCH','DELETE'): return None
    try:
        with _write(conn):
            deletion=re.fullmatch(r'(accounts|assets|inventory/items)/(\d+)',route)
            if method=='DELETE' and deletion:
                return {'accounts':_delete_account,'assets':_delete_asset,'inventory/items':_delete_item}[deletion[1]](conn,cid,int(deletion[2]),payload,user)
            if method=='POST' and route=='accounts': return _create_account(conn,cid,payload,user)
            if method=='POST' and route=='opening': return _opening(conn,cid,payload,user)
            if method=='POST' and route=='vouchers':
                if payload.get('source_type','manual')!='manual' or payload.get('source_id') is not None: raise ApiError(400,'手工凭证不得伪装为系统业务来源')
                vid=_insert_voucher(conn,cid,payload.get('date'),payload.get('summary'),payload.get('lines'),user,attachment_count=payload.get('attachment_count',0))
                return _voucher(conn,cid,vid)
            vm=re.fullmatch(r'vouchers/(\d+)(?:/(review|cashflow|withdraw))?',route)
            if vm:
                vid=int(vm[1]); row=_voucher(conn,cid,vid); _version(row,payload); _open(conn,cid,row['period'])
                if row['status']!='active': raise ApiError(409,'凭证已作废')
                if vm[2]=='withdraw' and method=='POST':
                    return withdraw_source(conn,cid,vid,user,payload.get('reason'),payload.get('version'))
                if vm[2]=='review' and method=='POST':
                    if type(payload.get('reviewed')) is not bool: raise ApiError(400,'审核状态须为布尔值')
                    reviewed=payload['reviewed']; conn.execute('UPDATE vouchers SET reviewed=?,reviewed_by=?,reviewed_at=?,version=version+1 WHERE id=?',(int(reviewed),(user or {}).get('id') if reviewed else None,now() if reviewed else None,vid)); audit(conn,user,'review','voucher',vid,{'reviewed':reviewed})
                    return _voucher(conn,cid,vid)
                if vm[2]=='cashflow' and method=='POST':
                    classifications=payload.get('classifications')
                    if not isinstance(classifications,list): raise ApiError(400,'请按分录指定分类')
                    mapping={x.get('line_id'):x.get('category') for x in classifications}
                    lines=[]
                    for line in row['lines']:
                        item=dict(line)
                        if line['id'] in mapping: item['cashflow_category']=mapping[line['id']]
                        lines.append(item)
                    _lines(conn,cid,lines)
                    validids={x['id'] for x in row['lines']}
                    if any(i not in validids for i in mapping): raise ApiError(400,'分录不属于该凭证')
                    for lid,cat in mapping.items(): conn.execute('UPDATE voucher_lines SET cashflow_category=? WHERE id=?',(cat,lid))
                    conn.execute('UPDATE vouchers SET version=version+1 WHERE id=?',(vid,)); audit(conn,user,'cashflow_classify','voucher',vid,{'classifications':classifications})
                    return _voucher(conn,cid,vid)
                if vm[2]: return None
                if row['source_type']!='manual': raise ApiError(409,'业务生成凭证不能直接修改或作废；请通过来源业务更正')
                if row['reviewed']: raise ApiError(409,'已审核凭证须先取消审核')
                if method=='PATCH':
                    date=_date(payload.get('date')); _open(conn,cid,date[:7])
                    if date[:7]!=row['period']: raise ApiError(400,'凭证不能跨月修改，请作废后另建')
                    summary=_text(payload.get('summary'),'摘要'); lines=_lines(conn,cid,payload.get('lines')); attachments=_attachment_count(payload.get('attachment_count',row['attachment_count']))
                    conn.execute('UPDATE vouchers SET date=?,summary=?,attachment_count=?,version=version+1 WHERE id=?',(date,summary,attachments,vid)); conn.execute('DELETE FROM voucher_lines WHERE voucher_id=?',(vid,)); conn.executemany('INSERT INTO voucher_lines(voucher_id,client_id,account_code,debit_fen,credit_fen,cashflow_category,summary) VALUES(?,?,?,?,?,?,?)',[(vid,cid,x['account_code'],x['debit_fen'],x['credit_fen'],x['cashflow_category'],x['summary'] or summary) for x in lines]); audit(conn,user,'update','voucher',vid,{'before':row,'after':payload})
                    return _voucher(conn,cid,vid)
                if method=='DELETE':
                    conn.execute("UPDATE vouchers SET status='void',version=version+1 WHERE id=?",(vid,)); audit(conn,user,'void','voucher',vid,{'before':row,'reason':payload.get('reason','')}); return _voucher(conn,cid,vid)
            if method=='POST' and route=='close': return _close(conn,cid,payload,user)
            if method=='POST' and route=='reopen': return _reopen(conn,cid,payload,user)
            if method=='POST' and route=='assets': return _asset_create(conn,cid,payload,user)
            if method=='POST' and route=='assets/depreciate': return _depreciate(conn,cid,payload,user)
            az=re.fullmatch(r'assets/(\d+)/depreciations/(\d{4}-\d{2})/withdraw',route)
            if method=='POST' and az:
                card=conn.execute('SELECT * FROM assets WHERE client_id=? AND id=?',(cid,int(az[1]))).fetchone()
                if not card: raise ApiError(404,'资产不存在')
                _version(card,payload); p=_period(az[2]); _open(conn,cid,p)
                record=conn.execute('SELECT * FROM asset_depreciations WHERE asset_id=? AND period=?',(card['id'],p)).fetchone()
                if not record: raise ApiError(404,'该月没有折旧记录')
                if record['voucher_id']:
                    v=_voucher(conn,cid,record['voucher_id'])
                    return withdraw_source(conn,cid,v['id'],user,payload.get('reason'),v['version'])
                if card['disposal_voucher_id'] or conn.execute('SELECT 1 FROM asset_depreciations WHERE asset_id=? AND period>?',(card['id'],p)).fetchone():
                    raise ApiError(409,'请先撤回资产后续折旧及处置')
                reason=_text(payload.get('reason'),'撤回原因',500)
                conn.execute('DELETE FROM asset_depreciations WHERE id=?',(record['id'],)); conn.execute('UPDATE assets SET version=version+1 WHERE id=?',(card['id'],))
                audit(conn,user,'withdraw_zero_depreciation','asset',card['id'],{'reason':reason,'before':dict(record)})
                return {'id':card['id'],'period':p,'withdrawn':True}
            am=re.fullmatch(r'assets/(\d+)/dispose',route)
            if method=='POST' and am: return _dispose(conn,cid,int(am[1]),payload,user)
            if method=='POST' and route=='inventory/items': return _item_create(conn,cid,payload,user)
            if method=='POST' and route=='inventory/movements': return _movement(conn,cid,payload,user)
            if method=='POST' and route=='payroll':
                p=_period(payload.get('period'))
                if conn.execute('SELECT 1 FROM payroll WHERE client_id=? AND period=? AND voucher_id IS NOT NULL',(cid,p)).fetchone(): raise ApiError(409,'本期已计提，工资记录锁定')
                return _payroll_create(conn,cid,payload,user)
            if method=='POST' and route=='payroll/post': return _payroll_post(conn,cid,payload,user)
            if method=='POST' and route=='payroll/pay': return _payroll_pay(conn,cid,payload,user)
            pm=re.fullmatch(r'payroll/(\d+)',route)
            if pm and method=='DELETE':
                row=conn.execute('SELECT * FROM payroll WHERE client_id=? AND id=?',(cid,int(pm[1]))).fetchone()
                if not row: raise ApiError(404,'工资记录不存在')
                _version(row,payload); _open(conn,cid,row['period'])
                if row['voucher_id']: raise ApiError(409,'已计提工资不能删除')
                conn.execute('DELETE FROM payroll WHERE id=?',(row['id'],)); audit(conn,user,'delete','payroll',row['id'],{'before':dict(row),'reason':payload.get('reason','')}); return {'deleted':True}
            if method=='POST' and route=='journals': return create_bank_journal(conn,cid,payload,user)
            jm=re.fullmatch(r'journals/(\d+)(?:/(post))?',route)
            if jm:
                row=conn.execute('SELECT * FROM journals WHERE client_id=? AND id=?',(cid,int(jm[1]))).fetchone()
                if not row: raise ApiError(404,'日记账不存在')
                _version(row,payload); _open(conn,cid,row['period'])
                if method=='POST' and jm[2]=='post':
                    if row['voucher_id']: return {'id':row['id'],'voucher_id':row['voucher_id'],'already_posted':True}
                    d=row['amount_fen'] if row['direction']=='income' else 0; cr=row['amount_fen'] if row['direction']=='expense' else 0
                    candidates=[dict(x) for x in conn.execute("""SELECT DISTINCT v.id voucher_id,v.date,v.number,v.source_type,v.summary,
                        (SELECT GROUP_CONCAT(a.code || ' ' || a.name, '；') FROM voucher_lines other
                         JOIN accounts a ON a.client_id=other.client_id AND a.code=other.account_code
                         WHERE other.voucher_id=v.id AND other.account_code<>l.account_code) counter_accounts
                        FROM vouchers v JOIN voucher_lines l ON l.voucher_id=v.id
                        WHERE v.client_id=? AND v.source_type='reconciliation' AND v.status='active' AND v.date=?
                        AND l.account_code=? AND l.debit_fen=? AND l.credit_fen=? ORDER BY v.id""",
                        (cid,row['date'],row['bank_account'],d,cr))]
                    note=payload.get('duplicate_review_note','')
                    if not isinstance(note,str) or len(note.strip())>500: raise ApiError(400,'重复核验说明须为不超过500字的文本')
                    note=note.strip()
                    if candidates and not note: raise ApiError(409,'发现日期、金额及银行科目相同的核对收付款凭证，可能重复；请核对是否为不同流水',{'code':'possible_duplicate','candidates':candidates})
                    lines=[_entry(row['bank_account'],d,cr,row['cashflow_category']),_entry(row['counter_account'],cr,d,row['cashflow_category'] if row['cashflow_category']=='transfer' else 'unclassified')]
                    vid=_insert_voucher(conn,cid,row['date'],row['summary'],lines,user,'bank',row['id']); conn.execute('UPDATE journals SET voucher_id=?,version=version+1 WHERE id=?',(vid,row['id'])); audit(conn,user,'post','journal',row['id'],{'voucher_id':vid,'duplicate_candidates':candidates,'duplicate_review_note':note if candidates else ''}); return {'id':row['id'],'voucher_id':vid,'already_posted':False}
                if method=='DELETE' and not jm[2]:
                    if row['voucher_id']: raise ApiError(409,'已生成凭证的日记账不能删除')
                    conn.execute('DELETE FROM journals WHERE id=?',(row['id'],)); audit(conn,user,'delete','journal',row['id'],{'before':dict(row),'reason':payload.get('reason','')}); return {'deleted':True}
            return None
    except sqlite3.IntegrityError as exc:
        raise ApiError(409,'记录重复或关联约束冲突，未保存') from exc
