"""会小企01 / 会小企02 statements from the ledger.

Amounts are integer fen. Zero detail lines are omitted (None). Grand totals and
the three profit result lines stay visible when they are zero. Year-begin is the
book balance on 1 January. Books opened after January report year-begin as zero;
their opening balances stay in the ending column. Receivables and payables are
not reclassified. "其中" lines are details and are not added again.
"""
import calendar


I1 = '\u00a0 \u00a0\u00a0   '
I2 = I1 + I1
E1 = '  ' + I1
E2 = '  ' + I2

SMALL = 'small2013'
ENTERPRISE = 'enterprise2007'


def build_statutory(conn, client, period, trial):
    standard = client['standard']
    if standard not in (SMALL, ENTERPRISE):
        standard = SMALL
    small = standard == SMALL
    closing, begin = _positions(conn, client, period, trial)
    categories = {row['account_code']: row['category'] for row in trial}
    names = {row['account_code']: row['account_name'] for row in trial}
    balance = _balance_sheet(closing, begin, categories, small)
    profit = _profit(conn, client, period, small)
    difference = balance['assets_ending_fen'] - balance['claims_ending_fen']
    notes = [
        '按当前月份的有效凭证和期初余额生成，作废凭证不计入。',
        '年初余额是报表年度1月1日的账面。建账月份晚于1月时，年初按0列示，建账期初只计入期末。',
        '往来不自动重分类。应收账款出现贷方余额时，会以负数留在应收账款，需人工复核是否重分类到预收款项。',
        '利润表不含损益结转凭证，结账后仍按结转前的收入和费用列示。',
        '“其中”只展示明细，不重复计入合计。没有名称为利息的明细时，利息费用等于财务费用。',
    ]
    if not small:
        notes.append('企业会计准则账套沿用这份小企业报表行次：资产减值损失计入营业外支出，公允价值变动计入投资收益。这不是会企01、会企02法定格式。')
    if difference:
        notes.append(f'资产总计与负债及所有者权益总计相差{difference/100:.2f}元，请核对期初和凭证。')
    year, month = int(period[:4]), int(period[5:7])
    return {
        'company': client['name'], 'period': period, 'standard': client['standard'],
        'date': f'{year:04d}-{month:02d}-{calendar.monthrange(year, month)[1]:02d}',
        'balanced': difference == 0, 'difference_fen': difference, 'notes': notes,
        'balance_sheet': {
            'title': '资产负债表', 'form_no': '会小企01表' if small else '管理用表',
            'rows': balance['rows'],
            'assets_ending_fen': balance['assets_ending_fen'], 'assets_begin_fen': balance['assets_begin_fen'],
            'claims_ending_fen': balance['claims_ending_fen'], 'claims_begin_fen': balance['claims_begin_fen'],
        },
        'profit': {
            'title': '利润表', 'form_no': '会小企02表' if small else '管理用表',
            'rows': profit,
        },
    }


def _positions(conn, client, period, trial):
    closing = {row['account_code']: row['closing_debit_fen'] - row['closing_credit_fen'] for row in trial}
    year = period[:4] + '-01'
    if client['start_period'] > year:
        return closing, {code: 0 for code in closing}
    opening = {row['account_code']: row['debit_fen'] - row['credit_fen']
               for row in conn.execute('SELECT account_code,debit_fen,credit_fen FROM opening_balances WHERE client_id=?', (client['id'],))}
    prior = {row['account_code']: row['balance'] for row in conn.execute(
        '''SELECT l.account_code,SUM(l.debit_fen-l.credit_fen) balance
           FROM voucher_lines l JOIN vouchers v ON v.id=l.voucher_id
           WHERE v.client_id=? AND v.status='active' AND v.period>=? AND v.period<?
           GROUP BY l.account_code''', (client['id'], client['start_period'], year))}
    return closing, {code: opening.get(code, 0) + prior.get(code, 0) for code in closing}


