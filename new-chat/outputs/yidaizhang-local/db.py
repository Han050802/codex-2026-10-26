"""Shared SQLite and validation utilities. Monetary values are integer fen."""
import datetime as _dt
import json
import sqlite3
from pathlib import Path


class ApiError(Exception):
    def __init__(self, status, message, details=None):
        super().__init__(message)
        self.status, self.message, self.details = status, message, details


def now():
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec='seconds')


def connect(db_path):
    conn = sqlite3.connect(str(db_path), timeout=20)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys=ON')
    conn.execute('PRAGMA busy_timeout=20000')
    return conn


def amount(value):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 900000000000000:
        raise ApiError(400, '金额必须是非负整数分，且不能超出限额')
    return value


def audit(conn, user, action, entity, entity_id, detail):
    from client_profile import scrub_audit
    detail=scrub_audit(detail)
    conn.execute('INSERT INTO audit_logs(user_id,username,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?)',
                 ((user or {}).get('id'), (user or {}).get('username', 'system'), str(action), str(entity), str(entity_id),
                  json.dumps(detail, ensure_ascii=False, default=str), now()))


def valid_industry(value):
    """Normalize a reusable industry, excluding invalid legacy values."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if value and len(value) <= 80 and '\x00' not in value else None


def remember_industry(conn, value):
    """Record an industry in the caller's customer-write transaction."""
    value = valid_industry(value)
    if value:
        conn.execute('INSERT OR IGNORE INTO client_industries(name,name_key,created_at) VALUES(?,?,?)',
                     (value, value.casefold(), now()))


def industry_names(conn):
    """Return saved and legacy customer industries without changing the database."""
    names = {}
    for row in conn.execute('SELECT name FROM client_industries ORDER BY rowid'):
        value = valid_industry(row['name'])
        if value:
            names.setdefault(value.casefold(), value)
    for row in conn.execute('SELECT industry FROM clients ORDER BY id'):
        value = valid_industry(row['industry'])
        if value:
            names.setdefault(value.casefold(), value)
    return sorted(names.values(), key=str.casefold)


def initialize(db_path):
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = connect(db_path)
    conn.execute('PRAGMA journal_mode=WAL')
    conn.executescript('''
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password_hash TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,created_at TEXT NOT NULL,expires_at REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_logs(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),username TEXT NOT NULL,action TEXT NOT NULL,entity TEXT NOT NULL,entity_id TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS clients(id INTEGER PRIMARY KEY,name TEXT NOT NULL,code TEXT NOT NULL UNIQUE,taxpayer_type TEXT NOT NULL,standard TEXT NOT NULL,industry TEXT NOT NULL DEFAULT '',region TEXT NOT NULL DEFAULT '',start_period TEXT NOT NULL,accountant_id INTEGER REFERENCES users(id),enabled INTEGER NOT NULL DEFAULT 1,labels TEXT NOT NULL DEFAULT '[]',service_status TEXT NOT NULL DEFAULT 'unset',note TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS client_industries(name TEXT NOT NULL COLLATE NOCASE UNIQUE,name_key TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES clients(id),text TEXT NOT NULL,user_id INTEGER REFERENCES users(id),created_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS files(id INTEGER PRIMARY KEY,name TEXT NOT NULL,path TEXT UNIQUE NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,user_id INTEGER REFERENCES users(id),created_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES clients(id),period TEXT NOT NULL,kind TEXT NOT NULL,number TEXT NOT NULL,date TEXT NOT NULL,category TEXT NOT NULL DEFAULT '',summary TEXT NOT NULL DEFAULT '',amount_fen INTEGER NOT NULL,tax_fen INTEGER NOT NULL,total_fen INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'unprocessed',voucher_id INTEGER,attachment_id INTEGER REFERENCES files(id),version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(client_id,number));
    CREATE TABLE IF NOT EXISTS contracts(id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES clients(id),service TEXT NOT NULL,start_period TEXT NOT NULL,end_period TEXT NOT NULL,monthly_fee_fen INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'active',termination_period TEXT,note TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS receipts(id INTEGER PRIMARY KEY,contract_id INTEGER NOT NULL REFERENCES contracts(id),client_id INTEGER NOT NULL REFERENCES clients(id),date TEXT NOT NULL,amount_fen INTEGER NOT NULL,method TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',reversal_of INTEGER UNIQUE REFERENCES receipts(id),user_id INTEGER REFERENCES users(id),created_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES clients(id),name TEXT NOT NULL,type TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending',due_date TEXT NOT NULL,assignee_id INTEGER REFERENCES users(id),steps TEXT NOT NULL DEFAULT '[]',version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tax_records(id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES clients(id),period TEXT NOT NULL,tax_type TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',payment_status TEXT NOT NULL DEFAULT 'unpaid',confirmation_status TEXT NOT NULL DEFAULT 'pending',amount_fen INTEGER NOT NULL DEFAULT 0,paid_fen INTEGER NOT NULL DEFAULT 0,reference TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT 'manual',attachment_id INTEGER REFERENCES files(id),note TEXT NOT NULL DEFAULT '',user_id INTEGER REFERENCES users(id),recorded_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0,deleted_at TEXT);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS tax_agents(id INTEGER PRIMARY KEY,name TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',role TEXT NOT NULL DEFAULT '',client_id INTEGER REFERENCES clients(id),note TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invoice_requests(id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES clients(id),buyer_name TEXT NOT NULL DEFAULT '',buyer_tax_no TEXT NOT NULL DEFAULT '',content TEXT NOT NULL DEFAULT '',amount_fen INTEGER NOT NULL DEFAULT 0,tax_fen INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'draft',note TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    ''')
    if 'termination_period' not in {r['name'] for r in conn.execute('PRAGMA table_info(contracts)')}:
        conn.execute('ALTER TABLE contracts ADD COLUMN termination_period TEXT')
    client_columns={r['name'] for r in conn.execute('PRAGMA table_info(clients)')}
    for field in ('profile_json','sensitive_json'):
        if field not in client_columns:
            conn.execute("ALTER TABLE clients ADD COLUMN "+field+" TEXT NOT NULL DEFAULT '{}'")
    for row in conn.execute('SELECT industry FROM clients ORDER BY id'):
        remember_industry(conn, row['industry'])
    if 'enabled' not in {r['name'] for r in conn.execute('PRAGMA table_info(tax_agents)')}:
        conn.execute('ALTER TABLE tax_agents ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1')
    import finance
    finance.init_schema(conn)
    import ticket_workflow
    ticket_workflow.init_schema(conn)
    import tax_workflow
    tax_workflow.init_schema(conn)
    import reconciliation
    reconciliation.init_schema(conn)
    _migrate_business_deletions(conn)
    conn.commit()
    conn.close()


