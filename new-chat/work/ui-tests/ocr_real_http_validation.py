import base64, json, sqlite3, sys, tempfile, threading, time
from contextlib import closing
from pathlib import Path
root=Path(r'D:\Codex\2026-10-26\new-chat\outputs\yidaizhang-local')
sys.path.insert(0,str(root));sys.path.insert(0,str(root/'tests'))
import server
from test_http import Client
sample=Path(r'D:\Codex\2026-10-26\new-chat\work\ui-tests\synthetic_invoice_0.png')
with tempfile.TemporaryDirectory(prefix='ydz-real-ocr-http-') as directory:
    app=server.Application(directory)
    http=server.make_server('127.0.0.1',0,app)
    th=threading.Thread(target=http.serve_forever,daemon=True);th.start()
    base=f'http://127.0.0.1:{http.server_address[1]}'
    client=Client(base)
    users=[{'username':f'ocr{i}','name':f'测试{i}','password':f'OcrOnly-{i}-Strong!'} for i in range(1,4)]
    try:
        code,out,_=client.call('/api/setup',{'company_name':'合成测试机构','users':users},headers={'X-Setup-Token':app.setup_token});assert code==200,(code,out)
        def tables():
            with closing(sqlite3.connect(app.db_path)) as conn:
                return {t:conn.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in ('reconciliation_records','vouchers','invoices','clients')}
        before=tables()
        payload={'invoices':[{'name':'broken.png','content_base64':base64.b64encode(b'not an image').decode()}, {'name':sample.name,'content_base64':base64.b64encode(sample.read_bytes()).decode()}]}
        t0=time.monotonic(); code,out,_=client.call('/api/reconcile/parse/start',payload);assert code==200,(code,out)
        ident=out['job_id'];other=Client(base)
        code,_,_=other.call('/api/login',{'username':'ocr2','password':'OcrOnly-2-Strong!'});assert code==200
        code,_,_=other.call('/api/reconcile/parse/progress?job_id='+ident);assert code==404,code
        seen=set()
        while True:
            code,out,_=client.call('/api/reconcile/parse/progress?job_id='+ident);assert code==200,(code,out)
            seen.add(out['status'])
            if out['status']!='running': break
            assert time.monotonic()-t0<120,'timeout'
            time.sleep(.5)
        assert out['status']=='completed',out
        files=out['files'];assert [f['name'] for f in files]==['broken.png',sample.name]
        assert all(f['status']=='completed' for f in files)
        assert files[0]['pages'][0]['orientation_passes'] is None
        passes=files[1]['pages'][0]['orientation_passes'];assert passes in (1,2),passes
        assert files[1]['pages'][0]['elapsed_seconds']>0
        result=out['result'];assert len(result['invoices'])==1,result
        row=result['invoices'][0]
        expected={'date':'2026-09-08','number':'26112000003789636136','amount':'112000.00','buyer':'鸿悦盛嘉（北京）医院管理有限公司','seller':'北京超建邦科技有限公司'}
        assert all(row[k]==v for k,v in expected.items()), {k:row[k] for k in expected}
        assert any('broken.png' in w and '识别失败' in w for w in result['warnings']),result['warnings']
        after=tables();assert before==after,(before,after)
        print(json.dumps({'ok':True,'elapsed_seconds':round(time.monotonic()-t0,2),'seen':sorted(seen),'files':[{'name':f['name'],'status':f['status'],'elapsed_seconds':f['elapsed_seconds'],'pages':f['pages']} for f in files],'warnings':result['warnings'],'fields_verified':list(expected),'session_isolation':True,'business_counts_before_after':before},ensure_ascii=False))
    finally:
        http.shutdown();http.server_close();th.join(timeout=3)
