"""Original-file traceability through HTTP, using only isolated synthetic data."""
import base64
from contextlib import closing
import io
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import db
import maintenance
import reconciliation
import server
from test_http import Client


PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
OWN = '归档合成客户'
SUPPLIER = '归档合成供应商'
INVOICE_TEXT = ('电子发票（普通发票）\n发票号码：12345678901234567890\n'
                '开票日期：2026年9月8日\n名称：' + OWN + '\n名称：' + SUPPLIER + '\n'
                '*咨询服务*咨询费\n不含税金额：100.00\n税额合计：0.00\n价税合计 小写：100.00')
RECEIPT_TEXT = ('电子回单（付款）\n回单编号：SYNTH-RECEIPT-1\n日期：20260909\n小写：100.00\n'
                '付款人户名：' + OWN + '\n收款人户名：' + SUPPLIER + '\n摘要：咨询服务费')


def pdf_bytes(label):
    """A valid one-page PDF; text recognition is mocked, file storage is real."""
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
               b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
               b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>',
               b'<< /Length 0 >>\nstream\n\nendstream']
    content = b'%PDF-1.4\n%' + label.encode('ascii') + b'\n'
    offsets = []
    for number, obj in enumerate(objects, 1):
        offsets.append(len(content))
        content += str(number).encode() + b' 0 obj\n' + obj + b'\nendobj\n'
    xref = len(content)
    content += b'xref\n0 5\n0000000000 65535 f \n'
    content += b''.join(('%010d 00000 n \n' % offset).encode() for offset in offsets)
    return content + b'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n' + str(xref).encode() + b'\n%%EOF\n'


def encoded(name, content):
    return {'name': name, 'content_base64': base64.b64encode(content).decode('ascii')}


class SourceArchiveHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ydz-source-archive-http-')
        self.root = Path(self.temp.name)
        self.servers = []
        self.app = server.Application(self.root / 'original')
        self.client = self.start_server(self.app)
        self.users = [{'username': 'archive' + str(i), 'name': '归档合成操作员' + str(i),
                       'password': 'ArchiveOnly-' + str(i) + '-Strong!'} for i in range(1, 4)]
        code, body, _ = self.client.call('/api/setup', {'company_name': '归档合成测试机构', 'users': self.users},
                                         headers={'X-Setup-Token': self.app.setup_token})
        self.assertEqual(code, 200, body)
        self.cid = self.create_client(OWN, 'ARCHIVE-1')
        self.other_cid = self.create_client('另一归档合成客户', 'ARCHIVE-2')

    def tearDown(self):
        for http, thread in reversed(self.servers):
            http.shutdown()
            http.server_close()
            thread.join(timeout=3)
        self.temp.cleanup()

    def start_server(self, app):
        http = server.make_server('127.0.0.1', 0, app)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        self.servers.append((http, thread))
        return Client('http://127.0.0.1:' + str(http.server_address[1]))

    def create_client(self, name, code):
        status, body, _ = self.client.call('/api/clients', {
            'name': name, 'code': code, 'taxpayer_type': 'general', 'standard': 'small2013',
            'start_period': '2026-01', 'industry': '商务服务', 'region': '本地',
            'accountant_id': 1, 'enabled': True})
        self.assertEqual(status, 200, body)
        return body['id']

    def parse_batch(self):
        invoice_pdf = pdf_bytes('invoice-fixture')
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('nested/发票.pdf', invoice_pdf)
        package = buffer.getvalue()
        payload = {'client_id': self.cid, 'statement': encoded('流水.png', PNG),
                   'invoices': [encoded('票据.zip', package)]}
        bank_ocr = {'ok': True, 'orientation_confident': True, 'orientation_candidates_tried': 1,
                    'fields': {'account_name': OWN, 'transactions': [
                        {'date': '2026-09-09', 'amount': '-100.00', 'counterparty': SUPPLIER,
                         'description': '咨询服务费', 'direction_needs_review': False}]}}
        with patch.object(reconciliation, 'extract_pdf', return_value=(INVOICE_TEXT, '')), \
                patch.object(reconciliation.OCRWorker, 'run', return_value=(bank_ocr, '')):
            code, started, _ = self.client.call('/api/reconcile/parse/start', payload)
            self.assertEqual(code, 200, started)
            deadline = time.monotonic() + 5
            while True:
                code, progress, _ = self.client.call('/api/reconcile/parse/progress?job_id=' + started['job_id'])
                self.assertEqual(code, 200, progress)
                if progress.get('status') != 'running':
                    break
                self.assertLess(time.monotonic(), deadline, progress)
                time.sleep(.01)
        self.assertEqual(progress['status'], 'completed', progress)
        result = progress['result']
        self.assertTrue(result.get('archive_id'), result)
        self.assertEqual((len(result['transactions']), len(result['invoices'])), (1, 1))
        originals = {'流水.png': PNG, '票据.zip': package, '票据.zip / nested/发票.pdf': invoice_pdf}
        return result, originals

    def batch_payload(self, parsed, cid=None):
        return {'client_id': cid or self.cid, 'archive_id': parsed['archive_id'],
                'account_name': OWN, 'transactions': parsed['transactions'], 'invoices': parsed['invoices'],
                'evidence': [{'bank_account_code': '1002'}]}

    def post_batch(self, parsed):
        code, posted, _ = self.client.call('/api/reconcile/batch-auto', self.batch_payload(parsed))
        self.assertEqual(code, 200, posted)
        self.assertEqual(posted['rows'][0]['status'], 'posted', posted)
        return posted['rows'][0]

    def sources(self, voucher_id, client=None, cid=None):
        client = client or self.client
        code, body, _ = client.call(f'/api/books/{cid or self.cid}/vouchers/{voucher_id}/sources')
        self.assertEqual(code, 200, body)
        self.assertTrue(body['has_originals'], body)
        self.assertTrue(body['archives'], body)
        return body

    def check_originals(self, sources, expected, client=None):
        client = client or self.client
        files = [file for archive in sources['archives'] for file in archive['files']]
        self.assertEqual({file['source'] for file in files}, set(expected))
        self.assertTrue(any(file['is_container'] for file in files))
        for file in files:
            self.assertTrue(file['available'], file)
            code, content, headers = client.call(file['download_url'])
            self.assertEqual(code, 200, file)
            self.assertEqual(content, expected[file['source']])
            self.assertEqual(file['size'], len(content))
            self.assertIn('attachment', headers['Content-Disposition'])
            if file['name'].lower().endswith('.pdf'):
                code, preview, headers = client.call(file['download_url'] + '&inline=1')
                self.assertEqual(code, 200)
                self.assertEqual(preview, content)
                self.assertTrue(headers['Content-Type'].startswith('application/pdf'))
                self.assertIn('inline', headers['Content-Disposition'])

    def test_pdf_zip_retry_void_history_and_backup_restore(self):
        parsed, originals = self.parse_batch()
        posted = self.post_batch(parsed)
        sources = self.sources(posted['voucher_id'])
        self.check_originals(sources, originals)
        archive = sources['archives'][0]
        self.assertEqual(archive['archive_id'], parsed['archive_id'])
        self.assertEqual(archive['recognized']['invoices'][0]['number'], '12345678901234567890')
        self.assertEqual(archive['recognized']['transactions'][0]['amount'], '-100.00')
        self.assertEqual(len(archive['links']), 1)
        link = archive['links'][0]
        self.assertEqual(link['record_id'], posted['id'])
        self.assertEqual(link['transaction']['counterparty'], SUPPLIER)
        self.assertEqual(link['invoice']['number'], '12345678901234567890')
        self.assertTrue(link['matching_basis'])
        self.assertEqual(link['evidence']['bank_account_code'], '1002')
        self.assertTrue(link['automatic_posting'])

        retried = self.post_batch(parsed)
        self.assertEqual(retried['voucher_id'], posted['voucher_id'])
        self.assertTrue(retried['already_posted'])
        again = self.sources(posted['voucher_id'])
        self.assertEqual(again, sources)
        with closing(db.connect(self.app.db_path)) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0], 1)

        code, removed, _ = self.client.call(f'/api/books/{self.cid}/balance-entries/delete',
                                           {'voucher_id': posted['voucher_id'], 'reason': '合成归档作废验证'})
        self.assertEqual(code, 200, removed)
        with closing(db.connect(self.app.db_path)) as conn:
            self.assertEqual(conn.execute('SELECT status FROM vouchers WHERE id=?', (posted['voucher_id'],)).fetchone()[0], 'void')
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM reconciliation_records').fetchone()[0], 0)
        old_sources = self.sources(posted['voucher_id'])
        old_link = old_sources['archives'][0]['links'][0]
        for key in ('transaction', 'invoice', 'receipt', 'matching_basis', 'evidence', 'classification', 'automatic_posting'):
            self.assertEqual(old_link.get(key), link.get(key), key)
        self.check_originals(old_sources, originals)
        reposted = self.post_batch(parsed)
        self.assertNotEqual(reposted['voucher_id'], posted['voucher_id'])
        self.check_originals(self.sources(reposted['voucher_id']), originals)

        code, backup, _ = self.client.call('/api/backup')
        self.assertEqual(code, 200)
        backup_path = self.root / 'synthetic-backup.zip'
        backup_path.write_bytes(backup)
        restored_dir = self.root / 'restored'
        maintenance.restore(restored_dir, backup_path)
        restored_app = server.Application(restored_dir)
        restored = self.start_server(restored_app)
        user = self.users[0]
        code, body, _ = restored.call('/api/login', {'username': user['username'], 'password': user['password']})
        self.assertEqual(code, 200, body)
        self.check_originals(self.sources(posted['voucher_id'], restored), originals, restored)
        self.check_originals(self.sources(reposted['voucher_id'], restored), originals, restored)

    def test_client_scope_authentication_and_required_client(self):
        for endpoint in ('/api/reconcile/parse', '/api/reconcile/parse/start'):
            code, body, _ = self.client.call(endpoint, {'invoices': [encoded('发票.png', PNG)]})
            self.assertEqual(code, 400, body)
        parsed, _ = self.parse_batch()
        aid = parsed['archive_id']
        code, archive, _ = self.client.call(f'/api/reconcile/archives/{aid}?client_id={self.cid}')
        self.assertEqual(code, 200, archive)
        self.assertEqual(self.client.call(f'/api/reconcile/archives/{aid}?client_id={self.other_cid}')[0], 404)
        code, rejected, _ = self.client.call('/api/reconcile/batch-auto', self.batch_payload(parsed, self.other_cid))
        self.assertIn(code, (400, 404, 409), rejected)
        with closing(db.connect(self.app.db_path)) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0], 0)
        posted = self.post_batch(parsed)
        sources = self.sources(posted['voucher_id'])
        self.assertEqual(self.client.call(f'/api/books/{self.other_cid}/vouchers/{posted["voucher_id"]}/sources')[0], 404)
        anonymous = Client(self.client.base)
        self.assertEqual(anonymous.call(f'/api/books/{self.cid}/vouchers/{posted["voucher_id"]}/sources')[0], 401)
        for file in sources['archives'][0]['files']:
            self.assertEqual(anonymous.call(file['download_url'])[0], 401)
            self.assertEqual(self.client.call('/api/files/' + str(file['id']))[0], 404)
            url = urlsplit(file['download_url'])
            query = parse_qs(url.query)
            query['client_id'] = [str(self.other_cid)]
            wrong_scope = urlunsplit((url.scheme, url.netloc, url.path, urlencode(query, doseq=True), url.fragment))
            self.assertEqual(self.client.call(wrong_scope)[0], 404)
            self.assertIn(self.client.call(url.path)[0], (400, 404))

    def test_receipt_original_is_linked_once(self):
        content = pdf_bytes('receipt-fixture')
        with patch.object(reconciliation, 'extract_pdf', return_value=(RECEIPT_TEXT, '')):
            code, parsed, _ = self.client.call('/api/reconcile/parse', {
                'client_id': self.cid, 'invoices': [encoded('银行回单.pdf', content)]})
        self.assertEqual(code, 200, parsed)
        self.assertEqual(len(parsed['receipts']), 1)
        payload = {'client_id': self.cid, 'archive_id': parsed['archive_id'], 'account_name': OWN,
                   'transactions': parsed['transactions'], 'receipts': parsed['receipts'], 'invoices': []}
        code, out, _ = self.client.call('/api/reconcile/receipt-post', payload)
        self.assertEqual(code, 200, out)
        self.assertEqual(out['rows'][0]['status'], 'posted', out)
        vid = out['rows'][0]['voucher_id']
        first = self.sources(vid)
        link = first['archives'][0]['links'][0]
        self.assertEqual(link['receipt']['number'], 'SYNTH-RECEIPT-1')
        self.assertEqual(link['transaction']['amount'], '-100.00')
        code, downloaded, _ = self.client.call(first['archives'][0]['files'][0]['download_url'])
        self.assertEqual(code, 200)
        self.assertEqual(downloaded, content)
        code, repeated, _ = self.client.call('/api/reconcile/receipt-post', payload)
        self.assertEqual(code, 200, repeated)
        self.assertEqual(repeated['rows'][0]['voucher_id'], vid)
        self.assertEqual(self.sources(vid), first)

    def test_same_names_keep_all_batch_originals_and_only_voucher_matches(self):
        first_pdf, unmatched_pdf = pdf_bytes('matched'), pdf_bytes('unmatched')
        statement = {'ok': True, 'fields': {'account_name': OWN, 'transactions': [
            {'date': '2026-09-09', 'amount': '-100.00', 'counterparty': SUPPLIER,
             'description': '咨询服务费', 'direction_needs_review': False}]}}
        def read_pdf(content):
            text = INVOICE_TEXT
            if content == unmatched_pdf:
                text = text.replace('12345678901234567890', '12345678901234567891').replace('100.00', '200.00')
            return text, ''
        with patch.object(reconciliation, 'extract_pdf', side_effect=read_pdf), \
                patch.object(reconciliation.OCRWorker, 'run', return_value=(statement, '')):
            code, parsed, _ = self.client.call('/api/reconcile/parse', {
                'client_id': self.cid, 'statement': encoded('流水.png', PNG),
                'invoices': [encoded('同名发票.pdf', first_pdf), encoded('同名发票.pdf', unmatched_pdf)]})
        self.assertEqual(code, 200, parsed)
        self.assertEqual(len(parsed['invoices']), 2)
        recognized_sources = [invoice['source'] for invoice in parsed['invoices']]
        self.assertEqual(len(set(recognized_sources)), 2)
        posted = self.post_batch(parsed)
        code, whole, _ = self.client.call(f'/api/reconcile/archives/{parsed["archive_id"]}?client_id={self.cid}')
        self.assertEqual(code, 200, whole)
        whole_files = whole['archives'][0]['files']
        self.assertEqual(len(whole_files), 3)
        pdf_files = [file for file in whole_files if file['name'].endswith('.pdf')]
        self.assertEqual([file['name'] for file in pdf_files], ['同名发票.pdf', '同名发票.pdf'])
        for file, expected in zip(pdf_files, (first_pdf, unmatched_pdf)):
            code, content, headers = self.client.call(file['download_url'])
            self.assertEqual(code, 200)
            self.assertEqual(content, expected)
            self.assertNotIn('%282%29', headers['Content-Disposition'])
        linked = self.sources(posted['voucher_id'])
        linked_files = linked['archives'][0]['files']
        self.assertEqual({file['source'] for file in linked_files}, {'流水.png', recognized_sources[0]})
        self.assertNotIn(recognized_sources[1], {file['source'] for file in linked_files})

    def test_saved_record_carries_archive_to_later_manual_posting(self):
        parsed, originals = self.parse_batch()
        payload = {'client_id': self.cid, 'archive_id': parsed['archive_id'], 'account_name': OWN,
                   'transaction': parsed['transactions'][0], 'invoice': parsed['invoices'][0],
                   'batch': {'transactions': parsed['transactions'], 'invoices': parsed['invoices'],
                             'transaction_index': 0, 'invoice_index': 0}}
        code, saved, _ = self.client.call('/api/reconcile/save', payload)
        self.assertEqual(code, 200, saved)
        self.assertNotIn('voucher_id', saved)
        code, history, _ = self.client.call(f'/api/reconcile/records?client_id={self.cid}')
        self.assertEqual(code, 200, history)
        record = next(row for row in history['records'] if row['id'] == saved['id'])
        self.assertIn(parsed['archive_id'], record['archive_ids'])
        code, before, _ = self.client.call(f'/api/reconcile/records/{saved["id"]}/sources?client_id={self.cid}')
        self.assertEqual(code, 200, before)
        self.assertIsNone(before['archives'][0]['links'][0]['voucher_id'])
        voucher = {'date': '2026-09-09', 'summary': '归档后手工确认凭证', 'lines': [
            {'account_code': '5602', 'debit_fen': 10000, 'credit_fen': 0},
            {'account_code': '1002', 'debit_fen': 0, 'credit_fen': 10000}]}
        code, posted, _ = self.client.call(f'/api/reconcile/records/{saved["id"]}/post',
                                          {'client_id': self.cid, 'voucher': voucher})
        self.assertEqual(code, 200, posted)
        sources = self.sources(posted['voucher_id'])
        self.assertEqual(sources['archives'][0]['links'][0]['record_id'], saved['id'])
        self.check_originals(sources, originals)

        # A deleted record ID may be reused; the old voucher snapshot must stay intact.
        code, removed, _ = self.client.call(f'/api/books/{self.cid}/balance-entries/delete',
                                           {'voucher_id': posted['voucher_id'], 'reason': '合成手工凭证重做'})
        self.assertEqual(code, 200, removed)
        code, pending, _ = self.client.call('/api/reconcile/save', payload)
        self.assertEqual(code, 200, pending)
        old_link = self.sources(posted['voucher_id'])['archives'][0]['links'][0]
        for key in ('transaction', 'invoice', 'receipt', 'matching_basis', 'evidence', 'classification', 'automatic_posting'):
            self.assertEqual(old_link.get(key), sources['archives'][0]['links'][0].get(key), key)
        code, pending_sources, _ = self.client.call(f'/api/reconcile/records/{pending["id"]}/sources?client_id={self.cid}')
        self.assertEqual(code, 200, pending_sources)
        self.assertEqual(len(pending_sources['archives'][0]['links']), 1)
        self.assertIsNone(pending_sources['archives'][0]['links'][0]['voucher_id'])
        file_id = pending_sources['archives'][0]['files'][0]['id']
        with closing(db.connect(self.app.db_path)) as conn:
            stored = conn.execute('SELECT path FROM files WHERE id=?', (file_id,)).fetchone()
        original_path = self.app.files_dir / stored['path']
        original_bytes = original_path.read_bytes()
        for fault in ('damaged', 'missing'):
            with self.subTest(pending_fault=fault):
                if fault == 'damaged':
                    original_path.write_bytes(b'x' * len(original_bytes))
                else:
                    original_path.unlink()
                code, rejected, _ = self.client.call(f'/api/reconcile/records/{pending["id"]}/post',
                                                     {'client_id': self.cid, 'voucher': voucher})
                self.assertEqual(code, 409, rejected)
                with closing(db.connect(self.app.db_path)) as conn:
                    self.assertEqual(conn.execute("SELECT COUNT(*) FROM vouchers WHERE status='active'").fetchone()[0], 0)
                original_path.write_bytes(original_bytes)
        code, replacement, _ = self.client.call(f'/api/reconcile/records/{pending["id"]}/post',
                                               {'client_id': self.cid, 'voucher': voucher})
        self.assertEqual(code, 200, replacement)
        self.assertNotEqual(replacement['voucher_id'], posted['voucher_id'])
        self.check_originals(self.sources(replacement['voucher_id']), originals)
        self.check_originals(self.sources(posted['voucher_id']), originals)

    def test_damaged_or_missing_original_does_not_leave_a_posted_voucher(self):
        parsed, _ = self.parse_batch()
        code, archive, _ = self.client.call(f'/api/reconcile/archives/{parsed["archive_id"]}?client_id={self.cid}')
        self.assertEqual(code, 200, archive)
        files = archive['archives'][0]['files']
        file_id = next(file['id'] for file in files if not file['is_container'])
        with closing(db.connect(self.app.db_path)) as conn:
            row = conn.execute('SELECT path FROM files WHERE id=?', (file_id,)).fetchone()
        original_path = self.app.files_dir / row['path']
        for fault in ('damaged', 'missing'):
            with self.subTest(fault=fault):
                if fault == 'damaged':
                    original_path.write_bytes(b'synthetic damaged original')
                else:
                    original_path.unlink()
                code, out, _ = self.client.call('/api/reconcile/batch-auto', self.batch_payload(parsed))
                if code == 200:
                    self.assertTrue(all(row['status'] != 'posted' for row in out['rows']), out)
                else:
                    self.assertIn(code, (400, 404, 409), out)
                with closing(db.connect(self.app.db_path)) as conn:
                    self.assertEqual(conn.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0], 0)
                    self.assertEqual(conn.execute('SELECT COUNT(*) FROM reconciliation_records').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
