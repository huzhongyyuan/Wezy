/* global Terminal, FitAddon, WebLinksAddon */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
document.body.classList.add(window.lane.platform);

let state = { projects: [] };      // 持久化：[{id,name,cwd}]
const terms = new Map();          // id -> {term, fit, host, running}
let activeId = null;              // 最近聚焦的会话
const paneActive = { claude: null, codex: null }; // 上下两行的会话
const kindOf = (p) => (p && p.kind === 'codex' ? 'codex' : 'claude');
let lastDiag = null;
let titles = {};                  // cwd -> /rename 的会话名
let codexArchivedView = false;
let codexReady = false;
let codexSyncPending = null;
const displayName = p => (kindOf(p) === 'codex' && p.pinned ? '📌 ' : '') + (p.hostId && p.hostId !== 'local' ? '🌐 ' : '') + p.name;
const terminalStatus = rec => rec?.status === 'exited' ? rec.exitSummary : rec?.status === 'running' ? '正在运行' : rec?.status === 'done' ? '已完成' : rec ? '空闲' : '未启动';
let currentKind = 'claude';       // 当前侧边栏 tab

const uid = () => Math.random().toString(36).slice(2, 10);
const basename = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- 视图切换 ----------
function showView(v) {
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $$('.view').forEach((s) => s.classList.toggle('active', s.id === 'view-' + v));
  if (v === 'usage') loadUsage();
  if (v === 'access') loadProfiles();
  if (v === 'term' && activeId) requestAnimationFrame(() => fitActive());
}
$$('.nav-btn').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

// ---------- 项目与会话 ----------
async function persist() { await window.lane.setState(state); }

// 记住打开的标签页和当前标签，下次启动自动恢复（恢复过程中不写，避免覆盖）
let restoring = false;
function saveOpen() {
  if (restoring) return;
  state.openIds = [...terms].filter(([, rec]) => rec.running).map(([id]) => id);
  state.activeId = terms.get(paneActive.claude)?.running ? paneActive.claude : null;
  state.activeCx = terms.get(paneActive.codex)?.running ? paneActive.codex : null;
  persist();
}

function renderProjects() {
  if (dragProject) return; // 状态更新不能在拖动中移除拖动源。
  const ul = $('#projects'), cul = $('#cx-projects');
  ul.innerHTML = ''; cul.innerHTML = '';
  const claudeProjs = state.projects.filter((p) => kindOf(p) === 'claude');
  const codexProjs = window.codexSync.visible(state.projects, codexArchivedView);
  $('#projects-empty').style.display = claudeProjs.length ? 'none' : 'block';
  $('#cx-empty').style.display = codexProjs.length ? 'none' : 'block';

  // 根据当前 tab 显示对应列表
  const showCx = currentKind === 'codex';
  ul.style.display = showCx ? 'none' : 'block';
  $('#projects-empty').style.display = (showCx || claudeProjs.length) ? 'none' : 'block';
  cul.style.display = showCx ? 'block' : 'none';
  $('#cx-empty').style.display = (!showCx || codexProjs.length) ? 'none' : 'block';
  $('#btn-import').style.display = showCx ? 'none' : 'inline';
  $('#btn-add').textContent = showCx ? '＋ 新建' : '＋ 新建会话';

  for (const p of [...claudeProjs, ...codexProjs]) {
    const li = document.createElement('li');
    const rec = terms.get(p.id);
    li.className = (p.id === paneActive[kindOf(p)] ? 'active ' : '') + (rec?.running ? 'running' : '') + (rec?.status === 'running' ? ' busy' : rec?.status === 'done' ? ' done' : '');
    li.dataset.projectId = p.id;
    li.title = terminalStatus(rec) + (kindOf(p) === 'codex' ? ' · 名称、置顶和归档跟随官方 Codex' : ' · 拖动调整顺序');
    if (p.hostId && p.hostId !== 'local') li.title = `${p.hostLabel || p.hostId} · 点击在桌面版打开原会话${p.remoteStale ? ' · 读取失败，显示上次置顶' : ''}`;
    li.innerHTML = `<span class="dot">${rec?.status === 'done' ? '✓' : ''}</span><div class="pname"><div>${esc(p.sessionId ? displayName(p) : (titles[p.cwd] || p.name))}</div><small title="${esc(p.cwd)}">${esc(p.sessionId ? basename(p.cwd) + ' · 会话' : (titles[p.cwd] ? p.name : p.cwd))}</small></div><span class="project-actions"><button class="order-up" title="上移" aria-label="上移会话">↑</button><button class="order-down" title="下移" aria-label="下移会话">↓</button><button class="x" title="移除" aria-label="移除会话">✕</button></span>`;
    li.addEventListener('click', () => { if (p.archived && !terms.has(p.id)) alert('请先点击恢复，再打开已归档会话。'); else openSession(p.id); });
    const peers = kindOf(p) === 'codex' ? codexProjs : claudeProjs;
    const position = peers.findIndex((x) => x.id === p.id);
    for (const [selector, delta] of [['.order-up', -1], ['.order-down', 1]]) {
      const button = li.querySelector(selector);
      button.disabled = !peers[position + delta];
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        moveProjectStep(p.id, delta);
        // 重绘后保留键盘焦点，让连续调整也可用。
        const row = $$('.projects li').find((x) => x.dataset.projectId === p.id);
        row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const next = row?.querySelector(selector);
        (next?.disabled ? row.querySelector(delta < 0 ? '.order-down' : '.order-up') : next)?.focus({ preventScroll: true });
      });
    }
    li.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); removeProject(p.id); });
    if (kindOf(p) === 'codex' && p.sessionId) {
      li.querySelector('.order-up').hidden = true;
      li.querySelector('.order-down').hidden = true;
      const action = li.querySelector('.x');
      action.textContent = p.archived ? '↩' : '▣';
      action.title = p.archived ? '恢复到官方会话列表' : '归档到官方 Codex';
      action.setAttribute('aria-label', action.title);
      if (p.hostId && p.hostId !== 'local') { action.textContent = '↗'; action.title = '在原桌面会话管理归档与置顶'; action.setAttribute('aria-label', action.title); }
    } else bindProjectDrag(li, p, 'vertical');
    // 根据项目类型和当前 tab 决定显示位置
    if (kindOf(p) === currentKind) (currentKind === 'codex' ? cul : ul).appendChild(li);
  }
  renderPaneTitles();
  renderTabs();
}

