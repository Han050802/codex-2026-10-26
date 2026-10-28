"""Reconciliation batch suggestions and atomic confirmation."""
import hashlib, json, re
import account_rules, finance, reconciliation
from db import ApiError, audit

# Only an explicit standalone use statement is eligible; account names and
# invoice item hints alone do not establish how a purchase or sale was used.
NOTE_USES={
    '主营业务销售','主营销售','主营业务服务','其他业务销售',
    '购入商品用于转售','商品入库待售','商品用于转售',
    '生产用原材料','材料验收入库','原材料入库',
    '符合固定资产确认条件','确认为固定资产',
    '行政管理用途','管理部门使用','行政办公使用',
    '销售推广用途','销售部门使用','广告宣传用途',
    '生产车间间接费用','车间间接费用','直接生产成本','直接生产耗用',
    '符合无形资产确认条件','确认为无形资产',
}

NOTE_ALIASES = {
    '销售广告宣传费': ('广告宣传用途','广告'),
    '销售广告费': ('广告宣传用途','广告'),
    '销售推广费': ('销售推广用途','推广'),
    '管理部门办公用品': ('行政办公使用','办公用品'),
    '管理部门办公用品费': ('行政办公使用','办公用品'),
}


def _note_classification(conn,cid,t,invoice):
    """Classify with an explicit, unambiguous use in the raw bank note."""
    if reconciliation.normalize(invoice.get('business_purpose')): return None
    raw=reconciliation.normalize(t.get('note'))
    if not raw or any(x in raw for x in ('不','非','未','待','可能','拟','假设','或者','或许')): return None
    segments=[x.strip() for x in re.split(r'[,，;；。\n]+',raw) if x.strip()]
    segments=[re.sub(r'^(?:业务用途|用途)\s*[:：]\s*','',x) for x in segments]
    item=reconciliation.normalize(invoice.get('item_name'))
    uses=[x if x in NOTE_USES else NOTE_ALIASES[x][0] for x in segments
          if x in NOTE_USES or (x in NOTE_ALIASES and NOTE_ALIASES[x][1] in item)]
    if not uses: return None
    role='sale' if reconciliation.fen(t.get('amount'))>0 else 'purchase'
    # Do not ignore free-form clauses that might contradict the use statement.
    # Other segments must be a neutral payment label or a short item label
    # grounded in an existing item hint that is actually present on the invoice.
    hints=[r['keyword'] for r in conn.execute('''SELECT DISTINCT h.keyword FROM invoice_item_hints h
        JOIN invoice_account_rules r ON r.id=h.rule_id WHERE r.role=?''',(role,)) if r['keyword'] in item]
    for segment in segments:
        if segment in NOTE_USES or (segment in NOTE_ALIASES and NOTE_ALIASES[segment][1] in item) or segment in ('付款','支付','采购','收款'): continue
        if not any(segment in (hint,hint+'费',hint+'服务',hint+'服务费',hint+'款') for hint in hints): return None
    classification=account_rules.classify(conn,cid,dict(invoice,business_purpose='；'.join(uses)),role)
    if classification.get('status')!='suggested': return None
    return classification,{'source':'transaction_note','raw_note':raw,'uses':uses,
                           'rule_ids':classification['rule_ids'],'source_urls':classification['source_urls']}


def _leaf(conn, cid, code):
    if not isinstance(code,str) or not code.strip(): return None
    row=conn.execute('SELECT * FROM accounts WHERE client_id=? AND code=?',(cid,code.strip())).fetchone()
    if not row or conn.execute('SELECT 1 FROM accounts WHERE client_id=? AND code LIKE ? AND code<>?',(cid,code.strip()+'%',code.strip())).fetchone(): return None
    return dict(row)


def _classification_inputs(invoice):
    return {key:('' if invoice.get(key) is None else str(invoice.get(key)).strip()) for key in
            ('item_name','business_purpose','net_amount','tax_amount','invoice_type')}


def _suggestion_context(transactions):
    # Batch ratios depend on all receipt and supplier amounts, not just the
    # invoice being updated.  Preserve only the fields used by those rules.
    return [{key:('' if t.get(key) is None else str(t.get(key)).strip()) for key in
             ('date','amount','counterparty','note','direction_needs_review')} for t in transactions]