def _profit(conn, client, period, small):
    year = period[:4] + '-01'
    rows = [dict(row) for row in conn.execute(
        '''SELECT l.account_code code,a.name name,
                  SUM(CASE WHEN v.period=? THEN l.debit_fen ELSE 0 END) month_debit,
                  SUM(CASE WHEN v.period=? THEN l.credit_fen ELSE 0 END) month_credit,
                  SUM(l.debit_fen) ytd_debit,SUM(l.credit_fen) ytd_credit
           FROM voucher_lines l JOIN vouchers v ON v.id=l.voucher_id
           JOIN accounts a ON a.client_id=l.client_id AND a.code=l.account_code
           WHERE v.client_id=? AND v.status='active' AND v.source_type<>'closing'
             AND v.period BETWEEN ? AND ? AND a.category IN ('income','expense')
           GROUP BY l.account_code,a.name''', (period, period, client['id'], year, period))]
    spec = _profit_spec(small)

    def signed(row, which, style):
        debit = row['month_debit' if which == 'month' else 'ytd_debit']
        credit = row['month_credit' if which == 'month' else 'ytd_credit']
        amount = debit - credit
        return -amount if style == 'income' else amount

    def total(prefixes, style, which):
        return sum(signed(row, which, style) for row in rows if _match(row['code'], prefixes))

    def named(parent, keywords, style, which):
        picked = [row for row in rows if _match(row['code'], (parent,)) and any(word in row['name'] for word in keywords)]
        if not picked:
            return None
        return sum(signed(row, which, style) for row in picked)

    def pair(prefixes, style):
        return total(prefixes, style, 'month'), total(prefixes, style, 'ytd')

    revenue = pair(spec['revenue'], 'income')
    cost = pair(spec['cost'], 'expense')
    taxes = pair(spec['tax'], 'expense')
    selling = pair(spec['selling'], 'expense')
    admin = pair(spec['admin'], 'expense')
    finance = pair(spec['finance'], 'expense')
    investment = pair(spec['investment'], 'income')
    other_income = pair(spec['other_income'], 'income')
    other_expense = pair(spec['other_expense'], 'expense')
    income_tax = pair(spec['income_tax'], 'expense')
    interest = []
    for index, which in enumerate(('month', 'ytd')):
        picked = [row for row in rows if _match(row['code'], spec['finance']) and '利息' in row['name']]
        interest.append(sum(signed(row, which, 'expense') for row in picked) if picked else finance[index])
    interest = tuple(interest)
    operating = tuple(revenue[i] - cost[i] - taxes[i] - selling[i] - admin[i] - finance[i] + investment[i] for i in (0, 1))
    profit_total = tuple(operating[i] + other_income[i] - other_expense[i] for i in (0, 1))
    net = tuple(profit_total[i] - income_tax[i] for i in (0, 1))

    def detail(parent, keywords, style):
        return tuple(named(parent, keywords, style, which) for which in ('month', 'ytd'))

    tax_parent, sell_parent, admin_parent = spec['tax'][0], spec['selling'][0], spec['admin'][0]
    other_in_parent, other_out_parent = spec['other_income'][0], spec['other_expense'][0]
    lines = [
        ('一、营业收入', '1', revenue, False),
        ('    减：营业成本', '2', cost, False),
        ('    税金及附加', '3', taxes, False),
        ('       其中：消费税', '4', detail(tax_parent, ('消费税',), 'expense'), False),
        ('       营业税', '5', detail(tax_parent, ('营业税',), 'expense'), False),
        ('       城市维护建设税', '6', detail(tax_parent, ('城市维护建设税', '城建税'), 'expense'), False),
        ('       资源税', '7', detail(tax_parent, ('资源税',), 'expense'), False),
        ('       土地增值税', '8', detail(tax_parent, ('土地增值税',), 'expense'), False),
        ('       城镇土地使用税、房产税、车船税、印花税', '9', detail(tax_parent, ('城镇土地使用税', '房产税', '车船税', '印花税'), 'expense'), False),
        ('       教育费附加、矿产资源补偿费、排污费', '10', detail(tax_parent, ('教育费附加', '矿产资源补偿费', '排污费'), 'expense'), False),
        ('    销售费用', '11', selling, False),
        ('       其中：商品维修费', '12', detail(sell_parent, ('商品维修费',), 'expense'), False),
        ('       广告费和业务宣传费', '13', detail(sell_parent, ('广告费', '业务宣传费'), 'expense'), False),
        ('    管理费用', '14', admin, False),
        ('       其中：开办费', '15', detail(admin_parent, ('开办费',), 'expense'), False),
        ('       业务招待费', '16', detail(admin_parent, ('业务招待费',), 'expense'), False),
        ('       研究费用', '17', detail(admin_parent, ('研究费用', '研发费用'), 'expense'), False),
        ('    财务费用', '18', finance, False),
        ('       其中：利息费用（收入以“-”号填列）', '19', interest, False),
        ('    加：投资收益', '20', investment, False),
        ('二、营业利润（亏损以"－"号填列）', '21', operating, True),
        ('    加：营业外收入', '22', other_income, False),
        ('       其中：政府补助', '23', detail(other_in_parent, ('政府补助',), 'income'), False),
        ('    减：营业外支出', '24', other_expense, False),
        ('       其中：坏账损失', '25', detail(other_out_parent, ('坏账损失',), 'expense'), False),
        ('       无法收回的长期债券投资损失', '26', detail(other_out_parent, ('长期债券投资损失',), 'expense'), False),
        ('       无法收回的长期股权投资损失', '27', detail(other_out_parent, ('长期股权投资损失',), 'expense'), False),
        ('       自然灾害等不可抗力因素造成的损失', '28', detail(other_out_parent, ('自然灾害', '不可抗力'), 'expense'), False),
        ('       税收滞纳金', '29', detail(other_out_parent, ('滞纳金',), 'expense'), False),
        ('三、利润总额（亏损总额以"－"号填列）', '30', profit_total, True),
        ('    减：所得税费用', '31', income_tax, False),
        ('四、净利润（净亏损以"－"号填列）', '32', net, True),
    ]
    return [{'name': name, 'line': line, 'month_fen': _show(amounts[0], always), 'ytd_fen': _show(amounts[1], always)}
            for name, line, amounts, always in lines]


