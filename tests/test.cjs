const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const assert = require('assert/strict'), {execFileSync} = require('child_process');
const root = path.resolve(process.argv[2] || '.');
const sync = require(path.join(root, 'src/renderer/codex-sync.js'));
const backend = require(path.join(root, 'src/main/codex-sessions.js'));
const checks = [];
const test = async (name, fn) => { try { await fn(); checks.push({name, pass:true}); } catch(e) { checks.push({name,pass:false,error:e.stack}); } };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wezy-sync-'));
let id = 0; const uid = () => 'new' + ++id;
const sample = (sessionId, more={}) => ({sessionId,cwd:'/tmp/work',title:sessionId,pinned:false,archived:false,mtime:1,subagent:false,...more});
(async () => {
 const claude = {id:'claude',name:'Claude',cwd:'/tmp/work'};
 const old = [claude,{id:'existing',kind:'codex',sessionId:'a',name:'📌 Old',cwd:'/old'}];
 await test('official rename/unpin/cwd replace old snapshot without changing local identity', () => {
  const result=sync.reconcile(old,[sample('a',{title:'Renamed'})],uid);
  assert.equal(result[1].id,'existing'); assert.equal(result[1].name,'Renamed'); assert.equal(result[1].pinned,false); assert.equal(result[1].cwd,'/tmp/work'); assert.equal(result[0],claude);
 });
 await test('pin and recency order, archive/unarchive, root session filtering', () => {
  const result=sync.reconcile(old,[sample('a',{archived:true}),sample('b',{pinned:true}),sample('c',{mtime:9}),sample('sub',{subagent:true})],uid);
  assert.deepEqual(sync.visible(result).map(p=>p.sessionId),['b','c']);
  assert.deepEqual(sync.visible(result,true).map(p=>p.sessionId),['a']);
  assert.equal(result.some(p=>p.sessionId==='sub'),false);
  const restored=sync.reconcile(result,[sample('a',{pinned:true}),sample('b'),sample('c')],uid);
  assert.equal(sync.visible(restored)[0].id,'existing'); assert.equal(sync.visible(restored,true).length,0);
 });
 await test('missing and archived records retain IDs and objects needed by open terminals', () => {
  const result=sync.reconcile(old,[],uid);
  assert.equal(result.length,2);assert.equal(result[1].id,'existing');assert.equal(result[1].codexMissing,true);assert.equal(sync.visible(result).length,0);
  assert.equal(sync.reconcile(result,[sample('a')],uid)[1].codexMissing,false);
 });
 await test('invalid data cannot become an empty snapshot; new snapshots are idempotent', () => {
  assert.throws(()=>sync.reconcile(old,null,uid));assert.throws(()=>sync.reconcile(old,[{}],uid));
  const result=sync.reconcile(old,[sample('a'),sample('b')],uid);
  assert.deepEqual(sync.reconcile(result,[sample('a'),sample('b')],uid),result);
 });
 const db=path.join(temp,'state_5.sqlite');
 execFileSync('/usr/bin/sqlite3',[db,`create table threads(id text,cwd text,name text,title text,is_pinned integer,archived integer,source text,updated_at integer); with recursive cnt(x) as (select 1 union all select x+1 from cnt where x<350) insert into threads select 's'||x,'/tmp','','title'||x,x=350,x=2,'cli',x from cnt;`]);
 await test('real SQLite read includes >300 records, pins and archives without writing DB', async()=>{
  const before=fs.readFileSync(db);const rows=await backend.listSessions(temp);
  assert.equal(rows.length,350);assert.equal(rows[0].sessionId,'s350');assert.equal(rows.find(r=>r.sessionId==='s2').archived,true);assert.deepEqual(fs.readFileSync(db),before);
 });
 await test('missing or incompatible DB rejects instead of deleting UI entries', async()=>{
  await assert.rejects(backend.listSessions(path.join(temp,'absent')));
 });
 const source=fs.readFileSync(path.join(root,'src/renderer/app.js'),'utf8');
 let state={projects:structuredClone(old),openIds:['existing'],activeCx:'existing'};
 const rec={buffer:'keep',running:true};const terms=new Map([['existing',rec]]);let saved=0,closed=0,archiveCalls=0;
 const status={};const context={state,terms,codexReady:true,codexSyncPending:null,uid,Date,JSON,alert:()=>{},confirm:()=>true,
  kindOf:p=>p.kind==='codex'?'codex':'claude',$:()=>status,renderProjects:()=>{},persist:async()=>saved++,closeSession:async()=>closed++,
  window:{codexSync:sync,lane:{listCodexSessions:async()=>[sample('a',{archived:true})],archiveCodexSession:async()=>archiveCalls++}},setInterval:()=>{},addEventListener:()=>{}};
 vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('async function refreshCodexSessions('), source.indexOf("addEventListener('focus', () => refreshCodexSessions());") + "addEventListener('focus', () => refreshCodexSessions());".length),context);
 vm.runInContext(source.slice(source.indexOf('async function removeProject('),source.indexOf('function makeTerm(')),context);
 await test('production refresh preserves live terminal, active selection and open IDs on archive', async()=>{
  await context.refreshCodexSessions();assert.equal(terms.get('existing'),rec);assert.equal(closed,0);assert.equal(context.state.activeCx,'existing');assert.deepEqual(context.state.openIds,['existing']);assert.equal(context.state.projects[1].archived,true);
 });
 await test('production refresh error retains exact state; concurrent requests are coalesced', async()=>{
  const before=context.state.projects;context.window.lane.listCodexSessions=async()=>{throw Error('locked')};
  await context.refreshCodexSessions();assert.equal(context.state.projects,before);assert.match(status.textContent,/同步失败/);
  let count=0,release;context.window.lane.listCodexSessions=()=>{count++;return new Promise(r=>release=r)};
  const first=context.refreshCodexSessions(),second=context.refreshCodexSessions();release([sample('a')]);await Promise.all([first,second]);assert.equal(count,1);
 });
 await test('production archive control refuses an open terminal without API call or kill',async()=>{
  await context.removeProject('existing');assert.equal(archiveCalls,0);assert.equal(closed,0);
 });
 await test('production archive failure retains session for retry',async()=>{
  terms.clear();context.window.lane.archiveCodexSession=async()=>{throw Error('failed')};const before=context.state.projects;
  await context.removeProject('existing');assert.equal(context.state.projects,before);assert.equal(closed,0);
 });
 const fake=path.join(temp,'fake-codex');
 fs.writeFileSync(fake,`#!${process.execPath}\nconst rl=require('readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({id:1,result:{}}));if(m.id===2){if(!['thread/archive','thread/unarchive'].includes(m.method))process.exit(3);if(m.params.threadId==='error')console.log(JSON.stringify({id:2,error:{message:'failure'}}));else if(m.params.threadId==='exit')process.exit(4);else if(m.params.threadId!=='timeout')console.log(JSON.stringify({id:2,result:{}}));}});`,{mode:0o700});
 await test('native archive/unarchive protocol handshake handles success and rejection',async()=>{
  await backend.setArchived(fake,process.env,'test',true);await backend.setArchived(fake,process.env,'test',false);
  await assert.rejects(backend.setArchived(fake,process.env,'error',true));await assert.rejects(backend.setArchived(fake,process.env,'exit',true));
 });
 await test('native protocol timeout and invalid IDs reject safely',async()=>{
  await assert.rejects(backend.setArchived(fake,process.env,'timeout',true,80));await assert.rejects(backend.setArchived(fake,process.env,'bad;id',true));
 });
 await test('native archive methods match installed official CLI protocol schema',()=>{
  const schema=fs.readFileSync(process.env.CODEX_SCHEMA + '/ClientRequest.json','utf8');assert(schema.includes('thread/archive'));assert(schema.includes('thread/unarchive'));
 });
 const result={at:new Date().toISOString(),scope:'SQLite fixture; production merge/renderer functions; fake native protocol; no live session mutation or graphical E2E',checks};
 fs.writeFileSync(path.resolve(process.argv[3]||'tests/results.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));process.exitCode=checks.every(c=>c.pass)?0:1;
})();
