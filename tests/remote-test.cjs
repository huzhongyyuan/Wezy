const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{execFileSync}=require('child_process');
const root=path.resolve(process.argv[2]||'.'),remote=require(path.join(root,'src/main/codex-remote')),sync=require(path.join(root,'src/renderer/codex-sync'));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wezy-remote-')),db=path.join(dir,'state_5.sqlite'),prefs=path.join(dir,'.codex-global-state.json');
const checks=[],test=async(name,f)=>{try{await f();checks.push({name,pass:true})}catch(e){checks.push({name,pass:false,error:String(e.stack)})}};
const sql=s=>execFileSync('/usr/bin/sqlite3',[db,s]);
const pin='01984de2-8f74-7c91-a3b2-5c5e937cf318';
const row=(id,hostId,rank)=>({sessionId:id,cwd:'/tmp',title:'same title',hostId,pinned:true,pinRank:rank});
const state=order=>({'electron-persisted-atom-state':{'unified-sidebar-pinned-order-v1':order.map(([h,id])=>`codex:thread:${h}:${id}`)}});
const ids=rows=>rows.filter(r=>r.pinned&&!r.archived&&!r.subagent).sort((a,b)=>a.pinRank-b.pinRank).map(r=>`${r.hostId||'local'}:${r.sessionId}`);
(async()=>{
await test('host slots preserved while current native section positions reorder within each host',()=>{
 const rows=[row('a',null,0),row('b',null,1),row('c','ssh:r',0),row('d','ssh:r',1)];
 assert.deepEqual(ids(remote.ordered(rows,state([['ssh:r','d'],['local','b'],['ssh:r','c'],['local','a']]))),['ssh:r:c','local:a','ssh:r:d','local:b']);
});
await test('unpin, duplicate stored keys and stale entries never revive hidden pins',()=>{
 assert.deepEqual(ids(remote.ordered([row('a',null,0),{...row('b',null,1),pinned:false}],state([['local','b'],['local','a'],['local','a'],['local','gone']]))),['local:a']);
});
await test('remote migration under local key resolves only unique owner',()=>{
 assert.deepEqual(ids(remote.ordered([row('z','ssh:r',0),row('a',null,0)],state([['local','z'],['local','a']]))),['ssh:r:z','local:a']);
 const mixed=remote.ordered([row('z','ssh:r',0),row('z','ssh:q',0)],state([['local','z']]));assert.equal(mixed.length,2);
});
await test('legacy remote schema follows persisted desktop order instead of recent activity',()=>{
 assert.deepEqual(ids(remote.ordered([row('recent','r',null),row('first','r',null)],state([['r','first'],['r','recent']]))),['r:first','r:recent']);
});
await test('same UUID on different hosts remains separate, local identity survives',()=>{
 const rows=[row('same',null,0),row('same','r',1)];let n=0;
 const result=sync.reconcile([{kind:'codex',id:'existing',sessionId:'same',cwd:'/tmp'}],rows,()=>`new${++n}`);
 assert.equal(result.length,2);assert.equal(result[0].id,'existing');assert.equal(result[1].hostId,'r');
 assert.equal(sync.visible(sync.reconcile(result,[rows[0]],()=>{throw Error('new')})).length,1);
});
let conf={'codex-managed-remote-connections':[{source:'discovered',hostId:'r',alias:'remote-example',displayName:'Remote example'}],'app-server-migrated-pinned-thread-ids-by-host':{'r:/tmp/codex':true}};
await test('discovered SSH source resolved from exact host home',()=>assert.deepEqual(remote.sources(conf),[{hostId:'r',alias:'remote-example',home:'/tmp/codex',label:'Remote example'}]));
await test('unsafe alias, ambiguous homes rejected; unmanaged hosts excluded',()=>{
 assert.throws(()=>remote.sources({...conf,'codex-managed-remote-connections':[{source:'discovered',hostId:'r',alias:'-oProxyCommand=bad'}]}));
 assert.throws(()=>remote.sources({...conf,'app-server-migrated-pinned-thread-ids-by-host':{'r:/one':true,'r:/two':true}}));
 assert.deepEqual(remote.sources({'codex-managed-remote-connections':[{source:'manual',hostId:'r',alias:'remote-example'}]}),[]);
});
sql(`create table threads(id text,cwd text,name text,title text,is_pinned integer,archived integer,source text,updated_at integer,thread_section_id text,section_position integer); insert into threads values('local','/tmp','Local','',0,0,'cli',1,'${pin}',100),('old','/tmp','Old','',1,0,'cli',2,null,null),('sub','/tmp','Sub','',0,0,'subagent',3,'${pin}',50);`);
fs.writeFileSync(prefs,JSON.stringify(conf));let now=0,calls=0,fail=false;
const reader=remote.createReader(async s=>{calls++;if(fail)throw Error('fixture offline');return {identity:'realhost:/home',native:true,rows:[{id:'remote',cwd:'/remote',updated_at:3}]};},()=>now);
await test('reader merges real native local DB and remote metadata; caches 60 seconds',async()=>{
 const rows=await reader(dir);assert.deepEqual(ids(rows.sessions),['local:local','r:remote']);assert.equal(calls,1);await reader(dir);assert.equal(calls,1);
});
await test('failure preserves cached rows with visible warning and throttles repeated SSH',async()=>{
 fail=true;now=60000;const r=await reader(dir);assert.equal(r.sessions.find(x=>x.hostId==='r').remoteStale,true);assert.deepEqual(r.warnings,['fixture offline']);assert.equal(calls,2);await reader(dir);assert.equal(calls,2);
});
await test('successful next read clears stale state',async()=>{
 fail=false;now=120000;const r=await reader(dir);assert.equal(r.sessions.find(x=>x.hostId==='r').remoteStale,false);assert.deepEqual(r.warnings,[]);
});
await test('malformed old global config cannot break native local sections; warns and marks remote stale',async()=>{
 fs.writeFileSync(prefs,'{');const r=await reader(dir);assert.equal(r.sessions.find(x=>x.sessionId==='local').pinned,true);assert.equal(r.warnings.length,1);assert.equal(r.sessions.find(x=>x.hostId==='r').remoteStale,true);
 const fresh=await remote.createReader(async()=>{throw Error('must not run')})(dir);assert.equal(fresh.sessions.some(x=>x.sessionId==='local'),true);assert.equal(fresh.warnings.length,1);
});
await test('two SSH aliases for same host and home produce one metadata set',async()=>{
 const c=structuredClone(conf);c['codex-managed-remote-connections'].push({source:'discovered',hostId:'q',alias:'remote-alias'});c['app-server-migrated-pinned-thread-ids-by-host']['q:/tmp/codex']=true;fs.writeFileSync(prefs,JSON.stringify(c));
 const r=await remote.createReader(async()=>({identity:'host:/home',native:true,rows:[{id:'remote',cwd:'/tmp',updated_at:1}]}))(dir);assert.equal(r.sessions.filter(x=>x.sessionId==='remote').length,1);
});
await test('production Python probe reads native membership/order and does not mutate SQLite',()=>{
 const before=fs.readFileSync(db);const out=JSON.parse(execFileSync('python3',['-c',remote.probe,dir],{encoding:'utf8'}));assert.equal(out.native,true);assert.deepEqual(out.rows.map(r=>r.id),['local']);assert.deepEqual(fs.readFileSync(db),before);
});
await test('production Python probe handles legacy schema and rejects partial migration',()=>{
 sql('alter table threads drop column thread_section_id; alter table threads drop column section_position');
 const out=JSON.parse(execFileSync('python3',['-c',remote.probe,dir],{encoding:'utf8'}));assert.equal(out.native,false);assert.deepEqual(out.rows.map(r=>r.id),['old']);
 sql('alter table threads add column thread_section_id text');assert.throws(()=>execFileSync('python3',['-c',remote.probe,dir],{stdio:'pipe'}));
});
const result={at:new Date().toISOString(),scope:'isolated SQLite/Python/renderer reconciliation and SSH transport fixtures; no live writes',checks};fs.writeFileSync(process.argv[3]||path.join(__dirname,'remote-tests.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));process.exitCode=checks.every(c=>c.pass)?0:1;
})().finally(()=>fs.rmSync(dir,{recursive:true,force:true}));
