const {app,BrowserWindow}=require('electron');const fs=require('fs'),path=require('path');
app.setPath('userData',fs.mkdtempSync('/tmp/wezy-sync-gui-'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1280,height:820,webPreferences:{preload:path.join(__dirname,'gui-preload.cjs'),contextIsolation:true,sandbox:false}});
 try{
  await win.loadFile(path.resolve('src/renderer/index.html'));
  const result=await win.webContents.executeJavaScript(`(async()=>{
   const wait=()=>new Promise(r=>setTimeout(r,100));await wait();window.confirm=()=>true;window.alert=()=>{};
   document.querySelector('[data-kind="codex"]').click();await wait();
   const names=()=>[...document.querySelectorAll('#cx-projects .pname>div')].map(e=>e.textContent);
   const checks=[];checks.push({name:'pin sorted first and archive hidden',pass:JSON.stringify(names())===JSON.stringify(['📌 置顶会话','普通会话'])});
   document.querySelector('#btn-cx-archived').click();checks.push({name:'archive view',pass:JSON.stringify(names())===JSON.stringify(['已归档会话'])});
   document.querySelector('#cx-projects .x').click();await wait();checks.push({name:'restore removes row from archived view',pass:names().length===0});
   document.querySelector('#btn-cx-archived').click();checks.push({name:'restored row appears in active view',pass:names().includes('已归档会话')});
   checks.push({name:'sync status visible',pass:document.querySelector('#cx-sync-status').textContent.includes('已同步')});
   document.querySelector('[data-kind="claude"]').click();checks.push({name:'Claude unchanged',pass:document.querySelector('#projects .pname>div').textContent==='Claude preserved'});
   document.querySelector('[data-kind="codex"]').click();await wait();return {at:new Date().toISOString(),scope:'Hidden Electron window, production renderer, fixture IPC; no PTYs or real user state',checks};
  })()`);
  fs.writeFileSync(path.join(__dirname,'gui-tests.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  const img=await win.webContents.capturePage();fs.writeFileSync(path.join(__dirname,'preview.jpg'),img.resize({width:1280}).toJPEG(65));
  app.exit(result.checks.every(c=>c.pass)?0:1);
 }catch(e){console.error(e);app.exit(2)}
});setTimeout(()=>app.exit(3),15000);
