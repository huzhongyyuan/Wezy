// 接入配置：官方账号（Claude Code 自己的登录）或团队网关 / Anthropic 兼容接口。
// 令牌用系统钥匙串（Electron safeStorage）加密后存盘，渲染进程拿不到明文。
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const OFFICIAL = { id: 'official', name: '官方账号', type: 'official' };
const file = () => path.join(app.getPath('userData'), 'profiles.json');

function load() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return { active: 'official', items: [] }; }
}
function save(d) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(d, null, 2), { mode: 0o600 });
}
const enc = (t) => safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(t).toString('base64') : 'raw:' + Buffer.from(t).toString('base64');
const dec = (s) => !s ? '' : s.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')) : Buffer.from(s.slice(4), 'base64').toString();
const pub = (p) => ({ id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl || null, hasToken: !!p.token });

function list() {
  const d = load();
  return { active: d.active, items: [OFFICIAL, ...d.items].map(pub) };
}
function upsert({ id, name, baseUrl, token }) {
  const d = load();
  baseUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/.test(baseUrl)) throw new Error('网关地址要以 http:// 或 https:// 开头');
  let p = id && d.items.find((x) => x.id === id);
  if (!p) { p = { id: crypto.randomUUID(), type: 'gateway' }; d.items.push(p); }
  p.name = String(name || '').trim() || new URL(baseUrl).host;
  p.baseUrl = baseUrl;
  if (token) p.token = enc(String(token).trim());
  if (!p.token) throw new Error('缺少成员令牌');
  save(d);
  return pub(p);
}
function remove(id) {
  const d = load();
  d.items = d.items.filter((x) => x.id !== id);
  if (d.active === id) d.active = 'official';
  save(d);
  try { fs.unlinkSync(settingsPath(id)); } catch { /* none */ }
  return list();
}
function activate(id) {
  const d = load();
  if (id !== 'official' && !d.items.some((x) => x.id === id)) throw new Error('配置不存在');
  d.active = id; save(d);
  return list();
}
// 主进程内部用：带明文令牌
function active() {
  const d = load();
  const p = d.items.find((x) => x.id === d.active);
  return p ? { ...pub(p), token: dec(p.token) } : { ...OFFICIAL };
}
function get(id) {
  const p = load().items.find((x) => x.id === id);
  return p ? { ...pub(p), token: dec(p.token) } : null;
}

// 给 claude --settings 用的配置文件，只本人可读；不动用户的 ~/.claude/settings.json
const settingsPath = (id) => path.join(app.getPath('userData'), 'profile-settings', `${id}.json`);
function writeSettings(p) {
  const f = settingsPath(p.id);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, JSON.stringify({ env: { ANTHROPIC_BASE_URL: p.baseUrl, ANTHROPIC_AUTH_TOKEN: p.token, ANTHROPIC_API_KEY: '' } }, null, 2), { mode: 0o600 });
  fs.chmodSync(f, 0o600);
  return f;
}

// ---------- 网关探测 ----------
function req(url, token, timeout = 8000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const t0 = Date.now();
    const r = (u.protocol === 'http:' ? http : https).request(u, {
      method: 'GET', timeout,
      headers: { ...(token ? { authorization: `Bearer ${token}`, 'x-api-key': token } : {}), 'anthropic-version': '2023-06-01', 'user-agent': 'lane' },
    }, (res) => {
      let b = ''; res.on('data', (c) => { if (b.length < 65536) b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* not json */ } resolve({ ok: true, status: res.statusCode, ms: Date.now() - t0, json: j }); });
    });
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, err: 'timeout', ms: Date.now() - t0 }); });
    r.on('error', (e) => resolve({ ok: false, err: e.code || e.message, ms: Date.now() - t0 }));
    r.end();
  });
}
const errMsg = (r) => (r.json && r.json.error && r.json.error.message) || (r.ok ? `HTTP ${r.status}` : r.err);

// 返回 { reachable, ms, kind: 'lane'|'compatible', auth: {ok, title, detail}, me }
async function probe(p) {
  const health = await req(p.baseUrl + '/lane/health');
  if (!health.ok) return { reachable: false, ms: health.ms, error: health.err };
  const isLane = health.status === 200 && health.json && health.json.service === 'lane-gateway';
  if (isLane) {
    const me = await req(p.baseUrl + '/lane/me', p.token);
    if (me.ok && me.status === 200) return { reachable: true, ms: health.ms, kind: 'lane', version: health.json.version, auth: { ok: true, title: `团队网关 · ${me.json.name}`, detail: p.baseUrl }, me: me.json };
    return { reachable: true, ms: health.ms, kind: 'lane', version: health.json.version, auth: { ok: false, title: me.status === 403 ? '成员已停用' : '成员令牌无效', detail: errMsg(me) } };
  }
  // 非 Lane 网关：按 Anthropic 兼容接口探测
  const models = await req(p.baseUrl + '/v1/models', p.token);
  if (!models.ok) return { reachable: false, ms: models.ms, error: models.err };
  const authOk = models.status === 200;
  const authBad = models.status === 401 || models.status === 403;
  return {
    reachable: true, ms: models.ms, kind: 'compatible',
    auth: { ok: authOk || !authBad, title: authOk ? `兼容接口 · ${p.name}` : authBad ? '令牌无效' : `兼容接口 · ${p.name}（未提供模型列表）`, detail: authOk ? p.baseUrl : errMsg(models) },
  };
}

module.exports = { list, upsert, remove, activate, active, get, writeSettings, probe };
