const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),crypto=require('crypto');
const {execFileSync}=require('child_process');
const root=path.resolve(process.argv[2]||'.');
const backend=require(path.join(root,'src/main/codex-sessions.js'));
const sync=require(path.join(root,'src/renderer/codex-sync.js'));
const home=fs.mkdtempSync(path.join(os.tmpdir(),'wezy-pin-order-'));
const db=path.join(home,'state_5.sqlite'),prefs=path.join(home,'.codex-global-state.json');
const checks=[];const test=async(name,fn)=>{try{await fn();checks.push({name,pass:true})}catch(e){checks.push({name,pass:false,error:String(e)})}};
const write=atoms=>fs.writeFileSync(prefs,JSON.stringify({'electron-persisted-atom-state':atoms}));
const unified=ids=>({'unified-sidebar-pinned-order-v1':ids});
const local=id=>'codex:thread:local:'+id;
const visible=rows=>sync.visible(sync.reconcile([],rows,()=>Math.random().toString(36)));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
(async()=>{
 execFileSync('/usr/bin/sqlite3',[db,"create table threads(id text,cwd text,name text,title text,is_pinned integer,archived integer,source text,updated_at integer); insert into threads values ('a','/tmp','','A',1,0,'cli',10),('b','/tmp','','B',1,0,'cli',20),('c','/tmp','','C',0,0,'cli',30),('arch','/tmp','','Archived',1,1,'cli',40),('sub','/tmp','','Agent',1,0,'subagent',50);"]);
 await test('original failure: explicit pinned order wins over recency',async()=>{
  write(unified([local('a'),local('b')]));
  assert.deepEqual(visible(await backend.listSessions(home)).map(p=>p.sessionId),['a','b','c']);
 });
 await test('order changes are re-read on next refresh; names and unpin track SQLite',async()=>{
  const previous=sync.reconcile([{id:'keep',kind:'codex',sessionId:'a',name:'📌 Old'}],await backend.listSessions(home),()=>Math.random().toString(36));
  write(unified([local('b'),local('a')]));
  let next=sync.reconcile(previous,await backend.listSessions(home),()=>{throw Error('unexpected new record')});
  assert.deepEqual(sync.visible(next).map(p=>p.sessionId),['b','a','c']);
  execFileSync('/usr/bin/sqlite3',[db,"update threads set is_pinned=0,name='Renamed' where id='a'"]);
  next=sync.reconcile(next,await backend.listSessions(home),()=>{throw Error('unexpected new record')});
  const a=next.find(p=>p.sessionId==='a');assert.equal(a.id,'keep');assert.equal(a.name,'Renamed');assert.equal(a.pinned,false);
  assert.deepEqual(sync.visible(next).map(p=>p.sessionId),['b','c','a']);
  execFileSync('/usr/bin/sqlite3',[db,"update threads set is_pinned=1,name='' where id='a'"]);
 });
 await test('remote and non-Codex entries cannot change local rank; duplicates use first position',async()=>{
  write(unified(['chatgpt:conversation:a','codex:thread:remote:a',local('b'),local('a'),local('b')]));
  assert.deepEqual(visible(await backend.listSessions(home)).map(p=>p.sessionId),['b','a','c']);
 });
 await test('stale order entry cannot repin or unarchive a thread; subagents stay hidden',async()=>{
  write(unified([local('c'),local('arch'),local('sub'),local('a'),local('b')]));
  assert.deepEqual(visible(await backend.listSessions(home)).map(p=>p.sessionId),['a','b','c']);
 });
 await test('unified empty list overrides legacy; absent unified uses legacy compatibility',async()=>{
  write({'unified-sidebar-pinned-order-v1':[],'app-server-pinned-thread-order-v1':['a','b']});
  assert.deepEqual(visible(await backend.listSessions(home)).map(p=>p.sessionId),['b','a','c']);
  write({'app-server-pinned-thread-order-v1':['a','b']});
  assert.deepEqual(visible(await backend.listSessions(home)).map(p=>p.sessionId),['a','b','c']);
 });
 await test('CLI-only home without desktop state keeps pin-plus-recency order',async()=>{
  fs.unlinkSync(prefs);assert.deepEqual(visible(await backend.listSessions(home)).map(p=>p.sessionId),['b','a','c']);
 });
 await test('malformed/truncated preferences reject rather than silently reorder',async()=>{
  fs.writeFileSync(prefs,'{');await assert.rejects(backend.listSessions(home));
  write(unified('wrong'));await assert.rejects(backend.listSessions(home));
  write(unified([3]));await assert.rejects(backend.listSessions(home));
 });
 await test('read-only DB and preference bytes preserved',async()=>{
  write(unified([local('a'),local('b')]));const before=[sha(fs.readFileSync(db)),sha(fs.readFileSync(prefs))];
  await backend.listSessions(home);assert.deepEqual([sha(fs.readFileSync(db)),sha(fs.readFileSync(prefs))],before);
 });
 const result={at:new Date().toISOString(),scope:'isolated SQLite and desktop preference fixtures; production reader/reconciler/sort; no live session or config mutations',checks};
 const out=path.resolve(process.argv[3]||path.join(__dirname,'pin-order-tests.json'));fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));process.exitCode=checks.every(c=>c.pass)?0:1;
})().finally(()=>fs.rmSync(home,{recursive:true,force:true}));