def _migrate_business_deletions(conn):
    """Preserve every row while allowing only active tax records to be unique."""
    with conn:
        if not conn.in_transaction:conn.execute('BEGIN IMMEDIATE')
        for table in ('notes','projects','contracts'):
            columns={r['name'] for r in conn.execute('PRAGMA table_info('+table+')')}
            if 'deleted' not in columns:conn.execute('ALTER TABLE '+table+' ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0')
            if 'deleted_at' not in columns:conn.execute('ALTER TABLE '+table+' ADD COLUMN deleted_at TEXT')
        columns={r['name'] for r in conn.execute('PRAGMA table_info(tax_records)')}
        legacy_unique=any(r['origin']=='u' for r in conn.execute('PRAGMA index_list(tax_records)'))
        if 'deleted' not in columns or legacy_unique:
            conn.execute('''CREATE TABLE tax_records_soft_migration(
                id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES clients(id),period TEXT NOT NULL,tax_type TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',payment_status TEXT NOT NULL DEFAULT 'unpaid',confirmation_status TEXT NOT NULL DEFAULT 'pending',
                amount_fen INTEGER NOT NULL DEFAULT 0,paid_fen INTEGER NOT NULL DEFAULT 0,reference TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT 'manual',
                attachment_id INTEGER REFERENCES files(id),note TEXT NOT NULL DEFAULT '',user_id INTEGER REFERENCES users(id),recorded_at TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0,deleted_at TEXT)''')
            retained=['id','client_id','period','tax_type','status','payment_status','confirmation_status','amount_fen','paid_fen','reference','source','attachment_id','note','user_id','recorded_at','version']
            retained.extend(k for k in ('deleted','deleted_at') if k in columns)
            names=','.join(retained)
            conn.execute('INSERT INTO tax_records_soft_migration('+names+') SELECT '+names+' FROM tax_records')
            conn.execute('DROP TABLE tax_records')
            conn.execute('ALTER TABLE tax_records_soft_migration RENAME TO tax_records')
        elif 'deleted_at' not in columns:
            conn.execute('ALTER TABLE tax_records ADD COLUMN deleted_at TEXT')
        conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS tax_records_active_unique ON tax_records(client_id,period,tax_type) WHERE deleted=0')