function renderPaneTitles() {
  for (const k of ['claude', 'codex']) {
    const p = state.projects.find((x) => x.id === paneActive[k]);
    const st = p ? terms.get(p.id)?.status : null;
    const el = $('#pane-title-' + k);
    el.textContent = (p ? (p.sessionId ? displayName(p) : (titles[p.cwd] || p.name)) : '（左侧选一个会话）') +
      (st === 'running' ? ' · 运行中' : st === 'done' ? ' · 已完成' : st === 'exited' ? ' · ' + terms.get(p.id).exitSummary : '');
    el.className = 'muted' + (st === 'done' ? ' done' : '');
  }
}

function renderTabs() {
  if (dragProject) return;
  const bars = {claude: $('#tabs'), codex: $('#tabs-codex')};
  const scroll = Object.fromEntries(Object.entries(bars).map(([k,b]) => [k,b.scrollLeft]));
  for (const b of Object.values(bars)) b.innerHTML = '';
  for (const p of state.projects.filter((x) => terms.has(x.id))) {
    const t = document.createElement('div');
    const trec = terms.get(p.id);
    const st = trec?.status;
    t.className = 'tab' + (p.id === paneActive[kindOf(p)] ? ' active' : '') + (kindOf(p) === 'codex' ? ' codex' : '') + (st === 'running' ? ' busy' : st === 'done' ? ' done' : '');
    t.title = terminalStatus(trec) + (trec?.profile ? ` · 接入：${trec.profile.name}` : '');
    t.innerHTML = `<span>${esc(p.sessionId ? displayName(p) : (titles[p.cwd] || p.name))}</span><button class="x" title="结束会话">✕</button>`;
    t.addEventListener('click', () => openSession(p.id));
    t.querySelector('.x').addEventListener('click', (e) => { e.stopPropagation(); closeSession(p.id); });
    bindProjectDrag(t, p, 'horizontal');
    bars[kindOf(p)].appendChild(t);
  }
  for (const [k,b] of Object.entries(bars)) b.scrollLeft = scroll[k];
  $('#welcome').classList.toggle('hidden', terms.size > 0);
}

// 侧边栏和顶部标签共用持久化顺序；排序不打开、关闭或重启会话。
let dragProject = null;
// Keep scrolling while the pointer rests at an edge; native dragover events
// alone are too infrequent for a smooth trip through a long session list.
let projectDragScroll = null;
function stopProjectDragScroll() {
  if (projectDragScroll) cancelAnimationFrame(projectDragScroll.frame);
  projectDragScroll = null;
  $$('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
}
function startProjectDragScroll(element, axis) {
  stopProjectDragScroll();
  const container = element.closest(axis === 'vertical' ? '.panel.grow' : '.tabs');
  if (!container) return;
  const ctx = { container, axis, point: null, last: null, frame: 0 };
  projectDragScroll = ctx;
  const tick = (time) => {
    if (!dragProject || projectDragScroll !== ctx) return;
    const elapsed = ctx.last === null ? 0 : Math.min(time - ctx.last, 50);
    ctx.last = time;
    if (ctx.point) {
      const rect = container.getBoundingClientRect();
      const { x, y } = ctx.point;
      const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      if (inside) {
        const vertical = axis === 'vertical';
        const start = vertical ? rect.top : rect.left;
        const end = vertical ? rect.bottom : rect.right;
        const pos = vertical ? y : x;
        const edge = Math.min(56, (end - start) / 3);
        const speed = edge <= 0 ? 0 : pos < start + edge ? -(start + edge - pos) / edge :
          pos > end - edge ? (pos - end + edge) / edge : 0;
        container[vertical ? 'scrollTop' : 'scrollLeft'] += speed * 700 * elapsed / 1000;
        // A stationary pointer can now be over a different row after scrolling.
        const target = document.elementFromPoint(x, y)?.closest(vertical ? '.projects li' : '.tab');
        $$('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
        const project = state.projects.find(p => p.id === target?.dataset.projectId);
        if (target && container.contains(target) && project && project.id !== dragProject.id && kindOf(project) === dragProject.kind) {
          const box = target.getBoundingClientRect();
          const after = vertical ? y > box.top + box.height / 2 : x > box.left + box.width / 2;
          target.classList.add(after ? 'drop-after' : 'drop-before');
        }
      }
    }
    ctx.frame = requestAnimationFrame(tick);
  };
  ctx.frame = requestAnimationFrame(tick);
}
document.addEventListener('dragover', (e) => {
  const ctx = projectDragScroll;
  if (!ctx || !dragProject) return;
  ctx.point = { x: e.clientX, y: e.clientY };
  const rect = ctx.container.getBoundingClientRect();
  if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  } else {
    $$('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
  }
}, true);
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget && projectDragScroll) projectDragScroll.point = null;
});
document.addEventListener('drop', stopProjectDragScroll, true);
document.addEventListener('dragend', stopProjectDragScroll, true);
window.addEventListener('blur', stopProjectDragScroll);

