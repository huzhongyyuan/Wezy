const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',fs.mkdtempSync('/tmp/wezy-pane-check-'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1280,height:820,webPreferences:{preload:path.join(__dirname,'drag-preload.cjs'),contextIsolation:true,sandbox:false}});
 try{
 await win.loadFile(path.join(__dirname,'../src/renderer/index.html'));
 const result=await win.webContents.executeJavaScript(`(async()=>{
 await new Promise(r=>setTimeout(r,150));
 for(const id of ['c1','c2','x1','x2'])await openSession(id);
 const checks=[]; const check=(name,pass)=>checks.push({name,pass});
 check('Claude tabs in Claude pane',document.querySelector('#tabs').parentElement.contains(document.querySelector('#term-wrap')) && document.querySelectorAll('#tabs .tab').length===2 && !document.querySelector('#tabs .codex'));
 check('Codex tabs in Codex pane',document.querySelector('#tabs-codex').parentElement.contains(document.querySelector('#term-wrap-codex')) && document.querySelectorAll('#tabs-codex .codex').length===2);
 document.querySelector('#tabs .tab').click();check('Claude switch preserves Codex',paneActive.claude==='c1'&&paneActive.codex==='x2');
 document.querySelector('#tabs-codex .tab').click();check('Codex switch preserves Claude',paneActive.claude==='c1'&&paneActive.codex==='x1');
 const refs=[...terms];renderProjects();check('rerender preserves terminals',refs.every(([id,r])=>terms.get(id)===r)&&terms.size===4);
 check('both panes have active tab',document.querySelectorAll('#tabs .active').length===1&&document.querySelectorAll('#tabs-codex .active').length===1);
 await closeSession('x1');check('close only affects its own pane',!terms.has('x1')&&terms.has('c1')&&paneActive.claude==='c1'&&document.querySelectorAll('#tabs-codex .tab').length===1);
 return {scope:'Production renderer with fixture IPC; no real PTYs or user state',checks}; })()`);
 fs.writeFileSync(path.join(__dirname,'pane-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));app.exit(result.checks.every(c=>c.pass)?0:1);
 }catch(e){console.error(e);app.exit(2)}
});setTimeout(()=>app.exit(3),15000);
