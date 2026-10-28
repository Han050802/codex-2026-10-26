import json, sqlite3, re
from pathlib import Path

ROOT = Path(r'C:\Users\Admin\AppData\Roaming\AionUi')
db = sqlite3.connect(f'file:{(ROOT / "aionui/aionui-backend.db").as_posix()}?mode=ro', uri=True)
db.row_factory = sqlite3.Row

def clean(v):
    if isinstance(v, str):
        try: return clean(json.loads(v))
        except (ValueError, TypeError):
            return re.sub(r'(sk-[\w-]+|Bearer\s+[^\s\"]+)', '<redacted>', v)
    if isinstance(v, dict):
        return {k: ('<redacted>' if re.search(r'key|secret|token|password|credential', k, re.I) else clean(x)) for k, x in v.items()}
    if isinstance(v, list): return [clean(x) for x in v]
    return v

queries = {
 'providers': 'select id,platform,name,base_url,models,enabled,capabilities,context_limit,model_protocols,model_enabled,model_health,is_full_url,model_settings,updated_at from providers',
 'preferences': "select key,value from client_preferences where key like '%model%' or key like '%proxy%' or key like '%provider%' or key like '%agent%'",
 'agents': 'select agent_id,name,agent_type,agent_source,backend,enabled,command,command_override,last_check_status,last_check_error_code,last_check_error_message from agent_metadata',
 'conversations': 'select id,type,model,updated_at from conversations order by updated_at desc limit 15',
 'assistant_preferences': 'select assistant_definition_id,last_model_id,last_thought_level_value from assistant_preferences',
}
for name, query in queries.items():
    print(name, json.dumps([clean(dict(r)) for r in db.execute(query)], ensure_ascii=False))
print('config', clean((ROOT/'config/aionui-config.txt').read_text(encoding='utf-8')))
