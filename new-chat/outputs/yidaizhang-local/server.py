"""Self-contained LAN application server. Run on a trusted private LAN."""
import argparse
import base64
import binascii
import datetime as dt
import hashlib
import hmac
import io
import ipaddress
import json
import mimetypes
import os
import re
import secrets
import shutil
import socket
import sqlite3
import tempfile
import threading
import time
import urllib.parse
import zipfile
from contextlib import closing
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import business
import db
from db import ApiError, now

ROOT=Path(__file__).resolve().parent
MAX_BODY=15*1024*1024
MAX_FILE=10*1024*1024
EXTENSIONS={'.pdf','.png','.jpg','.jpeg','.webp','.gif','.csv','.xlsx','.txt'}


def password_hash(password):
    validate_password(password)
    salt=secrets.token_bytes(16)
    digest=hashlib.scrypt(password.encode('utf-8'),salt=salt,n=16384,r=8,p=1,dklen=32)
    return 'scrypt$16384$8$1$'+salt.hex()+'$'+digest.hex()


def validate_password(password):
    if not isinstance(password,str) or not 10<=len(password)<=128:
        raise ApiError(400,'密码须为10—128位')
    if len(set(password))<4 or password.lower() in ('password123','1234567890','abcdefghij'):
        raise ApiError(400,'请使用不易猜测且至少四种不同字符的密码')


def password_verify(password,stored):
    try:
        if not isinstance(password,str) or len(password)>128:return False
        _,n,r,p,salt,digest=stored.split('$')
        actual=hashlib.scrypt(password.encode('utf-8'),salt=bytes.fromhex(salt),n=int(n),r=int(r),p=int(p),dklen=32)
        return hmac.compare_digest(actual,bytes.fromhex(digest))
    except (ValueError,TypeError):return False


class ReconciliationJobs:
    """Bounded in-memory jobs; one OCR process at a time across all users."""
    ttl=900
    max_completed=4

    def __init__(self):
        self.lock=threading.Lock()
        self.jobs={}
        self.active=False

    def _clean(self):
        now_mono=time.monotonic()
        for key,job in list(self.jobs.items()):
            if job['status'] != 'running' and now_mono-job['finished'] > self.ttl:
                timer=job.get('expiry_timer')
                if timer: timer.cancel()
                del self.jobs[key]

    def start(self, payload, user_id, session):
        with self.lock:
            self._clean()
            if self.active:
                raise ApiError(429,'已有识别任务正在进行，请等待完成后重试')
            finished=sorted((j['finished'],key) for key,j in self.jobs.items() if j['status']!='running')
            while len(finished)>=self.max_completed:
                _,key=finished.pop(0)
                old=self.jobs.pop(key)
                if old.get('expiry_timer'): old['expiry_timer'].cancel()
            ident=secrets.token_urlsafe(24)
            job={'owner':user_id,'session':session,'status':'running','started':time.monotonic(),'files':[]}
            self.jobs[ident]=job
            self.active=True
        def update(event, **data):
            with self.lock:
                if event=='start':
                    job['files'].append({'name':data['name'],'kind':data['kind'],'status':'running','started':time.monotonic(),'pages':[]})
                elif event=='page':
                    job['files'][-1]['pages'].append({'page':data['page'],'elapsed_seconds':round(data['elapsed_seconds'],2),'orientation_passes':data['orientation_passes']})
                elif event=='end':
                    entry=job['files'][-1]
                    entry['elapsed_seconds']=round(time.monotonic()-entry.pop('started'),2)
                    entry['status']='completed'
        def run():
            try:
                import reconciliation
                result=reconciliation.parse(payload, update)
                with self.lock:
                    job['result']=result;job['status']='completed';job['finished']=time.monotonic()
            except ApiError as e:
                with self.lock:
                    job['error']=e.message;job['status']='failed';job['finished']=time.monotonic()
            except Exception:
                # Never log document data or exception messages from parsers.
                with self.lock:
                    job['error']='识别任务失败，请检查文件后重试';job['status']='failed';job['finished']=time.monotonic()
            finally:
                def expire():
                    with self.lock:
                        if self.jobs.get(ident) is job: self.jobs.pop(ident,None)
                with self.lock:
                    self.active=False
                    if self.jobs.get(ident) is job:
                        timer=threading.Timer(self.ttl,expire);timer.daemon=True
                        job['expiry_timer']=timer
                        timer.start()
        threading.Thread(target=run,daemon=True).start()
        return {'job_id':ident}

    def parse_sync(self, payload):
        with self.lock:
            if self.active: raise ApiError(429,'已有识别任务正在进行，请等待完成后重试')
            self.active=True
        try:
            import reconciliation
            return reconciliation.parse(payload)
        finally:
            with self.lock: self.active=False

    def progress(self, ident, user_id, session):
        with self.lock:
            self._clean()
            job=self.jobs.get(ident)
            if not job or job['owner']!=user_id or not hmac.compare_digest(job['session'],session):
                raise ApiError(404,'识别任务不存在或已过期')
            now_mono=time.monotonic()
            files=[]
            for entry in job['files']:
                row={k:v for k,v in entry.items() if k!='started'}
                if entry['status']=='running': row['elapsed_seconds']=round(now_mono-entry['started'],2)
                files.append(row)
            out={'status':job['status'],'files':files,'elapsed_seconds':round(job.get('finished',now_mono)-job['started'],2)}
            if job['status']=='completed': out['result']=job['result']
            if job['status']=='failed': out['error']=job['error']
            # Snapshot nested rows while holding the lock.
            return json.loads(json.dumps(out,ensure_ascii=False))


