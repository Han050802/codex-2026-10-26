"""One-time, explicit migration of a single existing small-business book."""
import argparse
import json
from pathlib import Path

import db
import finance


def main():
    parser=argparse.ArgumentParser(description='将科目清单应用到指定账套；不删除原有科目')
    parser.add_argument('--database', required=True, help='现有 SQLite 数据库文件路径')
    parser.add_argument('--client-id', type=int, required=True)
    parser.add_argument('--client-name', required=True, help='必须与账套名称完全一致')
    args=parser.parse_args()
    path=Path(args.database).resolve(strict=True)
    conn=db.connect(path)
    try:
        with conn:
            conn.execute('BEGIN IMMEDIATE')
            result=finance.apply_subject_list_to_book(conn,args.client_id,args.client_name)
        print(json.dumps(result,ensure_ascii=False))
    finally:
        conn.close()


if __name__=='__main__':
    main()
