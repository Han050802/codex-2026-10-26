"""A selected local client fills only blank CSV client columns, atomically."""
import base64
import csv
import io
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import business
import db


class ImportClientFallbackTests(unittest.TestCase):
    def test_invoice_and_tax_blank_fallback_explicit_priority_and_atomic_failure(self):
        with tempfile.TemporaryDirectory(prefix='import-fallback-test-') as directory:
            path=Path(directory)/'temporary.sqlite3';db.initialize(path);conn=db.connect(path)
            try:
                with conn:conn.execute("INSERT INTO users(username,name,password_hash) VALUES('fallback-user','合成导入操作员','not-a-live-login')")
                user=dict(conn.execute('SELECT id,username,name FROM users').fetchone())
                clients=[business.handle(conn,'POST','/api/clients',{'name':'合成导入客户'+str(i),'code':'FALLBACK-'+str(i),'start_period':'2026-01'},user,{}) for i in (1,2)]

                def payload(kind,rows,fallback=None):
                    out=io.StringIO(newline='');writer=csv.DictWriter(out,fieldnames=business.TEMPLATES[kind]);writer.writeheader();writer.writerows(rows)
                    result={'filename':'synthetic-fallback.csv','content_base64':base64.b64encode(out.getvalue().encode('utf-8-sig')).decode()}
                    if fallback is not None:result['client_id']=fallback
                    return result

                for kind in ('invoices','tax-records'):
                    with self.subTest(kind=kind):
                        if kind=='invoices':
                            base={'client_id':'','period':'2026-09','kind':'output','number':'FALLBACK-INV-1','date':'2026-09-01','category':'合成','summary':'仅合成导入','amount':'10.00','tax':'0.00','total':'10.00'}
                            first={**base,'client_id':'   '};second={**base,'client_id':str(clients[1]['id']),'number':'FALLBACK-INV-2'}
                        else:
                            base={'client_id':'','period':'2026-09','tax_type':'合成税种1','status':'pending','payment_status':'unpaid','confirmation_status':'pending','amount':'10.00','paid':'0.00','reference':'','note':'仅合成导入'}
                            first={**base,'client_id':'   '};second={**base,'client_id':str(clients[1]['id']),'tax_type':'合成税种2'}
                        result=business.import_csv(conn,kind,payload(kind,[first,second],clients[0]['id']),user)
                        table=kind.replace('-','_');self.assertEqual(result['imported'],2)
                        self.assertEqual([row['client_id'] for row in conn.execute('SELECT client_id FROM '+table+' ORDER BY id')],[clients[0]['id'],clients[1]['id']])
                        before=conn.execute('SELECT COUNT(*) FROM '+table).fetchone()[0]
                        unique_key='number' if kind=='invoices' else 'tax_type'
                        explicit={**base,'client_id':str(clients[1]['id']),unique_key:'合成整批回滚显式行'}
                        blank={**base,'client_id':'',unique_key:'合成整批回滚空白行'}
                        with self.assertRaises(db.ApiError) as cm:business.import_csv(conn,kind,payload(kind,[explicit,blank]),user)
                        self.assertEqual(cm.exception.status,400);self.assertEqual(cm.exception.details['rows'][0]['row'],3)
                        self.assertEqual(conn.execute('SELECT COUNT(*) FROM '+table).fetchone()[0],before)
                        # A supplied fallback never overrides invalid explicit IDs,
                        # and duplicate checks still apply after resolving blanks.
                        invalid={**base,'client_id':'999999',unique_key:'合成无效显式ID'}
                        for rows in ([invalid],[first]):
                            with self.assertRaises(db.ApiError):business.import_csv(conn,kind,payload(kind,rows,clients[0]['id']),user)
                            self.assertEqual(conn.execute('SELECT COUNT(*) FROM '+table).fetchone()[0],before)
            finally:conn.close()


if __name__=='__main__':unittest.main()
