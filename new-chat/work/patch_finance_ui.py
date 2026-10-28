from pathlib import Path
p=Path(__file__).resolve().parents[1]/'outputs/yidaizhang-local/public/finance-ui.js'
s=p.read_text(encoding='utf-8')
s=s.replace("${button('作废','void-voucher',`data-id=\"${v.id}\"`)}", "${button('资金分类','cashflow-voucher',`data-id=\"${v.id}\"`)}${button('作废','void-voucher',`data-id=\"${v.id}\"`)}")
s=s.replace("case 'new-account':return newAccount(ctx);", "case 'cashflow-voucher':return cashflowModal(ctx,id);\n    case 'new-account':return newAccount(ctx);")
s=s.replace("button('生成工资计提凭证','post-payroll')", "button('生成工资计提凭证','post-payroll')+button('登记工资发放','pay-payroll')")
s=s.replace("case 'new-journal':return journalModal(ctx);", "case 'pay-payroll':return payPayrollModal(ctx);\n    case 'new-journal':return journalModal(ctx);")
s=s.replace("{balances});", "{balances,version:book.opening_version});")
mapping={'other_assets':'other_asset','receivables':'receivable','fixed_assets':'fixed_asset','payables':'payable','retained_earnings':'retained','cost':'business_cost','selling_expense':'selling','admin_expense':'administration','finance_expense':'finance'}
# Replace report-key option values only; the domain category `cost` stays cost.
for old,new in mapping.items():
    s=s.replace("['"+old+"','", "['"+new+"','") if old!='cost' else s.replace("['cost','营业成本']", "['business_cost','营业成本']")
# Accumulated depreciation uses the fixed-asset report row with a credit normal balance.
s=s.replace("['depreciation','累计折旧']", "['fixed_asset','累计折旧（固定资产抵减）']")
s=s.replace("['bank','银行存款']", "['cash','银行存款']")
s=s.replace("'购置、折旧和清理均生成凭证。'", "'购置、折旧和清理均生成凭证。'")
s += '''
function cashflowModal(ctx,id){
  const v=book.vouchers.find(x=>x.id===id), cashLines=v.lines.filter(l=>book.accounts.find(a=>a.code===l.account_code)?.report_key==='cash');
  if(!cashLines.length)throw new Error('这张凭证没有货币资金分录，无需现金流分类');
  return ctx.modal('资金活动分类',`<p>${h(v.number)} ${h(v.summary)}</p><div class="form-grid">${cashLines.map(l=>selectField('cf_'+l.id,`${l.account_code} ${l.account_name}（借 ${money(l.debit_fen)} / 贷 ${money(l.credit_fen)}）`,CF,l.cashflow_category||'unclassified')).join('')}</div><p class="muted">仅修改现金流分类，不修改会计分录金额。已结账期间不可修改。</p>`,async form=>save(ctx,`${base()}/vouchers/${id}/cashflow`,{version:v.version,classifications:cashLines.map(l=>({line_id:l.id,category:form.elements['cf_'+l.id].value}))}));
}
function payPayrollModal(ctx){return ctx.modal('登记工资发放',`<div class="form-grid">${field('period','所属期间','month',book.period,'required')}${field('date','发放日期','date',periodDate(),'required')}${accountField('bank_account','发放资金科目',acctDefault('bank','银行存款','1002'))}</div><p class="muted">为本期已计提工资生成发放凭证，实际向员工转账需在银行办理。已登记发放的记录不会重复记账。</p>`,async form=>save(ctx,`${base()}/payroll/pay`,formObject(form)));}
'''
p.write_text(s,encoding='utf-8')