def _existing_record(conn,cid,t,i):
    """Reuse only the same unposted match, never an unrelated invoice or transaction."""
    row=conn.execute('SELECT * FROM reconciliation_records WHERE client_id=? AND invoice_number=?',
                     (cid,str(i.get('number','')).strip())).fetchone()
    if not row: return None, ''
    old_t=json.loads(row['transaction_json']); old_i=json.loads(row['invoice_json'])
    same_t=(all(reconciliation.normalize(old_t.get(k))==reconciliation.normalize(t.get(k))
                for k in ('date','counterparty','note')) and reconciliation.fen(old_t.get('amount'))==reconciliation.fen(t.get('amount')))
    same_i=(all(reconciliation.normalize(old_i.get(k))==reconciliation.normalize(i.get(k))
                for k in ('date','seller','buyer','number')) and reconciliation.fen(old_i.get('amount'))==reconciliation.fen(i.get('amount')))
    if not same_t or not same_i or row['status'] not in ('matched','reviewed'):
        return None, '该发票已有不同核对记录，请核实后处理'
    posted=conn.execute("SELECT 1 FROM vouchers WHERE client_id=? AND source_type='reconciliation' AND source_id=? AND status='active'",(cid,str(row['id']))).fetchone()
    if posted: return None, '该发票已保存并入账，请核对是否重复'
    return dict(row), ''


def _store_match(conn,payload,draft,row,user):
    """Save a match or update supplemental invoice information on the same match."""
    ti,ii=row['transaction_index'],row['invoice_index']
    t=payload['transactions'][ti]; i=payload['invoices'][ii]
    existing,error=_existing_record(conn,draft['client_id'],t,i)
    if error: raise ApiError(409,error)
    if existing:
        keys=('date','amount','seller','buyer','number','source','item_name','net_amount','tax_amount','business_purpose','invoice_type')
        cleaned=reconciliation.clean_row(i,keys)
        cleaned['needs_review']=bool(i.get('needs_review',False))
        old=json.loads(existing['invoice_json'])
        if old!=cleaned:
            conn.execute('UPDATE reconciliation_records SET invoice_json=? WHERE id=?',
                         (json.dumps(cleaned,ensure_ascii=False),existing['id']))
            audit(conn,user,'reconcile_update_invoice','reconciliation_records',existing['id'],{'before':old,'after':cleaned})
        result={'id':existing['id'],'status':existing['status']}
        if row.get('voucher'):
            result.update(reconciliation._post_confirmed(conn,existing['id'],draft['client_id'],row['voucher'],user))
    else:
        record={'client_id':draft['client_id'],'account_name':payload['account_name'],
                'account_needs_review':payload.get('account_needs_review',False),
                'transaction':t,'invoice':i,
                'batch':{'transactions':payload['transactions'],'invoices':payload['invoices'],
                         'transaction_index':ti,'invoice_index':ii}}
        if row.get('voucher'): record['voucher']=row['voucher']
        result=reconciliation.save(conn,record,user,_in_transaction=True)
    previous=json.loads(existing['batch_metadata_json'] or '{}') if existing else {}
    supplied=payload.get('evidence',[])
    evidence=supplied[ti] if ti<len(supplied) else previous.get('evidence',{})
    metadata={'evidence':evidence,'classification':row.get('classification'),
              'reason':row.get('reason',''), 'classification_inputs':_classification_inputs(i),
              'suggestion_context':_suggestion_context(payload['transactions'])}
    if row.get('expense_classification'):
        metadata['expense_classification']=row['expense_classification']
    if metadata!=previous:
        conn.execute('UPDATE reconciliation_records SET batch_metadata_json=? WHERE id=?',
                     (json.dumps(metadata,ensure_ascii=False),result['id']))
        audit(conn,user,'reconcile_batch_metadata','reconciliation_records',result['id'],{'before':previous,'after':metadata})
    return result


def _asof(conn,cid,code,date,include_date=False):
    opening=conn.execute('SELECT debit_fen-credit_fen FROM opening_balances WHERE client_id=? AND account_code=?',(cid,code)).fetchone()
    value=opening[0] if opening else 0
    value+=conn.execute("""SELECT COALESCE(SUM(l.debit_fen-l.credit_fen),0) FROM voucher_lines l JOIN vouchers v ON v.id=l.voucher_id
        WHERE v.client_id=? AND v.status='active' AND l.account_code=? AND (v.date<? OR (? AND v.date=?))""",(cid,code,date,int(include_date),date)).fetchone()[0]
    return value


