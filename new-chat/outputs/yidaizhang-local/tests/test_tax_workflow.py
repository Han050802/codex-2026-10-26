"""Local tax preparation rules and freshness; every DB is disposable."""
import concurrent.futures
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import business
import db
import finance
import tax_workflow


class TaxWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='tax-workflow-test-');self.path=Path(self.tmp.name)/'local.sqlite3'
        db.initialize(self.path);self.conn=db.connect(self.path)
        with self.conn:self.conn.executemany('INSERT INTO users(username,name,password_hash) VALUES(?,?,?)',[(f'taxrule{i}',f'合成核对员{i}','not-a-live-login') for i in range(1,4)])
        self.users=[dict(r) for r in self.conn.execute('SELECT id,username,name FROM users ORDER BY id')];self.user=self.users[0]
        self.client=business.handle(self.conn,'POST','/api/clients',{'name':'合成报税客户','code':'TAX-RULE-LOCAL','tax_no':'SYNTHETIC123456789','start_period':'2026-01','authorized_user_ids':[1]},self.user,{})
        self.agent=business.handle(self.conn,'POST','/api/tax-agents',{'name':'合成本地联系人','phone':'13800000000'},self.user,{})

    def tearDown(self):self.conn.close();self.tmp.cleanup()
    def call(self,method='POST',body=None,ident=None,action='',user=None,query=None):
        return business.handle(self.conn,method,'/api/tax-workflows'+(f'/{ident}' if ident else '')+('/'+action if action else ''),body or {},user or self.user,query or {})
    def create(self,**values):return self.call(body={'client_id':self.client['id'],'period':'2026-09','tax_agent_id':self.agent['id'],**values})
    def verified(self,**values):return self.create(verification_status='passed',verification_note='人工核对本地合成资料，不作税局认证',**values)
    def check(self,row,user=None):return self.call(body={'version':row['version']},ident=row['id'],action='check',user=user)
    def patch(self,row,user=None,**values):return self.call('PATCH',{'version':row['version'],**values},row['id'],user=user)
    def get(self,row):return self.call('GET',ident=row['id'])
    def tax(self,**values):
        return business.handle(self.conn,'POST','/api/tax-records',{'client_id':self.client['id'],'period':'2026-09','tax_type':'合成本地增值税','status':'submitted','reference':'SYNTHETIC-LOCAL-RECEIPT','amount_fen':10000,'paid_fen':10000,'payment_status':'paid',**values},self.user,{})
    def error(self,expected,fn,*args,**kwargs):
        with self.assertRaises(db.ApiError) as cm:fn(*args,**kwargs)
        self.assertEqual(cm.exception.status,expected,cm.exception.message)

    def test_no_automatic_configuration_and_no_records_cannot_pass(self):
        self.tax()
        self.assertEqual(business.bootstrap(self.conn,'2026-09',False)['tax_workflows'],[])
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM tax_workflows').fetchone()[0],0)
        row=self.verified(period='2026-08');checked=self.check(row)
        self.assertEqual(checked['general_status'],'failed');self.assertEqual(checked['overall_status'],'failed')
        self.assertEqual(checked['individual_status'],'not_applicable');self.assertEqual(checked['annual_status'],'not_checked')
        self.assertFalse(checked['check_stale']);self.assertEqual(checked['external_action'],'none')

    def test_core_results_only_server_can_generate_and_times_are_not_forgeable(self):
        for values in ({'overall_status':'passed'},{'check_details':[]},{'verified_by':3},{'verified_at':'2000-01-01'},{'checked_at':'2000-01-01'},{'password':'never-store-tax-secret'}):
            self.error(400,self.create,**values)
        self.error(400,self.create,verification_status='passed',verification_note='')
        self.error(400,self.create,tax_agent_id=None,verification_status='passed',verification_note='不能凭空匹配')
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM tax_workflows').fetchone()[0],0)
        row=self.create();self.error(400,self.call,body={'version':1,'overall_status':'passed'},ident=row['id'],action='check')
        self.assertIsNone(row['verified_at']);self.assertIsNone(row['checked_at'])

    def test_fresh_local_pass_has_real_records_manual_identity_and_rule_details(self):
        self.tax();row=self.verified();checked=self.check(row)
        self.assertEqual(checked['overall_status'],'passed');self.assertEqual(checked['general_status'],'passed')
        self.assertEqual(checked['derived_status'],'passed');self.assertEqual(checked['checked_by'],1)
        self.assertFalse(checked['verification_stale']);self.assertEqual(checked['current_check_hash'],checked['checked_snapshot_hash'])
        self.assertTrue(all({'code','title','state','detail','scope','severity','core'}<=set(d) for d in checked['check_details']))
        before=self.conn.execute('SELECT COUNT(*) FROM audit_logs').fetchone()[0]
        again=self.get(checked);self.assertEqual(again['version'],checked['version']);self.assertEqual(again['current_check_hash'],checked['current_check_hash'])
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM audit_logs').fetchone()[0],before)

    def test_invalid_legacy_submission_evidence_and_amounts_are_detected(self):
        record=self.tax();row=self.verified()
        with self.conn:self.conn.execute("UPDATE tax_records SET reference='',attachment_id=NULL,version=version+1 WHERE id=?",(record['id'],))
        checked=self.check(row)
        self.assertEqual(checked['general_status'],'failed')
        self.assertEqual(next(d for d in checked['check_details'] if d['code']=='general_submission_evidence')['state'],'failed')
        with self.conn:self.conn.execute("UPDATE tax_records SET reference='SYNTHETIC-LOCAL-ACK',paid_fen=amount_fen+1,version=version+1 WHERE id=?",(record['id'],))
        self.assertTrue(self.get(checked)['check_stale']);checked=self.check(checked)
        self.assertEqual(next(d for d in checked['check_details'] if d['code']=='general_payment_consistency')['state'],'failed')

    def test_individual_scope_is_explicit_and_missing_records_never_become_success(self):
        self.tax();checked=self.check(self.verified())
        self.assertEqual(checked['individual_status'],'not_applicable')
        enabled=self.patch(checked,individual_applicable=True);checked=self.check(enabled)
        self.assertEqual(checked['individual_status'],'failed');self.assertEqual(checked['overall_status'],'failed')
        self.tax(tax_type='IIT',reference='SYNTHETIC-IIT-ACK')
        self.assertTrue(self.get(checked)['check_stale']);checked=self.check(checked)
        self.assertEqual(checked['individual_status'],'passed');self.assertEqual(checked['overall_status'],'passed')

    def test_annual_result_only_represents_linked_local_project(self):
        self.tax();row=self.verified()
        project=business.handle(self.conn,'POST','/api/projects',{'client_id':self.client['id'],'name':'合成年度资料待办','due_date':'2026-10-31','steps':[{'title':'本地资料步骤','done':False}]},self.user,{})
        row=self.patch(row,annual_project_id=project['id']);checked=self.check(row)
        self.assertEqual(checked['annual_status'],'failed')
        business.handle(self.conn,'PATCH',f'/api/projects/{project["id"]}',{'version':project['version'],'status':'completed','steps':[{'title':'本地资料步骤','done':True}]},self.users[1],{})
        self.assertTrue(self.get(checked)['check_stale']);checked=self.check(checked)
        self.assertEqual(checked['annual_status'],'passed')
        self.assertIn('不代表正式',next(d for d in checked['check_details'] if d['code']=='annual_project')['detail'])

    def test_tax_source_changes_and_deletion_make_previous_pass_stale(self):
        record=self.tax();checked=self.check(self.verified());version=checked['version']
        business.handle(self.conn,'PATCH',f'/api/tax-records/{record["id"]}',{'version':record['version'],'note':'合成源记录修改'},self.user,{})
        stale=self.get(checked)
        self.assertTrue(stale['check_stale']);self.assertEqual(stale['overall_status'],'passed');self.assertEqual(stale['derived_overall_status'],'not_checked')
        self.assertEqual(stale['version'],version);self.assertTrue(all(d['state']=='not_checked' for d in stale['check_details']))
        self.assertTrue(any(d['state']=='passed' for d in stale['last_check_details']))
        fresh=self.check(stale);record=business.fetched(self.conn,'tax_records',record['id'])
        business.handle(self.conn,'DELETE',f'/api/tax-records/{record["id"]}',{'version':record['version']},self.user,{})
        self.assertTrue(self.get(fresh)['check_stale']);self.assertEqual(self.check(fresh)['general_status'],'failed')

    def test_agent_and_client_identity_changes_invalidate_manual_verification(self):
        self.tax();checked=self.check(self.verified())
        changed_agent=business.handle(self.conn,'PATCH',f'/api/tax-agents/{self.agent["id"]}',{'version':self.agent['version'],'phone':'13900000000'},self.users[1],{})
        stale=self.get(checked);self.assertTrue(stale['verification_stale']);self.assertEqual(stale['derived_verification_status'],'unverified')
        self.assertTrue(stale['check_stale']);self.assertEqual(stale['verification_status'],'passed')
        reverified=self.patch(stale,verification_status='passed',verification_note='再次人工核对变更后的联系人')
        self.assertFalse(reverified['verification_stale']);checked=self.check(reverified)
        updated_client=business.handle(self.conn,'PATCH',f'/api/clients/{self.client["id"]}',{'version':self.client['version'],'tax_no':'SYNTHETIC987654321'},self.user,{})
        stale=self.get(checked);self.assertTrue(stale['verification_stale']);self.assertTrue(stale['check_stale'])
        self.assertEqual(self.check(stale)['overall_status'],'failed')
        self.assertEqual(changed_agent['enabled'],1);self.assertEqual(updated_client['tax_no'],'SYNTHETIC987654321')

    def test_invalid_disabled_deleted_or_other_client_agent_cannot_be_used(self):
        other=business.handle(self.conn,'POST','/api/clients',{'name':'合成其他客户','code':'TAX-RULE-OTHER','start_period':'2026-01'},self.user,{})
        other_agent=business.handle(self.conn,'POST','/api/tax-agents',{'name':'仅其他客户联系人','client_id':other['id']},self.user,{})
        self.error(400,self.create,tax_agent_id=other_agent['id'])
        row=self.verified()
        disabled=business.handle(self.conn,'PATCH',f'/api/tax-agents/{self.agent["id"]}',{'version':1,'enabled':False},self.user,{})
        self.assertTrue(self.get(row)['verification_stale']);self.error(400,self.check,row)
        self.error(400,self.patch,row,note='停用办税人不能继续写')
        self.error(400,self.call,'DELETE',{'version':row['version']},row['id'])
        replacement=business.handle(self.conn,'POST','/api/tax-agents',{'name':'合成替换有效联系人','client_id':self.client['id']},self.user,{})
        rebound=self.patch(row,tax_agent_id=replacement['id'])
        self.assertEqual(rebound['verification_status'],'unverified');self.assertIsNone(rebound['verified_at'])
        business.handle(self.conn,'DELETE',f'/api/tax-agents/{replacement["id"]}',{'version':replacement['version']},self.user,{})
        self.error(400,self.check,rebound);self.assertEqual(disabled['enabled'],0)

    def test_finance_sources_are_advisories_and_config_changes_invalidate_results(self):
        self.tax();checked=self.check(self.verified())
        finance.handle(self.conn,'POST',f'/api/books/{self.client["id"]}/vouchers',{'date':'2026-09-01','summary':'合成待审凭证','lines':[{'account_code':'1002','debit_fen':10000,'credit_fen':0},{'account_code':'3001','debit_fen':0,'credit_fen':10000}]},self.user,{})
        business.handle(self.conn,'POST','/api/invoices',{'client_id':self.client['id'],'period':'2026-09','kind':'expense','number':'SYNTHETIC-NOT-POSTED','date':'2026-09-01','amount_fen':100,'tax_fen':0,'total_fen':100},self.user,{})
        self.assertTrue(self.get(checked)['check_stale']);checked=self.check(checked)
        self.assertEqual(checked['overall_status'],'passed')
        for code in ('unreviewed_vouchers','unposted_invoices'):
            self.assertEqual(next(d for d in checked['check_details'] if d['code']==code)['state'],'warning')
        settings=business.settings(self.conn)
        changed=business.handle(self.conn,'POST','/api/settings',{'version':settings['version'],'tax_check_config':{'warn_unreviewed_vouchers':False,'warn_unposted_invoices':False}},self.users[2],{})
        self.assertTrue(self.get(checked)['check_stale']);self.assertFalse(self.get(checked)['verification_stale'])
        checked=self.check(checked)
        self.assertTrue(all(d['state']=='disabled' for d in checked['check_details'] if not d['core']))
        business.handle(self.conn,'POST','/api/settings',{'version':changed['version'],'company_name':'仅修改机构名称不影响规则'},self.user,{})
        self.assertFalse(self.get(checked)['check_stale'])

    def test_settings_only_toggle_advisories_and_core_rules_remain_required(self):
        settings=business.settings(self.conn);self.assertEqual(settings['tax_check_config'],tax_workflow.CONFIG_DEFAULTS)
        for value in ({'check_identity':False},{'require_receipts':False},{'warn_unposted_invoices':0},None,[]):
            self.error(400,business.handle,self.conn,'POST','/api/settings',{'version':settings['version'],'tax_check_config':value},self.user,{})
        changed=business.handle(self.conn,'POST','/api/settings',{'version':settings['version'],'tax_check_config':{'warn_unposted_invoices':False}},self.user,{})
        self.assertTrue(changed['tax_check_config']['warn_unreviewed_vouchers'])
        checked=self.check(self.create());self.assertEqual(checked['overall_status'],'failed')
        detail=json.loads(self.conn.execute("SELECT detail FROM audit_logs WHERE entity='settings' ORDER BY id DESC LIMIT 1").fetchone()[0])
        self.assertEqual(detail['tax_check_config']['after']['warn_unposted_invoices'],False)

    def test_three_users_versions_upsert_and_scope_fields_remain_protected(self):
        self.tax();row=self.verified()
        self.error(409,self.create,note='未携版本')
        for user in self.users[1:]:
            row=self.patch(row,user=user,note=user['name']+'本地编辑');self.assertEqual(row['updated_by'],user['id'])
        self.error(409,self.patch,{**row,'version':1},note='旧版本')
        self.error(400,self.patch,row,period='2026-10');self.error(400,self.patch,row,client_id=999)
        checked=self.check(row,user=self.users[2]);self.assertEqual(checked['checked_by'],3)
        self.assertEqual(self.conn.execute("SELECT user_id FROM audit_logs WHERE entity='tax_workflows' AND action='check' ORDER BY id DESC LIMIT 1").fetchone()[0],3)

    def test_soft_delete_recycle_and_purge_preserve_workflow_history(self):
        row=self.create();deleted=self.call('DELETE',{'version':1,'reason':'合成本地配置纠错'},row['id'])
        self.assertEqual(deleted['deleted'],1);self.assertEqual(business.bootstrap(self.conn,'2026-09',False)['tax_workflows'],[])
        self.error(404,self.get,row)
        recreated=self.create();self.assertNotEqual(row['id'],recreated['id'])
        disabled=business.handle(self.conn,'PATCH',f'/api/clients/{self.client["id"]}',{'version':1,'enabled':False},self.user,{})
        self.error(400,self.check,recreated)
        enabled=business.handle(self.conn,'PATCH',f'/api/clients/{self.client["id"]}',{'version':disabled['version'],'enabled':True},self.user,{})
        recycled=business.handle(self.conn,'DELETE',f'/api/clients/{self.client["id"]}',{'version':enabled['version']},self.user,{})
        self.assertTrue(self.get(recreated)['client_deleted']);self.error(400,self.patch,recreated,note='不能写回收客户')
        self.error(409,business.handle,self.conn,'POST',f'/api/clients/{self.client["id"]}/purge',{'version':recycled['version']},self.user,{})
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM tax_workflows').fetchone()[0],2)

    def test_concurrent_initial_configuration_and_edits_have_one_winner(self):
        def race(payloads):
            barrier=threading.Barrier(2)
            def run(payload):
                conn=db.connect(self.path)
                try:
                    barrier.wait(timeout=3)
                    try:return tax_workflow.handle(conn,'POST','/api/tax-workflows',payload,self.user,{})['version']
                    except db.ApiError as error:return error.status
                finally:conn.close()
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:return list(pool.map(run,payloads))
        payload={'client_id':self.client['id'],'period':'2026-09','tax_agent_id':self.agent['id']}
        self.assertEqual(sorted(race([payload,payload])),[1,409])
        self.assertEqual(sorted(race([{**payload,'version':1,'note':'合成A'},{**payload,'version':1,'note':'合成B'}])),[2,409])

    def test_additive_initialization_preserves_legacy_agents_and_no_configs(self):
        legacy=Path(self.tmp.name)/'legacy.sqlite3';raw=sqlite3.connect(legacy)
        raw.execute("CREATE TABLE tax_agents(id INTEGER PRIMARY KEY,name TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',role TEXT NOT NULL DEFAULT '',client_id INTEGER,note TEXT NOT NULL DEFAULT '',deleted INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)")
        raw.execute("INSERT INTO tax_agents(name,created_at,updated_at) VALUES('合成旧联系人','2000-01-01','2000-01-01')");raw.commit();raw.close()
        db.initialize(legacy);conn=db.connect(legacy)
        try:
            self.assertEqual(conn.execute('SELECT name,enabled FROM tax_agents').fetchone()['enabled'],1)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM tax_workflows').fetchone()[0],0)
        finally:conn.close()


