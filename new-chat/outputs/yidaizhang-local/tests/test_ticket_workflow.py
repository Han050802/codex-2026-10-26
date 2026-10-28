"""Local-only ticket workflow checks. Every database is disposable."""
import concurrent.futures
import base64
import csv
import datetime as dt
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import business
import db
import ticket_workflow


class TicketWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='ticket-workflow-test-')
        self.path=Path(self.tmp.name)/'workflow.sqlite3';db.initialize(self.path);self.conn=db.connect(self.path)
        with self.conn:self.conn.executemany('INSERT INTO users(username,name,password_hash) VALUES(?,?,?)',[(f'workflow{i}',f'合成操作员{i}','not-a-live-login') for i in range(1,4)])
        self.users=[dict(row) for row in self.conn.execute('SELECT id,username,name FROM users ORDER BY id')]
        self.user=self.users[0]
        self.customer=business.handle(self.conn,'POST','/api/clients',{'name':'合成取票客户','code':'TICKET-SYNTHETIC','start_period':'2026-01','accountant_id':1,'authorized_user_ids':[1]},self.user,{})

    def tearDown(self):self.conn.close();self.tmp.cleanup()
    def call(self,kind='ticket-tasks',body=None,method='POST',ident=None,user=None,query=None):
        path='/api/'+kind+(f'/{ident}' if ident else '')
        return business.handle(self.conn,method,path,body or {},user or self.user,query or {})
    def create(self,kind='ticket-tasks',**fields):return self.call(kind,{'client_id':self.customer['id'],'period':'2026-09',**fields})
    def error(self,expected_status,fn,*args,**kwargs):
        with self.assertRaises(db.ApiError) as cm:fn(*args,**kwargs)
        self.assertEqual(cm.exception.status,expected_status,cm.exception.message)

    def test_defaults_bootstrap_and_actual_invoice_counts_stay_independent(self):
        task=self.create();check=self.create('ticket-auth-checks')
        self.assertEqual((task['status'],task['version'],task['created_by']),('pending',1,1))
        self.assertEqual((check['status'],check['checked_at'],check['checked_by']),('unrecorded',None,None))
        completed=self.call(body={'version':task['version'],'status':'completed'},method='PATCH',ident=task['id'])
        self.assertEqual(completed['status_label'],'已完成待办');self.assertEqual(completed['external_action'],'none')
        boot=business.bootstrap(self.conn,'2026-09',False)
        self.assertEqual(boot['invoices'],[]);self.assertEqual(len(boot['ticket_tasks']),1);self.assertEqual(len(boot['ticket_auth_checks']),1)
        self.assertTrue(all(x['local_only'] for k in ('ticket_tasks','ticket_auth_checks') for x in boot[k]))
        self.assertEqual(boot['ticket_tasks'][0]['client_name'],self.customer['name'])

    def test_schedule_validation_due_flag_and_no_automatic_execution(self):
        for bad in ('2026-02-30T12:00','2026-10-01','2026-10-01T25:00','2026-10-01T01:00Z',False):
            self.error(400,self.create,status='scheduled',scheduled_at=bad)
        self.error(400,self.create,status='scheduled')
        old=self.create(status='scheduled',scheduled_at='2026-01-01T09:00',note='仅合成待办')
        self.assertTrue(old['due']);self.assertEqual(old['status'],'scheduled')
        again=self.call(method='GET',ident=old['id']);self.assertEqual(again['version'],1);self.assertEqual(again['status'],'scheduled')
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM invoices').fetchone()[0],0)

    def test_failed_tasks_require_reason_and_authentication_labels_are_manual(self):
        self.error(400,self.create,status='failed',note=' ')
        failed=self.create(status='failed',note='本地文件校验失败')
        self.assertEqual(failed['status'],'failed')
        check=self.create('ticket-auth-checks',status='confirmed',note='合成人工资料核对')
        self.assertEqual(check['status_label'],'已人工核对');self.assertEqual(check['checked_by'],1)
        self.assertIsNotNone(check['checked_at']);self.assertEqual(check['source'],'manual')
        self.error(400,self.create,'ticket-auth-checks',period='2026-08',source='import')
        self.error(400,self.create,'ticket-auth-checks',period='2026-08',status='authenticated')

    def test_post_upsert_and_patch_require_exact_version_and_preserve_identity(self):
        for kind in ('ticket-tasks','ticket-auth-checks'):
            with self.subTest(kind=kind):
                item=self.create(kind)
                self.error(409,self.create,kind,note='遗漏版本')
                self.error(409,self.create,kind,version=True,note='布尔版本')
                changed=self.create(kind,version=1,note='原子更新')
                self.assertEqual(changed['id'],item['id']);self.assertEqual(changed['version'],2)
                self.error(409,self.call,kind,{'version':1,'note':'旧版本'},'PATCH',item['id'])
                self.error(400,self.call,kind,{'version':2,'period':'2026-10'},'PATCH',item['id'])
                self.error(400,self.call,kind,{'version':2,'client_id':999},'PATCH',item['id'])
        self.error(409,self.create,period='2026-10',version=0.0)

    def test_server_controls_check_identity_time_and_does_not_store_credentials(self):
        secrets={'password':'never-store-tax-password','tax_username':'never-store-tax-user','checked_at':'2001-01-01','checked_by':3,'created_by':3}
        for key,value in secrets.items():
            self.error(400,self.create,'ticket-auth-checks',**{key:value})
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM ticket_auth_checks').fetchone()[0],0)
        self.assertNotIn('never-store-tax',json.dumps(business.bootstrap(self.conn,'2026-09',False),ensure_ascii=False))
        check=self.create('ticket-auth-checks',status='confirmed')
        updated=self.call('ticket-auth-checks',{'version':1,'note':'仅补充备注'},'PATCH',check['id'],self.users[1])
        self.assertEqual(updated['checked_by'],1);self.assertEqual(updated['checked_at'],check['checked_at']);self.assertEqual(updated['updated_by'],2)
        rechecked=self.call('ticket-auth-checks',{'version':2,'status':'needs_update'},'PATCH',check['id'],self.users[2])
        self.assertEqual(rechecked['checked_by'],3)
        reset=self.call('ticket-auth-checks',{'version':3,'status':'unrecorded'},'PATCH',check['id'])
        self.assertIsNone(reset['checked_at']);self.assertIsNone(reset['checked_by'])

    def test_three_users_can_edit_unassigned_company_and_audit_records_executor(self):
        item=self.create()
        for user in self.users[1:]:
            item=self.call(body={'version':item['version'],'note':user['name']+'编辑'},method='PATCH',ident=item['id'],user=user)
            self.assertEqual(item['updated_by'],user['id'])
        audit_row=self.conn.execute("SELECT * FROM audit_logs WHERE entity='ticket_tasks' ORDER BY id DESC LIMIT 1").fetchone()
        self.assertEqual(audit_row['user_id'],3)
        detail=json.loads(audit_row['detail']);self.assertEqual(detail['after']['client_id'],self.customer['id']);self.assertEqual(detail['external_action'],'none')

    def test_soft_delete_preserves_history_and_allows_new_current_record(self):
        for kind,table in ticket_workflow.TABLES.items():
            item=self.create(kind)
            removed=self.call(kind,{'version':item['version'],'reason':'合成本地纠错'},'DELETE',item['id'])
            self.assertEqual(removed['deleted'],1);self.assertEqual(removed['version'],2)
            self.assertIsNotNone(removed['deleted_at'])
            if kind=='ticket-tasks':self.assertEqual(removed['status'],'cancelled')
            self.error(404,self.call,kind,method='GET',ident=item['id'])
            self.assertEqual(business.bootstrap(self.conn,'2026-09',False)[table],[])
            fresh=self.create(kind);self.assertNotEqual(fresh['id'],item['id']);self.assertEqual(fresh['version'],1)
            self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM '+table).fetchone()[0],2)

    def test_disabled_and_recycled_clients_keep_rows_and_block_writes(self):
        item=self.create()
        disabled=business.handle(self.conn,'PATCH',f'/api/clients/{self.customer["id"]}',{'version':1,'enabled':False},self.user,{})
        self.error(400,self.call,body={'version':1,'note':'不能写停用公司'},method='PATCH',ident=item['id'])
        self.error(400,self.call,body={'version':1},method='DELETE',ident=item['id'])
        enabled=business.handle(self.conn,'PATCH',f'/api/clients/{self.customer["id"]}',{'version':disabled['version'],'enabled':True},self.user,{})
        recycled=business.handle(self.conn,'DELETE',f'/api/clients/{enabled["id"]}',{'version':enabled['version']},self.user,{})
        self.error(400,self.create,'ticket-auth-checks')
        self.error(400,self.call,body={'version':1},method='DELETE',ident=item['id'])
        stored=business.bootstrap(self.conn,'2026-09',False)['ticket_tasks'][0]
        self.assertTrue(stored['client_deleted']);self.assertEqual(stored['version'],1)
        restored=business.handle(self.conn,'POST',f'/api/clients/{recycled["id"]}/restore',{'version':recycled['version']},self.user,{})
        edited=self.call(body={'version':1,'note':'恢复后可编辑'},method='PATCH',ident=item['id'])
        self.assertEqual(edited['version'],2);self.assertEqual(restored['deleted'],0)

    def test_purge_protects_even_soft_deleted_workflow_history(self):
        for number,kind in enumerate(('ticket-tasks','ticket-auth-checks'),1):
            client=business.handle(self.conn,'POST','/api/clients',{'name':'合成历史保护'+str(number),'code':'TICKET-HISTORY-'+str(number),'start_period':'2026-01'},self.user,{})
            item=self.call(kind,{'client_id':client['id'],'period':'2026-09'})
            self.call(kind,{'version':1},'DELETE',item['id'])
            recycled=business.handle(self.conn,'DELETE',f'/api/clients/{client["id"]}',{'version':1},self.user,{})
            with self.assertRaises(db.ApiError) as cm:business.handle(self.conn,'POST',f'/api/clients/{client["id"]}/purge',{'version':recycled['version']},self.user,{})
            self.assertEqual(cm.exception.status,409);self.assertIn(ticket_workflow.TABLES[kind],cm.exception.details['counts'])

    def test_concurrent_create_and_edit_have_only_one_winner(self):
        def race(payloads):
            barrier=threading.Barrier(2)
            def run(payload):
                conn=db.connect(self.path)
                try:
                    barrier.wait(timeout=3)
                    try:return ticket_workflow.handle(conn,'POST','/api/ticket-tasks',payload,self.user,{})['version']
                    except db.ApiError as error:return error.status
                finally:conn.close()
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:return list(pool.map(run,payloads))
        payload={'client_id':self.customer['id'],'period':'2026-09','status':'pending'}
        self.assertEqual(sorted(race([payload,payload])),[1,409])
        self.assertEqual(sorted(race([{**payload,'version':1,'note':'合成并发A'},{**payload,'version':1,'note':'合成并发B'}])),[2,409])
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM ticket_tasks').fetchone()[0],1)

    def test_reinitialization_is_additive_and_filters_are_read_only(self):
        task=self.create();self.create('ticket-auth-checks',status='confirmed')
        self.conn.close();db.initialize(self.path);self.conn=db.connect(self.path)
        selected=self.call(method='GET',query={'client_id':str(self.customer['id']),'period':'2026-09'})
        self.assertEqual(len(selected),1);self.assertEqual(selected[0]['id'],task['id']);self.assertEqual(selected[0]['version'],1)
        self.assertEqual(self.call(method='GET',query={'period':'2026-10'}),[])
        self.error(400,self.call,method='GET',query={'client_id':'not-an-id'})
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM clients').fetchone()[0],1)

    def test_vat_filing_frequency_defaults_preservation_validation_and_versions(self):
        self.assertEqual(self.customer['vat_filing_frequency'],'')
        # A profile created before this optional field existed also stays unset.
        with self.conn:self.conn.execute("UPDATE clients SET profile_json='{}' WHERE id=?",(self.customer['id'],))
        legacy=business.fetched(self.conn,'clients',self.customer['id']);self.assertEqual(legacy['vat_filing_frequency'],'')
        for bad in ('annual','季',True,1,None,[]):
            self.error(400,business.handle,self.conn,'PATCH',f'/api/clients/{legacy["id"]}',{'version':legacy['version'],'vat_filing_frequency':bad},self.user,{})
        changed=business.handle(self.conn,'PATCH',f'/api/clients/{legacy["id"]}',{'version':legacy['version'],'vat_filing_frequency':'quarter'},self.user,{})
        self.assertEqual(changed['vat_filing_frequency'],'quarter');self.assertEqual(changed['version'],legacy['version']+1)
        kept=business.handle(self.conn,'PATCH',f'/api/clients/{changed["id"]}',{'version':changed['version'],'note':'普通资料修改保留期限'},self.user,{})
        self.assertEqual(kept['vat_filing_frequency'],'quarter')
        self.error(409,business.handle,self.conn,'PATCH',f'/api/clients/{kept["id"]}',{'version':1,'vat_filing_frequency':'month'},self.user,{})
        cleared=business.handle(self.conn,'PATCH',f'/api/clients/{kept["id"]}',{'version':kept['version'],'vat_filing_frequency':''},self.user,{})
        self.assertEqual(cleared['vat_filing_frequency'],'')

    def test_vat_filing_frequency_optional_csv_roundtrip_without_guessing(self):
        fields=business.TEMPLATES['clients']+['vat_filing_frequency']
        out=io.StringIO(newline='');writer=csv.DictWriter(out,fieldnames=fields);writer.writeheader()
        for i,frequency in enumerate(('month','quarter',''),1):
            row={key:'' for key in fields};row.update(name='合成期限客户'+str(i),code='TICKET-VAT-'+str(i),taxpayer_type='general' if i==2 else 'small',standard='small2013',start_period='2026-01',vat_filing_frequency=frequency);writer.writerow(row)
        result=business.import_csv(self.conn,'clients',{'filename':'synthetic-frequency.csv','content_base64':base64.b64encode(out.getvalue().encode('utf-8-sig')).decode()},self.user)
        self.assertEqual(result['imported'],3)
        exported=list(csv.DictReader(io.StringIO(business.export_csv(self.conn,'clients',{}).decode('utf-8-sig'))))
        values={row['code']:row['vat_filing_frequency'] for row in exported}
        self.assertEqual([values['TICKET-VAT-'+str(i)] for i in range(1,4)],['month','quarter',''])
        self.assertEqual(business.fetched(self.conn,'clients',self.customer['id'])['vat_filing_frequency'],'')

    def test_local_warning_config_defaults_partial_updates_version_and_audit(self):
        original=business.settings(self.conn)
        self.assertEqual(original['ticket_warning_config'],{'quarter_limit_fen':30000000,'rolling12_limit_fen':500000000,'near_percent':90})
        configured=business.handle(self.conn,'POST','/api/settings',{'version':original['version'],'ticket_warning_config':{'quarter_limit_fen':12345678,'rolling12_limit_fen':987654321,'near_percent':80}},self.user,{})
        updated=business.handle(self.conn,'POST','/api/settings',{'version':configured['version'],'ticket_warning_config':{'near_percent':75}},self.users[2],{})
        self.assertEqual(updated['ticket_warning_config'],{'quarter_limit_fen':12345678,'rolling12_limit_fen':987654321,'near_percent':75})
        self.assertEqual(updated['version'],original['version']+2)
        self.error(409,business.handle,self.conn,'POST','/api/settings',{'version':original['version'],'ticket_warning_config':{}},self.user,{})
        entry=self.conn.execute("SELECT user_id,detail FROM audit_logs WHERE entity='settings' ORDER BY id DESC LIMIT 1").fetchone()
        self.assertEqual(entry['user_id'],3);detail=json.loads(entry['detail'])['ticket_warning_config']
        self.assertEqual(detail['before']['near_percent'],80);self.assertEqual(detail['after']['near_percent'],75)
        self.conn.close();db.initialize(self.path);self.conn=db.connect(self.path)
        self.assertEqual(business.settings(self.conn)['ticket_warning_config'],updated['ticket_warning_config'])

    def test_warning_config_rejects_boolean_nonintegers_ranges_and_rolls_back_batch(self):
        invalid=[None,[],{'unsupported':1}]
        invalid += [{key:value} for key in ('quarter_limit_fen','rolling12_limit_fen') for value in (0,-1,True,1.5,'30000000',900000000000001)]
        invalid += [{'near_percent':value} for value in (0,101,False,90.0,'90')]
        original=business.settings(self.conn)
        for value in invalid:
            self.error(400,business.handle,self.conn,'POST','/api/settings',{'version':original['version'],'company_name':'验证失败不得保存','ticket_warning_config':value},self.user,{})
            self.assertEqual(business.settings(self.conn),original)
        self.error(409,business.handle,self.conn,'POST','/api/settings',{'version':True,'ticket_warning_config':{'near_percent':95}},self.user,{})
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM audit_logs WHERE entity='settings'").fetchone()[0],0)