def _history(conn,cid,t,i,bank,date):
    """Use only a unique, identical business pattern from a prior confirmed record."""
    item=reconciliation.normalize(i.get('item_name')); purpose=reconciliation.normalize(i.get('business_purpose'))
    note=reconciliation.normalize(t.get('note')); counter=reconciliation.normalize(t.get('counterparty'))
    tx=reconciliation.fen(t.get('amount')); tax=reconciliation.fen(i.get('tax_amount')); net=reconciliation.fen(i.get('net_amount'))
    if not all((item,purpose,note,counter,tx)) or tax!=0 or net!=abs(tx): return None
    candidates={}
    rows=conn.execute("""SELECT r.id,r.transaction_json,r.invoice_json,v.id vid,v.date FROM reconciliation_records r
       JOIN vouchers v ON v.client_id=r.client_id AND v.source_type='reconciliation' AND v.source_id=CAST(r.id AS TEXT)
       WHERE r.client_id=? AND v.status='active' AND v.reviewed=1 AND v.date<? ORDER BY v.date DESC,v.id DESC LIMIT 500""",(cid,date))
    for row in rows:
        oldt=json.loads(row['transaction_json']); oldi=json.loads(row['invoice_json']); oldamt=reconciliation.fen(oldt.get('amount'))
        if not oldamt or (oldamt>0)!=(tx>0) or reconciliation.normalize(oldt.get('counterparty'))!=counter or reconciliation.normalize(oldt.get('note'))!=note: continue
        if reconciliation.normalize(oldi.get('item_name'))!=item or reconciliation.normalize(oldi.get('business_purpose'))!=purpose: continue
        if reconciliation.fen(oldi.get('tax_amount'))!=0 or reconciliation.fen(oldi.get('net_amount'))!=abs(oldamt): continue
        lines=[dict(x) for x in conn.execute('SELECT * FROM voucher_lines WHERE voucher_id=? ORDER BY id',(row['vid'],))]
        if len(lines)!=2: continue
        cash=[x for x in lines if x['account_code']==bank['code']]
        other=[x for x in lines if x['account_code']!=bank['code']]
        if len(cash)!=1 or len(other)!=1 or cash[0]['debit_fen']-cash[0]['credit_fen']!=oldamt: continue
        a=_leaf(conn,cid,other[0]['account_code'])
        if not a or finance._cash(a) or other[0]['debit_fen']-other[0]['credit_fen']!=-oldamt: continue
        if a['category']=='liability' and a['report_key']!='payable': continue
        if a['report_key'] in ('receivable','payable','prepaid','advance') and a['name']!=counter: continue
        candidates.setdefault(a['code'],row['vid'])
    if len(candidates)!=1: return None
    code,vid=next(iter(candidates.items())); value=abs(tx)
    lines=[finance._entry(bank['code'],value if tx>0 else 0,value if tx<0 else 0),finance._entry(code,value if tx<0 else 0,value if tx>0 else 0)]
    return lines, ['与历史核对凭证 %s 的对方、摘要、发票项目、用途、收付方向和零税额一致；拟沿用其科目，仍需核实本次确认时点和是否已有入账。'%vid]


