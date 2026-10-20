const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),crypto=require('crypto');
const {execFileSync}=require('child_process');
const root=path.resolve(process.argv[2]||'.');
const backend=require(path.join(root,'src/main/codex-sessions.js'));
const sync=require(path.join(root,'src/renderer/codex-sync.js'));
const home=fs.mkdtempSync(path.join(os.tmpdir(),'wezy-section-'));
const db=path.join(home,'state_5.sqlite'),prefs=path.join(home,'.codex-global-state.json');
const pin='01984de2-8f74-7c91-a3b2-5c5e937cf318',checks=[];
const sql=s=>execFileSync('/usr/bin/sqlite3',[db,s]);
const test=async(name,f)=>{try{await f();checks.push({name,pass:true})}catch(e){checks.push({name,pass:false,error:String(e)})}};
const rows=async()=>sync.visible(sync.reconcile([],await backend.listSessions(home),()=>Math.random().toString(36)));
const ids=async()=>(await rows()).filter(x=>x.pinned).map(x=>x.sessionId);
(async()=>{
 sql(`create table threads(id text,cwd text,name text,title text,is_pinned integer,archived integer,source text,updated_at integer,thread_section_id text,section_position integer);
 insert into threads values ('control','/tmp','项目总控','',0,0,'cli',1,'${pin}',100),('dance','/tmp','human-dance-v2','',0,0,'cli',3,'${pin}',200),('old','/tmp','old pin','',1,0,'cli',9,null,null),('custom','/tmp','custom section','',1,0,'cli',5,'user-section',50),('arch','/tmp','archived','',1,1,'cli',5,'${pin}',110),('sub','/tmp','agent','',1,0,'subagent',5,'${pin}',120);`);
 fs.writeFileSync(prefs,JSON.stringify({'pinned-thread-ids':['old'],'electron-persisted-atom-state':{'unified-sidebar-pinned-order-v1':['codex:thread:local:dance','codex:thread:local:old']}}));
 await test('original screenshot failure: section pins included despite is_pinned=0; stale old pins excluded',async()=>assert.deepEqual(await ids(),['control','dance']));
 await test('section order overrides conflicting legacy global order and recency',async()=>{
  sql("update threads set section_position=50 where id='dance'");assert.deepEqual(await ids(),['dance','control']);
 });
 await test('native unpin takes effect even with old is_pinned still true',async()=>{
  sql("update threads set thread_section_id=null,is_pinned=1 where id='dance'");assert.deepEqual(await ids(),['control']);
 });
 await test('custom sections, archived roots, subagents do not leak into visible pins',async()=>{
  assert.deepEqual(await ids(),['control']);assert.equal((await rows()).some(x=>['arch','sub'].includes(x.sessionId)),false);
 });
 await test('native sections do not depend on obsolete global preference parse',async()=>{
  fs.writeFileSync(prefs,'{');assert.deepEqual(await ids(),['control']);
 });
 await test('empty native pinned section does not revive legacy pins',async()=>{
  sql('update threads set thread_section_id=null');assert.deepEqual(await ids(),[]);
 });
 await test('official DB remains byte-identical during reads',async()=>{
  const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(db)).digest('hex');const before=hash();await rows();assert.equal(hash(),before);
 });
 await test('incomplete schema fails explicitly rather than falling back to obsolete flags',async()=>{
  sql('alter table threads drop column section_position');await assert.rejects(backend.listSessions(home),/结构不完整/);
 });
 const result={at:new Date().toISOString(),scope:'isolated official-schema fixtures through production reader/reconciler; no live writes',checks};
 fs.writeFileSync(path.resolve(process.argv[3]||path.join(__dirname,'section-tests.json')),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));process.exitCode=checks.every(x=>x.pass)?0:1;
})().finally(()=>fs.rmSync(home,{recursive:true,force:true}));