class Application:
    def __init__(self,data_dir,demo=False,setup_token=None):
        self.data_dir=Path(data_dir).resolve();self.data_dir.mkdir(parents=True,exist_ok=True)
        self.db_path=self.data_dir/'app.sqlite3';self.files_dir=self.data_dir/'files';self.files_dir.mkdir(exist_ok=True)
        self.lock=threading.RLock();self.failures={};self.demo=bool(demo);self.reconciliation_jobs=ReconciliationJobs()
        db.initialize(self.db_path)
        with closing(db.connect(self.db_path)) as conn, conn:
            mode=conn.execute("SELECT value FROM meta WHERE key='demo'").fetchone()
            if mode and (mode[0]=='true')!=self.demo:
                raise RuntimeError('数据目录模式不匹配，请为演示和生产使用独立目录')
            conn.execute("INSERT OR IGNORE INTO meta VALUES('demo',?)",('true' if self.demo else 'false',))
            count=conn.execute('SELECT COUNT(*) FROM users').fetchone()[0]
            if self.demo and not count:
                conn.executemany('INSERT INTO users(username,name,password_hash) VALUES(?,?,?)',
                    [('demo'+str(i),name,password_hash('DemoOnly123!')) for i,name in enumerate(('吕','会计1','会计2'),1)])
                conn.execute('INSERT INTO settings VALUES(?,?,1)',('company_name',json.dumps('合成演示代账机构',ensure_ascii=False)))
                conn.execute("INSERT INTO meta VALUES('settings_version','1')")
                count=3
        self.setup_token=setup_token or secrets.token_urlsafe(32) if not count else None
        self.setup_file=self.data_dir/'setup-token.txt'
        if self.setup_token:self.setup_file.write_text(self.setup_token,encoding='utf-8')
        elif self.setup_file.exists():self.setup_file.unlink()

    def session(self,conn,raw_cookie):
        try:
            jar=cookies.SimpleCookie();jar.load(raw_cookie or '')
            token=jar['ydz_session'].value if 'ydz_session' in jar else ''
        except cookies.CookieError:return None,None
        if not re.fullmatch(r'[A-Za-z0-9_-]{40,100}',token):return None,None
        digest=hashlib.sha256(token.encode()).hexdigest()
        row=conn.execute('SELECT u.id,u.username,u.name,s.csrf,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND u.enabled=1',(digest,)).fetchone()
        if not row or row['expires_at']<time.time():return None,None
        return {'id':row['id'],'username':row['username'],'name':row['name']},row['csrf']

    def new_session(self,conn,user):
        token=secrets.token_urlsafe(32);csrf=secrets.token_urlsafe(32)
        conn.execute('DELETE FROM sessions WHERE expires_at<?',(time.time(),))
        conn.execute('INSERT INTO sessions VALUES(?,?,?,?,?)',(hashlib.sha256(token.encode()).hexdigest(),user['id'],csrf,now(),time.time()+12*3600))
        return token,csrf

    def check_rate(self,key):
        cutoff=time.time()-900
        self.failures[key]=[t for t in self.failures.get(key,[]) if t>cutoff]
        if len(self.failures[key])>=8:raise ApiError(429,'登录尝试过多，请15分钟后重试')

    def create_backup(self,conn):
        with self.lock, tempfile.TemporaryDirectory(prefix='ydz-backup-') as temporary:
            snapshot=Path(temporary)/'app.sqlite3'
            target=sqlite3.connect(snapshot)
            target.row_factory=sqlite3.Row
            conn.backup(target)
            target.execute('DELETE FROM sessions');target.commit()
            integrity=target.execute('PRAGMA integrity_check').fetchone()[0]
            if integrity!='ok':target.close();raise ApiError(500,'数据库完整性检查未通过')
            files=[dict(r) for r in target.execute('SELECT id,name,path,size,sha256 FROM files')]
            target.close()
            buffer=io.BytesIO()
            with zipfile.ZipFile(buffer,'w',zipfile.ZIP_DEFLATED) as z:
                z.write(snapshot,'app.sqlite3')
                for item in files:
                    path=(self.files_dir/item['path']).resolve()
                    if path.parent!=self.files_dir or not path.is_file():raise ApiError(500,'附件缺失，备份未完成')
                    if hashlib.sha256(path.read_bytes()).hexdigest()!=item['sha256']:raise ApiError(500,'附件校验失败，备份未完成')
                    z.write(path,'files/'+item['path'])
                z.writestr('manifest.json',json.dumps({'format':'yidaizhang-local-v1','created_at':now(),'demo':self.demo,'files':files},ensure_ascii=False,indent=2))
            return buffer.getvalue()


