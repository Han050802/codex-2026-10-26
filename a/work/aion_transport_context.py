import pathlib,json,sys,re
sys.stdout.reconfigure(encoding='utf-8',errors='replace')
for day,start,end in [('23',450,485),('23',710,732),('26',485,645)]:
 p=pathlib.Path(r'C:\Users\Admin\AppData\Roaming\AionUi\logs\2026\10')/day/('2026-10-'+day+'.aioncore.log')
 print(p.name)
 for i,l in enumerate(p.read_text(encoding='utf-8',errors='replace').splitlines(),1):
  if not start<=i<=end:continue
  try:x=json.loads(l)
  except:continue
  f=x.get('fields',{})
  if f.get('message') in ['http response','fs subscribe','fs unsubscribe','watch target added','watch target removed']: continue
  deny={'prompt','content','messages','text','api_key','authorization','token','args','command_line','user_id','workspace','cwd','target_path','path'}
  d={k:v for k,v in f.items() if k not in deny}
  print(i,x.get('timestamp'),json.dumps(d,ensure_ascii=False))
