import json, subprocess, sys, time, zipfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OLD = HERE / 'ocr_before.py'
NEW = ROOT / 'outputs/yidaizhang-local/reconciliation_ocr.py'
if not OLD.exists():
    with zipfile.ZipFile(ROOT / 'outputs/yidaizhang-local-v1.zip') as archive:
        OLD.write_bytes(archive.read('yidaizhang-local/reconciliation_ocr.py'))
font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 32)
bold = ImageFont.truetype('C:/Windows/Fonts/msyhbd.ttc', 46)
im = Image.new('RGB', (1600, 900), 'white')
d = ImageDraw.Draw(im)
d.text((500, 36), '电子发票（增值税专用发票）', font=bold, fill='black')
d.text((95, 125), '发票号码：26112000003789636136', font=font, fill='black')
d.text((870, 125), '开票日期：2026年09月08日', font=font, fill='black')
d.text((95, 220), '购买方信息', font=font, fill='black')
d.text((95, 280), '名称：鸿悦盛嘉（北京）医院管理有限公司', font=font, fill='black')
d.text((900, 220), '销售方信息', font=font, fill='black')
d.text((900, 280), '名称：北京超建邦科技有限公司', font=font, fill='black')
d.text((95, 390), '项目名称', font=font, fill='black')
d.text((95, 450), '*现代服务*服务费', font=font, fill='black')
d.text((900, 450), '金额：105660.38', font=font, fill='black')
d.text((95, 590), '价税合计', font=font, fill='black')
d.text((900, 590), '小写：￥112000.00', font=font, fill='black')
d.line((80, 195, 1520, 195), fill='black', width=2)
d.line((80, 355, 1520, 355), fill='black', width=2)
d.line((80, 555, 1520, 555), fill='black', width=2)
for angle in [0, 90, 180, 270]:
    (im if not angle else im.rotate(angle, expand=True)).save(HERE / f'synthetic_invoice_{angle}.png')
mode = sys.argv[1] if len(sys.argv) > 1 else 'before'
script = OLD if mode == 'before' else NEW
results = []
for angle in [0, 90, 180, 270]:
    start = time.perf_counter()
    p = subprocess.run([sys.executable, '-X', 'utf8', str(script), str(HERE / f'synthetic_invoice_{angle}.png'), 'invoice'], capture_output=True, text=True, encoding='utf8', timeout=180)
    elapsed = time.perf_counter() - start
    try: data = json.loads(p.stdout)
    except ValueError: data = {'error': p.stdout[:500], 'stderr': p.stderr[:500]}
    result = {'input_rotation': angle, 'seconds': round(elapsed, 2), 'returncode': p.returncode, 'rotation_ccw': data.get('rotation_ccw'), 'fields': data.get('fields'), 'error': data.get('error')}
    fields = result.get('fields') or {}
    result['fields_correct'] = all([
        fields.get('invoice_number') == '26112000003789636136',
        fields.get('invoice_date') == '2026-09-08',
        fields.get('buyer_name') == '鸿悦盛嘉（北京）医院管理有限公司',
        fields.get('seller_name') == '北京超建邦科技有限公司',
        fields.get('total_amount') == '112000.00',
    ])
    print(json.dumps(result, ensure_ascii=False), flush=True)
    results.append(result)
(HERE / f'ocr_{mode}_measurements.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf8')