def _profit_spec(small):
    if small:
        return {'revenue': ('5001', '5051'), 'cost': ('5401', '5402'), 'tax': ('5403',), 'selling': ('5601',),
                'admin': ('5602',), 'finance': ('5603',), 'investment': ('5111',), 'other_income': ('5301',),
                'other_expense': ('5711',), 'income_tax': ('5801',)}
    return {'revenue': ('6001', '6051'), 'cost': ('6401', '6402'), 'tax': ('6403',), 'selling': ('6601',),
            'admin': ('6602',), 'finance': ('6603',), 'investment': ('6111', '6101'), 'other_income': ('6301',),
            'other_expense': ('6711', '6701'), 'income_tax': ('6801',)}


def _balance_sheet(closing, begin, categories, small):
    used = set()

    def take(prefixes):
        codes = [code for code in closing if code not in used and _match(code, prefixes)]
        used.update(codes)
        return _pair(closing, begin, codes)

    def raw(prefixes):
        codes = [code for code in closing if _match(code, prefixes)]
        return _pair(closing, begin, codes)

    spec = _balance_spec(small)
    cash, short, notes_r, ar, prepay, dividend, interest_r, other_r = (take(spec[key]) for key in
        ('cash', 'short', 'notes_r', 'ar', 'prepay', 'dividend', 'interest_r', 'other_r'))
    raw_material, wip, goods, turnover = (raw(spec[key]) for key in ('raw', 'wip', 'goods', 'turnover'))
    inventory = take(spec['inventory'])
    suspense = take(('1901',))
    bond, equity_invest = take(spec['bond']), take(spec['equity_invest'])
    gross, depreciation = raw(spec['gross']), raw(spec['depreciation'])
    book_value = take(spec['book'])
    cip, materials, disposal, biological = take(spec['cip']), take(spec['materials']), take(spec['disposal']), take(spec['biological'])
    intangible, development, deferred = take(spec['intangible']), take(spec['development']), take(spec['deferred'])
    other_current = _zeros()
    other_noncurrent = _zeros()
    for code in list(closing):
        if code in used or categories.get(code) not in ('asset', 'cost'):
            continue
        target = other_noncurrent if code >= '1501' else other_current
        target[0] += closing[code]
        target[1] += begin.get(code, 0)
        used.add(code)
    current_assets = _add(cash, short, notes_r, ar, prepay, dividend, interest_r, other_r, inventory, suspense, other_current)
    noncurrent_assets = _add(bond, equity_invest, book_value, cip, materials, disposal, biological, intangible, development, deferred, other_noncurrent)
    assets = _add(current_assets, noncurrent_assets)

    short_loan, notes_p, ap, advance, payroll, tax, interest_p, profit_p, other_p = (take(spec[key]) for key in
        ('short_loan', 'notes_p', 'ap', 'advance', 'payroll', 'tax_p', 'interest_p', 'profit_p', 'other_p'))
    deferred_income, long_loan, long_pay = take(spec['deferred_income']), take(spec['long_loan']), take(spec['long_pay'])
    capital, reserve, surplus = take(spec['capital']), take(spec['reserve']), take(spec['surplus'])
    retained_accounts = take(spec['retained'])
    other_cl, other_ncl = _zeros(), _zeros()
    leftover_equity = _zeros()
    for code in list(closing):
        if code in used:
            continue
        category = categories.get(code)
        if category == 'liability':
            target = other_ncl if code >= '2401' else other_cl
        elif category == 'equity':
            target = leftover_equity
        else:
            continue
        target[0] += closing[code]
        target[1] += begin.get(code, 0)
        used.add(code)
    unclosed = _zeros()
    for code, category in categories.items():
        if category in ('income', 'expense') and code not in used:
            unclosed[0] += closing[code]
            unclosed[1] += begin.get(code, 0)
            used.add(code)
    current_liab = _add(short_loan, notes_p, ap, advance, payroll, tax, interest_p, profit_p, other_p, other_cl)
    noncurrent_liab = _add(long_loan, long_pay, deferred_income, other_ncl)
    liabilities = _add(current_liab, noncurrent_liab)
    # Income and expense debit-nets are negative when they are profits. Adding
    # them to the equity debit-net keeps a credit profit on 未分配利润.
    retained = _add(retained_accounts, leftover_equity, unclosed)
    equity = _add(capital, reserve, surplus, retained)
    claims = _add(liabilities, equity)

    def asset(name, line, pair, always=False):
        return {'asset_name': name, 'asset_line': line, 'asset_ending_fen': _show(pair[0], always), 'asset_begin_fen': _show(pair[1], always)}

    def claim(name, line, pair, always=False, credit=True):
        values = _negate(pair) if credit else pair
        return {'equity_name': name, 'equity_line': line, 'equity_ending_fen': _show(values[0], always), 'equity_begin_fen': _show(values[1], always)}

    def blank_claim():
        return {'equity_name': '  ', 'equity_line': '', 'equity_ending_fen': None, 'equity_begin_fen': None}

    body = [
        ({**asset('流动资产：', '', _zeros()), **claim('  流动负债：', '', _zeros(), credit=False)}),
        {**asset(I1 + '货币资金', '1', cash), **claim(E1 + '短期借款', '31', short_loan)},
        {**asset(I1 + '短期投资', '2', short), **claim(E1 + '应付票据', '32', notes_p)},
        {**asset(I1 + '应收票据', '3', notes_r), **claim(E1 + '应付账款', '33', ap)},
        {**asset(I1 + '应收账款', '4', ar), **claim(E1 + '预收款项', '34', advance)},
        {**asset(I1 + '预付款项', '5', prepay), **claim(E1 + '应付职工薪酬', '35', payroll)},
        {**asset(I1 + '应收股利', '6', dividend), **claim(E1 + '应交税费', '36', tax)},
        {**asset(I1 + '应收利息', '7', interest_r), **claim(E1 + '应付利息', '37', interest_p)},
        {**asset(I1 + '其他应收款', '8', other_r), **claim(E1 + '应付利润', '38', profit_p)},
        {**asset(I1 + '存货', '9', inventory), **claim(E1 + '其他应付款', '39', other_p)},
        {**asset(I2 + '其中：原材料', '10', raw_material), **blank_claim()},
        {**asset(I2 + '在产品', '11', wip), **blank_claim()},
        {**asset(I2 + '库存商品', '12', goods), **blank_claim()},
        {**asset(I2 + '周转材料', '13', turnover), **blank_claim()},
        {**asset(I1 + '其他流动资产', '14', _add(suspense, other_current)), **claim(E1 + '其他流动负债', '40', other_cl)},
        {**asset(I2 + '流动资产合计', '15', current_assets), **claim(E2 + '流动负债合计', '41', current_liab)},
        {**asset('非流动资产：', '', _zeros()), **claim('  非流动负债：', '', _zeros(), credit=False)},
        {**asset(I1 + '长期债券投资', '16', bond), **claim(E1 + '长期借款', '42', long_loan)},
        {**asset(I1 + '长期股权投资', '17', equity_invest), **claim(E1 + '长期应付款', '43', long_pay)},
        {**asset(I1 + '固定资产原价', '18', gross), **claim(E1 + '递延收益', '44', deferred_income)},
        {**asset(I1 + '减：累计折旧', '19', _negate(depreciation)), **claim(E1 + '其他非流动负债', '45', other_ncl)},
        {**asset(I1 + '固定资产账面价值', '20', book_value), **claim(E2 + '非流动负债合计', '46', noncurrent_liab)},
        {**asset(I1 + '在建工程', '21', cip), **claim('  负债合计', '47', liabilities)},
        {**asset(I1 + '工程物资', '22', materials), **blank_claim()},
        {**asset(I1 + '固定资产清理', '23', disposal), **blank_claim()},
        {**asset(I1 + '生产性生物资产', '24', biological), **claim('  所有者权益（或股东权益）：', '', _zeros(), credit=False)},
        {**asset(I1 + '无形资产', '25', intangible), **claim(E1 + '实收资本（或股本）', '48', capital)},
        {**asset(I1 + '开发支出', '26', development), **claim(E1 + '资本公积', '49', reserve)},
        {**asset(I1 + '长期待摊费用', '27', deferred), **claim(E1 + '盈余公积', '50', surplus)},
        {**asset(I1 + '其他非流动资产', '28', other_noncurrent), **claim(E1 + '未分配利润', '51', retained)},
        {**asset(I2 + '非流动资产合计', '29', noncurrent_assets), **claim('  所有者权益（或股东权益）合计', '52', equity)},
        {**asset('资产总计', '30', assets, True), **claim('  负债和所有者权益（或股东权益）总计', '53', claims, True)},
    ]
    return {'rows': body, 'assets_ending_fen': assets[0], 'assets_begin_fen': assets[1],
            'claims_ending_fen': -claims[0], 'claims_begin_fen': -claims[1]}


