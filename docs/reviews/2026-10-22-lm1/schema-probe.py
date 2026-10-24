import json, os, pathlib, subprocess, tempfile, selectors, time
with tempfile.TemporaryDirectory(prefix='modex-lm1-native-') as root:
 home=pathlib.Path(root); (home/'codex').mkdir(); (home/'fixture').mkdir()
 env={'PATH':os.environ['PATH'], 'HOME':root, 'CODEX_HOME':str(home/'codex')}
 settings=['model_provider="lm1_probe"','model_providers.lm1_probe.name="LM1 isolated unavailable endpoint"','model_providers.lm1_probe.base_url="http://127.0.0.1:1/v1"','model_providers.lm1_probe.wire_api="responses"','model_providers.lm1_probe.requires_openai_auth=false','model_providers.lm1_probe.supports_websockets=false','web_search="disabled"']
 args=['/opt/homebrew/bin/codex','app-server']+sum((['-c',s] for s in settings),[])
 p=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=env,cwd=home/'fixture',text=True)
 selector=selectors.DefaultSelector();selector.register(p.stdout,selectors.EVENT_READ)
 def request(i,method,params):
  p.stdin.write(json.dumps({'id':i,'method':method,'params':params})+'\n');p.stdin.flush()
  end=time.monotonic()+15
  while time.monotonic()<end:
   if not selector.select(max(0,end-time.monotonic())):break
   line=p.stdout.readline()
   if not line:raise RuntimeError('app-server exited')
   msg=json.loads(line)
   if msg.get('id')==i:
    if 'error' in msg:raise RuntimeError(str(msg['error']))
    return msg['result']
  raise RuntimeError(method+' timeout')
 try:
  init=request(1,'initialize',{'clientInfo':{'name':'modex_lm1_probe','version':'0.0.1'},'capabilities':{'experimentalApi':True}})
  p.stdin.write('{"method":"initialized","params":{}}\n');p.stdin.flush()
  models=request(2,'model/list',{})
  arbitrary='lm1-unlisted/Exact-ID:Q4'
  started=request(3,'thread/start',{'cwd':str(home/'fixture'),'model':arbitrary,'modelProvider':'lm1_probe','allowProviderModelFallback':False,'approvalPolicy':'untrusted','sandbox':'read-only','ephemeral':True})
  print(json.dumps({'initialize':init,'catalogueCount':len(models.get('data',[])),'requestedInCatalogue':any(x.get('id')==arbitrary for x in models.get('data',[])),'requestedModel':arbitrary,'returnedModel':started.get('model'),'returnedProvider':started.get('modelProvider'),'inferenceAttempted':False,'configuration':settings},indent=2))
 finally:
  p.terminate()
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:p.kill();p.wait()
