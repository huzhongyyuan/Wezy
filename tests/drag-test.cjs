const {app,BrowserWindow}=require('electron');
const fs=require('fs'),path=require('path');
app.setPath('userData',fs.mkdtempSync('/tmp/wezy-drag-check-'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1280,height:820,webPreferences:{preload:path.join(__dirname,'drag-preload.cjs'),contextIsolation:true,sandbox:false,backgroundThrottling:false}});
 try {
  await win.loadFile(path.join(__dirname,'../src/renderer/index.html'));
  const result=await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname,'drag-scenario.js'),'utf8'));
  fs.writeFileSync(path.join(__dirname,'drag-results.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result)); app.exit(result.checks.every(c=>c.pass)?0:1);
 } catch(e) { console.error(e); app.exit(2); }
});
setTimeout(()=>app.exit(3),20000);
