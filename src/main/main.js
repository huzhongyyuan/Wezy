const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const diagnostics = require('./diagnostics');
const usage = require('./usage');
const profiles = require('./profiles');
const codexSessions = require('./codex-sessions');

// 测试或多开时可用 LANE_USERDATA 指定独立数据目录
if (process.env.LANE_USERDATA) app.setPath('userData', process.env.LANE_USERDATA);
else app.setPath('userData', app.getPath('userData')); // 先固定数据目录，再改显示名，避免丢失已保存的会话
app.setName('Wezy');

let win;
const ptys = new Map(); // id -> { proc, cwd, buffer }
let quitting = false;
const lifecycle = require('./lifecycle')(app.getPath('userData'));
const storeFile = () => path.join(app.getPath('userData'), 'lane-state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(storeFile(), 'utf8')); } catch { return { projects: [] }; }
}
function saveState(s) {
  try { fs.mkdirSync(path.dirname(storeFile()), { recursive: true }); fs.writeFileSync(storeFile(), JSON.stringify(s, null, 2)); } catch (e) { console.error(e); }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 560,
    backgroundColor: '#0f1115', show: !process.env.LANE_SNAPSHOT,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.webContents.on('render-process-gone', (_e, d) => lifecycle('renderer-exit', { reason: d.reason, exitCode: d.exitCode }));
  win.on('close', e => {
    // The red window button on macOS must not terminate live terminals.
    if (process.platform === 'darwin' && !quitting && ptys.size) {
      e.preventDefault(); win.hide();
      lifecycle('window-hidden', { liveTerminals: ptys.size });
    }
  });
  win.on('closed', () => { lifecycle('window-closed'); win = null; });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // 自测用：LANE_SNAPSHOT=<png路径> 时，加载后截一张窗口图再退出；LANE_VIEW 指定要截的视图
  if (process.env.LANE_SNAPSHOT) {
    win.webContents.once('did-finish-load', async () => {
      if (process.env.LANE_VIEW) await win.webContents.executeJavaScript(`document.querySelector('[data-view="${process.env.LANE_VIEW}"]').click()`);
      if (process.env.LANE_PROFILE) await win.webContents.executeJavaScript(`window.__laneTestProfile(${process.env.LANE_PROFILE})`);
      if (process.env.LANE_VIEW2) await win.webContents.executeJavaScript(`document.querySelector('[data-view="${process.env.LANE_VIEW2}"]').click()`);
      if (process.env.LANE_OPEN) await win.webContents.executeJavaScript(`window.__laneTestOpen && window.__laneTestOpen(${JSON.stringify(process.env.LANE_OPEN)})`);
      if (process.env.LANE_TYPE) setTimeout(() => { for (const { proc } of ptys.values()) proc.write(process.env.LANE_TYPE + '\r'); }, Number(process.env.LANE_TYPE_AT || 8000));
      // LANE_FAKE_BUSY：往第一个 pty 直接喂“忙碌→完成”的字节流，验证状态提示，无需等真实对话跑完
      if (process.env.LANE_FAKE_BUSY) {
        const at = Number(process.env.LANE_FAKE_AT || 4000);
        setTimeout(() => {
          const first = [...ptys.entries()][0];
          if (!first) return console.error('LANE_FAKE_BUSY: 没有 pty');
          const [pid, entry] = first;
          onPtyData(entry, pid, '\x1b[2K\r✳ Working (5s · esc to interrupt)');
        }, at);
        setTimeout(() => {
          const first = [...ptys.entries()][0];
          if (!first) return;
          const [pid, entry] = first;
          onPtyData(entry, pid, '\x1b[2K\r\x1b[1A\x1b[2K\r● 好的\r\n\x1b[2K\r> ');
        }, at + Number(process.env.LANE_FAKE_DONE_MS || 6000));
      }
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.LANE_SNAPSHOT, img.toPNG());
        } catch (e) { console.error('snapshot failed:', e.message); }
        app.exit(0);
      }, Number(process.env.LANE_WAIT || 9000));
    });
  }
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// 去掉从父进程继承的 Claude Code 会话标记，避免终端里的 claude 被当成子会话
let sysProxyCache;
function systemProxy() {
  if (sysProxyCache !== undefined) return sysProxyCache;
  try {
    const out = require('child_process').execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 2000 });
    const g = (k) => (out.match(new RegExp('^\\s*' + k + ' : (.+)$', 'm')) || [])[1];
    sysProxyCache = g('HTTPSEnable') === '1' && g('HTTPSProxy') ? `http://${g('HTTPSProxy')}:${g('HTTPSPort')}` : null;
  } catch { sysProxyCache = null; }
  return sysProxyCache;
}
function cleanEnv() {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANE: '1' };
  // 工作台内是真实彩色终端，不继承自动化启动器用于纯文本日志的 NO_COLOR。
  delete env.NO_COLOR;
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  // 从 Dock/Finder 启动时没有终端的代理变量；没设置就沿用 macOS 系统代理（Clash 等），否则直连会被拦
  if (process.platform === 'darwin' && !env.HTTPS_PROXY && !env.https_proxy) {
    const sp = systemProxy();
    if (sp) { env.HTTPS_PROXY = env.HTTP_PROXY = env.https_proxy = env.http_proxy = sp; env.NO_PROXY = env.no_proxy = 'localhost,127.0.0.1,::1'; }
  }
  return env;
}

