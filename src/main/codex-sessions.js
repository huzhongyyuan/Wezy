const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { execFile, spawn } = require('child_process');

const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
// Codex's built-in Pinned section ID; names are editable and not identities.
const PINNED_SECTION_ID = '01984de2-8f74-7c91-a3b2-5c5e937cf318';

function readRows(home, sql) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/sqlite3', ['-readonly', '-cmd', '.timeout 2000', '-json', path.join(home, 'state_5.sqlite'), sql],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 64 << 20 }, (err, out) => {
        if (err) return reject(new Error('无法读取官方 Codex 会话，已保留上次列表。'));
        try { resolve(JSON.parse(out || '[]')); }
        catch { reject(new Error('官方 Codex 会话数据格式异常，已保留上次列表。')); }
      });
  });
}

// Metadata only. Never repair or rewrite the official database or rollout files.
async function desktopPinOrder(home) {
  let raw;
  try { raw = await fs.readFile(path.join(home, '.codex-global-state.json'), 'utf8'); }
  catch (error) {
    // CLI-only homes have no desktop ordering preferences.
    if (error.code === 'ENOENT') return new Map();
    throw new Error('无法读取桌面版置顶顺序，已保留上次列表。');
  }
  let state;
  try { state = JSON.parse(raw); }
  catch { throw new Error('桌面版置顶顺序数据格式异常，已保留上次列表。'); }
  const atoms = state?.['electron-persisted-atom-state'];
  const unified = atoms?.['unified-sidebar-pinned-order-v1'];
  const legacy = atoms?.['app-server-pinned-thread-order-v1'];
  const order = unified === undefined ? legacy : unified;
  if (order === undefined) return new Map();
  if (!Array.isArray(order) || order.some(id => typeof id !== 'string')) {
    throw new Error('桌面版置顶顺序数据格式异常，已保留上次列表。');
  }
  const ranks = new Map();
  const prefix = 'codex:thread:local:';
  for (const item of order) {
    // The unified list also contains remote threads and ChatGPT conversations.
    if (unified !== undefined && !item.startsWith(prefix)) continue;
    const id = unified === undefined ? item : item.slice(prefix.length);
    if (id && !ranks.has(id)) ranks.set(id, ranks.size);
  }
  return ranks;
}

async function listSessions(home = codexHome()) {
  const columns = new Set((await readRows(home, 'pragma table_info(threads)')).map(r => r.name));
  const sectionSchema = columns.has('thread_section_id') && columns.has('section_position');
  if (columns.has('thread_section_id') !== columns.has('section_position')) {
    throw new Error('Codex 会话分组数据结构不完整，已保留上次列表。');
  }
  // In current Codex, is_pinned and global-state pin lists are migration-era
  // metadata. Section membership/position are the same source the desktop uses.
  const pinOrder = sectionSchema ? new Map() : await desktopPinOrder(home);
  const pinned = sectionSchema ? `coalesce(thread_section_id = '${PINNED_SECTION_ID}', 0)` : 'is_pinned';
  const position = sectionSchema ? 'section_position' : 'null';
  const rows = await readRows(home, `select id, cwd, coalesce(nullif(name,''), title) as title,
      ${pinned} as pinned, ${position} as position, archived, source, updated_at as t
      from threads order by pinned desc, ${sectionSchema ? 'section_position asc,' : ''} updated_at desc, id`);
  return rows.map((r, index) => ({
            sessionId: r.id, cwd: r.cwd, title: String(r.title || '').replace(/\s+/g, ' ').trim(),
            pinned: !!r.pinned, archived: !!r.archived, mtime: r.t * 1000,
            pinRank: sectionSchema ? (r.pinned ? index : null) : pinOrder.get(r.id) ?? null,
            subagent: String(r.source || '').includes('subagent'),
          }));
}

// Only explicit UI actions use this native protocol; no turn is started or resumed.
function setArchived(binary, env, threadId, archived, timeout = 15000) {
  if (!/^[a-zA-Z0-9_-]+$/.test(threadId) || typeof archived !== 'boolean') return Promise.reject(new Error('无效的会话操作'));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
      env: { ...env, CODEX_HOME: codexHome() }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buffer = '', settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.stdin.end(); child.kill();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Codex 操作超时；请刷新列表确认官方状态。')), timeout);
    const send = data => { if (!settled) child.stdin.write(JSON.stringify(data) + '\n'); };
    child.on('error', () => finish(new Error('无法启动官方 Codex 会话接口')));
    child.stdin.on('error', () => finish(new Error('Codex 会话接口连接中断')));
    child.on('exit', () => finish(new Error('Codex 会话接口提前退出')));
    child.stdout.on('data', data => {
      buffer += data;
      if (buffer.length > (8 << 20)) return finish(new Error('Codex 会话接口响应过大'));
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== 1 && msg.id !== 2) continue;
        if (msg.error) return finish(new Error('官方 Codex 拒绝操作；请在官方应用检查该会话。'));
        if (msg.id === 1) {
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: archived ? 'thread/archive' : 'thread/unarchive', params: { threadId } });
        } else return finish();
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'wezy_session_sync', version: '0.1.0' } } });
  });
}
module.exports = { listSessions, setArchived };
