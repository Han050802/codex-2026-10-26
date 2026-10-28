"""Versioned, local invoice classification rules; suggestions only, never posting."""
import json
import re
from db import ApiError

SOURCE = 'https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852734144.pdf'
SOURCE_ENTERPRISE = 'https://czj.sh.gov.cn/zys_8908/zcfg_8983/zcfb_8985/hj_9035/cwhjjbzdgf/20061201/0017-156907.html'
SOURCE_CONTRACT_LIABILITY = 'https://www.csrc.gov.cn/jiangsu/c105409/c6940347/content.shtml'
# Each rule requires an explicit use asserted by the operator, not a guess from
# a merchant name or payment. These examples are not a substitute for review.
SEEDS = [
 ('sale_main','sale','主营业务收入',['主营业务销售','主营销售','主营业务收入','主营业务服务'],'本方销售；明确属于主营业务，收入确认条件需核实。'),
 ('sale_other','sale','其他业务收入',['其他业务销售','其他业务收入'],'本方销售；明确属于其他业务，收入确认条件需核实。'),
 ('purchase_resale','purchase','库存商品',['购入商品用于转售','商品入库待售','商品用于转售','库存商品'],'购入商品已验收入库、持有待售；核实验收和成本。'),
 ('purchase_material','purchase','原材料',['生产用原材料','材料验收入库','原材料入库'],'购入原材料已验收入库；核实用途及入库状态。'),
 ('purchase_fixed','purchase','固定资产',['符合固定资产确认条件','确认为固定资产'],'自用资产符合固定资产定义和确认条件；需核实使用期限及会计政策。'),
 ('purchase_admin','purchase','管理费用',['行政管理用途','管理部门使用','行政办公使用','管理费用'],'行政管理部门使用的当期费用；核实用途及是否应资本化或分摊。'),
 ('purchase_selling','purchase','销售费用',['销售推广用途','销售部门使用','广告宣传用途','销售费用'],'销售、宣传推广使用的当期费用；核实用途及是否应资本化或分摊。'),
 ('purchase_finance','purchase','财务费用',['银行手续费','筹资手续费','财务费用'],'属于筹资活动相关手续费；核实具体性质和是否应资本化。'),
 ('purchase_manufacturing','purchase','制造费用',['生产车间间接费用','车间间接费用','制造费用'],'生产车间间接费用；需核实成本归集和分配。'),
 ('purchase_production','purchase','生产成本',['直接生产成本','直接生产耗用'],'已直接用于生产且属于可归集成本；需核实归集对象。'),
 ('purchase_intangible','purchase','无形资产',['符合无形资产确认条件','确认为无形资产'],'购入项目符合无形资产确认条件，核实权利、使用期限和成本。'),
]

# Item words generate conditional leads, never a confirmed classification.
HINTS = [
 ('咨询','purchase_admin','行政管理咨询且属于当期费用时'),
 ('审计','purchase_admin','管理部门聘请的审计且属于当期费用时'),
 ('办公用品','purchase_admin','管理部门耗用且不需资本化时'),
 ('餐饮','purchase_admin','属于管理部门业务招待费且有合规依据时'),
 ('广告','purchase_selling','用于销售宣传推广且属于当期费用时'),
 ('广告','purchase_admin','用于企业管理、招聘等且属于当期费用时'),
 ('宣传','purchase_selling','用于销售宣传推广且属于当期费用时'),
 ('推广','purchase_selling','用于销售宣传推广且属于当期费用时'),
 ('差旅','purchase_admin','管理部门差旅且属于当期费用时'),
 ('差旅','purchase_selling','销售部门差旅且属于当期费用时'),
 ('水电','purchase_admin','管理部门使用且属于当期费用时'),
 ('水电','purchase_manufacturing','生产车间间接使用且属于当期费用时'),
 ('运输','purchase_selling','属于销售过程中发生的运输费用时'),
 ('运输','purchase_material','属于购入原材料成本且符合入库条件时'),
 ('银行手续费','purchase_finance','属于筹资活动的银行手续费且不需资本化时'),
 ('电脑','purchase_fixed','满足固定资产确认条件时'),
 ('电脑','purchase_admin','行政办公使用且不满足资本化条件时'),
 ('打印机','purchase_fixed','满足固定资产确认条件时'),
 ('打印机','purchase_admin','行政办公使用且不满足资本化条件时'),
 ('软件','purchase_intangible','满足无形资产确认条件时'),
 ('软件','purchase_admin','管理部门使用且属于当期费用时'),
 ('租赁','purchase_admin','行政管理使用且属于当期费用时'),
 ('租赁','purchase_selling','销售部门使用且属于当期费用时'),
 ('租赁','purchase_manufacturing','生产车间间接使用且属于当期费用时'),
 ('商品','purchase_resale','购入商品已验收入库并持有待售时'),
 ('原材料','purchase_material','生产用原材料已验收入库时'),
]