def _balance_spec(small):
    if small:
        return {
            'cash': ('1001', '1002', '1012'), 'short': ('1101',), 'notes_r': ('1121',), 'ar': ('1122',),
            'prepay': ('1123',), 'dividend': ('1131',), 'interest_r': ('1132',), 'other_r': ('1221', '1133'),
            'inventory': ('1401', '1402', '1403', '1404', '1405', '1407', '1408', '1411', '1421', '4001', '4101', '4401', '4403'),
            'raw': ('1403', '1404'), 'wip': ('4001', '4101', '4401', '4403'), 'goods': ('1405', '1407', '1408'), 'turnover': ('1411',),
            'bond': ('1501',), 'equity_invest': ('1511',), 'gross': ('1601',), 'depreciation': ('1602',), 'book': ('1601', '1602'),
            'cip': ('1604',), 'materials': ('1605',), 'disposal': ('1606',), 'biological': ('1621', '1622'),
            'intangible': ('1701', '1702'), 'development': ('4301',), 'deferred': ('1801',),
            'short_loan': ('2001',), 'notes_p': ('2201',), 'ap': ('2202',), 'advance': ('2203',), 'payroll': ('2211',),
            'tax_p': ('2221',), 'interest_p': ('2231',), 'profit_p': ('2232',), 'other_p': ('2241',),
            'deferred_income': ('2401',), 'long_loan': ('2501',), 'long_pay': ('2701',),
            'capital': ('3001',), 'reserve': ('3002',), 'surplus': ('3101',), 'retained': ('3103', '3104'),
        }
    return {
        'cash': ('1001', '1002', '1012'), 'short': ('1101',), 'notes_r': ('1121',), 'ar': ('1122', '1231'),
        'prepay': ('1123',), 'dividend': ('1131',), 'interest_r': ('1132',), 'other_r': ('1221',),
        'inventory': ('1401', '1402', '1403', '1404', '1405', '1406', '1407', '1408', '1411', '1471', '5001', '5101', '5201', '5401', '5403'),
        'raw': ('1403', '1404'), 'wip': ('5001', '5101', '5201', '5401', '5403'), 'goods': ('1405', '1406', '1407', '1408', '1471'), 'turnover': ('1411',),
        'bond': ('1501', '1502'), 'equity_invest': ('1511', '1512'), 'gross': ('1601',),
        'cip': ('1604',), 'materials': ('1605',), 'disposal': ('1606',), 'biological': (),
        'intangible': ('1701', '1702', '1703'), 'development': ('5301',), 'deferred': ('1801',),
        'depreciation': ('1602', '1603'), 'book': ('1601', '1602', '1603'),
        'short_loan': ('2001',), 'notes_p': ('2201',), 'ap': ('2202',), 'advance': ('2203',), 'payroll': ('2211',),
        'tax_p': ('2221',), 'interest_p': ('2231',), 'profit_p': ('2232',), 'other_p': ('2241',),
        'deferred_income': ('2401',), 'long_loan': ('2501', '2502'), 'long_pay': ('2701', '2711'),
        'capital': ('4001', '4201'), 'reserve': ('4002',), 'surplus': ('4101',), 'retained': ('4103', '4104'),
    }


def _match(code, prefixes):
    return any(code == prefix or (prefix and code.startswith(prefix)) for prefix in prefixes)


def _pair(closing, begin, codes):
    return [sum(closing[code] for code in codes), sum(begin.get(code, 0) for code in codes)]


def _zeros():
    return [0, 0]


def _add(*pairs):
    return [sum(pair[0] for pair in pairs), sum(pair[1] for pair in pairs)]


def _negate(pair):
    return [-pair[0], -pair[1]]


def _show(value, always=False):
    if value is None:
        return None
    value = int(value)
    if value == 0 and not always:
        return None
    return value