class TaxWorkflowHTTPTests(unittest.TestCase):
    def test_authenticated_local_check_routes_csrf_and_freshness(self):
        import server
        from tests.test_http import Client
        with tempfile.TemporaryDirectory(prefix='tax-workflow-http-test-') as directory:
            app=server.Application(directory);http=server.make_server('127.0.0.1',0,app);thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
            try:
                client=Client(f'http://127.0.0.1:{http.server_address[1]}');self.assertEqual(client.call('/api/tax-workflows')[0],401)
                users=[{'username':f'taxhttp{i}','name':f'合成报税HTTP{i}','password':f'TaxWorkflow-{i}-Strong!'} for i in range(1,4)]
                self.assertEqual(client.call('/api/setup',{'company_name':'合成报税规则HTTP','users':users},headers={'X-Setup-Token':app.setup_token})[0],200)
                self.assertEqual(client.call('/api/bootstrap')[1]['tax_workflows'],[])
                _,company,_=client.call('/api/clients',{'name':'合成HTTP检查客户','code':'TAX-HTTP','tax_no':'SYNTHETIC123456789','start_period':'2026-01'})
                _,agent,_=client.call('/api/tax-agents',{'name':'合成HTTP联系人'})
                payload={'client_id':company['id'],'period':'2026-09','tax_agent_id':agent['id'],'verification_status':'passed','verification_note':'合成人工匹配核对'}
                self.assertEqual(client.call('/api/tax-workflows',payload,csrf=False)[0],403)
                code,row,_=client.call('/api/tax-workflows',payload);self.assertEqual(code,200,row)
                code,checked,_=client.call(f'/api/tax-workflows/{row["id"]}/check',{'version':row['version']});self.assertEqual(code,200,checked);self.assertEqual(checked['overall_status'],'failed')
                self.assertEqual(client.call('/api/tax-records',{'client_id':company['id'],'period':'2026-09','tax_type':'合成增值税','status':'submitted','reference':'SYNTHETIC-ACK'})[0],200)
                current=client.call(f'/api/tax-workflows/{row["id"]}')[1]
                self.assertTrue(current['check_stale']);self.assertEqual(current['version'],checked['version']);self.assertEqual(current['derived_status'],'not_checked')
                code,fresh,_=client.call(f'/api/tax-workflows/{row["id"]}/check',{'version':current['version']});self.assertEqual(code,200,fresh);self.assertEqual(fresh['overall_status'],'passed')
                self.assertEqual(client.call(f'/api/tax-workflows/{row["id"]}',{'version':fresh['version'],'overall_status':'passed'},'PATCH')[0],400)
                self.assertEqual(client.call(f'/api/tax-workflows/{row["id"]}',{'version':fresh['version']},'DELETE')[0],200)
                self.assertEqual(client.call('/api/bootstrap')[1]['tax_workflows'],[])
            finally:http.shutdown();http.server_close();thread.join(timeout=3)


if __name__=='__main__':unittest.main()
