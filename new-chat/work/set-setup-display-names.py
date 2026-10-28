from pathlib import Path
path=Path(__file__).resolve().parent.parent/'outputs'/'yidaizhang-local'/'public'/'app.js'
source=path.read_text(encoding='utf-8')
old="${field('姓名 / 显示名', `name${n}`, '', 'text', 'required maxlength=\"40\"')}"
new="${field('姓名 / 显示名', `name${n}`, ['吕', '会计1', '会计2'][n - 1], 'text', 'required maxlength=\"40\"')}"
assert old in source
path.write_text(source.replace(old,new,1),encoding='utf-8')
print('Initial setup display names now default to the user-approved three names.')