function bindProjectDrag(element, project, axis) {
  element.draggable = true;
  element.dataset.projectId = project.id;
  const accepts = () => dragProject && dragProject.id !== project.id && dragProject.axis === axis &&
    dragProject.kind === kindOf(project);
  const after = (e) => {
    const rect = element.getBoundingClientRect();
    return axis === 'vertical' ? e.clientY > rect.top + rect.height / 2 : e.clientX > rect.left + rect.width / 2;
  };
  element.addEventListener('dragstart', (e) => {
    if (e.target.closest('button')) { e.preventDefault(); return; }
    dragProject = { id: project.id, kind: kindOf(project), axis };
    startProjectDragScroll(element, axis);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-wezy-project', project.id);
    element.classList.add('dragging');
  });
  element.addEventListener('dragover', (e) => {
    if (!accepts()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const below = after(e);
    element.classList.toggle('drop-after', below);
    element.classList.toggle('drop-before', !below);
  });
  element.addEventListener('dragleave', (e) => {
    if (!element.contains(e.relatedTarget)) element.classList.remove('drop-after', 'drop-before');
  });
  element.addEventListener('drop', (e) => {
    if (!accepts()) return;
    e.preventDefault(); e.stopPropagation();
    const from = dragProject.id;
    dragProject = null;
    moveProject(from, project.id, after(e));
  });
  element.addEventListener('dragend', () => { dragProject = null; renderProjects(); });
}
function moveProjectStep(id, delta) {
  const project = state.projects.find((p) => p.id === id);
  if (!project || ![-1, 1].includes(delta)) return;
  const peers = state.projects.filter((p) => kindOf(p) === kindOf(project));
  const neighbor = peers[peers.findIndex((p) => p.id === id) + delta];
  if (neighbor) moveProject(id, neighbor.id, delta > 0);
}
function moveProject(from, to, after) {
  const a = state.projects.findIndex((x) => x.id === from);
  if (a < 0 || from === to || !state.projects.some((x) => x.id === to)) return;
  const [it] = state.projects.splice(a, 1);
  let b = state.projects.findIndex((x) => x.id === to);
  if (b < 0) b = state.projects.length; else if (after) b++;
  state.projects.splice(b, 0, it);
  persist(); renderProjects();
}

async function addProject(kind) {
  const dir = await window.lane.pickDir();
  if (!dir) return;
  const cx = kind === 'codex';
  let p = state.projects.find((x) => x.cwd === dir && !x.sessionId && (kindOf(x) === 'codex') === cx);
  if (!p) { p = { id: uid(), name: basename(dir), cwd: dir, ...(cx ? { kind: 'codex' } : {}) }; state.projects.push(p); await persist(); }
  showView('term');
  openSession(p.id, true);
}

async function removeProject(id) {
  const p = state.projects.find((x) => x.id === id);
  if (p?.hostId && p.hostId !== 'local') { await openRemoteSession(p); return; }
  if (p && kindOf(p) === 'codex' && p.sessionId) {
    if (terms.has(id)) { alert('请先结束该会话的终端，再操作归档。'); return; }
    if (!confirm(`${p.archived ? '恢复' : '归档'}「${p.name}」？这也会改变官方 Codex 的归档状态。`)) return;
    try {
      if (codexSyncPending) await codexSyncPending;
      await window.lane.archiveCodexSession({ sessionId: p.sessionId, archived: !p.archived });
      await refreshCodexSessions(true);
    } catch (e) { alert(String(e.message || e)); }
    return;
  }
  if (p && p.sessionId) {
    const r = await window.lane.removeSession({ kind: kindOf(p), sessionId: p.sessionId, cwd: p.cwd, name: p.name });
    if (r === 'cancel') return;
  }
  await closeSession(id);
  state.projects = state.projects.filter((p) => p.id !== id);
  await persist();
  renderProjects();
}

async function openRemoteSession(p) {
  const url = `codex://threads/${encodeURIComponent(p.sessionId)}?${new URLSearchParams({hostId:p.hostId})}`;
  try { await window.lane.openExternal(url); }
  catch (e) { alert('无法打开原桌面会话：' + String(e.message || e)); }
}

function makeTerm(id, kind) {
  const host = document.createElement('div');
  host.className = 'term-host';
  $(kind === 'codex' ? '#term-wrap-codex' : '#term-wrap').appendChild(host);
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', fontSize: 13, lineHeight: 1.2,
    cursorBlink: true, allowProposedApi: true, scrollback: 5000, macOptionIsMeta: true,
    theme: { background: '#0f1115', foreground: '#e6e8ee', cursor: '#3ddc97', selectionBackground: '#2b3a4a' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, url) => window.lane.openExternal(url)));
  term.open(host);
  term.onData((d) => window.lane.ptyWrite(id, d));
  // 粘贴/拖入文件：Finder 里复制的文件和拖进来的文件，输入真实路径；截图等纯图片存成临时文件再输入路径
  const quote = (f) => (/[\s'"()&;]/.test(f) ? `'${f.replace(/'/g, "'\\''")}'` : f);
  const typePaths = (paths) => paths.length && window.lane.ptyWrite(id, paths.map(quote).join(' ') + ' ');
  host.addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault(); e.stopPropagation();
    const paths = [];
    for (const f of files) {
      const real = window.lane.filePath(f);
      if (real) paths.push(real);
      else if (f.type.startsWith('image/')) paths.push(await window.lane.saveImage(new Uint8Array(await f.arrayBuffer()), f.type.split('/')[1].replace('jpeg', 'jpg')));
    }
    typePaths(paths);
  }, true);
  host.addEventListener('dragover', (e) => e.preventDefault());
  host.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    typePaths(files.map((f) => window.lane.filePath(f)).filter(Boolean));
  });
  term.onResize(({ cols, rows }) => window.lane.ptyResize(id, cols, rows));
  const rec = { term, fit, host, running: true, kind, followTail: true };
  // CLI 全屏重绘可能先发 CSI 3 J 清空 scrollback。阅读历史时保留历史，
  // 否则 xterm 的 viewportY/baseY 同时归零，onScroll 会错误地恢复跟随。
  // 其他擦屏指令仍交给 xterm；回到最新后 CSI 3 J 恢复原有语义。
  term.parser.registerCsiHandler({ final: 'J' }, params =>
    params.length === 1 && params[0] === 3 && !rec.followTail && term.buffer.active.type === 'normal');
  const latest = document.createElement('button');
  latest.className = 'term-latest';
  latest.textContent = '↓ 回到最新';
  latest.title = window.lane.platform === 'darwin' ? '回到底部（⌘ End）' : '回到底部（Ctrl End）';
  latest.hidden = true;
  latest.addEventListener('click', () => scrollToLatest(rec));
  host.appendChild(latest);
  rec.latest = latest;
  trackTerminalScroll(rec);
  term.attachCustomKeyEventHandler((e) => {
    const modifier = window.lane.platform === 'darwin' ? e.metaKey : e.ctrlKey;
    if (modifier && !e.altKey && !e.shiftKey && e.key === 'End') {
      if (e.type === 'keydown') { e.preventDefault(); scrollToLatest(rec); }
      return false;
    }
    return true;
  });
  terms.set(id, rec);
  return rec;
}

