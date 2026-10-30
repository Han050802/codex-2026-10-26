"""Suggestions derived from gpt.md, with evidence gaps kept visible.

These are primary-account suggestions only and never authorize posting.
"""
import re
from collections import defaultdict
from account_rules import SOURCE

ACCOUNTS = {'1002':'银行存款','1122':'应收账款','1123':'预付账款','1221':'其他应收款',
 '1403':'原材料','1405':'库存商品','1601':'固定资产','1801':'长期待摊费用',
 '2211':'应付职工薪酬','2221':'应交税费','2241':'其他应付款','3001':'实收资本','5001':'主营业务收入',
 '5301':'营业外收入','5401':'主营业务成本','5403':'税金及附加','5601':'销售费用',
 '5602':'管理费用','5603':'财务费用'}

def suggest(transactions, invoices, matches, industry='', fen=None):
    """Return one provisional rule suggestion per transaction, including unmatched ones."""
    by_tx={m['transaction_index']:m for m in matches}
    income=defaultdict(int); vendor=defaultdict(int)
    for t in transactions:
        n=fen(t.get('amount')); month=str(t.get('date') or '')[:7]
        if n and n>0: income[month]+=n
        elif n and n<0: vendor[(month,str(t.get('counterparty') or '').strip())]+=-n
    result=[]
    for index,t in enumerate(transactions):
        n=fen(t.get('amount')); m=by_tx.get(index,{})
        ii=m.get('invoice_index') if m.get('status')=='matched' else None
        inv=invoices[ii] if ii is not None else None
        note=str(t.get('note') or ''); counter=str(t.get('counterparty') or '')
        item=str((inv or {}).get('item_name') or ''); purpose=str((inv or {}).get('business_purpose') or '')
        text=' '.join((note,item,purpose)); code=None; rule=''; basis=''; warning=''; sub=''
        def has(*words): return any(w in text for w in words)
        def payer(*words): return any(w in counter for w in words)
        if not n or t.get('direction_needs_review'):
            warning='金额或收付款方向不明确，暂不能推荐科目。'
        elif n>0 and has('批量结息','利息收入','结息','利息'):
            code,rule,basis='5603','P1-2','银行结息收入，建议借记银行存款、贷记财务费用。'
        elif n<0 and has('惠享服务'):
            code,rule,basis,sub='1221','P1-3','银行惠享服务套餐扣费，建议先挂其他应收款，待取得发票或确认服务期间后转费用。','惠享服务'
            warning='如已取得银行服务费发票且属当期服务，可直接计入财务费用。'
        elif n<0 and (has('费用外收','手续费','回单箱','账户管理费','网银年服务费','批量扣费','工本费') or ('银行' in counter and '支行' in counter and -n<200000)):
            code,rule,basis='5603','P1-1','银行相关费用，建议借记财务费用、贷记银行存款。'
            warning='如为银行支行小额付款，仅凭对方和金额推断费用，需结合实际业务。'
        elif n<0 and (has('公积金') or payer('公积金')):
            code,rule,basis,sub='5602','P2-3','付款对象为住房公积金管理中心（或摘要含公积金），未计提时建议直接计入管理费用。','住房公积金（支出）'
            warning='如已按月计提应付职工薪酬，应改为冲减应付职工薪酬，避免重复入账；个人缴存部分应从工资中代扣。'
        elif n>0 and n<=1000 and (has('认证','验证','鉴权','实名') or payer('支付宝','财付通','银联','备付金')):
            code,rule,basis,sub='2241','P3-4','开户或企业认证产生的小额打款（10 元以内），建议计入其他应付款。','账号验证款'
            warning='小额验证款通常无需退回，可在年末按营业外收入处理。'
        elif n<0 and has('工资','代发','薪酬','社保','社会保险'):
            code,rule,basis='2211','P2-1','薪酬或社保支付，建议借记应付职工薪酬。'
            warning='须结合应计提金额及既有凭证，避免重复入账。'
        elif n<0 and has('缴税','三方协议','税款','国库','印花税'):
            code,rule,basis=('5403' if '印花税' in text else '2221'),'P2-2','按税款或印花税支付规则推荐。'
            warning='应核对税种及此前是否已计提；三方协议本身不必然表示缴税。'
        elif n>0 and has('投资款','注册资本','增资','入资','实缴','资本金'):
            code,rule,basis,sub='3001','P3-2','按投资或增资摘要推荐实收资本。',counter.strip()
            warning='须核对投资协议、股权和注册资本，超出部分处理另行确认。'
        elif n>0 and has('借款','往来款','周转金','垫付'):
            code,rule,basis='2241','P3-2','按往来拆借摘要推荐其他应付款。'
            warning='须核对借款性质；银行借款等可能使用其他科目。'
        elif n>0 and has('稳岗补贴','个税手续费返还','政府奖励','补助'):
            code,rule,basis='5301','P3-3','按补助摘要推荐营业外收入。'
            warning='须结合补助性质、确认时点及是否涉及递延收益。'
        elif n>0 and has('预收','预付款'):
            code,rule,basis='2203','P3-1','按预收摘要推荐预收账款。'
            ACCOUNTS.setdefault('2203','预收账款'); warning='须结合合同履约、已有凭证判断。'
        elif n>0 and inv:
            code,rule,basis,sub='5001','P3-5','收款已匹配本方开具的销售发票，建议确认主营业务收入。',counter.strip()
            warning='发票价税合计含销项税额，应按不含税金额确认收入并贷记应交税费；非主营业务请改用其他业务收入。'
        elif n>0 and has('服务费','技术服务费','管理费','咨询费','货款','项目款') and payer('公司','中心','医院','学校','研究院'):
            code,rule,basis,sub='5001','P3-6','对方单位支付服务费、货款等经营款项，建议确认主营业务收入。',counter.strip()
            warning='尚未匹配发票：如已开票请上传发票核对；未开票须按无票收入申报。若属预收款或以前已确认收入的回款，应改为预收账款或应收账款。'
        elif n>0 and has('服务费','技术服务费','管理费','咨询费','货款','项目款'):
            code,rule,basis='1122','P3-1','经营收款建议先按应收账款往来处理，避免重复确认收入。'
            warning='须核对该款是否已确认收入或属于预收；流水和发票本身不证明原账状态。'
        elif n<0 and has('房租','租金','房屋租赁'):
            # A sum alone is only a heuristic, not proof of a multi-month lease.
            long=bool(re.search(r'(?:[2-9]|[1-9]\d+)\s*(?:个)?月|跨年|年度|一年|两年',text))
            code,rule,basis=('1123' if long or -n>=3000000 else '5602'),'P4-1','按租赁期限或金额规则推荐科目。'
            warning='金额不能证明租赁期限或预付性质；结合合同及租赁期间确认。' if code=='1123' else '房租用途及所属期间可能影响归类。'
        elif n<0 and has('装修') and has('租入','租赁','租用') and has('超过一年','一年以上','两年','3年','三年'):
            code,rule,basis='1801','P4-2','按租入场地长期装修推荐长期待摊费用。'; warning='须结合受益期、用途及资本化条件。'
        elif n<0 and has('电脑','服务器','打印机','医疗设备','办公家具','车辆'):
            code,rule,basis='1601','P4-2','资产类项目建议按固定资产条件判断。'; warning='数量和单价无法从总金额推断；需结合用途、使用期限及确认条件。'
        elif n<0 and has('广告','宣传','推广','展位','营销','销售佣金'):
            code,rule,basis='5601','P5-1','按营销推广关键词推荐销售费用。'; warning='如用于招聘、企业管理等其他用途，分类可能不同。'
        elif n<0 and inv and has('原材料','主辅料'):
            code,rule,basis='1403','P4-3','按原材料采购推荐。'; warning='须结合实际用途和验收入库状态。'
        elif n<0 and inv and has('库存商品','商品入库','用于转售'):
            code,rule,basis='1405','P4-3','按商品采购推荐。'; warning='须结合实际用途和验收入库状态。'
        elif n<0 and re.fullmatch(r'[\u4e00-\u9fff·]{2,5}',counter) and not has('有限公司','银行','公司','中心','医院','政府','税务','分行','支行','商行') and (has('报销','差旅','备用金','借款') or not note):
            code,rule,basis=('5602' if inv else '1221'),'P5-2','按个人款项有票或无票规则暂作建议。'; warning='个人转账及是否有票不能单独证明款项性质；发票与报销人对应关系也须有依据。'
        elif n<0 and inv:
            month=str(t.get('date') or '')[:7]; total=income[month]; v=vendor[(month,counter.strip())]
            generic=has('服务费','技术费','信息技术服务','咨询服务','劳务')
            if generic and v>=1000000 and total and v*100>=total*15:
                code,rule,basis='5401','P5-1','同供应商当月支出达到 1 万元且占流水收入至少 15%，按提示词给出成本候选。'
                warning='金额占比只是提示词线索，不能证明该支出与主营业务直接相关；流水收入不等于主营业务收入。'
            else:
                code,rule,basis='5602','P5-1','按提示词日常有票支出兜底规则给出管理费用候选。'
                warning='仅据票面和金额不能证明实际用途或费用归属，资产、存货及跨期支出需另行判断。'
        if code:
            if inv and fen(inv.get('tax_amount')) not in (None,0):
                warning += ' 发票税额是否抵扣须结合纳税人身份及业务政策，未自动拆税。'
            result.append({'account_code':code,'account_name':ACCOUNTS[code],'sub_account':sub, 'status':'provisional','rule_ids':[rule], 'basis':basis,'review':warning or '科目建议须结合实际业务及已有账务确认。','source_urls':[SOURCE]})
        else:
            result.append({'account_code':None,'account_name':None,'status':'review','rule_ids':[], 'basis':warning or '现有摘要及已匹配单据未命中可用规则。','review':'避免仅凭资金方向或缺失凭证虚构业务性质。','source_urls':[SOURCE]})
    return result
