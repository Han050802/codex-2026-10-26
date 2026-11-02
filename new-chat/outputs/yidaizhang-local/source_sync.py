"""Synchronize reviewed application source without staging local accounting data."""
from __future__ import annotations
import argparse
import datetime as dt
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys


class SyncError(RuntimeError):
    pass


class SourceSync:
    def __init__(self, app_dir=None):
        self.app = Path(app_dir or Path(__file__).resolve().parent).resolve()
        try:
            result = subprocess.run(['git', '-C', str(self.app), 'rev-parse', '--show-toplevel'],
                                    capture_output=True, text=True, encoding='utf-8')
        except FileNotFoundError:
            raise SyncError('未找到 Git，请先安装 Git for Windows。') from None
        if result.returncode:
            raise SyncError('当前程序目录不在 Git 仓库内，请先使用源码仓库安装程序。')
        self.repo = Path(result.stdout.strip()).resolve()
        self.prefix = self.app.relative_to(self.repo).as_posix()
        if self.prefix == '.':
            self.prefix = ''
        self.scope = self.prefix + '/' if self.prefix else '.'

    def git(self, *args):
        result = subprocess.run(['git', '-c', 'core.quotepath=false', *args], cwd=self.repo,
                                capture_output=True, text=True, encoding='utf-8', errors='replace')
        if result.returncode:
            detail = re.sub(r'https?://[^\s/@]+(?::[^\s/@]*)?@', 'https://[已隐藏]@', result.stderr.strip())
            raise SyncError('Git 操作未完成：' + (detail or '请检查仓库状态和网络连接。'))
        return result.stdout.strip() if '-z' not in args else result.stdout

    def kind(self, path):
        if self.prefix:
            if not path.startswith(self.prefix + '/'):
                return 'outside'
            path = path[len(self.prefix) + 1:]
        p = PurePosixPath(path)
        parts = p.parts
        if not parts or any(ord(c) < 32 for c in path):
            return 'unsupported'
        if any(x.lower() in {'data', 'demo-data', 'update-backups', 'node_modules',
                             '__pycache__', '.venv', 'venv'} for x in parts):
            return 'excluded'
        name = p.name.lower()
        if (name.startswith('.env') or re.search(r'(^|[._-])(secrets?|credentials?|tokens?|passwords?|private)([._-]|$)', name)
                or any(x in name for x in ('密码', '凭据', '私钥'))
                or p.suffix.lower() in {'.sqlite3', '.db', '.pem', '.key', '.p12', '.pfx'}):
            return 'excluded'
        if len(parts) == 1 and (name in {'.gitignore', 'package.json'}
                               or p.suffix.lower() in {'.py', '.cmd', '.md', '.ps1'}):
            return 'source'
        allowed = {'public': {'.js', '.css', '.html'}, 'tests': {'.py', '.mjs'}}
        if len(parts) > 1 and p.suffix.lower() in allowed.get(parts[0], set()):
            return 'source'
        return 'unsupported'

    def changes(self):
        fields = self.git('status', '--porcelain=v1', '-z', '--untracked-files=all', '--', self.scope).split('\0')
        paths = []
        i = 0
        while i < len(fields):
            item = fields[i]
            i += 1
            if not item:
                continue
            paths.append(item[3:])
            if 'R' in item[:2] or 'C' in item[:2]:
                paths.append(fields[i])
                i += 1
        return sorted(set(paths))

    def require_main(self):
        if self.git('branch', '--show-current') != 'main':
            raise SyncError('请在 main 分支同步；当前分支或分离状态不符合要求。')
        self.git('remote', 'get-url', 'origin')
        if self.git('ls-files', '-u'):
            raise SyncError('仓库存在未解决的合并冲突，请先处理后再同步。')

    def staged(self):
        return [p for p in self.git('diff', '--cached', '--name-only', '--no-renames', '-z').split('\0') if p]

    def require_source(self, paths, message):
        blocked = [p for p in paths if self.kind(p) != 'source']
        if blocked:
            raise SyncError(message + '\n' + '\n'.join('  ' + p for p in blocked))

    def remote_state(self):
        self.git('fetch', 'origin')
        values = self.git('rev-list', '--left-right', '--count', 'HEAD...origin/main').split()
        return int(values[0]), int(values[1])

    def status(self):
        print('程序目录：' + str(self.app))
        print('当前分支：' + (self.git('branch', '--show-current') or '分离状态'))
        groups = {'source': [], 'excluded': [], 'unsupported': []}
        for path in self.changes():
            groups[self.kind(path)].append(path)
        for key, title in [('source', '待同步源码'), ('excluded', '自动排除的数据或凭据'),
                           ('unsupported', '尚不支持的文件（提交前需处理）')]:
            print(title + '：' + str(len(groups[key])))
            for path in groups[key]:
                print('  ' + path)
        unrelated = [p for p in self.staged() if self.kind(p) != 'source']
        if unrelated:
            print('仓库另有不允许提交的已暂存文件；提交工具会拒绝继续。')
        print('状态检查未访问远端。账务数据由办公室服务器统一保存。')

    def pull(self):
        self.require_main()
        dirty = [p for p in self.changes() if self.kind(p) != 'excluded']
        if dirty:
            raise SyncError('本程序有未提交或未跟踪源码，已保留原文件。请先提交或自行处理：\n' + '\n'.join(dirty))
        ahead, behind = self.remote_state()
        if ahead and behind:
            raise SyncError('本机与远端已有分叉，已拒绝合并；请维护人员处理。')
        incoming = self.git('diff', '--name-only', '--no-renames', '-z', 'HEAD..origin/main', '--', self.scope)
        self.require_source([p for p in incoming.split('\0') if p], '远端包含非白名单程序文件，已拒绝拉取：')
        self.git('merge', '--ff-only', 'origin/main')
        print('程序源码已更新。账务数据未参与同步。')
        print('服务器正在运行时，请先正常停止再启动程序，修改才会生效；本工具不会自动重启。')

    def push(self, message=None):
        self.require_main()
        self.require_source(self.staged(), '存在无关或不允许的已暂存文件，请自行取消暂存后重试（原文件已保留）：')
        paths = self.changes()
        unsupported = [p for p in paths if self.kind(p) == 'unsupported']
        if unsupported:
            raise SyncError('发现白名单外文件，不能确认是否遗漏源码，已拒绝提交：\n' + '\n'.join(unsupported))
        ahead, behind = self.remote_state()
        if behind:
            raise SyncError('本机源码落后于远端或已有分叉，已拒绝提交和推送；请先处理远端更新。')
        if self.git('rev-list', '--merges', 'origin/main..HEAD'):
            raise SyncError('尚未推送的历史包含合并提交，无法确认全部文件，已拒绝上传；请维护人员检查。')
        pending = self.git('log', '--format=', '--name-only', '--no-renames', '-z', 'origin/main..HEAD')
        self.require_source([p.strip('\n') for p in pending.split('\0') if p.strip('\n')],
                            '尚未推送的提交包含非本程序源码，已拒绝上传：')
        source = [p for p in paths if self.kind(p) == 'source']
        excluded = [p for p in paths if self.kind(p) == 'excluded']
        if excluded:
            print('已排除数据或凭据文件：' + str(len(excluded)) + ' 个。')
        if source or self.staged():
            try:
                identity = [self.git('config', 'user.name'), self.git('config', 'user.email')]
            except SyncError:
                identity = []
            if len(identity) != 2 or not all(identity):
                raise SyncError('首次提交前，请在当前程序目录配置本仓库的提交者姓名和邮箱，再重试：\n'
                                'git config user.name "你的姓名"\n'
                                'git config user.email "你的邮箱"')
        if source:
            stage = [p for p in source if (self.repo / p).exists() or (self.repo / p).is_symlink()
                     or self.git('ls-files', '--', p)]
            if stage:
                self.git('add', '--', *stage)
        self.require_source(self.staged(), '暂存区出现非白名单文件，已停止提交：')
        if self.staged():
            text = message or '更新代账台程序 ' + dt.datetime.now().strftime('%Y-%m-%d %H:%M')
            self.git('commit', '-m', text)
            print('源码已提交到本机。')
        elif not ahead:
            print('没有待上传的程序修改。')
            return
        try:
            self.git('push', 'origin', 'main')
        except SyncError as error:
            raise SyncError(str(error) + '\n本机提交已保留，可检查网络或远端状态后重试。') from None
        print('程序源码已上传。其他电脑可运行“拉取程序更新.cmd”。')
        print('要让修改在办公室服务器生效，请在服务器拉取后正常停止并重新启动程序。')


def main(argv=None):
    parser = argparse.ArgumentParser(description='只同步代账台源码，不同步账务数据，不覆盖本地修改。')
    parser.add_argument('action', choices=['status', 'pull', 'push'])
    parser.add_argument('--message', help='提交说明；默认使用中文说明及本机时间')
    parser.add_argument('--no-pause', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        sync = SourceSync()
        if args.action == 'push':
            sync.push(args.message)
        else:
            getattr(sync, args.action)()
        return 0
    except (SyncError, OSError) as error:
        print('同步未完成：' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    raise SystemExit(main())
