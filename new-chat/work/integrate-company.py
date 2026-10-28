from pathlib import Path
root=Path(__file__).resolve().parent.parent/'outputs'/'yidaizhang-local'
path=root/'public'/'finance-ui.js'
s=path.read_text(encoding='utf-8')
start=s.index('  return `<section class="book-workspace">',s.index('export async function renderBook'))
end=s.index('\n}',start)
s=s[:start]+"  return renderCompanyWorkspace(book,ctx,{view:activeView,content:renderView()});"+s[end:]
s=s.replace("function renderView(){const html=", "function renderView(){if(activeView==='home')return renderCompanyHome(book);if(activeView==='vouchers')return renderCompanyVouchers(book,bookContext);if(activeView==='ledger')return renderCompanyBalance(book,bookContext);const html=")
start=s.index('function bindLegacyBook(')
end=s.index('function repaint(',start)
s=s[:start]+'''export function bindBook(container,ctx){
  const actions={
    perform:(action,id)=>performAction(action,Number(id),ctx),
    view:view=>{if(!['home','vouchers','ledger','reports','accounts','assets','inventory','payroll','journals','period'].includes(view))return;activeView=view;repaint(container,ctx);},
    period:async period=>{if(!/^\\d{4}-\\d{2}$/.test(period))throw new Error('请选择有效的会计期间');if(period<book.client.start_period)throw new Error('所选期间早于建账期间');ctx.setBook(book.client.id,period);await ctx.reload();},
    company:async id=>{const client=ctx.clients.find(c=>Number(c.id)===id);const period=book.period<(client?.start_period||'')?client.start_period:book.period;ctx.setBook(id,period);await ctx.reload();},
    agency:nav=>ctx.navigateCompany?.(nav,book.client.id)
  };
  bindCompanyWorkspace(container,book,ctx,actions);
  if(activeView==='vouchers')bindCompanyVouchers(container,book,ctx,actions);
  else if(activeView==='ledger')bindCompanyBalance(container,book,ctx,actions);
  else if(activeView!=='home')bindBookContent(container,ctx);
}
''' +s[end:]
s=s.replace('<tr class="voucher-line"><td>', '<tr class="voucher-line"><td><input class="voucher-summary" aria-label="分录摘要" maxlength="200" value="${h(l.summary||\'\')}" placeholder="同凭证摘要"></td><td>')
s=s.replace("${field('summary','摘要','text',v?.summary||'','required maxlength=\"200\"')}</div>","${field('summary','摘要','text',v?.summary||'','required maxlength=\"200\"')}${field('attachment_count','附单据张数','number',v?.attachment_count||0,'required min=\"0\" max=\"99999\" step=\"1\"')}</div>")
s=s.replace('<thead><tr><th>会计科目</th><th>借方金额</th><th>贷方金额</th><th>资金活动分类</th>', '<thead><tr><th>摘要</th><th>会计科目</th><th>借方金额</th><th>贷方金额</th><th>资金活动分类</th>')
s=s.replace("map(row=>({account_code:row.querySelector('.voucher-account').value", "map(row=>({summary:row.querySelector('.voucher-summary').value.trim(),account_code:row.querySelector('.voucher-account').value")
s=s.replace("const payload={...formObject(form),lines,...(v?{version:v.version}:{})};", "const payload={...formObject(form),attachment_count:Number(form.elements.attachment_count.value),lines,...(v?{version:v.version}:{})};")
path.write_text(s,encoding='utf-8')
path=root/'public'/'app.js'
s=path.read_text(encoding='utf-8')
s=s.replace("closeBook: async () =>", "navigateCompany: async (nav,id) => { await navigate(nav); S.clientId=String(id); await render(); }, closeBook: async () =>",1)
old="html = `<div class=\"book-top\"><div class=\"inline\">${btn(`${icon('back')} 返回工作台`, 'close-book')}<strong>${escape(clientName(S.bookId))}</strong><span class=\"muted\">独立账套</span></div></div>${await renderBook(Number(S.bookId), S.period, ctx())}`;"
assert old in s
s=s.replace(old,"html = await renderBook(Number(S.bookId), S.period, ctx());",1)
# The homepage name is the entry into the company dashboard. More/details retain profile access.
for function_name in ['homeTable','renderAgencyProgress']:
    start=s.index('function '+function_name+'(')
    end=s.index('\n',start)
    row=s[start:end]
    row=row.replace("link(escape(c.name), 'client-detail',", "link(escape(c.name), 'company-home',")
    s=s[:start]+row+s[end:]
s=s.replace("case 'open-book': return openBook(id, el.dataset.period);", "case 'company-home': setBookView('home'); return openBook(id, el.dataset.period);\n    case 'open-book': return openBook(id, el.dataset.period);")
path.write_text(s,encoding='utf-8')
path=root/'public'/'index.html'
s=path.read_text(encoding='utf-8').replace('  <link rel="stylesheet" href="./finance.css">','  <link rel="stylesheet" href="./finance.css">\n  <link rel="stylesheet" href="./company-workspace.css">\n  <link rel="stylesheet" href="./company-vouchers.css">\n  <link rel="stylesheet" href="./company-balance.css">')
path.write_text(s,encoding='utf-8')
print('Integrated company dashboard, voucher and balance pages into the existing workbench.')
