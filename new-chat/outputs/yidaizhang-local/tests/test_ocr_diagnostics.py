import io, json, queue, sys, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
import reconciliation

class OCRDiagnosticTests(unittest.TestCase):
    def run_worker_response(self, response):
        worker=reconciliation.OCRWorker()
        worker.py=Path(sys.executable)
        proc=SimpleNamespace(stdin=io.StringIO(),stdout=io.StringIO(),kill=Mock(),wait=Mock())
        worker.proc=proc; worker.lines=queue.Queue(); worker.lines.put(json.dumps(response))
        result,error=worker.run(Path('sample.png'),'invoice')
        return worker,proc,result,error
    def test_memory_error_becomes_actionable_and_process_is_restarted(self):
        worker,proc,result,error=self.run_worker_response({'ok':False,'error_code':'memory_allocation','error':'PRIVATE SECRET'})
        self.assertIsNone(result); self.assertIn('内存分配失败',error); self.assertIn('分批',error)
        self.assertNotIn('PRIVATE',error); self.assertIsNone(worker.proc); proc.kill.assert_called_once()
    def test_untrusted_worker_error_is_not_exposed(self):
        worker,proc,result,error=self.run_worker_response({'ok':False,'error_code':'unknown','error':'PRIVATE SECRET'})
        self.assertIsNone(result); self.assertIn('OCR 识别失败',error)
        self.assertNotIn('PRIVATE',error)
        worker.close()

if __name__=='__main__': unittest.main()
