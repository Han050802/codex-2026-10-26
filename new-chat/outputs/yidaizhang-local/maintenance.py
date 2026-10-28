"""Offline consistent backup and verified restore. Stop the web service first."""
import argparse
import hashlib
import json
import os
import re
import shutil
import socket
import sqlite3
import tempfile
import time
import zipfile
from contextlib import closing
from pathlib import Path
import db

ROOT=Path(__file__).resolve().parent


def assert_offline(data_dir):
    marker=data_dir/'server.lock'
    if marker.exists():
        raise RuntimeError('服务仍有运行锁。请先正常关闭服务；若进程已退出，再核实后删除server.lock重试。')
    path=data_dir/'app.sqlite3'
    if path.exists():
        conn=sqlite3.connect(path,timeout=1)
        try:conn.execute('BEGIN EXCLUSIVE');conn.rollback()
        finally:conn.close()


def backup(data_dir,destination):
    path=data_dir/'app.sqlite3'
    if not path.exists():raise RuntimeError('没有可备份的数据库')
    from server import Application
    with closing(db.connect(path)) as conn:
        mode=conn.execute("SELECT value FROM meta WHERE key='demo'").fetchone()
        # Do not initialize the server or rotate setup credentials for maintenance.
        app=object.__new__(Application);app.data_dir=data_dir;app.db_path=path;app.files_dir=(data_dir/'files').resolve()
        import threading
        app.lock=threading.RLock();app.demo=bool(mode and mode[0]=='true')
        content=app.create_backup(conn)
    destination.parent.mkdir(parents=True,exist_ok=True)
    with destination.open('xb') as f:f.write(content)
    return destination


def restore(data_dir,archive):
    data_dir=data_dir.resolve();archive=archive.resolve();data_dir.mkdir(parents=True,exist_ok=True)
    assert_offline(data_dir)
    # Extract into a sibling temporary directory so replacement stays on the same drive.
    with tempfile.TemporaryDirectory(prefix='ydz-restore-',dir=data_dir.parent) as temporary:
        stage=Path(temporary)
        with zipfile.ZipFile(archive) as z:
            names=z.namelist()
            if len(names)!=len(set(names)) or 'manifest.json' not in names or 'app.sqlite3' not in names:raise RuntimeError('备份目录或格式无效')
            manifest=json.loads(z.read('manifest.json'))
            if manifest.get('format')!='yidaizhang-local-v1':raise RuntimeError('不支持该备份格式')
            if not isinstance(manifest.get('files'),list) or any(not re.fullmatch(r'[0-9a-f]{48}\.[a-z0-9]+',str(x.get('path',''))) for x in manifest['files']):raise RuntimeError('备份附件路径无效')
            expected={'app.sqlite3','manifest.json'}|{'files/'+x['path'] for x in manifest.get('files',[])}
            if set(names)!=expected:raise RuntimeError('备份含未登记文件')
            if sum(x.file_size for x in z.infolist())>2*1024**3:raise RuntimeError('备份解压大小超过2GB限制')
            for item in z.infolist():
                target=(stage/item.filename).resolve()
                if not target.is_relative_to(stage) or item.filename.startswith(('/', '\\')):raise RuntimeError('备份含非法文件路径')
                target.parent.mkdir(parents=True,exist_ok=True)
                with z.open(item) as source,target.open('xb') as output:shutil.copyfileobj(source,output)
        check=sqlite3.connect(stage/'app.sqlite3');check.row_factory=sqlite3.Row
        try:
            if check.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise RuntimeError('备份数据库完整性验证失败')
            if check.execute('PRAGMA foreign_key_check').fetchone():raise RuntimeError('备份存在失效关联')
            stored=[dict(x) for x in check.execute('SELECT id,name,path,size,sha256 FROM files ORDER BY id')]
            if sorted(stored,key=lambda x:x['id'])!=sorted(manifest['files'],key=lambda x:x['id']):raise RuntimeError('附件清单与数据库不一致')
            for item in stored:
                source=stage/'files'/item['path']
                if source.stat().st_size!=item['size'] or hashlib.sha256(source.read_bytes()).hexdigest()!=item['sha256']:raise RuntimeError('附件内容校验失败')
            check.execute('DELETE FROM sessions');check.commit()
        finally:check.close()
        existing=data_dir/'app.sqlite3'
        if existing.exists():
            original=data_dir.parent/('pre-restore-'+time.strftime('%Y%m%d-%H%M%S')+'-'+str(time.time_ns()%1000000)+'.zip')
            backup(data_dir,original)
            print('Current database backed up:',original)
        # The stopped service is required above; checkpoint then remove sidecars.
        if existing.exists():
            previous=sqlite3.connect(existing)
            try:previous.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            finally:previous.close()
        for suffix in ('-wal','-shm'):(data_dir/('app.sqlite3'+suffix)).unlink(missing_ok=True)
        old_files=data_dir/'files'
        if old_files.exists():
            resolved=old_files.resolve()
            if resolved.parent!=data_dir:raise RuntimeError('附件目录超出目标目录')
            shutil.rmtree(resolved)
        (stage/'files').mkdir(exist_ok=True)
        shutil.move(str(stage/'files'),str(old_files))
        os.replace(stage/'app.sqlite3',existing)
        (data_dir/'setup-token.txt').unlink(missing_ok=True)
        print('Restore verified and complete:',data_dir)


def main():
    p=argparse.ArgumentParser(description='离线数据备份恢复（先关闭服务）');p.add_argument('action',choices=['backup','restore']);p.add_argument('archive');p.add_argument('--data-dir',default=str(ROOT/'data'))
    a=p.parse_args();directory=Path(a.data_dir).resolve();target=Path(a.archive).resolve()
    assert_offline(directory)
    if a.action=='backup':print(backup(directory,target))
    else:restore(directory,target)


if __name__=='__main__':main()