function trackTerminalScroll(rec) {
  const { term, host } = rec;
  const sync = () => {
    rec.followTail = term.buffer.active.viewportY >= term.buffer.active.baseY;
    updateLatestButton(rec);
  };
  term.onScroll(sync);
  // xterm 5.5 的原生 viewport 滚动使用 suppressScrollEvent=true，
  // 滚轮/触控板/拖滚动条不会触发公开 onScroll；监听实际 DOM 滚动。
  // 此监听在 term.open 后注册，xterm 已先同步 viewportY。
  const viewport = host.querySelector('.xterm-viewport');
  viewport.addEventListener('scroll', sync, { passive: true });
  // 在浏览器派发异步 scroll 事件前就暂停跟随，保护同一帧的清屏重绘。
  // 不拦截事件，保留 xterm 的滚轮、鼠标协议及备用屏幕行为。
  host.addEventListener('wheel', e => {
    if (e.deltaY < 0 && !e.shiftKey && term.buffer.active.type === 'normal' && term.buffer.active.baseY > 0) {
      rec.followTail = false;
    }
  }, { capture: true, passive: true });
}

function updateLatestButton(rec) {
  rec.latest.hidden = rec.term.buffer.active.viewportY >= rec.term.buffer.active.baseY;
}

function fitTerm(rec) {
  // display:none 的页面没有可用尺寸；不能向仍在运行的 CLI 发送 2×1 的尺寸。
  if (!rec.host.getClientRects().length || rec.host.clientWidth <= 0 || rec.host.clientHeight <= 0) return;
  const followTail = rec.followTail;
  const buffer = rec.term.buffer.active;
  // 宽度改变会重排历史行；用 marker 跟踪正在阅读的内容，不沿用旧行号。
  const anchor = !followTail && buffer.type === 'normal'
    ? rec.term.registerMarker(buffer.viewportY - buffer.baseY - buffer.cursorY) : null;
  try {
    rec.fit.fit();
    if (followTail) { rec.followTail = true; rec.term.scrollToBottom(); }
    else if (anchor && !anchor.isDisposed) { rec.term.scrollToLine(anchor.line); rec.followTail = false; }
  } finally { anchor?.dispose(); }
  updateLatestButton(rec);
}