SETTLEMENT_RULES = [
 ('settlement_receivable','应收账款',['销售未收款','应收账款','1122'], '销售商品或提供劳务形成的应收款项，按对方单位明细核算；核实履约、其他期间流水及既有凭证。'),
 ('settlement_prepayment','预付账款',['预付款','预付账款','1123'], '按合同预付的货款、租金或工程款等，按对方单位明细核算；核实合同和履约状态。'),
 ('settlement_other_receivable','其他应收款',['代垫款','赔款','其他应收款','1221'], '应收赔款、代垫款等其他应收暂付款；核实具体性质，不能仅凭转出或对方姓名判断。'),
 ('settlement_payable','应付账款',['采购未付款','应付账款','2202'], '因购买商品或接受劳务等应付的款项，按对方单位明细核算；核实履约、付款和既有凭证。'),
 ('settlement_advance','预收账款',['预收款','预收账款','2203'], '小企业准则下按合同预收的款项；企业会计准则下应另核实合同负债及适用准则，不可一概套用。'),
 ('settlement_other_payable','其他应付款',['其他应付款','2241'], '其他应付、暂收款应核实负债性质；不能仅凭转入或对方姓名判断。'),
 ('settlement_bank','银行存款',['银行资金流向','银行存款','1002'], '银行存款反映银行资金增减，需核实真实流水、账户及业务对方科目。'),
]

def init_schema(conn):
    conn.execute('''CREATE TABLE IF NOT EXISTS invoice_account_rules (
      id TEXT PRIMARY KEY, role TEXT NOT NULL, account_name TEXT NOT NULL,
      keywords_json TEXT NOT NULL, conditions TEXT NOT NULL, explanation TEXT NOT NULL,
      source_title TEXT NOT NULL, source_url TEXT NOT NULL, version INTEGER NOT NULL)''')
    conn.execute('''CREATE TABLE IF NOT EXISTS invoice_item_hints (
      keyword TEXT NOT NULL, rule_id TEXT NOT NULL REFERENCES invoice_account_rules(id),
      condition TEXT NOT NULL, PRIMARY KEY(keyword,rule_id))''')
    for ident,role,name,keywords,condition in SEEDS:
        conn.execute('''INSERT OR IGNORE INTO invoice_account_rules
          (id,role,account_name,keywords_json,conditions,explanation,source_title,source_url,version)
          VALUES(?,?,?,?,?,?,?,?,?)''', (ident,role,name,json.dumps(keywords,ensure_ascii=False),condition,
          '依据明确用途给出候选科目；发票本身不证明入账时点、已付款或税务处理。',
          '财政部小企业会计准则附录',SOURCE,2))
    conn.execute('''UPDATE invoice_account_rules SET source_title=?,source_url=?,version=2
        WHERE version=1 AND source_url=?''',('财政部小企业会计准则附录',SOURCE,
        'https://kjs.mof.gov.cn/zhengcefabu/201111/P020111118325852319878.pdf'))
    for ident,name,keywords,condition in SETTLEMENT_RULES:
        conn.execute('''INSERT OR IGNORE INTO invoice_account_rules
          (id,role,account_name,keywords_json,conditions,explanation,source_title,source_url,version)
          VALUES(?,?,?,?,?,?,?,?,?)''', (ident,'settlement',name,json.dumps(keywords,ensure_ascii=False),condition,
          '这是待核提示；应结合交易事实、适用准则和已有凭证判断，不直接生成凭证。',
          '财政部小企业会计准则附录',SOURCE,2))
        # Upgrade only the original bundled rules, leaving newer/custom rules alone.
        conn.execute('''UPDATE invoice_account_rules SET account_name=?,keywords_json=?,conditions=?,
          explanation=?,source_title=?,source_url=?,version=2 WHERE id=? AND version=1''',
          (name,json.dumps(keywords,ensure_ascii=False),condition,
           '这是待核提示；应结合交易事实、适用准则和已有凭证判断，不直接生成凭证。',
           '财政部小企业会计准则附录',SOURCE,ident))
    conn.executemany('INSERT OR IGNORE INTO invoice_item_hints(keyword,rule_id,condition) VALUES(?,?,?)',HINTS)

