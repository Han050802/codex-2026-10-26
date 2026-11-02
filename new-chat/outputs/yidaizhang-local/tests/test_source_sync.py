"""Source sharing acceptance checks using disposable repositories and a bare remote."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from source_sync import SourceSync, SyncError


class SourceSyncTests(unittest.TestCase):
    def git(self, folder, *args):
        result = subprocess.run(['git', *args], cwd=folder, capture_output=True,
                                text=True, encoding='utf-8', errors='replace')
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ydz-source-sync-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.remote = self.root / 'remote.git'
        self.local = self.root / 'local'
        self.other = self.root / 'other'
        self.git(self.root, 'init', '--bare', '--initial-branch=main', str(self.remote))
        self.git(self.root, 'clone', str(self.remote), str(self.local))
        self.configure(self.local)
        self.app = self.local / 'apps' / 'accounting'
        self.app.mkdir(parents=True)
        (self.app / 'server.py').write_text('VERSION = 1\n', encoding='utf-8')
        self.git(self.local, 'add', 'apps/accounting/server.py')
        self.git(self.local, 'commit', '-m', 'initial source')
        self.git(self.local, 'push', 'origin', 'main')
        self.git(self.root, 'clone', str(self.remote), str(self.other))
        self.configure(self.other)
        self.sync = SourceSync(self.app)

    def configure(self, folder):
        self.git(folder, 'config', 'user.name', 'Source Sync Test')
        self.git(folder, 'config', 'user.email', 'source-sync@example.invalid')

    def remote_edit(self):
        target = self.other / 'apps' / 'accounting' / 'server.py'
        target.write_text('VERSION = 2\n', encoding='utf-8')
        self.git(self.other, 'add', 'apps/accounting/server.py')
        self.git(self.other, 'commit', '-m', 'remote source update')
        self.git(self.other, 'push', 'origin', 'main')

    def test_push_source_excludes_data_credentials_and_outside_files(self):
        (self.app / 'existing.py').write_text('EXISTING = True\n', encoding='utf-8')
        self.git(self.local, 'add', 'apps/accounting/existing.py')
        self.git(self.local, 'commit', '-m', 'previous local source commit')
        self.git(self.local, 'mv', 'apps/accounting/server.py', 'apps/accounting/service.py')
        (self.app / 'feature.py').write_text('READY = True\n', encoding='utf-8')
        (self.app / 'data').mkdir()
        (self.app / 'data' / 'app.sqlite3').write_bytes(b'synthetic ledger')
        (self.app / 'secrets.py').write_text('synthetic private configuration\n', encoding='utf-8')
        (self.local / 'outside.txt').write_text('unrelated draft', encoding='utf-8')
        unsupported = self.app / 'feature.ts'
        unsupported.write_text('unhandled source', encoding='utf-8')
        with self.assertRaises(SyncError):
            self.sync.push('must not omit unsupported source')
        self.assertTrue(unsupported.exists())
        unsupported.unlink()
        self.git(self.local, 'config', 'user.name', '')
        with self.assertRaisesRegex(SyncError, 'git config user.name'):
            self.sync.push('identity required')
        self.configure(self.local)
        self.sync.push('add feature')
        tree = self.git(self.root, '--git-dir=' + str(self.remote), 'ls-tree', '-r', '--name-only', 'main')
        self.assertEqual(set(tree.splitlines()), {'apps/accounting/service.py', 'apps/accounting/existing.py',
                                                 'apps/accounting/feature.py'})
        self.assertTrue((self.app / 'data' / 'app.sqlite3').exists())
        self.assertTrue((self.app / 'secrets.py').exists())
        self.assertTrue((self.local / 'outside.txt').exists())

    def test_dirty_pull_preserves_tracked_and_untracked_source(self):
        self.remote_edit()
        target = self.app / 'server.py'
        target.write_text('LOCAL_UNSAVED = True\n', encoding='utf-8')
        extra = self.app / 'draft.py'
        extra.write_text('DRAFT = True\n', encoding='utf-8')
        before = self.git(self.local, 'rev-parse', 'HEAD')
        with self.assertRaises(SyncError):
            self.sync.pull()
        self.assertEqual(target.read_text(encoding='utf-8'), 'LOCAL_UNSAVED = True\n')
        self.assertEqual(extra.read_text(encoding='utf-8'), 'DRAFT = True\n')
        self.assertEqual(self.git(self.local, 'rev-parse', 'HEAD'), before)

    def test_remote_source_fast_forwards_without_touching_data(self):
        data = self.app / 'data'
        data.mkdir()
        (data / 'app.sqlite3').write_bytes(b'local-only synthetic bytes')
        self.remote_edit()
        self.sync.pull()
        self.assertEqual((self.app / 'server.py').read_text(encoding='utf-8'), 'VERSION = 2\n')
        self.assertEqual((data / 'app.sqlite3').read_bytes(), b'local-only synthetic bytes')
        self.assertEqual(self.git(self.local, 'rev-parse', 'HEAD'), self.git(self.other, 'rev-parse', 'HEAD'))

    def test_diverged_history_is_rejected_without_new_commit_or_overwrite(self):
        (self.app / 'feature.py').write_text('LOCAL = True\n', encoding='utf-8')
        self.git(self.local, 'add', 'apps/accounting/feature.py')
        self.git(self.local, 'commit', '-m', 'local branch work')
        before = self.git(self.local, 'rev-parse', 'HEAD')
        self.remote_edit()
        for operation in (self.sync.push, self.sync.pull):
            with self.assertRaises(SyncError):
                operation()
        self.assertEqual(self.git(self.local, 'rev-parse', 'HEAD'), before)
        self.assertEqual((self.app / 'feature.py').read_text(encoding='utf-8'), 'LOCAL = True\n')

    def test_unrelated_staged_change_and_unreviewed_merge_are_rejected(self):
        unrelated = self.local / 'outside.txt'
        unrelated.write_text('unrelated staged work', encoding='utf-8')
        self.git(self.local, 'add', 'outside.txt')
        (self.app / 'feature.py').write_text('READY = True\n', encoding='utf-8')
        before = self.git(self.local, 'rev-parse', 'HEAD')
        with self.assertRaises(SyncError):
            self.sync.push()
        self.assertEqual(self.git(self.local, 'diff', '--cached', '--name-only'), 'outside.txt')
        self.assertEqual(self.git(self.local, 'rev-parse', 'HEAD'), before)
        self.assertEqual(self.git(self.root, '--git-dir=' + str(self.remote), 'rev-parse', 'main'), before)
        self.git(self.local, 'restore', '--staged', 'outside.txt')
        self.git(self.local, 'checkout', '-b', 'feature')
        self.git(self.local, 'add', 'apps/accounting/feature.py')
        self.git(self.local, 'commit', '-m', 'feature source')
        self.git(self.local, 'checkout', 'main')
        self.git(self.local, 'merge', '--no-ff', '--no-commit', 'feature')
        forbidden = self.app / 'accounting.db'
        forbidden.write_bytes(b'synthetic merge-only accounting bytes')
        self.git(self.local, 'add', 'apps/accounting/accounting.db')
        self.git(self.local, 'commit', '-m', 'merge includes forbidden result')
        merge_head = self.git(self.local, 'rev-parse', 'HEAD')
        with self.assertRaisesRegex(SyncError, '合并提交'):
            self.sync.push()
        self.assertEqual(self.git(self.local, 'rev-parse', 'HEAD'), merge_head)
        self.assertEqual(self.git(self.root, '--git-dir=' + str(self.remote), 'rev-parse', 'main'), before)


if __name__ == '__main__':
    unittest.main(verbosity=2)
