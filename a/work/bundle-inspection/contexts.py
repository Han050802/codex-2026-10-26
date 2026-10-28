import pathlib,re,sys
sys.stdout.reconfigure(encoding='utf-8')
root=pathlib.Path(__file__).parent/'extracted'/'out'
pattern=re.compile(sys.argv[1], re.I)
context=int(sys.argv[2]) if len(sys.argv)>2 else 250
limit=int(sys.argv[3]) if len(sys.argv)>3 else 100
count=0
for p in root.rglob('*.js'):
    if '/vendor-' in p.as_posix():continue
    s=p.read_text(encoding='utf8')
    for m in pattern.finditer(s):
        count+=1
        print(str(p.relative_to(root))+':'+str(s.count('\n',0,m.start())+1)+' @'+str(m.start()))
        print(s[max(0,m.start()-context):min(len(s),m.end()+context)])
        if count>=limit:sys.exit()
