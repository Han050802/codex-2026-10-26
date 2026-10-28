"""Conservative extraction of invoice details; empty means unknown, not zero."""
import re
import unicodedata


def extract_details(text):
    text = unicodedata.normalize('NFKC', str(text or ''))
    # Tax classification markers bound the start of invoice line names. Do not
    # guess names from arbitrary company names, remarks, or standalone numbers.
    items = re.findall(r'\*[^*\r\n]{1,40}\*[\u4e00-\u9fffA-Za-z（）()·_-]{1,50}', text)
    if not items:
        items = re.findall(r'(?:项目名称|货物或应税劳务、服务名称)\s*[:：]\s*([^\r\n]{1,100})', text)
    names = list(dict.fromkeys(items))
    ordinary=bool(re.search(r'增值税普通发票|电子发票\s*[（(]?\s*普通发票',text))
    special=bool(re.search(r'增值税专用发票|电子发票\s*[（(]\s*增值税专用发票\s*[）)]',text))
    def labelled_amount(labels):
        found = []
        for label in labels:
            found.extend(re.findall(r'(?<![\u4e00-\u9fff])' + label + r'\s*[:：]\s*[¥￥]?\s*(-?[\d,]+\.\d{2})(?!\d)', text))
        values = list(dict.fromkeys(v.replace(',', '') for v in found))
        return values[0] if len(values) == 1 else ''
    return {'item_name': '；'.join(names), 'invoice_type': 'ordinary' if ordinary and not special else ('special' if special and not ordinary else ''),
            'net_amount': labelled_amount(('不含税金额', '金额合计')),
            'tax_amount': labelled_amount(('税额合计', '合计税额')),
            'business_purpose': ''}
