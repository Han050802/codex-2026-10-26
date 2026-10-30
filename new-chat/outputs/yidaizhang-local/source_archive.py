"""Local source documents and immutable recognition/posting evidence.

Bytes use the existing files registry so normal backup/restore includes them.
The public API exposes identifiers only, never storage paths.
"""
import base64
import hashlib
import json
import re
import secrets
from contextlib import closing
from functools import lru_cache
from pathlib import Path

import db
from db import ApiError, now


def init_schema(conn):
    conn.executescript('''
    CREATE TABLE IF NOT EXISTS source_archives(
        id TEXT PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id),
        fingerprint TEXT NOT NULL, recognized_json TEXT NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
        UNIQUE(client_id,fingerprint));
    CREATE TABLE IF NOT EXISTS source_archive_files(
        archive_id TEXT NOT NULL REFERENCES source_archives(id),
        file_id INTEGER NOT NULL REFERENCES files(id), source TEXT NOT NULL,
        kind TEXT NOT NULL, is_container INTEGER NOT NULL DEFAULT 0,
        container_source TEXT NOT NULL DEFAULT '', PRIMARY KEY(archive_id,file_id));
    CREATE TABLE IF NOT EXISTS source_archive_links(
        id INTEGER PRIMARY KEY, archive_id TEXT NOT NULL REFERENCES source_archives(id),
        client_id INTEGER NOT NULL REFERENCES clients(id),
        record_id INTEGER REFERENCES reconciliation_records(id) ON DELETE SET NULL,
        voucher_id INTEGER REFERENCES vouchers(id), source_key TEXT NOT NULL,
        final_json TEXT NOT NULL, basis_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(archive_id,source_key));
    CREATE INDEX IF NOT EXISTS source_links_voucher ON source_archive_links(client_id,voucher_id);
    CREATE INDEX IF NOT EXISTS source_links_record ON source_archive_links(client_id,record_id);
    ''')


def client_id(conn, value):
    if isinstance(value, bool): raise ApiError(400, '请选择客户账套后上传原件')
    try: cid = int(value)
    except (TypeError, ValueError): raise ApiError(400, '请选择客户账套后上传原件')
    if not conn.execute('SELECT 1 FROM clients WHERE id=? AND deleted=0', (cid,)).fetchone():
        raise ApiError(404, '客户账套不存在')
    return cid


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def prepare_payload(conn, payload):
    """Give same-named uploads distinct source names before the parser sees them."""
    client_id(conn, payload.get('client_id'))
    prepared = dict(payload)
    used = set()
    def prepare(item):
        if not isinstance(item, dict): raise ApiError(400, '文件格式错误')
        item = dict(item)
        original = item.get('name')
        if not isinstance(original, str) or not original: raise ApiError(400, '文件名无效')
        candidate, index = original, 1
        while candidate in used:
            index += 1
            path = Path(original)
            candidate = path.stem[:175] + ' (%s)' % index + path.suffix
        used.add(candidate)
        item['name'] = candidate
        item['_archive_original_name'] = original
        return item
    if prepared.get('statement'): prepared['statement'] = prepare(prepared['statement'])
    invoices = prepared.get('invoices', [])
    if not isinstance(invoices, list): raise ApiError(400, '发票文件数量无效')
    prepared['invoices'] = [prepare(item) for item in invoices]
    return prepared


def _files_dir(conn):
    filename = next(row[2] for row in conn.execute('PRAGMA database_list') if row[1] == 'main')
    return (Path(filename).resolve().parent / 'files').resolve()


def _file_path(conn, row):
    directory = _files_dir(conn)
    target = (directory / row['path']).resolve()
    if target.parent != directory or not target.is_file():
        raise ApiError(409, '归档原件缺失，请恢复附件备份后重试')
    return target


@lru_cache(maxsize=256)
def _digest(path, size, mtime_ns, ctime_ns):
    # The cache retains digests only; any normal file modification invalidates it.
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _verify_file(conn, row):
    target = _file_path(conn, row)
    info = target.stat()
    if info.st_size != row['size'] or _digest(str(target), info.st_size, info.st_mtime_ns, info.st_ctime_ns) != row['sha256']:
        raise ApiError(409, '归档原件完整性校验失败，请恢复附件备份后重试')
    return target