class TicketWorkflowHTTPTests(unittest.TestCase):
    def test_authenticated_csrf_guarded_routes_and_safe_bootstrap(self):
        import server
        from tests.test_http import Client
        with tempfile.TemporaryDirectory(prefix='ticket-workflow-http-test-') as directory:
            app=server.Application(directory)
            http=server.make_server('127.0.0.1',0,app);thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
            try:
                client=Client(f'http://127.0.0.1:{http.server_address[1]}')
                self.assertEqual(client.call('/api/ticket-tasks')[0],401)
                users=[{'username':f'tickethttp{i}','name':f'合成票据用户{i}','password':f'TicketHTTP-{i}-Strong!'} for i in range(1,4)]
                self.assertEqual(client.call('/api/setup',{'company_name':'合成票据HTTP','users':users},headers={'X-Setup-Token':app.setup_token})[0],200)
                code,company,_=client.call('/api/clients',{'name':'合成HTTP取票客户','code':'TICKET-HTTP','start_period':'2026-01'});self.assertEqual(code,200)
                payload={'client_id':company['id'],'period':'2026-09','status':'scheduled','scheduled_at':'2026-10-27T09:00'}
                self.assertEqual(client.call('/api/ticket-tasks',payload,csrf=False)[0],403)
                code,task,_=client.call('/api/ticket-tasks',payload);self.assertEqual(code,200,task)
                code,check,_=client.call('/api/ticket-auth-checks',{'client_id':company['id'],'period':'2026-09','status':'confirmed'});self.assertEqual(code,200,check)
                self.assertEqual(check['status_label'],'已人工核对');self.assertEqual(check['external_action'],'none')
                self.assertEqual(client.call('/api/ticket-tasks/'+str(task['id']),{'version':1,'status':'completed'},'PATCH')[0],200)
                bootstrap=client.call('/api/bootstrap?period=2026-09')[1]
                self.assertEqual(bootstrap['invoices'],[]);self.assertEqual(bootstrap['ticket_tasks'][0]['status'],'completed')
                self.assertNotIn('password_hash',json.dumps(bootstrap))
                self.assertEqual(client.call('/api/ticket-auth-checks/'+str(check['id']),{'version':1,'reason':'合成人工记录删除'},'DELETE')[0],200)
                self.assertEqual(client.call('/api/bootstrap')[1]['ticket_auth_checks'],[])
                settings=bootstrap['settings']
                code,configured,_=client.call('/api/settings',{'version':settings['version'],'ticket_warning_config':{'near_percent':85}})
                self.assertEqual(code,200,configured);self.assertEqual(configured['ticket_warning_config']['near_percent'],85)
                self.assertEqual(client.call('/api/settings',{'version':configured['version'],'ticket_warning_config':{'quarter_limit_fen':True}})[0],400)
                code,frequency,_=client.call('/api/clients/'+str(company['id']),{'version':company['version'],'vat_filing_frequency':'quarter'},'PATCH')
                self.assertEqual(code,200,frequency);self.assertEqual(frequency['vat_filing_frequency'],'quarter')
            finally:http.shutdown();http.server_close();thread.join(timeout=3)


if __name__=='__main__':unittest.main()