def _draft(conn,cid,t,i,classification,e):
    reasons=[]; basis=[]
    def missing(message): reasons.append(message)
    if t.get('direction_needs_review'): missing('流水收付款方向尚未确认')
    try: date=finance._date(t.get('date'))
    except ApiError: date=''; missing('流水日期无效')
    tx=reconciliation.fen(t.get('amount')); total=reconciliation.fen(i.get('amount'))
    if not tx or not total or total<=0 or abs(tx)!=total: missing('流水与发票金额须一致且有效')
    bank=_leaf(conn,cid,e.get('bank_account_code'))
    # An outgoing amount proves a payment, not which asset funded it.  In
    # particular, a sole bank account in the book is not evidence of payment
    # from that account.  Keep the match and classification for review instead
    # of posting an invented credit entry.
    if tx is not None and tx>0 and not e.get('bank_account_code'):
        banks=[dict(x) for x in conn.execute("SELECT * FROM accounts WHERE client_id=? AND code LIKE '1002%' ORDER BY code",(cid,)) if _leaf(conn,cid,x['code'])]
        if len(banks)==1: bank=banks[0]; basis.append('账套仅有一个银行末级科目，拟使用 '+bank['code']+' '+bank['name']+'，请核对实际账户')
    if not bank or not finance._cash(bank): missing('请核实实际资金来源（银行、现金、个人代付等）；代付或往来需依据凭证人工处理')
    treatment=e.get('treatment')
    note=str(e.get('evidence_note') or '').strip()
    if not treatment and not reasons:
        historical=_history(conn,cid,t,i,bank,date)
        if historical:
            other=next(line for line in historical[0] if line['account_code']!=bank['code'])
            account=_leaf(conn,cid,other['account_code'])
            if account['report_key'] in ('prepaid','advance') and not ('合同' in reconciliation.normalize(t.get('note')) and '预付' in reconciliation.normalize(t.get('note'))):
                missing('沿用预付款科目前须核实本次合同预付依据')
            if account['report_key'] in ('receivable','payable'):
                if (account['report_key']=='payable' and tx>=0) or (account['report_key']=='receivable' and tx<=0): missing('历史往来科目与本次收付款方向不符')
                bal=_asof(conn,cid,account['code'],date)
                outstanding=bal if account['report_key']=='receivable' else -bal
                if outstanding<abs(tx): missing('历史往来科目余额不足，请核实本次业务和原凭证')
            else:
                outstanding=conn.execute("SELECT code,report_key FROM accounts WHERE client_id=? AND name=? AND report_key IN ('receivable','payable')",(cid,reconciliation.normalize(t.get('counterparty')))).fetchall()
                if any((_asof(conn,cid,a['code'],date,True)>0 if a['report_key']=='receivable' else _asof(conn,cid,a['code'],date,True)<0) for a in outstanding if _leaf(conn,cid,a['code'])):
                    missing('该公司存在未结应收或应付，请核实是否应冲销原有往来，避免重复确认')
            if not reasons: return historical[0],[],basis+historical[1]
        transaction_note=reconciliation.normalize(t.get('note'))
        if tx<0 and '合同' in transaction_note and ('预付' in transaction_note or '预付款' in transaction_note):
            treatment='contract_prepayment'; note='流水附言：'+transaction_note
        elif classification.get('status')=='suggested':
            treatment='recognize_invoice'; note='依据已识别的业务科目；拟直接确认当期业务，须核实是否已入账及确认时点'
            # Existing same-company outstanding may signal a prior recognition.
            outstanding=conn.execute("SELECT code,report_key FROM accounts WHERE client_id=? AND name=? AND report_key IN ('receivable','payable')",(cid,reconciliation.normalize(t.get('counterparty')))).fetchall()
            if any((_asof(conn,cid,a['code'],date,True)>0 if a['report_key']=='receivable' else _asof(conn,cid,a['code'],date,True)<0) for a in outstanding if _leaf(conn,cid,a['code'])):
                missing('该公司存在未结应收或应付，请核实是否应冲销原有往来，避免重复确认')
    if treatment not in ('contract_prepayment','settle_payable','settle_receivable','recognize_invoice'):
        if classification.get('status')=='review':
            missing('已匹配发票，但科目尚不能确定：'+classification.get('basis','请核实业务性质'))
        else:
            missing('请选择业务处理依据：合同预付款、冲销已有应付/应收，或确认发票业务')
    elif len(note)<2 or len(note)>500: missing('请填写具体合同、原凭证或业务确认依据')
    lines=[]
    if not reasons:
        value=abs(tx)
        bankline=finance._entry(bank['code'],value if tx>0 else 0,value if tx<0 else 0)
        if treatment=='contract_prepayment':
            if tx>=0: missing('合同预付款仅适用于付款；请核实收付款及合同')
            else:
                parent=conn.execute("SELECT * FROM accounts WHERE client_id=? AND report_key='prepaid' AND length(code)=4 ORDER BY code",(cid,)).fetchall()
                if len(parent)!=1: missing('账套中需有唯一预付账款上级科目')
                else:
                    lines=[{'counterparty_parent_code':parent[0]['code'],'debit_fen':value,'credit_fen':0},bankline]
                    basis.append('合同预付款依据：'+note)
        elif treatment in ('settle_payable','settle_receivable'):
            target=_leaf(conn,cid,e.get('settlement_account_code'))
            desired='payable' if treatment=='settle_payable' else 'receivable'
            if (treatment=='settle_payable' and tx>=0) or (treatment=='settle_receivable' and tx<=0): missing('往来冲销方向与收付款不符')
            elif not target or target['report_key']!=desired or target['name']!=reconciliation.normalize(t.get('counterparty')):
                missing('请选择本账套中与对方公司同名的应付/应收末级科目')
            else:
                balance=_asof(conn,cid,target['code'],date)
                outstanding=-balance if desired=='payable' else balance
                if outstanding<value: missing('该公司在流水日期之前的未结往来余额不足，请核实原凭证和期间')
                else:
                    lines=([finance._entry(target['code'],value),bankline] if tx<0 else [bankline,finance._entry(target['code'],credit=value)])
                    basis.append('原有往来冲销依据：'+note+'；流水日前该明细余额 '+str(outstanding)+' 分')
        elif treatment=='recognize_invoice':
            code=classification.get('account_code')
            account=_leaf(conn,cid,code)
            net=reconciliation.fen(i.get('net_amount')); tax=reconciliation.fen(i.get('tax_amount'))
            if classification.get('status')!='suggested' or not account: missing('发票项目和具体用途未能确定唯一业务末级科目')
            elif account['category']=='liability' or account['report_key'] in ('receivable','prepaid','advance'):
                missing('该科目属于往来或负债，不能直接确认发票业务；请依据原有凭证和余额处理')
            if net is None or tax is None or net<0 or tax<0 or net+tax!=value: missing('请核实发票不含税金额与税额，且两者合计应等于价税合计')
            gross_cost=bool(tax and tx<0 and finance._client(conn,cid).get('taxpayer_type')=='small'
                            and i.get('invoice_type')=='ordinary')
            taxacc=None
            if tax and not gross_cost:
                taxacc=_leaf(conn,cid,e.get('tax_account_code'))
                if not taxacc or taxacc['report_key']!='tax_payable': missing('请明确选择正确的应交税费末级科目')
                expected='output' if tx>0 else 'deductible_input'
                if e.get('tax_treatment')!=expected: missing('请核实税额是否为销项税或可抵扣进项税')
            if not reasons:
                if tx<0:
                    lines=[finance._entry(account['code'],value if gross_cost else net)] if net or gross_cost else []
                    if tax and not gross_cost: lines.append(finance._entry(taxacc['code'],tax))
                    lines.append(bankline)
                else:
                    lines=[bankline]
                    if net: lines.append(finance._entry(account['code'],credit=net))
                    if tax: lines.append(finance._entry(taxacc['code'],credit=tax))
                basis.extend([classification.get('basis',''), '业务确认及税务处理依据：'+note])
                if gross_cost: basis.append('小规模纳税人取得普通发票，价税合计计入所选业务科目')
    return lines, reasons, basis


