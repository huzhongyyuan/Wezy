const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
const root = path.resolve(__dirname, '..'), checks = [];
const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
const c = vm.createContext({});
vm.runInContext(main.slice(main.indexOf('function matchClaudeBindings('), main.indexOf("ipcMain.handle('sessions:bindings'")), c);
const sid = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const entries = new Map([['film', {cwd:'/film',proc:{pid:10}}]]);
const parents = new Map([[10,1],[11,10],[12,11],[20,1]]);
const row = {pid:11,cwd:'/film',sessionId:sid,name:'human-film'};
const run = rows => JSON.parse(JSON.stringify(c.matchClaudeBindings(entries, rows, parents)));
async function test(name, fn) {try {await fn();checks.push({name,pass:true});} catch(e) {checks.push({name,pass:false,error:e.stack});}}
(async()=>{
 await test('folder session resolves through its actual shell child',()=>assert.deepEqual(run([row]),[{id:'film',sessionId:sid,title:'human-film'}]));
 await test('same-directory unrelated process cannot be selected',()=>assert.deepEqual(run([{...row,pid:20}]),[]));
 await test('nearest Claude owner wins over nested subagent',()=>assert.equal(run([row,{...row,pid:12,sessionId:other}])[0].sessionId,sid));
 await test('dead PID, different directory, malformed UUID ignored',()=>assert.deepEqual(run([{...row,pid:99},{...row,cwd:'/elsewhere'},{...row,sessionId:'invalid'}]),[]));
 await test('ambiguous owner fails visibly',()=>assert.throws(()=>run([row,{...row,sessionId:other}]),/无法唯一/));
 await test('Codex terminal untouched',()=>assert.equal(c.matchClaudeBindings(new Map([['cx',{cwd:'/film',proc:{pid:10},kind:'codex',profile:{id:'local'}}]]),[row],parents).length,0));
 let saved, launches=[], messages=[], bindings=run([row]);
 const state={projects:[{id:'film',cwd:'/film',name:'film'}],openIds:['film']};
 const rec={term:{cols:80,rows:24},running:true};
 const ctx=vm.createContext({state,terms:new Map(),kindOf:p=>p.kind==='codex'?'codex':'claude',titles:{},console:{error:(...x)=>messages.push(x)},
   persist:async()=>{saved=JSON.parse(JSON.stringify(state));},renderProjects(){},renderTabs(){},showView(){},activate(){},fitTerm(){},saveOpen(){},makeTerm:()=>rec,
   window:{lane:{sessionBindings:async()=>bindings,sessionTitles:async()=>({}),ptyCreate:async x=>{launches.push(x);return {profile:{}};}}}});
 vm.runInContext(renderer.slice(renderer.indexOf('async function refreshTitles()'),renderer.indexOf('setInterval(refreshTitles')),ctx);
 vm.runInContext(renderer.slice(renderer.indexOf('async function openSession('),renderer.indexOf('function activate(')),ctx);
 await test('observed UUID saved with existing project ID and open state',async()=>{await ctx.refreshTitles();assert.equal(saved.projects[0].sessionId,sid);assert.equal(saved.projects[0].id,'film');assert.deepEqual(saved.openIds,['film']);assert.equal(saved.projects[0].name,'human-film');});
 await test('next explicit open passes exact saved resume UUID',async()=>{await ctx.openSession('film');assert.equal(launches.length,1);assert.equal(launches[0].resume,sid);});
 await test('manual in-terminal resume updates binding to actual new session',async()=>{bindings=[{id:'film',sessionId:other,title:'changed'}];await ctx.refreshTitles();assert.equal(saved.projects[0].sessionId,other);});
 await test('registry failure preserves stored identity and reports error',async()=>{ctx.window.lane.sessionBindings=async()=>{throw Error('fixture registry failure')};await ctx.refreshTitles();assert.equal(saved.projects[0].sessionId,other);assert.equal(messages.length,1);});
 const result={at:new Date().toISOString(),checks,scope:'Production owner matching and renderer persist/reopen functions; no real session mutation or model invocation'};
 fs.writeFileSync(path.join(__dirname,'resume-binding-tests.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));process.exitCode=checks.every(x=>x.pass)?0:1;
})();
