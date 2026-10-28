"""Preview by default; explicitly apply missing small-book accounts when requested."""
import argparse
import json
import sqlite3
from pathlib import Path

import db
import finance


def main():
    parser = argparse.ArgumentParser(description='核对账套科目模板；默认只读预览')
    parser.add_argument('--database', required=True)
    parser.add_argument('--apply', action='store_true', help='明确执行补充，执行前请备份数据库')
    args = parser.parse_args()
    path = Path(args.database).resolve(strict=True)
    if args.apply:
        conn = db.connect(path)
    else:
        conn = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=20)
        conn.row_factory = sqlite3.Row
    try:
        if args.apply:
            conn.execute('BEGIN IMMEDIATE')
        clients = conn.execute('SELECT id,standard,deleted FROM clients ORDER BY id').fetchall()
        result = []
        for client in clients:
            if client['deleted'] or client['standard'] != 'small2013':
                result.append({'client_id':client['id'],'standard':client['standard'],
                               'skipped':'deleted' if client['deleted'] else 'different_standard'})
            else:
                result.append(finance.reconcile_small_subject_template(conn,client['id'],args.apply))
        if args.apply:
            conn.commit()
        print(json.dumps(result,ensure_ascii=False))
    except Exception:
        if args.apply:
            conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == '__main__':
    main()