def capture(app, payload, recognized, user):
    """Called only after successful parsing, with a separate worker connection."""
    import reconciliation
    originals = []
    statement = payload.get('statement')
    groups = ([('statement', statement)] if statement else []) + [('invoice', item) for item in payload.get('invoices', [])]
    count = 0
    for kind, item in groups:
        members = reconciliation.files_from(item)
        count += len(members)
        if count > reconciliation.MAX_FILES: raise ApiError(400, '文件数量超过 30')
        content = base64.b64decode(item['content_base64'], validate=True)
        if len(content) > 10 * 1024 * 1024: raise ApiError(413, '每份原件不得超过10MB')
        name = item['name']
        if any(ord(c) < 32 for c in name): raise ApiError(400, '文件名无效')
        is_zip = Path(name).suffix.lower() == '.zip'
        originals.append((name, content, kind, is_zip, '', item.get('_archive_original_name', name)))
        if is_zip:
            originals.extend((source, content, kind, False, name, Path(source).name) for source, content in members)
    if not originals: raise ApiError(400, '请上传需要识别和归档的原件')
    fingerprint = hashlib.sha256(_json({'files': [(name, kind, hashlib.sha256(content).hexdigest()) for name, content, kind, _, _, _ in originals], 'recognized': recognized}).encode()).hexdigest()
    written = []
    with app.lock, closing(db.connect(app.db_path)) as conn:
        cid = client_id(conn, payload.get('client_id'))
        existing = conn.execute('SELECT id FROM source_archives WHERE client_id=? AND fingerprint=?', (cid, fingerprint)).fetchone()
        if existing:
            validate(conn, cid, existing['id'])
            return dict(recognized, archive_id=existing['id'])
        ident = secrets.token_urlsafe(24)
        try:
            with conn:
                conn.execute('INSERT INTO source_archives VALUES(?,?,?,?,?,?)', (ident, cid, fingerprint, _json(recognized), user['id'], now()))
                for source, content, kind, container, parent, original_name in originals:
                    filename = secrets.token_hex(24) + Path(source).suffix.lower()
                    target = app.files_dir / filename
                    with target.open('xb') as output:
                        written.append(target)
                        output.write(content)
                    cur = conn.execute('INSERT INTO files(name,path,size,sha256,user_id,created_at) VALUES(?,?,?,?,?,?)',
                                       (original_name, filename, len(content), hashlib.sha256(content).hexdigest(), user['id'], now()))
                    conn.execute('INSERT INTO source_archive_files VALUES(?,?,?,?,?,?)', (ident, cur.lastrowid, source, kind, int(container), parent))
                db.audit(conn, user, 'source_archive', 'source_archives', ident, {'client_id': cid, 'file_count': len(originals)})
        except Exception:
            for target in written: target.unlink(missing_ok=True)
            raise
    return dict(recognized, archive_id=ident)