function scrollToLatest(rec) {
  rec.followTail = true;
  fitTerm(rec);
  rec.term.scrollToBottom();
  updateLatestButton(rec);
  rec.term.focus();
}

async function openSession(id, autostart = false) {
  const p = state.projects.find((x) => x.id === id);
  if (!p) return;
  if (p.hostId && p.hostId !== 'local') { await openRemoteSession(p); return; }
  if (kindOf(p) === 'codex' && (p.archived || p.codexMissing) && !terms.has(id)) return;
  showView('term');
  let rec = terms.get(id);
  if (!rec) {
    rec = makeTerm(id, kindOf(p));
    activate(id);
    fitTerm(rec);
    let r;
    try {
      r = await window.lane.ptyCreate({ id, kind: kindOf(p), cwd: p.cwd, cols: rec.term.cols, rows: rec.term.rows, autostart: autostart || p.autostart !== false, resume: p.sessionId });
    } catch (error) {
      showTerminalExit(id, { message: '启动失败：' + error.message });
      return;
    }
    if (r.error) {
      showTerminalExit(id, { message: r.message || r.error });
      return;
    }
    if (r.existing && r.buffer) rec.term.write(r.buffer);
    rec.profile = r.profile;
  } else activate(id);
  renderProjects();
  saveOpen();
}

function activate(id) {
  const rec0 = terms.get(id);
  const kind = rec0?.kind || 'claude';
  activeId = id;
  // 打开就把“已完成”提示收掉
  if (rec0 && rec0.status === 'done') rec0.status = 'idle';
  paneActive[kind] = id;
  for (const [k, r] of terms) if (r.kind === kind) r.host.classList.toggle('active', k === id);
  requestAnimationFrame(() => {
    // 快速切换标签时，只处理仍然显示的会话。
    const rec = terms.get(id);
    if (!rec || paneActive[kind] !== id) return;
    fitTerm(rec);
    rec.term.focus();
  });
}

function fitActive() {
  for (const k of ['claude', 'codex']) {
    const r = terms.get(paneActive[k]);
    if (r) try { fitTerm(r); } catch { /* terminal disposed during layout */ }
  }
}

let fitFrame = null;
function scheduleFitActive() {
  if (fitFrame !== null) return;
  fitFrame = requestAnimationFrame(() => { fitFrame = null; fitActive(); });
}

async function closeSession(id) {
  const r = terms.get(id);
  if (!r || r.closing) return;
  r.closing = true;
  try { if (r.running) await window.lane.ptyKill(id); }
  catch (error) { r.closing = false; alert('结束会话失败：' + error.message); return; }
  if (terms.get(id) !== r) return;
  r.term.dispose(); r.host.remove(); terms.delete(id);
  if (paneActive[r.kind] === id) {
    paneActive[r.kind] = [...terms].filter(([, x]) => x.kind === r.kind).map(([k]) => k).pop() || null;
    if (paneActive[r.kind]) activate(paneActive[r.kind]);
  }
  if (activeId === id) activeId = paneActive.claude || paneActive.codex;
  renderProjects();
  saveOpen();
}

window.lane.onPtyData(({ id, data }) => {
  const rec = terms.get(id);
  if (rec) {
    // xterm 自身会跟随末尾，并在原生滚动时保留阅读位置。
    // 不在 write 回调中强制 scrollToBottom，避免抢在 DOM scroll 通知前跳底。
    rec.term.write(data, () => {
      if (terms.get(id) !== rec) return;
      updateLatestButton(rec);
    });
  }
});
window.lane.onPtyStatus(({ id, status }) => {
  const rec = terms.get(id);
  if (!rec) return;
  rec.status = status;
  if (status === 'done' && document.hasFocus() && id === paneActive[rec.kind]) rec.status = 'idle';
  renderProjects();
});
function showTerminalExit(id, { exitCode, signal, message }) {
  const r = terms.get(id);
  if (!r || r.status === 'exited') return;
  r.running = false;
  r.status = 'exited';
  r.exitSummary = message || `已退出（退出码 ${exitCode ?? '未知'}${signal ? '，信号 ' + signal : ''}）`;
  r.term.options.disableStdin = true;
  r.term.options.cursorBlink = false;
  r.term.write(`\r\n\x1b[90m[${r.exitSummary}。终端内容已保留；需要继续时点击“重新打开”。]\x1b[0m\r\n`);
  const bar = document.createElement('div');
  bar.className = 'terminal-ended';
  const label = document.createElement('span');
  label.textContent = r.exitSummary;
  const button = document.createElement('button');
  button.textContent = '重新打开';
  button.addEventListener('click', async () => {
    if (terms.get(id) !== r || r.reopening) return;
    r.reopening = true; button.disabled = true;
    await closeSession(id);
    await openSession(id);
  });
  bar.append(label, button); r.host.appendChild(bar);
  renderProjects();
  saveOpen();
}
window.lane.onPtyExit(({ id, ...result }) => showTerminalExit(id, result));
new ResizeObserver(scheduleFitActive).observe($('#term-wrap'));
new ResizeObserver(scheduleFitActive).observe($('#term-wrap-codex'));
addEventListener('resize', scheduleFitActive);
document.fonts?.ready.then(scheduleFitActive);
document.fonts?.addEventListener('loadingdone', scheduleFitActive);

