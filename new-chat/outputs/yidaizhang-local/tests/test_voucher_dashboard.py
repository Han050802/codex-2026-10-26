"""Actual voucher history for the home page; every book uses temporary data."""
import os
import tempfile
import unittest

import db
import finance


class VoucherDashboardTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.path=os.path.join(self.tmp.name,'voucher-dashboard.sqlite3')
        db.initialize(self.path)
        self.conn=db.connect(self.path)
        self.user={'id':1,'username':'tester','name':'测试员'}
        with self.conn:
            self.conn.execute("INSERT INTO users(id,username,name,password_hash) VALUES(1,'tester','测试员','unused')")
            for cid in (1,2):
                self.conn.execute("INSERT INTO clients(id,name,code,taxpayer_type,standard,start_period,created_at,updated_at) VALUES(?,?,?,'small','small2013','2025-01',?,?)",
                                  (cid,f'合成账套{cid}',f'DASH{cid}',db.now(),db.now()))
                finance.ensure_book(self.conn,dict(self.conn.execute('SELECT * FROM clients WHERE id=?',(cid,)).fetchone()))

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def call(self,route='',payload=None,method='POST',cid=1,period='2026-10',query=None):
        return finance.handle(self.conn,method,f'/api/books/{cid}'+('/'+route if route else ''),
                              payload or {},self.user,query or {'period':period})

    def voucher(self,date='2026-09-10',attachments=0,cid=1,lines=None):
        return self.call('vouchers',{'date':date,'summary':'合成统计凭证','attachment_count':attachments,
                                    'lines':lines or [finance._entry('1002',10000,category='operating'),
                                                     finance._entry('5001',credit=10000)]},cid=cid)

    def dashboard(self,period='2026-10',cid=1):
        return self.call(method='GET',period=period,cid=cid)['dashboard']

    def test_current_empty_month_keeps_zero_and_exposes_registered_history(self):
        self.voucher(attachments=0)
        self.voucher(attachments=3)
        current=self.dashboard()
        self.assertEqual((0,0),(current['voucher_count'],current['attachment_count']))
        self.assertEqual({'voucher_count':2,'attachment_count':3,'periods':[
            {'period':'2026-09','voucher_count':2,'attachment_count':3}]},current['voucher_history'])
        historical=self.dashboard('2026-09')
        self.assertEqual((2,3),(historical['voucher_count'],historical['attachment_count']))
        self.assertEqual(current['voucher_history'],historical['voucher_history'])

    def test_history_spans_years_in_descending_order_and_isolates_clients(self):
        self.voucher(date='2025-12-31',attachments=2)
        self.voucher(date='2026-01-01',attachments=1)
        self.voucher(date='2027-02-01',attachments=4)
        self.voucher(date='2026-01-02',attachments=99,cid=2)
        history=self.dashboard()['voucher_history']
        self.assertEqual((3,7),(history['voucher_count'],history['attachment_count']))
        self.assertEqual([
            {'period':'2027-02','voucher_count':1,'attachment_count':4},
            {'period':'2026-01','voucher_count':1,'attachment_count':1},
            {'period':'2025-12','voucher_count':1,'attachment_count':2}],history['periods'])
        other=self.dashboard('2026-01',cid=2)
        self.assertEqual((1,99),(other['voucher_count'],other['attachment_count']))
        self.assertEqual({'voucher_count':1,'attachment_count':99,'periods':[
            {'period':'2026-01','voucher_count':1,'attachment_count':99}]},other['voucher_history'])

    def test_void_vouchers_are_excluded_from_current_and_history(self):
        self.voucher(date='2026-10-01',attachments=2)
        current=self.voucher(date='2026-10-02',attachments=9)
        historical=self.voucher(date='2025-02-01',attachments=7)
        for voucher in (current,historical):
            self.call(f'vouchers/{voucher["id"]}',{'version':voucher['version']},method='DELETE')
        dashboard=self.dashboard()
        self.assertEqual((1,2),(dashboard['voucher_count'],dashboard['attachment_count']))
        self.assertEqual({'voucher_count':1,'attachment_count':2,'periods':[
            {'period':'2026-10','voucher_count':1,'attachment_count':2}]},dashboard['voucher_history'])
        self.assertEqual(3,self.conn.execute('SELECT COUNT(*) FROM vouchers WHERE client_id=1').fetchone()[0])

    def test_repeated_account_lines_do_not_multiply_vouchers_or_attachments(self):
        lines=[finance._entry('5602',1000),finance._entry('5602',1000),
               finance._entry('2202',credit=1000),finance._entry('2202',credit=1000)]
        self.voucher(date='2026-10-01',attachments=3,lines=lines)
        dashboard=self.dashboard()
        self.assertEqual((1,3),(dashboard['voucher_count'],dashboard['attachment_count']))
        self.assertEqual({'voucher_count':1,'attachment_count':3,'periods':[
            {'period':'2026-10','voucher_count':1,'attachment_count':3}]},dashboard['voucher_history'])

    def test_opening_and_standard_projection_do_not_create_actual_voucher_counts(self):
        self.call('opening',{'version':1,'balances':[finance._entry('1002',10000),finance._entry('3001',credit=10000)]})
        opening=self.dashboard()
        self.assertEqual(10000,opening['funds']['bank_fen'])
        self.assertEqual({'voucher_count':0,'attachment_count':0,'periods':[]},opening['voucher_history'])
        self.voucher(attachments=0)
        before={table:[tuple(row) for row in self.conn.execute('SELECT * FROM '+table+' ORDER BY id')]
                for table in ('vouchers','voucher_lines')}
        standard=self.call('balance',method='GET',query={'start':'2026-09','end':'2027-01','basis':'standard'})
        self.assertEqual('standard',standard['basis'])
        dashboard=self.dashboard()
        self.assertEqual((0,0),(dashboard['voucher_count'],dashboard['attachment_count']))
        self.assertEqual({'voucher_count':1,'attachment_count':0,'periods':[
            {'period':'2026-09','voucher_count':1,'attachment_count':0}]},dashboard['voucher_history'])
        after={table:[tuple(row) for row in self.conn.execute('SELECT * FROM '+table+' ORDER BY id')]
               for table in ('vouchers','voucher_lines')}
        self.assertEqual(before,after)

    def test_withdrawn_source_drops_from_history_without_rewriting_attachment_count(self):
        with finance._write(self.conn):
            vid=finance._insert_voucher(self.conn,1,'2026-09-10','合成回单凭证',
                                       [finance._entry('1002',10000,category='operating'),finance._entry('5001',credit=10000)],
                                       self.user,'bank_receipt','synthetic-receipt',attachment_count=2)
        self.assertEqual(1,self.dashboard()['voucher_history']['voucher_count'])
        self.call(f'vouchers/{vid}/withdraw',{'version':1,'reason':'撤回合成测试回单'})
        dashboard=self.dashboard('2026-09')
        self.assertEqual((0,0),(dashboard['voucher_count'],dashboard['attachment_count']))
        self.assertEqual({'voucher_count':0,'attachment_count':0,'periods':[]},dashboard['voucher_history'])
        stored=self.conn.execute('SELECT status,attachment_count FROM vouchers WHERE id=?',(vid,)).fetchone()
        self.assertEqual(('void',2),tuple(stored))


if __name__=='__main__':
    unittest.main()