function send(ch, payload) { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); }

const BUSY_RE = /esc to interrupt|Working \(|Thinking[.\u2026]|\(\d+s \u00b7|tokens \u00b7/i;
// 去掉终端转义序列，只留下能读的文字，用来判断状态
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;       // 标题等 OSC，整段丢掉
const CSI_RE = /\x1b\[([0-9;?]*)([a-zA-Z])/g;
const stripAnsi = (t) => t.replace(ANSI_RE, '').replace(/\r/g, '\n');

// 只维护“当前屏幕可见内容”的极简模型：Claude/Codex 的进度行是原地重绘的，
// 若把 ANSI 一剥了事，旧的 "Working (3s)" 会一直留在尾部缓冲里，任务结束后状态退不出来。
const SCREEN_ROWS = 200;
function feedScreen(rows, data) {
  const text = String(data).replace(OSC_RE, '');
  let i = 0, row = rows.cursorRow ?? rows.length - 1, col = rows.cursorCol ?? 0;
  const put = (ch) => {
    while (row >= rows.length) rows.push('');
    const line = rows[row];
    rows[row] = (line.length >= col ? line.slice(0, col) : line + ' '.repeat(col - line.length)) + ch;
    col += 1;
  };
  const eraseLine = (mode) => {
    while (row >= rows.length) rows.push('');
    const line = rows[row];
    if (mode === 2) rows[row] = '';
    else if (mode === 1) rows[row] = ' '.repeat(Math.min(col, line.length)) + line.slice(col);
    else rows[row] = line.slice(0, col);
  };
  const at = (n) => { row = Math.max(0, Math.min(rows.length, n - 1)); col = 0; };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\x1b') {
      CSI_RE.lastIndex = i;
      const m = CSI_RE.exec(text);
      if (m && m.index === i) {
        const p = m[1] || '', op = m[2];
        if (op === 'K') eraseLine(Number(p) || 0);
        else if (op === 'J') { if ((Number(p) || 0) >= 1) { eraseLine(0); for (let r = row + 1; r < rows.length; r++) rows[r] = ''; } }
        else if (op === 'A') row = Math.max(0, row - (Number(p) || 1));
        else if (op === 'B') row = Math.min(SCREEN_ROWS - 1, row + (Number(p) || 1));
        else if (op === 'H' || op === 'f') { const parts = p.split(';'); row = Math.max(0, (Number(parts[0]) || 1) - 1); col = Math.max(0, (Number(parts[1]) || 1) - 1); }
        else if (op === 'G') col = Math.max(0, (Number(p) || 1) - 1);
        else if (op === 'C') col += (Number(p) || 1);
        else if (op === 'D') col = Math.max(0, col - (Number(p) || 1));
        i = CSI_RE.lastIndex;
        continue;
      }
      const rest = text.slice(i);
      const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(rest);
      if (osc) { i += osc[0].length; continue; }
      const sk = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(rest);
      if (sk) { i += sk[0].length; continue; }
      i += rest[1] === '[' || rest[1] === ']' || rest[1] === '(' || rest[1] === ')' ? 2 : 1;
      continue;
    }
    if (ch === '\r') { col = 0; i += 1; continue; }
    if (ch === '\n') { row = Math.min(SCREEN_ROWS - 1, row + 1); if (row === SCREEN_ROWS - 1) { rows.shift(); row = SCREEN_ROWS - 1; } col = 0; i += 1; continue; }
    if (ch === '\b') { col = Math.max(0, col - 1); i += 1; continue; }
    if (ch === '\x07') { i += 1; continue; }
    if (ch === '\t') { col = (Math.floor(col / 8) + 1) * 8; i += 1; continue; }
    if (ch < ' ') { i += 1; continue; }
    put(ch); i += 1;
  }
  rows.cursorRow = row; rows.cursorCol = col;
  return rows;
}
const tailText = (rows) => rows.slice(-25).join('\n');
const makeScreen = () => { const r = ['']; r.cursorRow = 0; r.cursorCol = 0; return r; };
function setStatus(entry, id, st) {
  if (entry.status === st) return;
  entry.status = st;
  send('pty:status', { id, status: st });
}
// 终端输出 → 状态。抽成函数便于自测直接喂字节流，不必真等一次对话跑完。
// 只有真的出现“忙碌中”提示才算开始干活：Claude 是 esc to interrupt，Codex 是 Working / Thinking。
// 注意不能把 “Esc to cancel”（信任目录等确认框）算进来，否则一启动就会被误判成在运行。
function onPtyData(entry, id, d) {
  entry.buffer = (entry.buffer + d).slice(-200000);
  send('pty:data', { id, data: d });
  entry.tail = tailText(feedScreen(entry.screen, d));
  clearTimeout(entry.timer);
  // 只有出现明确的工作提示才算运行中
  if (BUSY_RE.test(entry.tail)) { entry.sawBusy = true; setStatus(entry, id, 'running'); }
  // 延长等待时间到 10 秒，减少误判；同时只在看到过工作提示后才判断为完成
  entry.timer = setTimeout(() => {
    if (BUSY_RE.test(entry.tail)) { entry.sawBusy = true; return setStatus(entry, id, 'running'); }
    // 只有之前看到过工作提示且现在安静了才标记为完成，否则保持 idle
    if (entry.sawBusy) { entry.sawBusy = false; return setStatus(entry, id, 'done'); }
    // 没干过活，保持 idle（不主动显示已完成）
    setStatus(entry, id, 'idle');
  }, 10000);
}

ipcMain.handle('state:get', () => loadState());
ipcMain.handle('state:set', (_e, s) => { saveState(s); return true; });

ipcMain.handle('dialog:pickDir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// Reuse the installed Codex CLI and its user-selected provider, model and permissions.
function codexBin() {
  for (const c of ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex']) if (fs.existsSync(c)) return c;
  return 'codex';
}
function codexLaunch(env, resume) {
  // Use the same provider, credentials and model defaults as local Codex.
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  let cmd = q(codexBin());
  if (resume) cmd += ' resume ' + q(resume);
  return { cmd, profile: { id: 'local', name: '本机 Codex' } };
}

ipcMain.handle('pty:create', (_e, { id, cwd, cols, rows, autostart, resume, kind }) => {
  if (ptys.has(id)) return { id, existing: true, buffer: ptys.get(id).buffer, profile: ptys.get(id).profile };
  const shellPath = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh');
  const args = process.platform === 'win32' ? [] : ['-l'];
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  // 会话按创建时的接入配置启动；之后切换配置只影响新会话
  const prof = kind === 'codex' ? { type: 'codex' } : profiles.active();
  const env = cleanEnv();
  let launch = 'claude';
  let cx = null;

  if (kind === 'codex') {
    cx = codexLaunch(env, /^[\w-]+$/.test(resume || '') ? resume : null);
    launch = cx.cmd;
  } else if (prof.type === 'gateway') {
    env.ANTHROPIC_BASE_URL = prof.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = prof.token;
    delete env.ANTHROPIC_API_KEY;
    // 用户的 ~/.claude/settings.json 里的 env 优先级高于进程环境，所以再用 --settings 覆盖一次
    launch = `claude --settings '${profiles.writeSettings(prof).replace(/'/g, "'\\''")}'`;
  }
  // 导入的会话：直接以 claude --resume 作为进程启动，不经过 shell 提示符
  const direct = resume && /^[\w-]+$/.test(resume) && process.platform !== 'win32';
  if (direct && !cx) launch += ` --resume ${resume}`;
  const proc = pty.spawn(shellPath, direct ? ['-l', '-c', 'exec ' + launch] : args, { name: 'xterm-256color', cols: cols || 100, rows: rows || 30, cwd: dir, env });
  const entry = { proc, kind: kind || 'claude', cwd: dir, buffer: '', tail: '', screen: makeScreen(), status: 'idle', sawBusy: false, profile: cx ? cx.profile : { id: prof.id, name: prof.name } };
  ptys.set(id, entry);
  lifecycle('pty-start', { id, kind: kind || 'claude', pid: proc.pid, resumed: !!direct });
  proc.onData((d) => { if (ptys.get(id) === entry) onPtyData(entry, id, d); });
  proc.onExit(({ exitCode, signal }) => {
    clearTimeout(entry.timer); clearTimeout(entry.launchTimer);
    const reason = entry.closeReason || 'process-exit';
    lifecycle('pty-exit', { id, pid: proc.pid, exitCode, signal, reason });
    // An old process may exit after an explicitly reopened terminal already exists.
    if (ptys.get(id) !== entry) return;
    ptys.delete(id);
    send('pty:exit', { id, exitCode, signal, reason });
  });
  if (autostart && !direct) entry.launchTimer = setTimeout(() => { if (ptys.get(id) === entry) proc.write(launch + '\r'); }, 400);
  return { id, existing: false, cwd: dir, profile: entry.profile };
});
ipcMain.on('pty:write', (_e, { id, data }) => { const p = ptys.get(id); if (p) p.proc.write(data); });
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => { const p = ptys.get(id); if (p && cols > 0 && rows > 0) try { p.proc.resize(cols, rows); } catch { /* ignore */ } });
ipcMain.handle('pty:kill', (_e, { id }) => {
  const p = ptys.get(id);
  if (p) {
    p.closeReason = 'user-close';
    lifecycle('pty-close-request', { id, pid: p.proc.pid, reason: p.closeReason });
    clearTimeout(p.timer); clearTimeout(p.launchTimer);
    ptys.delete(id); p.proc.kill();
  }
  return true;
});
ipcMain.handle('pty:list', () => [...ptys.keys()]);
ipcMain.handle('pty:statuses', () => Object.fromEntries([...ptys].map(([id, e]) => [id, e.status])));

// Bind the actual Claude process to its terminal; a directory or latest file
// cannot identify a conversation when several sessions share that directory.
function matchClaudeBindings(entries, registry, parents) {
  const out = [];
  for (const [id, entry] of entries) {
    if (entry.kind === 'codex') continue;
    const matches = [];
    for (const row of registry) {
      if (row.cwd !== entry.cwd || !/^[0-9a-f-]{36}$/i.test(row.sessionId || '')) continue;
      let pid = row.pid, depth = 0;
      const seen = new Set();
      while (parents.has(pid) && !seen.has(pid)) {
        if (pid === entry.proc.pid) { matches.push({ row, depth }); break; }
        seen.add(pid); pid = parents.get(pid); depth++;
      }
    }
    matches.sort((a, b) => a.depth - b.depth);
    if (!matches.length) continue;
    if (matches[1]?.depth === matches[0].depth) throw Error('无法唯一识别 Claude 会话：' + id);
    const row = matches[0].row;
    out.push({ id, sessionId: row.sessionId, title: row.name || null });
  }
  return out;
}
ipcMain.handle('sessions:bindings', async () => {
  const root = path.join(os.homedir(), '.claude', 'sessions');
  let files;
  try { files = await fs.promises.readdir(root); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const registry = [];
  for (const name of files.filter(f => /^\d+\.json$/.test(f))) {
    try {
      const row = JSON.parse(await fs.promises.readFile(path.join(root, name), 'utf8'));
      if (row.pid === Number(name.slice(0, -5))) registry.push(row);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const output = await new Promise((resolve, reject) => require('child_process').execFile(
    '/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 3000 },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
  const parents = new Map(output.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)));
  return matchClaudeBindings(ptys, registry, parents);
});

ipcMain.handle('diag:run', () => diagnostics.run(profiles.active()));
ipcMain.handle('profiles:list', () => profiles.list());
ipcMain.handle('profiles:save', (_e, p) => profiles.upsert(p));
ipcMain.handle('profiles:remove', (_e, id) => profiles.remove(id));
ipcMain.handle('profiles:activate', (_e, id) => profiles.activate(id));
ipcMain.handle('profiles:test', async (_e, p) => {
  // p 可以是已保存的 id，也可以是表单里还没保存的 {baseUrl, token}
  const full = p.id && !p.token ? profiles.get(p.id) : { name: p.name || '', baseUrl: String(p.baseUrl || '').replace(/\/+$/, ''), token: p.token };
  if (!full || !full.baseUrl) return { reachable: false, error: '缺少网关地址' };
  return profiles.probe(full);
});
ipcMain.handle('profiles:me', async () => {
  const p = profiles.active();
  if (p.type !== 'gateway') return null;
  const r = await profiles.probe(p);
  return r.me ? { ...r.me, profile: p.name } : null;
});
// 读取 Claude Code 里 /rename 设置的会话名：取该目录最近一次 custom-title
const titleCache = new Map(); // 文件路径 -> { sig, title }，文件没变就不重读
function fileTitle(fp) {
  let st; try { st = fs.statSync(fp); } catch { return null; }
  const sig = st.mtimeMs + ':' + st.size;
  const c = titleCache.get(fp);
  if (c && c.sig === sig) return c.title;
  let title = null;
  try {
    const txt = fs.readFileSync(fp, 'utf8');
    const all = [...txt.matchAll(/"type":"custom-title","customTitle":"((?:[^"\\]|\\.)*)"/g)];
    if (all.length) { try { title = JSON.parse('"' + all[all.length - 1][1] + '"'); } catch { title = all[all.length - 1][1]; } }
  } catch { /* ignore */ }
  titleCache.set(fp, { sig, title });
  return title;
}
function sessionTitle(cwd) {
  const dir = path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 20); } catch { return null; }
  for (const { f } of files) { const t = fileTitle(path.join(dir, f)); if (t) return t; }
  return null;
}
// 扫描 ~/.claude/projects 下的全部 Claude Code 会话，供“导入会话”使用
function listSessions() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const out = [];
  let dirs = []; try { dirs = fs.readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    let files = []; try { files = fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const fp = path.join(root, d, f);
      let txt; try { txt = fs.readFileSync(fp, 'utf8'); } catch { continue; }
      let cwd = null, title = null, first = null;
      for (const line of txt.split('\n')) {
        if (!line) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (!cwd && o.cwd) cwd = o.cwd;
        if (o.type === 'custom-title' && o.customTitle) title = o.customTitle;
        if (!first && o.type === 'user' && !o.isMeta) {
          const c = o.message?.content;
          const s = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((x) => x.type === 'text')?.text || '') : '';
          if (s && !s.startsWith('<')) first = s.replace(/\s+/g, ' ').slice(0, 40);
        }
      }
      if (!cwd || cwd.includes('/scratchpad')) continue;
      out.push({ sessionId: f.slice(0, -6), cwd, title, first, mtime: fs.statSync(fp).mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
// 粘贴的图片存成临时文件，把路径交给 Claude Code（它会把图片路径当作图片附件）
ipcMain.handle('clip:saveImage', (_e, { data, ext }) => {
  const dir = path.join(os.tmpdir(), 'lane-paste');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `paste-${Date.now()}.${/^[a-z0-9]{2,5}$/.test(ext) ? ext : 'png'}`);
  fs.writeFileSync(f, Buffer.from(data));
  return f;
});
ipcMain.handle('sessions:list', () => listSessions());
// 删除会话：可以只从列表移除，也可以删除会话本身（Claude 移到废纸篓，Codex 归档，都能找回）
ipcMain.handle('session:remove', async (_e, { kind, sessionId, cwd, name }) => {
  if (!sessionId) return 'hide';
  if (kind === 'codex') return 'cancel'; // Codex uses its native archive controls.
  const r = await dialog.showMessageBox(win, {
    type: 'question', message: `移除「${name || sessionId}」`,
    detail: '“删除会话”会把会话记录文件移到废纸篓，可从废纸篓恢复。',
    buttons: ['仅从列表移除', '删除会话', '取消'], defaultId: 0, cancelId: 2,
  });
  if (r.response === 2) return 'cancel';
  if (r.response === 0) return 'hide';
  if (!/^[\w-]+$/.test(sessionId)) return 'hide';
  try {
    await shell.trashItem(path.join(os.homedir(), '.claude', 'projects', String(cwd).replace(/[^a-zA-Z0-9]/g, '-'), sessionId + '.jsonl'));
    return 'deleted';
  } catch (e) {
    await dialog.showMessageBox(win, { type: 'error', message: '删除失败，已只从列表移除', detail: String(e.message || e).slice(0, 500) });
    return 'hide';
  }
});
// Shared official metadata; failed reads reject instead of masquerading as an empty list.
ipcMain.handle('codex:sessions', () => require('./codex-remote').listSessions());
ipcMain.handle('codex:archive', async (_e, { sessionId, archived }) => {
  const opened = loadState().projects?.some(p => p.kind === 'codex' && p.sessionId === sessionId && ptys.has(p.id));
  if (opened) throw new Error('请先结束 Wezy 中该会话的终端，再操作归档。');
  await codexSessions.setArchived(codexBin(), cleanEnv(), sessionId, archived);
  return true;
});
ipcMain.handle('sessions:titles', (_e, cwds) => Object.fromEntries([...new Set(cwds || [])].map((c) => [c, sessionTitle(c)])));
ipcMain.handle('usage:get', (_e, days) => usage.summary(days || 30));
ipcMain.handle('shell:open', (_e, p) => shell.openPath(p));
ipcMain.handle('shell:openExternal', (_e, u) => shell.openExternal(u));

app.whenReady().then(() => {
  lifecycle('app-start', { pid: process.pid });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else { win.show(); win.focus(); } });
});
app.on('before-quit', () => { quitting = true; lifecycle('app-quit-request', { liveTerminals: ptys.size }); });
app.on('window-all-closed', () => {
  for (const [id, entry] of ptys) {
    entry.closeReason = quitting ? 'app-quit' : 'window-closed';
    lifecycle('pty-close-request', { id, pid: entry.proc.pid, reason: entry.closeReason });
    clearTimeout(entry.timer); clearTimeout(entry.launchTimer);
    try { entry.proc.kill(); } catch (error) { lifecycle('pty-close-error', { id, message: error.message }); }
  }
  if (process.platform !== 'darwin') app.quit();
});