def _account(conn, client_id, name, context=''):
    if not client_id: return None
    rows=conn.execute('SELECT code FROM accounts WHERE client_id=? AND name=? ORDER BY code',(client_id,name)).fetchall()
    if len(rows)!=1: return None
    code=rows[0]['code']
    codes=[r['code'] for r in conn.execute('SELECT code FROM accounts WHERE client_id=?',(client_id,))]
    children=[c for c in codes if c!=code and c.startswith(code)]
    if not children: return code
    # A parent with several details cannot itself be posted to. Select a leaf
    # only where the business text identifies its name (or a specific alias).
    aliases={'办公费':('办公用品','办公耗材'), '手续费':('银行手续费',),
             '广告费':('广告费','广告服务'), '宣传费':('宣传费','宣传服务'),
             '差旅费':('差旅费','差旅'), '咨询费':('咨询费','咨询服务')}
    leaves=[]
    for row in conn.execute('SELECT code,name FROM accounts WHERE client_id=?',(client_id,)):
        child=row['code']; label=row['name']
        if child not in children or any(c!=child and c.startswith(child) for c in children): continue
        terms=(label,)+aliases.get(label,())
        if label and any(term and term in context for term in terms): leaves.append(child)
    return leaves[0] if len(leaves)==1 else None

def list_rules(conn, query='', client_id=None):
    if not isinstance(query,str) or len(query)>100: raise ApiError(400,'规则检索内容不能超过 100 字')
    standard=None
    if client_id not in (None,''):
        try: client_id=int(client_id)
        except (TypeError,ValueError): raise ApiError(400,'客户无效')
        client=conn.execute('SELECT * FROM clients WHERE id=? AND deleted=0',(client_id,)).fetchone()
        if client_id<=0 or not client: raise ApiError(404,'客户不存在')
        if 'standard' in client.keys(): standard=client['standard']
    else: client_id=None
    q=query.strip().lower()
    result=[]
    for row in conn.execute('SELECT * FROM invoice_account_rules ORDER BY id'):
        rule=dict(row); rule['keywords']=json.loads(rule.pop('keywords_json'))
        if standard=='enterprise2007':
            rule['source_title']='企业会计准则应用指南'
            rule['source_url']=SOURCE_ENTERPRISE
            if rule['id']=='settlement_advance':
                rule['source_title']='江苏证监局：预付款项与预收款项'
                rule['source_url']=SOURCE_CONTRACT_LIABILITY
        else:
            rule['source_title']='小企业会计准则（企业准则请另核对）'
        rule['account_code']=_account(conn,client_id,rule['account_name'])
        hints=[r['keyword'] for r in conn.execute('SELECT keyword FROM invoice_item_hints WHERE rule_id=?',(rule['id'],))]
        rule['item_keywords']=hints
        rule['enterprise_source_title']='企业会计准则应用指南'
        rule['enterprise_source_url']=SOURCE_ENTERPRISE
        searchable=' '.join([rule['id'],rule['role'],rule['account_name'],rule['account_code'] or '',rule['conditions'],rule['explanation'],*rule['keywords'],*hints]).lower()
        if not q or q in searchable: result.append(rule)
    return {'rules':result[:100], 'total':len(result)}