def preview(conn,payload):
    if not isinstance(payload,dict): raise ApiError(400,'核对批次无效')
    if isinstance(payload.get('client_id'),bool): raise ApiError(400,'客户无效')
    try: cid=int(payload.get('client_id'))
    except (TypeError,ValueError): raise ApiError(400,'请选择客户账套')
    client=finance._client(conn,cid)
    txs=payload.get('transactions'); ivs=payload.get('invoices')
    if not isinstance(txs,list) or not txs or len(txs)>100 or not isinstance(ivs,list) or len(ivs)>100: raise ApiError(400,'批次需要 1 至 100 条流水，发票最多 100 张')
    evidence=payload.get('evidence',[])
    if not isinstance(evidence,list) or len(evidence)>len(txs) or any(not isinstance(x,dict) for x in evidence): raise ApiError(400,'业务依据格式无效')
    allowed={'treatment','bank_account_code','settlement_account_code','tax_treatment','tax_account_code','evidence_note','duplicate_review_note','business_account_code'}
    if any(any(k not in allowed or not isinstance(v,str) or len(v)>500 for k,v in x.items()) for x in evidence): raise ApiError(400,'业务依据格式无效')
    account=reconciliation.normalize(payload.get('account_name'))
    try: full=json.loads(client.get('profile_json') or '{}').get('enterprise_name','')
    except (ValueError,TypeError,AttributeError): full=''
    if not account or account not in {reconciliation.normalize(client['name']),reconciliation.normalize(full)}: raise ApiError(400,'本方名称必须与客户名称或企业全称一致')
    out=reconciliation.match(txs,ivs,account,payload.get('account_needs_review',False),conn,cid)
    matches={m['transaction_index']:m for m in out['matches']}
    rows=[]
    for index,t in enumerate(txs):
        m=matches.get(index); ii=m.get('invoice_index') if m else None
        reasons=[]; basis=[]; voucher=None; classification_evidence=None; expense_classification=None
        classification=out['classification_transactions'][index]
        rule_suggestion=classification.get('rule_suggestion')
        if not m or m['status']!='matched' or ii is None:
            reasons=(m or {}).get('reasons') or ['未找到唯一匹配发票']
        else:
            inv=ivs[ii]
            ev=evidence[index] if index<len(evidence) else {}
            existing,_=_existing_record(conn,cid,t,inv)
            if existing:
                try:
                    old_meta=json.loads(existing.get('batch_metadata_json') or '{}')
                    old_class=old_meta.get('classification') or {}
                    old_suggestion=old_class.get('rule_suggestion')
                    if (old_meta.get('classification_inputs')==_classification_inputs(inv)
                            and old_meta.get('suggestion_context')==_suggestion_context(txs)
                            and isinstance(old_suggestion,dict) and old_suggestion.get('status')=='provisional'):
                        rule_suggestion=old_suggestion
                except (ValueError,TypeError,AttributeError):
                    pass
            explicit_treatment=ev.get('treatment')
            selected_code=ev.get('business_account_code')
            if selected_code:
                selected=_leaf(conn,cid,selected_code)
                valid=selected and selected['report_key'] not in ('cash','tax_payable','prior_adjustment')
                if valid and explicit_treatment=='recognize_invoice' and 2<=len(str(ev.get('evidence_note') or '').strip())<=500:
                    classification={'status':'suggested','account_code':selected['code'],'account_name':selected['name'],
                        'basis':'人工核实选择业务科目：'+str(ev['evidence_note']).strip(), 'rule_ids':[], 'source_urls':[]}
                    classification_evidence={'source':'user_selected_account','account_code':selected['code'],
                        'account_name':selected['name'],'evidence_note':str(ev['evidence_note']).strip()}
                else:
                    classification={'status':'review','account_code':None,'account_name':None,
                        'basis':'选择有效的业务末级科目、发票业务处理方式并填写具体依据'}
            transaction_note=reconciliation.normalize(t.get('note'))
            prepayment_note='合同' in transaction_note and '预付' in transaction_note
            if (not selected_code and not reconciliation.normalize(inv.get('business_purpose'))
                    and (any(x in transaction_note for x in ('不','非','未','待','可能','拟','假设','或者','或许','实际为'))
                         or sum(1 for use in NOTE_USES if use in transaction_note)>1)):
                classification={'status':'review','account_code':None,'account_name':None,
                    'basis':'清单备注包含否定或不确定的用途，不能自动确定业务科目'}
            note_classification=_note_classification(conn,cid,t,inv) if not selected_code and explicit_treatment in (None,'','recognize_invoice') and not prepayment_note else None
            if note_classification:
                classification,classification_evidence=note_classification
            # The user accepts the displayed recommendation for classification;
            # retain its provenance and do not treat it as a journal entry.
            if (not selected_code and explicit_treatment in (None,'','recognize_invoice')
                    and not prepayment_note and rule_suggestion
                    and rule_suggestion.get('status')=='provisional'
                    and classification.get('status')!='suggested'
                    and not any(x in transaction_note for x in ('不','非','未','待','可能','拟','假设','或者','或许','实际为'))
                    and sum(1 for use in NOTE_USES if use in transaction_note)<=1):
                recommended=_leaf(conn,cid,rule_suggestion.get('account_code'))
                if recommended and recommended['report_key'] not in ('cash','tax_payable','prior_adjustment'):
                    classification={'status':'suggested','account_code':recommended['code'],
                        'account_name':recommended['name'],'basis':rule_suggestion.get('basis',''),
                        'rule_ids':rule_suggestion.get('rule_ids',[]),'source_urls':rule_suggestion.get('source_urls',[])}
                    classification_evidence={'source':'accepted_rule_suggestion','account_code':recommended['code'],
                        'account_name':recommended['name'],'basis':rule_suggestion.get('basis',''),
                        'rule_ids':rule_suggestion.get('rule_ids',[]),'review':rule_suggestion.get('review','')}
            if rule_suggestion is not None:
                classification['rule_suggestion']=rule_suggestion
            tx=reconciliation.fen(t.get('amount'))
            # A deliberately selected prepayment or settlement is a separate
            # accounting workflow and must continue through its evidence and
            # balance checks; do not silently recategorize it as an expense.
            explicit_accounting=explicit_treatment in ('contract_prepayment','settle_payable','settle_receivable')
            if tx is not None and tx<0 and not explicit_accounting:
                if any(word in transaction_note for word in ('预付','结清','应付','应收','还款','偿还','冲销')):
                    reasons.append('清单涉及预付款或往来结算，请确认业务处理方式后再记账')
                try: expense_date=finance._date(t.get('date'))
                except ApiError: expense_date=''; reasons.append('流水日期无效')
                if t.get('direction_needs_review'): reasons.append('流水收付款方向尚未确认')
                total=reconciliation.fen(inv.get('amount'))
                if not total or total<=0 or abs(tx)!=total: reasons.append('流水与发票金额须一致且有效')
                raw_net='' if inv.get('net_amount') is None else str(inv.get('net_amount')).strip()
                raw_tax='' if inv.get('tax_amount') is None else str(inv.get('tax_amount')).strip()
                net=reconciliation.fen(inv.get('net_amount')); tax=reconciliation.fen(inv.get('tax_amount'))
                if ((raw_net and (net is None or net<0)) or (raw_tax and (tax is None or tax<0)) or
                        (raw_net and raw_tax and net is not None and tax is not None and net+tax!=total)):
                    reasons.append('发票不含税金额、税额与价税合计不一致，请核实')
                account=_leaf(conn,cid,classification.get('account_code'))
                if (classification.get('status')!='suggested' or not account or account['category']=='liability'
                        or account['report_key'] in ('cash','tax_payable','prior_adjustment','receivable','prepaid','advance')):
                    reasons.append('发票与清单未能确定业务科目，请核实')
                if not reasons:
                    expense_classification={'account_code':account['code'],'account_name':account['name'],
                        'amount_fen':abs(tx),'direction':'expense','date':expense_date,
                        'source':(classification_evidence or {}).get('source','invoice_and_list')}
                    basis.append(classification.get('basis',''))
                    basis.append('已记录支出方向和业务科目，未生成会计凭证')
                lines=[]
            else:
                lines,reasons,basis=_draft(conn,cid,t,inv,classification,ev)
            if classification_evidence and classification_evidence['source']=='transaction_note':
                basis.append('业务用途依据：流水备注原文“'+classification_evidence['raw_note']+'”；按明确用途结合发票项目匹配科目规则')
            if not reasons and expense_classification is None:
                ev=evidence[index] if index<len(evidence) else {}
                voucher={'date':t['date'],'summary':('收款 ' if reconciliation.fen(t['amount'])>0 else '付款 ')+reconciliation.normalize(t.get('counterparty')),'lines':lines}
                try: finance._open(conn,cid,t['date'][:7])
                except ApiError as err: reasons.append(err.message)
                for line in lines:
                    parent=line.get('counterparty_parent_code')
                    if parent:
                        account_matches=conn.execute('SELECT code FROM accounts WHERE client_id=? AND code LIKE ? AND length(code)=? AND name=?',(cid,parent+'%',len(parent)+2,reconciliation.normalize(t.get('counterparty')))).fetchall()
                        if len(account_matches)>1 or (account_matches and not _leaf(conn,cid,account_matches[0]['code'])): reasons.append('同名往来明细不唯一或不是末级科目，请核对')
                        elif not account_matches and (conn.execute('SELECT 1 FROM voucher_lines WHERE client_id=? AND account_code=?',(cid,parent)).fetchone() or conn.execute('SELECT 1 FROM opening_balances WHERE client_id=? AND account_code=? AND (debit_fen<>0 OR credit_fen<>0)',(cid,parent)).fetchone()): reasons.append('上级科目已使用，不能直接新增公司明细，请先处理上级科目余额')
                    elif line.get('account_code'):
                        a=_leaf(conn,cid,line['account_code'])
                        if a and finance._cash(a):
                            duplicate=conn.execute("""SELECT 1 FROM vouchers v JOIN voucher_lines l ON l.voucher_id=v.id WHERE v.client_id=? AND v.status='active' AND v.date=? AND l.account_code=? AND l.debit_fen=? AND l.credit_fen=? LIMIT 1""",(cid,t['date'],line['account_code'],line.get('debit_fen',0),line.get('credit_fen',0))).fetchone()
                            if duplicate:
                                duplicate_note=ev.get('duplicate_review_note','')
                                if not isinstance(duplicate_note,str) or not duplicate_note.strip(): reasons.append('存在同日期、金额和资金科目的凭证，请核对并填写重复核验说明')
                                else: voucher['duplicate_review_note']=duplicate_note.strip()
            _,existing_error=_existing_record(conn,cid,t,inv)
            if existing_error: reasons.append(existing_error)
        if reasons: voucher=None
        if reasons: expense_classification=None
        rows.append({'transaction_index':index,'invoice_index':ii,'matched':bool(m and m['status']=='matched' and ii is not None),'status':'review' if reasons else ('expense_classified' if expense_classification else 'ready'),'reason':'；'.join(reasons),'counterparty':reconciliation.normalize(t.get('counterparty')),'amount_fen':reconciliation.fen(t.get('amount')),'voucher':voucher,'expense_classification':expense_classification,'basis':basis,'classification':classification,'classification_evidence':classification_evidence})
    result={'client_id':cid,'client_name':client['name'],'rows':rows,'unmatched_invoices':out['unmatched_invoices']}
    token_data={'input':{k:payload.get(k) for k in ('client_id','account_name','account_needs_review','transactions','invoices','evidence')},'result':result}
    result['preview_token']=hashlib.sha256(json.dumps(token_data,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return result


def save_batch(conn,payload,user):
    if payload.get('confirmed') is not True: raise ApiError(400,'请先核对并确认整批分录')
    with finance._write(conn):
        draft=preview(conn,payload)
        if payload.get('preview_token')!=draft['preview_token']: raise ApiError(409,'预览或账套状态已变化，请重新核对')
        selected=payload.get('selected_indices')
        if selected is None: selected=[r['transaction_index'] for r in draft['rows'] if r['status'] in ('ready','expense_classified')]
        if not isinstance(selected,list) or not selected or any(type(x) is not int for x in selected) or len(set(selected))!=len(selected): raise ApiError(400,'请选择需要保存的就绪项目')
        by_index={r['transaction_index']:r for r in draft['rows']}
        if any(i not in by_index or by_index[i]['status'] not in ('ready','expense_classified') for i in selected): raise ApiError(409,'所选项目仍需核对，未保存任何记录')
        selected_rows=[by_index[i] for i in selected]
        results=[]
        for row in selected_rows:
            ti,ii=row['transaction_index'],row['invoice_index']
            try: saved=_store_match(conn,payload,draft,row,user)
            except ApiError as err:
                raise ApiError(err.status, '第 %d 条流水保存失败：%s；整批未保存'%(ti+1,err.message),{'transaction_index':ti,'cause':err.details})
            if row['classification_evidence']:
                audit(conn,user,'reconcile_auto_classification','reconciliation_records',saved['id'],row['classification_evidence'])
            results.append({'transaction_index':ti,'invoice_index':ii,**saved})
        periods=sorted({(x['voucher']['date'] if x['voucher'] else x['expense_classification']['date'])[:7] for x in selected_rows})
        return {'client_id':draft['client_id'],'client_name':draft['client_name'],'periods':periods,'results':results}


def auto_post(conn,payload,user):
    """Re-evaluate each candidate under a write lock and post only ready rows.

    Each row has its own transaction: a duplicate or other conflict must not
    prevent independent, fully supported rows from reaching the balance table.
    A match is an automated comparison, not a verification of invoice validity
    or a human review of OCR and accounting treatment.
    """
    initial=preview(conn,payload)
    client=finance._client(conn,initial['client_id'])
    if client.get('standard')!='small2013':
        rows=[]
        for row in initial['rows']:
            result={k:row[k] for k in ('transaction_index','invoice_index','counterparty','amount_fen','basis','classification','classification_evidence')}
            result.update(status='review',reason='当前账套未设置为小企业会计准则；不能按小企业会计准则自动记账，请核实适用准则及账套设置。')
            rows.append(result)
        return {'client_id':initial['client_id'],'client_name':initial['client_name'],'rows':rows,
                'unmatched_invoices':initial['unmatched_invoices'],'periods':[],
                'invoice_verification':'not_checked','human_review':'not_performed'}
    results=[]; periods=set()
    for original in initial['rows']:
        index=original['transaction_index']
        try:
            with finance._write(conn):
                current=preview(conn,payload)
                row=current['rows'][index]
                result={k:row[k] for k in ('transaction_index','invoice_index','counterparty','amount_fen','basis','classification','classification_evidence')}
                if not row['matched']:
                    result.update(status='review',reason=row['reason'])
                else:
                    saved=_store_match(conn,payload,current,row,user)
                    if row['status']=='expense_classified':
                        if row['classification_evidence']:
                            audit(conn,user,'reconcile_auto_classification','reconciliation_records',saved['id'],row['classification_evidence'])
                        result.update(saved,status='expense_classified',reason='',expense_classification=row['expense_classification'])
                        periods.add(row['expense_classification']['date'][:7])
                    elif row['status']=='ready':
                        if row['classification_evidence']:
                            audit(conn,user,'reconcile_auto_classification','reconciliation_records',saved['id'],row['classification_evidence'])
                        result.update(saved, status='posted', reason='')
                        periods.add(row['voucher']['date'][:7])
                    else:
                        result.update(saved, status='saved_pending', reason=row['reason'])
            results.append(result)
        except ApiError as err:
            # _write has rolled back all changes for this candidate.
            results.append({k:original[k] for k in ('transaction_index','invoice_index','counterparty','amount_fen','basis','classification','classification_evidence')} |
                           {'status':'review','reason':err.message})
    return {'client_id':initial['client_id'],'client_name':initial['client_name'],'rows':results,
            'unmatched_invoices':initial['unmatched_invoices'],'periods':sorted(periods),
            'invoice_verification':'not_checked','human_review':'not_performed'}


def retry_saved(conn,client_id,user):
    """Retry unposted records with their original stored classification.

    Historical records without a stored recommendation are left for review:
    recomputing a single record can change a recommendation based on a batch.
    """
    if isinstance(client_id,bool): raise ApiError(400,'客户无效')
    try: cid=int(client_id)
    except (TypeError,ValueError): raise ApiError(400,'请选择客户账套')
    client=finance._client(conn,cid)
    records=conn.execute("""SELECT r.* FROM reconciliation_records r
        WHERE r.client_id=? AND r.status IN ('matched','reviewed') AND NOT EXISTS
        (SELECT 1 FROM vouchers v WHERE v.client_id=r.client_id AND v.source_type='reconciliation'
        AND v.source_id=CAST(r.id AS TEXT) AND v.status='active') ORDER BY r.id""",(cid,)).fetchall()
    results=[]; periods=set()
    for record in records:
        try:
            meta=json.loads(record['batch_metadata_json'] or '{}')
            classification=meta.get('classification') or {}
            suggestion=classification.get('rule_suggestion') if isinstance(classification,dict) else None
            previously_classified=(isinstance(classification,dict) and classification.get('status')=='suggested'
                                   and isinstance(classification.get('account_code'),str)
                                   and bool(classification['account_code'].strip()))
            provisional=isinstance(suggestion,dict) and suggestion.get('status')=='provisional'
            if not previously_classified and not provisional:
                results.append({'id':record['id'],'status':'review','reason':'原记录未保存推荐科目，请人工核实'}); continue
            transaction=json.loads(record['transaction_json']); invoice=json.loads(record['invoice_json'])
            prior_expense=meta.get('expense_classification')
            if (isinstance(prior_expense,dict) and isinstance(prior_expense.get('date'),str) and
                    meta.get('classification_inputs')==_classification_inputs(invoice)):
                results.append({'id':record['id'],'status':'expense_classified','reason':'',
                                'expense_classification':prior_expense})
                periods.add(prior_expense['date'][:7])
                continue
            evidence=meta.get('evidence') or {}
            payload={'client_id':cid,'account_name':record['account_name'],'transactions':[transaction],
                     'invoices':[invoice],'evidence':[evidence]}
            outcome=auto_post(conn,payload,user)
            row=outcome['rows'][0]
            results.append({'id':record['id'],**row})
            periods.update(outcome['periods'])
        except (ValueError,TypeError,AttributeError,ApiError) as err:
            results.append({'id':record['id'],'status':'review','reason':getattr(err,'message','已保存记录数据异常，请人工核实')})
    return {'client_id':cid,'client_name':client['name'],'rows':results,'periods':sorted(periods)}
