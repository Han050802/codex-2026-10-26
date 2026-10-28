from pathlib import Path
import json, shutil, hashlib

root=Path(r'D:\Codex\2026-10-26\a')
source=(root/'work/repair-report-draft.txt').read_text(encoding='utf-8')
extra='''部署状态：已完成，AionUi 已重启。
正式程序：D:\\AIONUI\\compat\\codex-bridge\\aionui-codex-bridge.exe
版本透传：codex-cli 0.163.0（没有启用降级版本）
程序 SHA256：95EE62C0B93753DFD49A9B4D78949F08C9DA8C291EABAA3B1207E8F7150972BC
源文件：同目录 CodexThreadBridge.cs
配置指向文件：同目录 codex-real-path.txt
原配置备份：D:\\AIONUI\\repair-backups\\20261026T103307Z\\aionui-backend.db
精确回滚清单：D:\\AIONUI\\repair-backups\\20261026T103307Z\\codex-override.json

部署后检查
- 正式后台 /health 返回 status=ok、version=0.2.2。
- SQLite integrity_check=ok。
- 原有12个会话、314条消息均保留，没有丢失记录。
- 正式安装路径的程序再次通过子任务/主最终回复/后续消息测试。
- stdin EOF、Job Object退出、异常stdout断管清理均通过独立测试。

撤销此修补
先关闭 AionUi，再在 PowerShell 执行以下一行。
此操作只恢复 Codex 的 command_override 字段，不会用旧数据库覆盖新聊天记录。
python "D:\\AIONUI\\compat\\codex-bridge\\patch_aionui_codex.py" rollback --manifest "D:\\AIONUI\\repair-backups\\20261026T103307Z\\codex-override.json"
然后重新打开 AionUi。

维护说明
这是针对当前已复现缺陷的本地兼容修补，不是官方已发布更新。
若以后升级 AionUi 或 Codex 后行为变化，可先按上述步骤撤销并重新核验兼容性。
排查期间下载但未启用的备用 Codex 0.151.0 保留在 D:\\AIONUI\\compat\\codex-0.151.0；清理请求被自动审批策略拦截（blocked by policy），未改用其他方式删除，不影响本次修补。
'''
(root/'outputs/AionUi-修复记录.txt').write_text(source.replace('部署与备份状态：待部署完成后更新。',extra),encoding='utf-8')
summary=json.loads((root/'work/aioncore-validation/validation-summary.json').read_text(encoding='utf-8'))
final=json.loads((root/'work/aioncore-validation/codex-subagent-deployed-final-result.json').read_text(encoding='utf-8'))
summary['deployed_final']={k:final.get(k) for k in ['label','conversation_id','premature_finished','parent_marker_missing','child_marker_leaked','followup_ok','finished_at']}
summary['installed_sha256']=hashlib.sha256(Path(r'D:\AIONUI\compat\codex-bridge\aionui-codex-bridge.exe').read_bytes()).hexdigest()
summary['production_health']='ok'
summary['database_integrity']='ok'
summary['records_preserved']={'conversations':12,'messages':314,'missing':0}
summary['lifecycle']=json.loads((root/'work/codex-bridge-review/lifecycle-results.json').read_text(encoding='utf-8'))
(root/'outputs/AionUi-验证结果.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
shutil.copy2(root/'outputs/AionUi-修复记录.txt',Path(r'D:\AIONUI\compat\codex-bridge\repair-notes.txt'))
print(json.dumps({'report':str(root/'outputs/AionUi-修复记录.txt'),'verification':str(root/'outputs/AionUi-验证结果.json')},ensure_ascii=False))
