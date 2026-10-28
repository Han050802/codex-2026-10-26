import json,pathlib,struct,re,sys
root=pathlib.Path(__file__).parent
source=pathlib.Path(r'D:\AIONUI\resources\app.asar')
with source.open('rb') as f:
    h=struct.unpack('<4I',f.read(16)); tree=json.loads(f.read(h[3])); base=8+h[1]
    def walk(nodes,prefix=''):
        for name,ent in nodes.items():
            p=prefix+name
            if 'files' in ent: yield from walk(ent['files'],p+'/')
            else: yield p,ent
    entries=dict(walk(tree['files']))
    if len(sys.argv)>1 and sys.argv[1]=='extract':
        for name,e in entries.items():
            if not (name.startswith('out/') or name=='package.json'):continue
            if 'offset' not in e:continue
            path=root/'extracted'/name;path.parent.mkdir(parents=True,exist_ok=True)
            f.seek(base+int(e['offset']));path.write_bytes(f.read(e['size']))
        print('Extracted out and package.json')
    else:
        for name,e in entries.items():
            if name.startswith('out/') or name=='package.json': print(name,e.get('size'),e.get('unpacked'))
