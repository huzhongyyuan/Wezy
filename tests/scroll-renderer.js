(async () => {
  const checks = [];
  const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const check = (name, pass, detail) => checks.push({name, pass, detail});
  const rec = makeTerm('native-scroll-fixture', 'claude');
  rec.host.classList.add('active');
  fitTerm(rec);
  const write = async data => {
    window.testPtyData({id:'native-scroll-fixture', data});
    await new Promise(r => rec.term.write('', r));
    await frame();
  };
  const pos = () => ({viewport:rec.term.buffer.active.viewportY, base:rec.term.buffer.active.baseY, follow:rec.followTail, latest:!rec.latest.hidden});
  try {
    await write(Array.from({length:200},(_,i)=>`history ${i}\r\n`).join(''));
    const viewport = rec.host.querySelector('.xterm-viewport');
    rec.term.element.dispatchEvent(new WheelEvent('wheel',{deltaY:-240,deltaMode:0,bubbles:true,cancelable:true}));
    await frame();
    const afterWheel = pos();
    check('wheel moves viewport and suspends following', afterWheel.viewport < afterWheel.base && !afterWheel.follow && afterWheel.latest, afterWheel);
    await write('\r\x1b[2KWorking (3s)');
    check('progress redraw after wheel keeps reading position',pos().viewport===afterWheel.viewport && !pos().follow,{before:afterWheel,after:pos()});
    scrollToLatest(rec); await frame();
    viewport.scrollTop -= 300; await frame();
    const afterDrag = pos();
    check('native scrollbar suspends following',afterDrag.viewport<afterDrag.base&&!afterDrag.follow&&afterDrag.latest,afterDrag);
    await write('\r\x1b[2KWorking (4s)');
    check('progress redraw after native scroll keeps position',pos().viewport===afterDrag.viewport&&!pos().follow,{before:afterDrag,after:pos()});
    viewport.scrollTop=viewport.scrollHeight; await frame();
    check('native scrolling back to bottom resumes following',pos().follow&&pos().viewport===pos().base&&!pos().latest,pos());
    rec.term.element.dispatchEvent(new WheelEvent('wheel',{deltaY:-240,deltaMode:0,bubbles:true,cancelable:true}));
    await frame(); const beforeClear=pos();
    await write('\x1b[3J\x1b[H\x1b[2Jredraw');
    check('native scroll protects history during full redraw',pos().viewport===beforeClear.viewport&&pos().base>0&&!pos().follow,{before:beforeClear,after:pos()});
    rec.latest.click();await frame();
    await write('\r\nnew output');
    check('latest button restores output following',pos().follow&&pos().viewport===pos().base&&!pos().latest,pos());
  } catch(e) {check('exception',false,String(e.stack));}
  window.nativeScrollResults={at:new Date().toISOString(),checks};
  const panel=document.createElement('pre');panel.id='test-results';panel.style='position:fixed;inset:0;z-index:99999;background:white;color:black;overflow:auto;padding:24px;white-space:pre-wrap';panel.textContent=JSON.stringify(window.nativeScrollResults,null,2);document.body.appendChild(panel);
  document.title=checks.every(c=>c.pass)?'Wezy native scroll PASS':'Wezy native scroll FAIL';
})();
