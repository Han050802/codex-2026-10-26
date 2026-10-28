import base64, json, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'outputs/yidaizhang-local'))
import reconciliation

def item(name, data):
    return {'name': name, 'content_base64': base64.b64encode(data).decode('ascii')}

files = [item('valid-0.png', (HERE / 'synthetic_invoice_0.png').read_bytes()),
         item('damaged.jpg', b'not-a-jpeg'),
         item('valid-180.png', (HERE / 'synthetic_invoice_180.png').read_bytes())]
t0 = time.perf_counter()
result = reconciliation.parse({'invoices': files})
elapsed = time.perf_counter() - t0
expected = {'number': '26112000003789636136', 'date': '2026-09-08', 'buyer': '鸿悦盛嘉（北京）医院管理有限公司', 'seller': '北京超建邦科技有限公司', 'amount': '112000.00'}
checks = {'invoice_count_two': len(result['invoices']) == 2,
          'both_complete': all(all(row.get(k) == v for k,v in expected.items()) for row in result['invoices']),
          'source_order_preserved': [row.get('source') for row in result['invoices']] == ['valid-0.png', 'valid-180.png'],
          'only_broken_file_warned': len(result['warnings']) == 1 and result['warnings'][0].startswith('damaged.jpg：'),
          'no_generic_warning': all('机器识别可能出错' not in w for w in result['warnings'])}
report = {'elapsed_seconds': round(elapsed, 2), 'checks': checks, 'result': result}
(HERE / 'ocr_batch_validation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
print(json.dumps({'elapsed_seconds': report['elapsed_seconds'], 'checks': checks, 'warnings': result['warnings']}, ensure_ascii=True))
if not all(checks.values()): raise SystemExit(1)
