const {app,BrowserWindow,ipcMain}=require('electron'),fs=require('fs'),path=require('path'),pty=require('node-pty');
const project=path.resolve(__dirname,'..'),stage=path.resolve(process.argv[2]||path.resolve(__dirname,'..'));
app.setPath('userData',fs.mkdtempSync('/tmp/wezy-lifecycle-ui-'));
const procs=new Map();let creates=0,win;const failures=[];
ipcMain.handle('fixture:create',(_,args)=>{if(args.id==='fixture-error')throw Error('Fixture launch refused');creates++;const p=pty.spawn('/bin/zsh',['-f','-c','printf "fixture terminal diagnostic\\r\\n"; read -r fixture_reply; exit 17'],{cwd:'/tmp',name:'xterm-256color',cols:80,rows:20,env:{PATH:'/usr/bin:/bin',TERM:'xterm-256color'}});procs.set(args.id,p);p.onData(data=>win.webContents.send('fixture:data',{id:args.id,data}));p.onExit(({exitCode,signal})=>{procs.delete(args.id);win.webContents.send('fixture:exit',{id:args.id,exitCode,signal,reason:'process-exit'})});return {id:args.id,profile:{name:'Fixture'}}});
ipcMain.on('fixture:write',(_,{id,data})=>procs.get(id)?.write(data));
ipcMain.handle('fixture:kill',(_,id)=>{procs.get(id)?.kill();procs.delete(id);return true});
app.whenReady().then(async()=>{
 win=new BrowserWindow({show:false,width:1280,height:820,webPreferences:{preload:path.join(__dirname,'pin-gui-preload.cjs'),contextIsolation:true,sandbox:false}});
 win.webContents.on('console-message',(_,level,message)=>{if(level>=3)failures.push(message)});
 try{
  await win.loadFile(path.join(stage,'src/renderer/index.html'));
  const result=await win.webContents.executeJavaScript(`(async()=>{
   const wait=()=>new Promise(r=>setTimeout(r,30)),until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await wait()}throw Error('Fixture timeout')};
   const checks=[],check=(name,pass)=>{checks.push({name,pass:!!pass})};await until(()=>codexReady&&!codexSyncPending);window.confirm=()=>true;window.alert=()=>{};
   check('startup does not open a terminal',terms.size===0);
   document.querySelector('[data-kind="codex"]').click();await wait();const names=()=>[...document.querySelectorAll('#cx-projects .pname>div')].map(e=>e.textContent);
   check('Codex pins first, archived and subagents hidden',JSON.stringify(names())===JSON.stringify(['📌 置顶会话','📌 另一置顶','普通会话']));
   await window.lane.fixtureMovePins();await refreshCodexSessions();check('desktop manual pin reorder reflected in actual DOM',JSON.stringify(names())===JSON.stringify(['📌 另一置顶','📌 置顶会话','普通会话']));
   document.querySelector('#btn-cx-archived').click();check('archive view',JSON.stringify(names())===JSON.stringify(['已归档会话']));
   document.querySelector('#cx-projects .x').click();await until(()=>names().length===0);document.querySelector('#btn-cx-archived').click();check('native restore result reflected',names().includes('已归档会话'));
   await window.lane.fixtureRemote();await refreshCodexSessions();
   const remote=state.projects.find(p=>p.hostId==='ssh:remote-host'),beforeActions=await window.lane.fixtureActions();
   await openSession(remote.id);const afterOpen=await window.lane.fixtureActions();
   check('remote click routes exact UUID and host through official deep link without PTY',terms.size===0&&afterOpen.external.at(-1)==='codex://threads/remote-uuid?hostId=ssh%3Aremote-host');
   await removeProject(remote.id);const afterManage=await window.lane.fixtureActions();
   check('remote management uses owner desktop and never local archive',afterManage.archiveCalls===beforeActions.archiveCalls&&afterManage.external.length===afterOpen.external.length+1);
   document.querySelector('[data-kind="claude"]').click();await openSession('fixture-c');await until(()=>terms.get('fixture-c')?.term.buffer.active.length>1);
   await window.lane.fixtureSetBindings([{id:'fixture-c',sessionId:'11111111-1111-4111-8111-111111111111',title:'Claude fixture'}]);await refreshTitles();
   check('live Claude identity persisted through renderer and preload', (await window.lane.fixtureStoredState()).projects.find(p=>p.id==='fixture-c').sessionId==='11111111-1111-4111-8111-111111111111');
   const rec=terms.get('fixture-c');window.lane.ptyWrite('fixture-c','finish\\r');await until(()=>rec.status==='exited');await wait();
   const output=Array.from({length:rec.term.buffer.active.length},(_,i)=>rec.term.buffer.active.getLine(i)?.translateToString(true)).join('\\n');
   check('real PTY exit retains last output and exit code 17',output.includes('fixture terminal diagnostic')&&output.includes('退出码 17'));
   check('exit keeps original terminal, tab and pane selected',terms.get('fixture-c')===rec&&paneActive.claude==='fixture-c'&&document.querySelector('#tabs').textContent.includes('Claude fixture'));
   check('exit banner and restart action visible; input disabled',rec.host.querySelector('.terminal-ended')?.textContent.includes('17')&&rec.term.options.disableStdin);
   check('exited terminal excluded from saved resume state',!state.openIds.includes('fixture-c'));
   await openSession('fixture-c');check('selecting exited tab only displays evidence',terms.get('fixture-c')===rec&&rec.status==='exited');
   rec.host.querySelector('.terminal-ended button').click();await until(()=>terms.get('fixture-c')!==rec&&terms.get('fixture-c')?.profile);check('explicit reopen creates a usable fresh terminal',terms.get('fixture-c').running&&!terms.get('fixture-c').term.options.disableStdin);
   check('explicit reopen uses persisted original Claude UUID',(await window.lane.fixtureLastCreate()).resume==='11111111-1111-4111-8111-111111111111');
   await closeSession('fixture-c');check('explicit close removes selected fixture tab',!terms.has('fixture-c'));
   await openSession('fixture-error');check('launch failure remains visible for diagnosis',terms.get('fixture-error')?.status==='exited'&&terms.get('fixture-error').host.textContent.includes('Fixture launch refused'));
   return {at:new Date().toISOString(),scope:'Hidden Electron with staged renderer, real xterm and local zsh PTY exit 17; fixture IPC, no Claude/Codex invocation or real state writes',checks};
  })()`);
  result.creates=creates;result.errors=failures;result.checks.push({name:'only initial fixture and explicit restart spawned',pass:creates===2});
  fs.writeFileSync(path.join(__dirname,'pin-gui-tests.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  for(const p of procs.values())p.kill();app.exit(result.checks.every(c=>c.pass)&&!failures.length?0:1);
 }catch(e){console.error(e);for(const p of procs.values())p.kill();app.exit(2)}
});setTimeout(()=>{for(const p of procs.values())p.kill();app.exit(3)},15000);