def validate(conn, cid, archive_id):
    if archive_id in (None, ''): return None
    if not isinstance(archive_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{24,64}', archive_id):
        raise ApiError(400, '原件归档标识无效')
    row = conn.execute('SELECT * FROM source_archives WHERE id=? AND client_id=?', (archive_id, cid)).fetchone()
    if not row: raise ApiError(404, '原件归档不存在或不属于当前账套')
    files = conn.execute('SELECT f.* FROM source_archive_files af JOIN files f ON f.id=af.file_id WHERE af.archive_id=?', (archive_id,)).fetchall()
    if not files: raise ApiError(409, '归档没有原件，不能关联凭证')
    for item in files: _verify_file(conn, item)
    return dict(row)


def attach(conn, cid, archive_id, user, transaction, invoice=None, receipt=None,
           record_id=None, voucher_id=None, basis=None):
    if not archive_id: return
    validate(conn, cid, archive_id)
    if record_id and not conn.execute('SELECT 1 FROM reconciliation_records WHERE id=? AND client_id=?', (record_id, cid)).fetchone():
        raise ApiError(404, '核对记录不属于当前账套')
    if voucher_id and not conn.execute('SELECT 1 FROM vouchers WHERE id=? AND client_id=?', (voucher_id, cid)).fetchone():
        raise ApiError(404, '凭证不属于当前账套')
    sources = {row['source'] for row in conn.execute('SELECT source FROM source_archive_files WHERE archive_id=? AND is_container=0', (archive_id,))}
    for value in (transaction, invoice, receipt):
        if isinstance(value, dict) and value.get('source') and value['source'] not in sources:
            raise ApiError(400, '所选归档与本次单据来源不一致，请重新上传识别')
    import reconciliation
    key = 'record:' + str(record_id) if record_id else 'transaction:' + reconciliation._transaction_key(transaction)
    if voucher_id and conn.execute('SELECT 1 FROM source_archive_links WHERE archive_id=? AND client_id=? AND voucher_id=?', (archive_id, cid, voucher_id)).fetchone():
        # Repeat matching must not replace the evidence captured at posting.
        return
    # Record IDs may be reused after withdrawal. Only the current unposted link
    # may change; a deleted record or any posted snapshot is always retained.
    previous = (conn.execute('SELECT * FROM source_archive_links WHERE archive_id=? AND record_id=? AND voucher_id IS NULL ORDER BY id DESC LIMIT 1', (archive_id, record_id)).fetchone()
                if record_id else conn.execute('SELECT * FROM source_archive_links WHERE archive_id=? AND source_key=? AND voucher_id IS NULL', (archive_id, key)).fetchone())
    final = {'transaction': transaction, 'invoice': invoice, 'receipt': receipt}
    final_json, basis_json = _json(final), _json(basis or {})
    if not previous and conn.execute('SELECT 1 FROM source_archive_links WHERE archive_id=? AND source_key=?', (archive_id, key)).fetchone():
        key += (':voucher:' + str(voucher_id)) if voucher_id else ':pending:' + secrets.token_urlsafe(12)
    if previous:
        if (previous['final_json'], previous['basis_json'], previous['voucher_id']) == (final_json, basis_json, voucher_id or previous['voucher_id']): return
        conn.execute('UPDATE source_archive_links SET record_id=?,voucher_id=COALESCE(?,voucher_id),final_json=?,basis_json=?,updated_at=? WHERE id=?',
                     (record_id, voucher_id, final_json, basis_json, now(), previous['id']))
    else:
        conn.execute('INSERT INTO source_archive_links(archive_id,client_id,record_id,voucher_id,source_key,final_json,basis_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
                     (archive_id, cid, record_id, voucher_id, key, final_json, basis_json, now(), now()))
    db.audit(conn, user, 'link_source_archive', 'source_archives', archive_id, {'client_id': cid, 'record_id': record_id, 'voucher_id': voucher_id})


def post_record(conn, cid, record_id, voucher_id):
    # Never rewrite evidence retained by a previously withdrawn voucher.
    pending = conn.execute('SELECT * FROM source_archive_links WHERE client_id=? AND record_id=? AND voucher_id IS NULL', (cid, record_id)).fetchall()
    if not pending: return
    record = conn.execute('SELECT transaction_json,invoice_json FROM reconciliation_records WHERE client_id=? AND id=?', (cid, record_id)).fetchone()
    voucher = conn.execute('SELECT date,period,number,summary FROM vouchers WHERE client_id=? AND id=?', (cid, voucher_id)).fetchone()
    lines = [dict(row) for row in conn.execute('SELECT account_code,debit_fen,credit_fen,summary FROM voucher_lines WHERE client_id=? AND voucher_id=? ORDER BY id', (cid, voucher_id))]
    for link in pending:
        validate(conn, cid, link['archive_id'])
        final, basis = json.loads(link['final_json']), json.loads(link['basis_json'])
        if record: final.update(transaction=json.loads(record['transaction_json']), invoice=json.loads(record['invoice_json']))
        if voucher: basis['posted_voucher'] = dict(voucher, lines=lines)
        conn.execute('UPDATE source_archive_links SET voucher_id=?,final_json=?,basis_json=?,updated_at=? WHERE id=?',
                     (voucher_id, _json(final), _json(basis), now(), link['id']))


def archive_ids(conn, cid, record_id):
    return [row['archive_id'] for row in conn.execute('SELECT DISTINCT archive_id FROM source_archive_links WHERE client_id=? AND record_id=? ORDER BY archive_id', (cid, record_id))]


def _archive_view(conn, row, links=None):
    ident, cid = row['id'], row['client_id']
    scoped = links is not None
    if links is None:
        links = conn.execute('SELECT * FROM source_archive_links WHERE archive_id=? ORDER BY id', (ident,)).fetchall()
    used = set()
    snapshots = []
    for link in links:
        final, basis = json.loads(link['final_json']), json.loads(link['basis_json'])
        used.update(value.get('source') for value in final.values() if isinstance(value, dict) and value.get('source'))
        snapshots.append({'record_id': link['record_id'], 'voucher_id': link['voucher_id'], **final,
                          'matching_basis': basis.get('matching_basis', []), **basis,
                          'created_at': link['created_at'], 'updated_at': link['updated_at']})
    files = []
    all_files = conn.execute('SELECT f.*,af.source,af.kind,af.is_container,af.container_source FROM source_archive_files af JOIN files f ON f.id=af.file_id WHERE af.archive_id=? ORDER BY f.id', (ident,)).fetchall()
    containers = {item['container_source'] for item in all_files if item['source'] in used and item['container_source']}
    for item in all_files:
        relevant = not scoped or item['source'] in used or (item['is_container'] and item['source'] in containers)
        if not relevant: continue
        try: _verify_file(conn, item); available = True
        except ApiError: available = False
        files.append({'id': item['id'], 'name': item['name'], 'size': item['size'], 'sha256': item['sha256'],
                      'source': item['source'], 'kind': item['kind'], 'is_container': bool(item['is_container']),
                      'container_source': item['container_source'], 'available': available,
                      'download_url': '/api/reconcile/archives/%s/files/%s?client_id=%s' % (ident, item['id'], cid)})
    return {'archive_id': ident, 'client_id': cid, 'created_at': row['created_at'], 'files': files,
            'recognized': json.loads(row['recognized_json']), 'links': snapshots}


def sources(conn, cid, voucher_id=None, record_id=None, archive_id=None):
    cid = client_id(conn, cid)
    links = None
    if voucher_id is not None:
        if not conn.execute('SELECT 1 FROM vouchers WHERE id=? AND client_id=?', (voucher_id, cid)).fetchone(): raise ApiError(404, '凭证不存在')
        links = conn.execute('SELECT * FROM source_archive_links WHERE client_id=? AND voucher_id=? ORDER BY id', (cid, voucher_id)).fetchall()
    elif record_id is not None:
        if not conn.execute('SELECT 1 FROM reconciliation_records WHERE id=? AND client_id=?', (record_id, cid)).fetchone(): raise ApiError(404, '核对记录不存在')
        links = conn.execute('SELECT * FROM source_archive_links WHERE client_id=? AND record_id=? ORDER BY id', (cid, record_id)).fetchall()
    if links is None:
        if not isinstance(archive_id, str): raise ApiError(400, '请选择原件归档')
        rows = conn.execute('SELECT * FROM source_archives WHERE id=? AND client_id=?', (archive_id, cid)).fetchall()
        if not rows: raise ApiError(404, '原件归档不存在或不属于当前账套')
    else:
        ids = list(dict.fromkeys(item['archive_id'] for item in links))
        rows = [conn.execute('SELECT * FROM source_archives WHERE id=? AND client_id=?', (ident, cid)).fetchone() for ident in ids]
    archives = [_archive_view(conn, row, None if links is None else [item for item in links if item['archive_id'] == row['id']]) for row in rows]
    return {'client_id': cid, 'voucher_id': voucher_id, 'record_id': record_id,
            'has_originals': any(item['files'] for item in archives), 'archives': archives}


def download(conn, cid, archive_id, file_id):
    cid = client_id(conn, cid)
    row = conn.execute('SELECT f.* FROM source_archives a JOIN source_archive_files af ON af.archive_id=a.id JOIN files f ON f.id=af.file_id WHERE a.id=? AND a.client_id=? AND f.id=?', (archive_id, cid, file_id)).fetchone()
    if not row: raise ApiError(404, '归档原件不存在或不属于当前账套')
    content = _file_path(conn, row).read_bytes()
    if len(content) != row['size'] or hashlib.sha256(content).hexdigest() != row['sha256']:
        raise ApiError(409, '原件完整性校验失败，请恢复附件备份')
    return row['name'], content