def classify(conn, client_id, invoice, role):
    candidates=[]
    def review(basis,extra='请补充项目和具体用途，核实后选择科目。'):
        return {'account_code':None,'account_name':None,'basis':basis,'review':extra,'status':'review','rule_ids':[],'source_urls':[]}
    item=str(invoice.get('item_name') or '').strip()
    purpose=str(invoice.get('business_purpose') or '').strip()
    note=str(invoice.get('transaction_note') or '').strip()
    if len(item)>2000 or len(purpose)>1000 or len(note)>2000: return review('发票项目、用途或流水附言过长，请核实')
    # Every item must be accounted for; conflicting multi-item uses need split
    # details and cannot be classified using a single global purpose.
    parts=[x.strip() for x in re.split(r'[;；\n]+',item) if x.strip()]
    if conn:
        for part in parts:
            rows=conn.execute('''SELECT h.keyword,h.condition,r.id,r.account_name FROM invoice_item_hints h
                JOIN invoice_account_rules r ON r.id=h.rule_id WHERE r.role=? ORDER BY r.id''',(role,)).fetchall()
            for row in rows:
                if row['keyword'] in part:
                    candidates.append({'item_name':part,'account_name':row['account_name'],
                        'account_code':_account(conn,client_id,row['account_name']),
                        'condition':row['condition'],'rule_id':row['id']})
            if role=='sale':
                for rid, name, condition in [('sale_main','主营业务收入','属于主营业务且满足收入确认条件时'),('sale_other','其他业务收入','属于其他业务且满足收入确认条件时')]:
                    candidates.append({'item_name':part,'account_name':name,'account_code':_account(conn,client_id,name),'condition':condition,'rule_id':rid})
    def pending(basis,extra='请补充项目和具体用途，核实后选择科目。'):
        result=review(basis,extra); result['candidates']=candidates
        if conn and client_id and candidates:
            client=conn.execute('SELECT standard FROM clients WHERE id=?',(client_id,)).fetchone()
            result['source_urls']=[SOURCE_ENTERPRISE if client and client['standard']=='enterprise2007' else SOURCE]
        return result
    if not conn or not client_id: return pending('尚未选择有效客户账套，无法对应实际科目')
    if not item: return pending('发票项目缺失')
    if len(parts)!=1: return pending('发票有多个项目，缺少逐项用途和金额','请逐项核对和拆分，不能将整张多项目发票按一个科目处理。')
    # Use explicit accounting/business descriptions in the actual invoice or
    # matched transaction as well as the dedicated purpose field. A generic
    # service description alone does not establish department or business use.
    context='；'.join(x for x in (item,purpose,note) if x)
    # Do not turn a negated or hypothetical description into affirmative
    # evidence. Preserve the explicit asset exception used below.
    positive_context=context.replace('不满足资本化条件','').replace('无形资产','')
    if any(x in positive_context for x in ('不','非','未','无','待','疑','或','可能','拟','尚','暂','预计','也许','是否','如属','如为','如果','假设')):
        return pending('业务描述存在否定或不确定表述')
    applicable=[]
    use_aliases={
        'purchase_admin':('管理用途','行政用途'),
        'purchase_selling':('销售用途','销售部门用途','实际为销售'),
    }
    for row in conn.execute('SELECT * FROM invoice_account_rules WHERE role=? ORDER BY id',(role,)):
        rule=dict(row)
        # Conflicting evidence from any field must remain visible.
        if any(k in context for k in json.loads(rule['keywords_json'])+list(use_aliases.get(rule['id'],()))): applicable.append(rule)
    if not applicable: return pending('现有项目、用途和流水附言不足以确定业务科目')
    names={x['account_name'] for x in applicable}
    if len(names)!=1: return pending('用途同时命中不同科目规则','请核实各项目用途及是否需拆分，再选择科目。')
    rule=applicable[0]; code=_account(conn,client_id,rule['account_name'],context)
    if candidates and rule['account_name'] not in {c['account_name'] for c in candidates}:
        return pending('票面项目与所填用途对应科目不一致','请核实项目和用途；如涉及不同性质的项目需拆分。')
    if any(c['account_name'] in ('固定资产','无形资产') for c in candidates) and rule['account_name'] not in ('固定资产','无形资产') and '不满足资本化条件' not in purpose:
        return pending('项目可能属于资产，尚未核实资本化条件','请确认是否满足固定资产或无形资产确认条件。')
    if not code: return pending('账套中没有唯一末级同名的“'+rule['account_name']+'”科目','请核实该账套科目及其明细后选择。')
    client=conn.execute('SELECT * FROM clients WHERE id=?',(client_id,)).fetchone()
    source=SOURCE_ENTERPRISE if client and 'standard' in client.keys() and client['standard']=='enterprise2007' else SOURCE
    selected_name=conn.execute('SELECT name FROM accounts WHERE client_id=? AND code=?',(client_id,code)).fetchone()['name']
    basis=rule['conditions'] if purpose else '依据发票项目或流水附言：'+context+'；'+rule['conditions']
    return {'account_code':code,'account_name':selected_name,'basis':basis,
            'review':'仅为科目建议；请核实项目、用途、入账时点、税额和是否已记账。',
            'status':'suggested','rule_ids':[x['id'] for x in applicable], 'source_urls':[source], 'candidates':candidates}