$('#btn-add').addEventListener('click', () => addProject(currentKind));
$('#btn-add2').addEventListener('click', () => addProject('claude'));
$('#btn-import').addEventListener('click', importSessions);
$('#btn-cx-add').addEventListener('click', () => addProject('codex'));
$('#btn-cx-import').addEventListener('click', importCodexSessions);
$('#btn-cx-archived').addEventListener('click', () => {
  codexArchivedView = !codexArchivedView;
  $('#btn-cx-archived').textContent = codexArchivedView ? '返回未归档' : '查看已归档';
  renderProjects();
});

// Claude/Codex tab toggle
$$('.toggle-btn').forEach((b) => b.addEventListener('click', () => {
  currentKind = b.dataset.kind;
  $$('.toggle-btn').forEach((x) => x.classList.toggle('active', x.dataset.kind === currentKind));
  // 切换 codex-head 的显示
  const showCx = currentKind === 'codex';
  $('.codex-head').style.display = showCx ? 'flex' : 'none';
  $('#cx-sync-controls').style.display = showCx ? 'block' : 'none';
  if (showCx) refreshCodexSessions();
  renderProjects();
}));

// ---------- 链路诊断 ----------
async function runDiag() {
  $('#verdict').className = 'verdict'; $('#verdict').textContent = '正在检测…';
  $$('#segments li').forEach((li) => { li.className = 'pending'; li.querySelector('span').textContent = '检测中…'; });
  const r = await window.lane.runDiagnostics();
  lastDiag = r;
  for (const s of r.segments) {
    const li = document.querySelector(`#segments li[data-k="${s.key}"]`);
    li.className = s.ok ? 'ok' : (s.key === 'exit' ? 'warn' : 'bad');
    li.querySelector('span').textContent = s.title;
    li.title = s.detail || '';
  }
  $('#verdict').className = 'verdict ' + (r.verdict.ok ? 'ok' : 'bad');
  $('#verdict').innerHTML = `${esc(r.verdict.text)}<small>${esc(r.verdict.hint)}</small>`;
  $('#diag-json').textContent = JSON.stringify(r, null, 2);
}
$('#btn-diag').addEventListener('click', runDiag);
$('#btn-copy').addEventListener('click', () => navigator.clipboard.writeText($('#diag-json').textContent));

// ---------- 用量 ----------
async function loadUsage() {
  $('#usage-meta').textContent = '统计中…';
  const u = await window.lane.getUsage(30);
  const kpi = (k, v, s) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  $('#kpis').innerHTML =
    kpi('今天输出', fmt(u.today.output), `${u.today.messages} 次回复`) +
    kpi('今天输入（含缓存）', fmt(u.today.input + u.today.cacheRead + u.today.cacheWrite), `缓存读 ${fmt(u.today.cacheRead)}`) +
    kpi('近 7 天输出', fmt(u.last7.output), `${u.last7.messages} 次回复`) +
    kpi('近 30 天输出', fmt(u.last30.output), `${u.sessions} 个会话`);
  const max = Math.max(1, ...u.series.map((d) => d.output));
  $('#chart').innerHTML = u.series.map((d) =>
    `<div class="bar" title="${d.day}：输出 ${fmt(d.output)}，${d.messages} 次回复"><div style="height:${Math.round((d.output / max) * 100)}%"></div><span>${d.day.slice(5)}</span></div>`).join('');
  const rows = Object.entries(u.last30.models).sort((a, b) => b[1] - a[1]);
  $('#models').innerHTML = rows.length ? rows.map(([m, n]) => `<tr><td>${esc(m)}</td><td>${fmt(n)}</td></tr>`).join('') : '<tr><td class="muted">近 30 天没有记录</td><td></td></tr>';
  $('#usage-meta').textContent = `扫描 ${u.scannedFiles} 个日志 · ${new Date(u.generatedAt).toLocaleTimeString()}`;
  loadTeam();
}

async function loadTeam() {
  const card = $('#team-card');
  const me = await window.lane.teamMe().catch(() => null);
  if (!me) { card.hidden = true; return; }
  card.hidden = false;
  const lim = me.monthlyLimit;
  const pct = lim ? Math.min(100, (me.monthUsed / lim) * 100) : 0;
  card.innerHTML = `<div class="row"><b>团队配额 · ${esc(me.profile)}</b><span class="muted">${esc(me.name)}</span></div>
    ${lim ? `<div class="meter"><div class="${pct >= 100 ? 'full' : pct >= 80 ? 'hot' : ''}" style="width:${pct.toFixed(1)}%"></div></div>` : ''}
    <div class="row muted"><span>本月已用 ${fmt(me.monthUsed)}${lim ? ' / ' + fmt(lim) + ' tokens' : ' tokens（不限额）'}</span><span>网关记录：今天 ${me.today.requests} 次，近 7 天 ${me.last7.requests} 次</span></div>`;
}
$('#btn-usage').addEventListener('click', loadUsage);

