const {app,BrowserWindow,session}=require('electron');
const fs=require('fs'),path=require('path'),{pathToFileURL}=require('url');
app.setPath('userData',fs.mkdtempSync('/tmp/wezy-scroll-'));
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_d,cb)=>cb({cancel:true}));
 const win=new BrowserWindow({show:false,width:1280,height:820,webPreferences:{backgroundThrottling:false}});
 try {
  const url=p=>pathToFileURL(path.resolve(p)).href;
  let html=fs.readFileSync('src/renderer/index.html','utf8').replace('<head>','<head><base href="'+url('src/renderer')+'/">');
  html=html.replace('<script src="../..', '<script src="'+url('tests/scroll-mock.js')+'"></script><script src="../..');
  html=html.replace('</body>','<script src="'+url('tests/scroll-renderer.js')+'"></script></body>');
  fs.writeFileSync('tests/scroll-fixture.html',html);
  await win.loadFile(path.resolve('tests/scroll-fixture.html'));
  const result=await win.webContents.executeJavaScript(`new Promise(resolve=>{const poll=()=>window.nativeScrollResults?resolve(window.nativeScrollResults):setTimeout(poll,25);poll()})`);
  fs.writeFileSync('tests/scroll-results.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));app.exit(result.checks.every(c=>c.pass)?0:1);
 } catch(e){console.error(e);app.exit(2)}
});setTimeout(()=>app.exit(3),20000);
