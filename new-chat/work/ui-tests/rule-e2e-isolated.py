import json, sys, tempfile, threading
from pathlib import Path
from urllib.parse import urlencode
from contextlib import closing
root=Path(__file__).resolve().parents[2]/'outputs'/'yidaizhang-local'
sys.path.insert(0,str(root)); sys.path.insert(0,str(root/'tests'))
import db,server
from test_http import Client

def check(condition, message):
    if not condition: raise AssertionError(message)

with tempfile.TemporaryDirectory(prefix='rule-e2e-isolated-') as directory:
    app=server.Application(directory)
    http=server.make_server('127.0.0.1',0,app)
    thread=threading.Thread(target=http.serve_forever,daemon=True); thread.start()
    try:
        client=Client(f'http://127.0.0.1:{http.server_address[1]}')
        users=[{'username':f'test{i}','name':f'测试{i}','password':f'OnlyForTests-{i}-Strong!'} for i in range(1,4)]
        status,body,_=client.call('/api/setup',{'company_name':'临时测试机构','users':users},headers={'X-Setup-Token':app.setup_token})
        check(status==200, f'setup {status} {body}')
        for standard,expected in [('small2013','5602'),('enterprise2007','6602')]:
            name='测试公司'+standard
            payload={'name':name,'code':'TEST-'+standard,'taxpayer_type':'general','standard':standard,'start_period':'2026-01','industry':'商务服务','region':'本地','accountant_id':1,'enabled':True}
            status,body,_=client.call('/api/clients',payload); check(status==200,f'client {status} {body}')
            cid=body['id']
            status,body,_=client.call('/api/reconcile/account-rules?'+urlencode({'client_id':cid,'q':'办公用品'}))
            check(status==200 and any(r['account_name']=='管理费用' and r['account_code']==expected for r in body['rules']),f'{standard} rules {body}')
            status,body,_=client.call('/api/reconcile/account-rules?'+urlencode({'client_id':cid,'q':'无此特定测试关键词XYZ'}))
            check(status==200 and body['rules']==[],f'{standard} empty {body}')
            trans={'date':'2026-09-09','amount':'-100.00','counterparty':'测试供应商','note':'办公','source':'test'}
            base={'date':'2026-09-08','amount':'100.00','seller':'测试供应商','buyer':name,'number':'SYNTH-'+standard,'source':'test','item_name':'办公用品','business_purpose':'行政管理用途'}
            def match(inv):
                status,out,_=client.call('/api/reconcile/match',{'client_id':cid,'account_name':name,'transactions':[trans],'invoices':[inv]})
                check(status==200,f'match {status} {out}'); check(out['matches'][0]['status']=='matched',f'pair {out}')
                return out['classification_invoices'][0]
            out=match(base); check(out['account_code']==expected and out['status']=='suggested',f'{standard} admin {out}')
            out=match(dict(base,business_purpose='')); check(out['status']=='review' and out['account_code'] is None and any(c['account_name']=='管理费用' for c in out['candidates']),f'{standard} missing {out}')
            out=match(dict(base,item_name='办公用品；电脑',business_purpose='行政管理用途')); check(out['status']=='review' and out['account_code'] is None and len(out['candidates'])>=2,f'{standard} multi {out}')
            print(f'{standard}: {expected}; 办公用品建议、用途缺失与多项目待核候选、规则搜索及空结果通过')
        with closing(db.connect(app.db_path)) as conn:
            check(conn.execute('SELECT COUNT(*) FROM vouchers').fetchone()[0]==0,'unexpected voucher')
            check(conn.execute('SELECT COUNT(*) FROM reconciliation_records').fetchone()[0]==0,'unexpected records')
        print('临时数据库无凭证和核对记录写入；测试服务已隔离。')
    finally:
        http.shutdown();http.server_close();thread.join(timeout=3)
