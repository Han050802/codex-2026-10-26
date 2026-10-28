import base64
import threading
import time
import unittest
from unittest.mock import patch

import reconciliation
from db import ApiError
from server import ReconciliationJobs


class JobTests(unittest.TestCase):
    def test_isolation_capacity_and_timing(self):
        manager=ReconciliationJobs()
        entered=threading.Event(); release=threading.Event()
        def fake_parse(payload, update):
            update('start',name='a.jpg',kind='invoice')
            entered.set(); release.wait(2)
            update('page',page=1,elapsed_seconds=1.25,orientation_passes=2)
            update('end')
            return {'transactions':[],'invoices':[],'warnings':[],'account_name':''}
        with patch.object(reconciliation,'parse',side_effect=fake_parse):
            ident=manager.start({},1,'session-a')['job_id']
            self.assertTrue(entered.wait(2))
            with self.assertRaises(ApiError): manager.start({},2,'session-b')
            with self.assertRaises(ApiError): manager.parse_sync({})
            with self.assertRaises(ApiError): manager.progress(ident,2,'session-a')
            with self.assertRaises(ApiError): manager.progress(ident,1,'session-b')
            self.assertEqual(manager.progress(ident,1,'session-a')['files'][0]['status'],'running')
            release.set()
            for _ in range(100):
                snapshot=manager.progress(ident,1,'session-a')
                if snapshot['status']!='running':break
                time.sleep(.01)
            self.assertEqual(snapshot['status'],'completed')
            self.assertEqual(snapshot['files'][0]['pages'][0]['orientation_passes'],2)
            self.assertEqual(snapshot['files'][0]['pages'][0]['elapsed_seconds'],1.25)
            self.assertEqual(snapshot['files'][0]['status'],'completed')
            manager.jobs[ident]['finished']-=901
            with self.assertRaises(ApiError): manager.progress(ident,1,'session-a')

    def test_idle_finished_job_expires(self):
        manager=ReconciliationJobs();manager.ttl=.05
        with patch.object(reconciliation,'parse',return_value={}):
            ident=manager.start({},1,'session')['job_id']
            time.sleep(.15)
        self.assertNotIn(ident,manager.jobs)

    def test_real_parse_events_and_errors_preserve_order(self):
        def item(name): return {'name':name,'content_base64':base64.b64encode(b'image').decode()}
        good={'ok':True,'orientation_candidates_tried':2,'orientation_confident':True,'fields':{'invoice_number':'123'}}
        events=[]
        with patch.object(reconciliation.OCRWorker,'run',side_effect=[(None,'失败'),(good,'')]):
            out=reconciliation.parse({'invoices':[item('one.jpg'),item('two.jpg')]},lambda event,**kw: events.append((event,kw)))
        self.assertEqual([e[1]['name'] for e in events if e[0]=='start'],['one.jpg','two.jpg'])
        pages=[e[1] for e in events if e[0]=='page']
        self.assertEqual([p['orientation_passes'] for p in pages],[None,2])
        self.assertGreaterEqual(pages[1]['elapsed_seconds'],0)
        self.assertEqual(len(out['invoices']),1)
        self.assertTrue(any('one.jpg' in x for x in out['warnings']))

    def test_job_invalid_input_reports_validation_error(self):
        manager=ReconciliationJobs()
        ident=manager.start({'invoices':'bad'},1,'session')['job_id']
        for _ in range(100):
            snapshot=manager.progress(ident,1,'session')
            if snapshot['status']!='running':break
            time.sleep(.01)
        self.assertEqual(snapshot['status'],'failed')
        self.assertIn('发票文件数量无效',snapshot['error'])

if __name__=='__main__': unittest.main()