// 自测钩子：直接用某个目录开会话（不弹选择框）
window.__laneTestProfile = async (p) => { const s = await window.lane.saveProfile(p); await window.lane.activateProfile(s.id); await loadProfiles(); await runDiag(); };
window.__laneTestOpen = async (dir) => {
  let p = state.projects.find((x) => x.cwd === dir);
  if (!p) { p = { id: uid(), name: basename(dir), cwd: dir }; state.projects.push(p); }
  showView('term'); openSession(p.id, false);
};

// ---------- 接入配置 ----------
let profileData = { active: 'official', items: [] };
async function loadProfiles() {
  profileData = await window.lane.listProfiles();
  const act = profileData.items.find((p) => p.id === profileData.active) || profileData.items[0];
  $('#profile-name').textContent = act.name;
  const ul = $('#profiles');
  ul.innerHTML = '';
  for (const p of profileData.items) {
    const li = document.createElement('li');
    li.className = p.id === profileData.active ? 'active' : '';
    const sub = p.type === 'official' ? '使用 Claude Code 自己的登录（订阅或 API Key）' : esc(p.baseUrl);
    li.innerHTML = `<span class="radio"></span><div class="info"><div>${esc(p.name)}<span class="tag">${p.type === 'official' ? '官方' : '网关'}</span></div><small>${sub}</small></div>
      <div class="acts">${p.id === profileData.active ? '<span class="muted small">当前</span>' : '<button class="ghost small" data-a="use">设为当前</button>'}
      ${p.type === 'gateway' ? '<button class="ghost small" data-a="test">测试</button><button class="ghost small" data-a="edit">编辑</button><button class="ghost small" data-a="del">删除</button>' : ''}</div>`;
    li.addEventListener('click', async (e) => {
      const a = e.target.dataset.a;
      if (a === 'use') { await window.lane.activateProfile(p.id); await loadProfiles(); runDiag(); }
      else if (a === 'edit') editProfile(p);
      else if (a === 'del') { if (confirm(`删除「${p.name}」？`)) { await window.lane.removeProfile(p.id); await loadProfiles(); runDiag(); } }
      else if (a === 'test') { e.target.textContent = '测试中…'; const r = await window.lane.testProfile({ id: p.id }); e.target.textContent = testText(r).replace(/^(.{0,18}).*$/, '$1'); e.target.title = testText(r); }
    });
    ul.appendChild(li);
  }
}
function testText(r) {
  if (!r.reachable) return `✕ 不可达：${r.error}`;
  const kind = r.kind === 'lane' ? `Lane 网关 ${r.version || ''}` : '兼容接口';
  return `${r.auth.ok ? '✓' : '✕'} ${kind} · ${r.ms} ms · ${r.auth.title}${r.auth.ok ? '' : '（' + r.auth.detail + '）'}`;
}
function editProfile(p) {
  $('#pf-id').value = p ? p.id : '';
  $('#pf-name').value = p ? p.name : '';
  $('#pf-url').value = p ? p.baseUrl : '';
  $('#pf-token').value = '';
  $('#pf-token').placeholder = p ? '留空则保留原令牌' : '管理员发给你的成员令牌';
  $('#pform-title').textContent = p ? `编辑「${p.name}」` : '添加团队网关';
  $('#pf-cancel').hidden = !p;
  setMsg('');
}
function setMsg(t, ok) { const m = $('#pf-msg'); m.textContent = t; m.className = 'form-msg ' + (ok === true ? 'ok' : ok === false ? 'bad' : ''); }
$('#pf-cancel').addEventListener('click', () => editProfile(null));
$('#pf-test').addEventListener('click', async () => {
  const id = $('#pf-id').value, token = $('#pf-token').value.trim();
  setMsg('测试中…');
  const r = await window.lane.testProfile(token || !id ? { name: $('#pf-name').value, baseUrl: $('#pf-url').value.trim(), token } : { id });
  setMsg(testText(r), r.reachable && r.auth && r.auth.ok);
});
$('#pform').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const saved = await window.lane.saveProfile({ id: $('#pf-id').value || undefined, name: $('#pf-name').value, baseUrl: $('#pf-url').value, token: $('#pf-token').value });
    editProfile(null); setMsg(`已保存「${saved.name}」`, true);
    await loadProfiles();
  } catch (err) { setMsg(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), false); }
});
$('#profile-chip').addEventListener('click', () => showView('access'));