class Handler(BaseHTTPRequestHandler):
    server_version='YDZLocal/1.0'
    protocol_version='HTTP/1.1'

    def log_message(self,fmt,*args):
        # Never log URL queries, headers, body or setup token.
        if args and isinstance(args[0],str):
            args=(re.sub(r'\?[^ ]*','?[redacted]',args[0]),)+args[1:]
        super().log_message(fmt,*args)

    @property
    def app(self):return self.server.app

    def send(self,status,body,ctype='application/json; charset=utf-8',extra=None):
        if not isinstance(body,bytes):body=json.dumps(body,ensure_ascii=False,allow_nan=False,default=str).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type',ctype);self.send_header('Content-Length',str(len(body)))
        self.send_header('X-Content-Type-Options','nosniff');self.send_header('X-Frame-Options','DENY')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        self.send_header('Cache-Control','no-store')
        for k,v in (extra or {}).items():self.send_header(k,v)
        self.end_headers()
        if self.command!='HEAD':self.wfile.write(body)

    def request_payload(self):
        try:n=int(self.headers.get('Content-Length','0'))
        except ValueError:raise ApiError(400,'请求长度无效')
        if n<0 or n>MAX_BODY:raise ApiError(413,'请求过大')
        if self.headers.get('Transfer-Encoding'):raise ApiError(400,'不支持分块请求')
        if n and self.headers.get('Content-Type','').split(';')[0].strip()!='application/json':raise ApiError(415,'请求必须使用JSON')
        if not n:return {}
        try:
            obj=json.loads(self.rfile.read(n).decode('utf-8'),parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if not isinstance(obj,dict):raise ValueError()
            return obj
        except (ValueError,UnicodeDecodeError):raise ApiError(400,'JSON请求格式错误')

    def validate_host(self):
        host=self.headers.get('Host','')
        try:
            parsed=urllib.parse.urlsplit('http://'+host)
            hostname=parsed.hostname
            if not hostname or parsed.username or parsed.password or parsed.path:raise ValueError()
        except ValueError:raise ApiError(400,'主机地址无效')
        if hostname.lower() not in self.server.allowed_hosts:raise ApiError(403,'不允许该主机名，请使用服务器IP或localhost')

    def origin_check(self):
        if self.headers.get('Sec-Fetch-Site')=='cross-site':raise ApiError(403,'拒绝跨站请求')
        origin=self.headers.get('Origin')
        if origin and origin!='http://'+self.headers.get('Host'):raise ApiError(403,'请求来源不匹配')

    def do_GET(self):self.dispatch()
    def do_POST(self):self.dispatch()
    def do_PATCH(self):self.dispatch()
    def do_DELETE(self):self.dispatch()
    def do_HEAD(self):self.dispatch()

    def dispatch(self):
        conn=None
        try:
            self.connection.settimeout(30);self.validate_host()
            parsed=urllib.parse.urlsplit(self.path);path=urllib.parse.unquote(parsed.path)
            query={k:v[0] for k,v in urllib.parse.parse_qs(parsed.query).items()}
            if not path.startswith('/api/'):
                return self.static(path)
            conn=db.connect(self.app.db_path)
            if self.command in ('GET','HEAD'):return self.api(conn,path,query,{})
            self.origin_check();payload=self.request_payload()
            # OCR and comparison do not write to the database; do not lock the
            # entire workbench while a large document is being processed.
            if self.command=='POST' and path in ('/api/reconcile/parse','/api/reconcile/parse/start','/api/reconcile/match'):return self.api(conn,path,query,payload)
            with self.app.lock:return self.api(conn,path,query,payload)
        except ApiError as e:
            self.close_connection=True
            body={'error':e.message}
            if e.details is not None:body['details']=e.details
            self.send(e.status,body)
        except sqlite3.IntegrityError:
            self.close_connection=True
            self.send(400,{'error':'记录重复或关联数据无效，请核对编号和引用'})
        except sqlite3.OperationalError:
            self.close_connection=True
            self.send(503,{'error':'数据库暂忙或结构未就绪，请稍后重试'})
        except (BrokenPipeError,ConnectionResetError,TimeoutError):pass
        except Exception as e:
            print('Request error:',type(e).__name__,str(e)[:200],flush=True)
            self.send(500,{'error':'服务器处理失败，请查看本机服务日志'})
        finally:
            if conn is not None:conn.close()

    def static(self,path):
        if self.command not in ('GET','HEAD'):raise ApiError(405,'方法不支持')
        if path=='/':path='/index.html'
        target=(ROOT/'public'/path.lstrip('/')).resolve();public=(ROOT/'public').resolve()
        if not target.is_relative_to(public) or not target.is_file():raise ApiError(404,'页面不存在')
        content=target.read_bytes();ctype=mimetypes.guess_type(target.name)[0] or 'application/octet-stream'
        if target.suffix in ('.js','.css','.html'):ctype+='; charset=utf-8'
        self.send(200,content,ctype)

    def api(self,conn,path,query,payload):
        method=self.command;user,csrf=self.app.session(conn,self.headers.get('Cookie'))
        count=conn.execute('SELECT COUNT(*) FROM users').fetchone()[0]
        if path=='/api/health' and method=='GET':return self.send(200,{'app':'yidaizhang-local','pid':os.getpid(),'demo':self.app.demo,'version':'1.0'})
        if path=='/api/session' and method=='GET':return self.send(200,{'user':user,'csrf':csrf,'setup_required':count==0,'demo':self.app.demo})
        if path=='/api/setup' and method=='POST':
            try:loopback=ipaddress.ip_address(self.client_address[0]).is_loopback
            except ValueError:loopback=False
            if not loopback or not self.app.setup_token or not hmac.compare_digest(self.headers.get('X-Setup-Token',''),self.app.setup_token):raise ApiError(403,'首次设置只能在服务器本机凭一次性设置链接完成')
            if count:raise ApiError(409,'首次设置已经完成')
            users=payload.get('users')
            if not isinstance(users,list) or len(users)!=3:raise ApiError(400,'请设置三名用户')
            prepared=[];seen=set()
            for item in users:
                if not isinstance(item,dict):raise ApiError(400,'用户信息格式错误')
                username=business.textval(item.get('username'),'用户名',40,True)
                if not re.fullmatch(r'[A-Za-z0-9_.-]{3,40}',username):raise ApiError(400,'用户名为3—40位字母数字或_.-')
                if username.lower() in seen:raise ApiError(400,'用户名不能重复')
                seen.add(username.lower());prepared.append((username,business.textval(item.get('name'),'姓名',80,True),password_hash(item.get('password'))))
            company=business.textval(payload.get('company_name'),'机构名称',200,True)
            with conn:
                conn.executemany('INSERT INTO users(username,name,password_hash) VALUES(?,?,?)',prepared)
                conn.execute('INSERT INTO settings(key,value) VALUES(?,?)',('company_name',json.dumps(company,ensure_ascii=False)))
                conn.execute("INSERT INTO meta VALUES('settings_version','1')")
                user=dict(conn.execute('SELECT id,username,name FROM users ORDER BY id LIMIT 1').fetchone())
                db.audit(conn,user,'setup','system','local',{'user_count':3,'demo':self.app.demo})
                token,csrf=self.app.new_session(conn,user)
            self.app.setup_token=None
            if self.app.setup_file.exists():self.app.setup_file.unlink()
            return self.send(200,{'user':user,'csrf':csrf,'setup_required':False,'demo':self.app.demo},extra={'Set-Cookie':self.cookie(token)})
        if path=='/api/login' and method=='POST':
            username=business.textval(payload.get('username'),'用户名',40,True);key=(self.client_address[0],username.lower());ipkey=(self.client_address[0],'*')
            self.app.check_rate(key);self.app.check_rate(ipkey)
            row=conn.execute('SELECT * FROM users WHERE lower(username)=lower(?) AND enabled=1',(username,)).fetchone()
            # Fixed-cost fallback limits account enumeration through timing.
            fallback='scrypt$16384$8$1$'+'00'*16+'$'+'00'*32
            if not password_verify(payload.get('password'),row['password_hash'] if row else fallback) or not row:
                self.app.failures.setdefault(key,[]).append(time.time());self.app.failures.setdefault(ipkey,[]).append(time.time())
                raise ApiError(401,'用户名或密码错误')
            self.app.failures.pop(key,None)
            user={k:row[k] for k in ('id','username','name')}
            with conn:token,csrf=self.app.new_session(conn,user);db.audit(conn,user,'login','session','current',{})
            return self.send(200,{'user':user,'csrf':csrf,'setup_required':False,'demo':self.app.demo},extra={'Set-Cookie':self.cookie(token)})
        if user is None:raise ApiError(401,'请先登录')
        if method not in ('GET','HEAD'):
            token=self.headers.get('X-CSRF-Token','')
            if not csrf or not hmac.compare_digest(token,csrf):raise ApiError(403,'请求校验失效，请刷新页面后重试')
        if path=='/api/logout' and method=='POST':
            with conn:conn.execute('DELETE FROM sessions WHERE user_id=? AND csrf=?',(user['id'],csrf))
            return self.send(200,{'ok':True},extra={'Set-Cookie':self.cookie('',clear=True)})
        if path=='/api/password' and method=='POST':
            row=conn.execute('SELECT password_hash FROM users WHERE id=?',(user['id'],)).fetchone()
            if not password_verify(payload.get('current_password'),row['password_hash']):raise ApiError(400,'当前密码不正确')
            hashed=password_hash(payload.get('password'))
            with conn:
                conn.execute('UPDATE users SET password_hash=?,version=version+1 WHERE id=?',(hashed,user['id']))
                conn.execute('DELETE FROM sessions WHERE user_id=? AND csrf<>?',(user['id'],csrf));db.audit(conn,user,'password_change','users',user['id'],{})
            return self.send(200,{'ok':True})
        if path=='/api/upload' and method=='POST':return self.upload(conn,payload,user)
        if path.startswith('/api/reconcile/'):
            import reconciliation
            if path=='/api/reconcile/parse' and method=='POST':return self.send(200,self.app.reconciliation_jobs.parse_sync(payload))
            if path=='/api/reconcile/parse/start' and method=='POST':return self.send(200,self.app.reconciliation_jobs.start(payload,user['id'],csrf))
            if path=='/api/reconcile/parse/progress' and method=='GET':return self.send(200,self.app.reconciliation_jobs.progress(query.get('job_id',''),user['id'],csrf))
            if path=='/api/reconcile/account-rules' and method=='GET':
                import account_rules
                return self.send(200,account_rules.list_rules(conn,query.get('q',''),query.get('client_id')))
            if path=='/api/reconcile/match' and method=='POST':
                import account_rules
                cid=payload.get('client_id')
                if cid not in (None,''):
                    account_rules.list_rules(conn,'',cid)
                    cid=int(cid)
                return self.send(200,reconciliation.match(payload.get('transactions',[]),payload.get('invoices',[]),payload.get('account_name',''),payload.get('account_needs_review',False),conn,cid))
            if path in ('/api/reconcile/batch-preview','/api/reconcile/batch-save') and method=='POST':
                import reconciliation_batch
                return self.send(200,reconciliation_batch.preview(conn,payload) if path.endswith('batch-preview') else reconciliation_batch.save_batch(conn,payload,user))
            if path=='/api/reconcile/batch-auto' and method=='POST':
                import reconciliation_batch
                return self.send(200,reconciliation_batch.auto_post(conn,payload,user))
            if path=='/api/reconcile/retry-saved' and method=='POST':
                import reconciliation_batch
                return self.send(200,reconciliation_batch.retry_saved(conn,payload.get('client_id'),user))
            if path=='/api/reconcile/save' and method=='POST':return self.send(200,reconciliation.save(conn,payload,user))
            if path=='/api/reconcile/records' and method=='GET':return self.send(200,reconciliation.records(conn,query.get('client_id')))
            record_post=re.fullmatch(r'/api/reconcile/records/(\d+)/post',path)
            if record_post and method=='POST':return self.send(200,reconciliation.post_confirmed(conn,int(record_post[1]),payload,user))
            raise ApiError(404,'接口不存在')
        match=re.fullmatch(r'/api/files/(\d+)',path)
        if match and method=='GET':return self.download(conn,int(match.group(1)))
        if path=='/api/backup' and method=='GET':
            with self.app.lock:
                content=self.app.create_backup(conn)
                with conn:db.audit(conn,user,'backup','system','zip',{})
            return self.send(200,content,'application/zip',{'Content-Disposition':'attachment; filename="ydz-backup-'+dt.date.today().isoformat()+'.zip"'})
        match=re.fullmatch(r'/api/templates/([a-z-]+)\.csv',path)
        if match and method=='GET':
            kind=match.group(1)
            if kind not in business.TEMPLATES:raise ApiError(404,'模板不存在')
            return self.send(200,business.safe_csv(business.TEMPLATES[kind],[]),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="'+kind+'-template.csv"'})
        match=re.fullmatch(r'/api/export/([a-z-]+)\.csv',path)
        if match and method=='GET':return self.send(200,business.export_csv(conn,match.group(1),query),'text/csv; charset=utf-8',{'Content-Disposition':'attachment; filename="'+match.group(1)+'.csv"'})
        match=re.fullmatch(r'/api/import/([a-z-]+)',path)
        if match and method=='POST':return self.send(200,business.import_csv(conn,match.group(1),payload,user))
        if path.startswith('/api/books/'):
            import finance
            result=finance.handle(conn,method,path,payload,user,query)
        else:result=business.handle(conn,method,path,payload,user,query,self.app.demo)
        if result is None:raise ApiError(404,'接口不存在')
        self.send(200,result)

    @staticmethod
    def cookie(token,clear=False):
        return 'ydz_session='+token+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+('0' if clear else '43200')

    def upload(self,conn,payload,user):
        name=business.textval(payload.get('name'),'文件名',200,True)
        if Path(name).name!=name or '/' in name or '\\' in name or ':' in name or any(ord(c)<32 for c in name):raise ApiError(400,'文件名无效')
        ext=Path(name).suffix.lower()
        if ext not in EXTENSIONS:raise ApiError(400,'支持PDF、常见图片、CSV、XLSX和TXT文件')
        try:content=base64.b64decode(payload.get('content_base64',''),validate=True)
        except (binascii.Error,TypeError):raise ApiError(400,'文件内容无效')
        if not content or len(content)>MAX_FILE:raise ApiError(413,'文件需为1字节至10MB')
        signatures={'.pdf':b'%PDF-','.png':b'\x89PNG\r\n\x1a\n','.jpg':b'\xff\xd8\xff','.jpeg':b'\xff\xd8\xff','.gif':b'GIF','.webp':b'RIFF','.xlsx':b'PK'}
        if ext in signatures and not content.startswith(signatures[ext]):raise ApiError(400,'文件内容与扩展名不符')
        filename=secrets.token_hex(24)+ext;target=self.app.files_dir/filename
        try:
            with target.open('xb') as f:f.write(content)
            with conn:
                cur=conn.execute('INSERT INTO files(name,path,size,sha256,user_id,created_at) VALUES(?,?,?,?,?,?)',(name,filename,len(content),hashlib.sha256(content).hexdigest(),user['id'],now()))
                db.audit(conn,user,'upload','files',cur.lastrowid,{'name':name,'size':len(content)})
                ident=cur.lastrowid
        except Exception:
            target.unlink(missing_ok=True);raise
        return self.send(200,{'id':ident,'name':name,'size':len(content),'version':1})

    def download(self,conn,ident):
        row=conn.execute('SELECT * FROM files WHERE id=?',(ident,)).fetchone()
        if not row:raise ApiError(404,'附件不存在')
        target=(self.app.files_dir/row['path']).resolve()
        if target.parent!=self.app.files_dir or not target.is_file():raise ApiError(404,'附件文件缺失')
        return self.send(200,target.read_bytes(),'application/octet-stream',{'Content-Disposition':"attachment; filename*=UTF-8''"+urllib.parse.quote(row['name'])})


def make_server(host,port,app):
    server=ThreadingHTTPServer((host,port),Handler);server.daemon_threads=True;server.app=app
    allowed={'localhost','127.0.0.1','::1',socket.gethostname().lower(),socket.getfqdn().lower()}
    if host not in ('0.0.0.0','::'):allowed.add(host.lower())
    try:
        allowed.update(x[4][0].lower() for x in socket.getaddrinfo(socket.gethostname(),None))
    except socket.gaierror:pass
    server.allowed_hosts=allowed
    return server


def process_alive(pid):
    """True on an alive or uninspectable PID; False only when proved exited."""
    if pid<=0:return True
    if os.name=='nt':
        import ctypes
        from ctypes import wintypes
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD]
        kernel.OpenProcess.restype=wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes=[wintypes.HANDLE,ctypes.POINTER(wintypes.DWORD)]
        kernel.CloseHandle.argtypes=[wintypes.HANDLE]
        handle=kernel.OpenProcess(0x1000,False,pid)
        if not handle:return ctypes.get_last_error()!=87
        try:
            code=wintypes.DWORD()
            return not kernel.GetExitCodeProcess(handle,ctypes.byref(code)) or code.value==259
        finally:kernel.CloseHandle(handle)
    try:os.kill(pid,0);return True
    except ProcessLookupError:return False
    except PermissionError:return True


def acquire_process_lock(data_dir):
    marker=Path(data_dir)/'server.lock'
    for _ in range(2):
        try:
            with marker.open('x',encoding='utf-8') as handle:handle.write(str(os.getpid()))
            return marker
        except FileExistsError:
            try:
                previous=marker.read_text(encoding='utf-8').strip();pid=int(previous)
            except (ValueError,OSError):raise RuntimeError('服务锁内容无效。请核实没有服务进程后手工清理server.lock。')
            if process_alive(pid):raise RuntimeError('该数据目录的服务进程仍在运行或无法确认状态，不能重复启动。')
            try:
                if marker.read_text(encoding='utf-8').strip()==previous:marker.unlink()
            except FileNotFoundError:pass
    raise RuntimeError('服务锁已发生变化，请稍后重试。')


def main():
    parser=argparse.ArgumentParser(description='易代账本地应用')
    parser.add_argument('--host',default='0.0.0.0');parser.add_argument('--port',type=int,default=8765)
    parser.add_argument('--data-dir',default=None);parser.add_argument('--demo',action='store_true');parser.add_argument('--setup-token')
    args=parser.parse_args();data=Path(args.data_dir) if args.data_dir else ROOT/('demo-data' if args.demo else 'data')
    data=data.resolve();data.mkdir(parents=True,exist_ok=True)
    try:marker=acquire_process_lock(data)
    except RuntimeError as e:raise SystemExit(str(e))
    try:
        app=Application(data,args.demo,args.setup_token)
        server=make_server(args.host,args.port,app)
    except BaseException:
        marker.unlink(missing_ok=True);raise
    print('Local application ready: http://127.0.0.1:'+str(args.port),flush=True)
    if app.setup_token:print('First setup (on this computer only): http://127.0.0.1:'+str(args.port)+'/?setup_token='+urllib.parse.quote(app.setup_token),flush=True)
    else:print('Sign in using your configured account.',flush=True)
    try:server.serve_forever(poll_interval=.3)
    except KeyboardInterrupt:pass
    finally:server.server_close();marker.unlink(missing_ok=True)


if __name__=='__main__':main()