// ---------- 启动 ----------
(async () => {
  state = await window.lane.getState();
  state.projects ||= [];
  codexReady = true;
  await refreshCodexSessions();
  applySplit(state.splitRows);
  // 初始化 codex-head 隐藏
  $('.codex-head').style.display = 'none';
  renderProjects();
  restoring = true;

  // Only an explicit restore accepts starting saved sessions; cancel starts none.
  const lastOpenIds = state.openIds || [state.activeId, state.activeCx].filter(Boolean);
  const currentlyOpenProjects = state.projects.filter((p) => lastOpenIds.includes(p.id));
  const savedActive = [state.activeId, state.activeCx];
  if (currentlyOpenProjects.length > 0 && terms.size === 0) {
    const confirmed = confirm(`检测到上次有 ${currentlyOpenProjects.length} 个会话正在运行，是否恢复？\n\n点"确定"恢复，"取消"重新选择。`);
    if (confirmed) {
      for (const p of currentlyOpenProjects) {
        await openSession(p.id, false);
      }
    }
  }
  for (const id of savedActive) if (terms.has(id)) activate(id);
  restoring = false;
  saveOpen();
  await loadProfiles();
  runDiag();
  setInterval(runDiag, 5 * 60 * 1000);
})();

// 定期同步 Claude Code 里 /rename 的会话名
async function refreshTitles() {
  try {
    const bindings = await window.lane.sessionBindings();
    let changed = false;
    for (const binding of bindings) {
      const p = state.projects.find(p => p.id === binding.id && kindOf(p) === 'claude');
      if (!p) continue;
      if (p.sessionId !== binding.sessionId) { p.sessionId = binding.sessionId; changed = true; }
      if (binding.title && p.name !== binding.title) { p.name = binding.title; changed = true; }
    }
    if (changed) { await persist(); renderProjects(); renderTabs(); }
    const t = await window.lane.sessionTitles(state.projects.map((p) => p.cwd));
    if (JSON.stringify(t) !== JSON.stringify(titles)) { titles = t; renderProjects(); }
  } catch (error) { console.error('Claude 会话同步失败：', error); }
}
setInterval(refreshTitles, 15000);
setTimeout(refreshTitles, 500);

// 导入 Claude Code 已有会话：每个会话一项，点开即 claude --resume
async function importSessions() {
  const list = await window.lane.listSessions();
  const have = new Set(state.projects.map((p) => p.sessionId).filter(Boolean));
  let n = 0;
  for (const s of list) {
    if (have.has(s.sessionId)) continue;

    state.projects.push({ id: uid(), name: s.title || s.first || basename(s.cwd), cwd: s.cwd, sessionId: s.sessionId });
    n++;
  }
  await persist(); renderProjects();
  alert(n ? `已导入 ${n} 个会话（共 ${list.length} 个）` : '没有新会话可导入');
}

// Poll official metadata without touching terminal ownership, buffers, or open IDs.
async function refreshCodexSessions(manual = false) {
  if (!codexReady) return;
  if (codexSyncPending) return codexSyncPending;
  codexSyncPending = (async () => {
    const status = $('#cx-sync-status');
    try {
      const response = await window.lane.listCodexSessions();
      const list = Array.isArray(response) ? response : response.sessions;
      const warnings = Array.isArray(response) ? [] : response.warnings || [];
      const next = window.codexSync.reconcile(state.projects, list, uid);
      if (JSON.stringify(next) !== JSON.stringify(state.projects)) {
        state.projects = next;
        await persist(); renderProjects();
      }
      status.textContent = (warnings.length ? ' · 远端部分未同步 ' : ' · 已同步 ') + new Date().toLocaleTimeString();
      status.title = warnings.length ? warnings.join('\n') : '本机每 15 秒、远端置顶每 60 秒读取官方数据；远端点击打开原桌面会话。';
      if (manual && warnings.length) alert(status.title);
      return true;
    } catch (e) {
      status.textContent = ' · 同步失败';
      status.title = String(e.message || e);
      if (manual) alert(status.title);
      return false;
    }
  })();
  try { return await codexSyncPending; } finally { codexSyncPending = null; }
}
async function importCodexSessions() { await refreshCodexSessions(true); }
setInterval(refreshCodexSessions, 15000);
addEventListener('focus', () => refreshCodexSessions());

// Claude 上、Codex 下；高度比例独立保存。
function applySplit(f) {
  const ratio = typeof f === 'number' && Number.isFinite(f) ? Math.min(0.85, Math.max(0.15, f)) : 0.5;
  $('.split').style.setProperty('--top', `${ratio}fr`);
  $('.split').style.setProperty('--bottom', `${1 - ratio}fr`);
  scheduleFitActive();
}
$('#splitter').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const sp = e.currentTarget, r = $('.split').getBoundingClientRect();
  sp.classList.add('dragging'); document.body.classList.add('resizing');
  const move = (ev) => { state.splitRows = Math.min(0.85, Math.max(0.15, (ev.clientY - r.top) / (r.height - 6))); applySplit(state.splitRows); };
  const up = () => { sp.classList.remove('dragging'); document.body.classList.remove('resizing'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); removeEventListener('blur', up); scheduleFitActive(); persist(); };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
  addEventListener('blur', up, { once: true });
});
$('#splitter').addEventListener('dblclick', () => { state.splitRows = null; applySplit(null); persist(); });
