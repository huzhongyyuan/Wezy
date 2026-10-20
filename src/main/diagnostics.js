// 链路诊断：本机 → 账号 → 网络 → 出口，四段分别检测，告诉用户是哪一段出了问题。
const { execFile } = require('child_process');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SHELL = process.env.SHELL || '/bin/zsh';

function sh(cmd, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(SHELL, ['-lc', cmd], { timeout, env: process.env }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), err: err && err.message });
    });
  });
}

function probe(url, timeout = 8000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.request(url, { method: 'GET', timeout, headers: { 'user-agent': 'lane-diagnostics' } }, (res) => {
      let body = '';
      res.on('data', (c) => { if (body.length < 65536) body += c; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, ms: Date.now() - t0, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, err: 'timeout', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ ok: false, err: e.code || e.message, ms: Date.now() - t0 }));
    req.end();
  });
}

async function checkCli() {
  const r = await sh('command -v claude && claude --version');
  if (!r.ok || !r.stdout) return { ok: false, title: '未找到 claude 命令', detail: '请先安装 Claude Code：npm install -g @anthropic-ai/claude-code', action: 'install' };
  const [bin, ...rest] = r.stdout.split('\n');
  return { ok: true, title: `Claude Code ${rest.join(' ').trim() || ''}`.trim(), detail: bin, path: bin, version: rest.join(' ').trim() };
}

async function checkAuth() {
  // 1) Claude Code 的 settings.json 里的 env，以及 shell 环境变量（API Key / Token / 自定义 BASE_URL）
  let cfgEnv = {};
  try { cfgEnv = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).env || {}; } catch (_) { /* none */ }
  const env = await sh('printf "%s\\n%s\\n%s" "${ANTHROPIC_API_KEY:+set}" "${ANTHROPIC_AUTH_TOKEN:+set}" "${ANTHROPIC_BASE_URL:-}"');
  const [keySet, tokSet, shellBase] = env.stdout.split('\n');
  const baseUrl = cfgEnv.ANTHROPIC_BASE_URL || shellBase || null;
  const info = { baseUrl };
  const hasKey = keySet === 'set' || !!cfgEnv.ANTHROPIC_API_KEY;
  const hasTok = tokSet === 'set' || !!cfgEnv.ANTHROPIC_AUTH_TOKEN;
  if (hasKey || hasTok) {
    const src = (cfgEnv.ANTHROPIC_API_KEY || cfgEnv.ANTHROPIC_AUTH_TOKEN) ? 'settings.json' : '环境变量';
    return { ok: true, title: `${hasKey ? 'API Key' : 'Auth Token'}（${src}）`, detail: baseUrl ? `BASE_URL = ${baseUrl}` : '直连 Anthropic API', mode: hasKey ? 'apikey' : 'token', ...info };
  }

  // 2) macOS 钥匙串（Claude Code 默认存放 OAuth 凭据的位置）
  if (process.platform === 'darwin') {
    const r = await sh('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null');
    if (r.ok && r.stdout) {
      try {
        const j = JSON.parse(r.stdout);
        const o = j.claudeAiOauth || {};
        const exp = o.expiresAt ? new Date(o.expiresAt) : null;
        const expired = exp && exp.getTime() < Date.now();
        return {
          ok: !expired,
          title: expired ? '登录已过期' : `已登录（${o.subscriptionType || 'claude.ai'}）`,
          detail: exp ? `令牌有效期至 ${exp.toLocaleString()}` : '凭据来自系统钥匙串',
          mode: 'oauth', subscription: o.subscriptionType || null, expiresAt: o.expiresAt || null, ...info,
          action: expired ? 'login' : undefined,
        };
      } catch (_) { /* fallthrough */ }
    }
  }
  // 3) 凭据文件（Linux / Windows）
  const credFile = path.join(os.homedir(), '.claude', '.credentials.json');
  if (fs.existsSync(credFile)) {
    try {
      const j = JSON.parse(fs.readFileSync(credFile, 'utf8'));
      const o = j.claudeAiOauth || {};
      const exp = o.expiresAt ? new Date(o.expiresAt) : null;
      const expired = exp && exp.getTime() < Date.now();
      return { ok: !expired, title: expired ? '登录已过期' : `已登录（${o.subscriptionType || 'claude.ai'}）`, detail: credFile, mode: 'oauth', subscription: o.subscriptionType || null, expiresAt: o.expiresAt || null, ...info, action: expired ? 'login' : undefined };
    } catch (_) { /* ignore */ }
  }
  // 4) ~/.claude.json 里有 oauthAccount：已用 claude.ai 账号登录（凭据由 Claude Code 自己管理）
  try {
    const cj = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    if (cj.oauthAccount) {
      const a = cj.oauthAccount;
      return { ok: true, title: '已登录（Claude 账号）', detail: a.organizationName || a.organizationRole || '凭据由 Claude Code 管理', mode: 'oauth', ...info };
    }
  } catch (_) { /* ignore */ }
  return { ok: false, title: '未登录', detail: '在终端里运行 claude，按提示用你自己的 Anthropic 账号或 API Key 登录', mode: 'none', action: 'login', ...info };
}

async function checkNetwork(baseUrl) {
  const apiHost = baseUrl && /^https?:\/\//.test(baseUrl) ? baseUrl.replace(/\/$/, '') : 'https://api.anthropic.com';
  const [api, site] = await Promise.all([probe(apiHost + '/v1/models'), probe('https://claude.ai/')]);
  // 没带 key 时 API 返回 401 也算“通”，关键是能握手、有响应。
  const apiOk = api.ok && api.status && api.status < 500;
  return {
    ok: apiOk,
    title: apiOk ? `API 可达（${api.ms} ms）` : `API 不可达（${api.err || 'HTTP ' + api.status}）`,
    detail: `${apiHost} → ${api.ok ? 'HTTP ' + api.status : api.err}；claude.ai → ${site.ok ? 'HTTP ' + site.status + '，' + site.ms + ' ms' : site.err}`,
    api: { host: apiHost, ...api, body: undefined }, site: { ...site, body: undefined },
    action: apiOk ? undefined : 'network',
  };
}

async function checkExit() {
  const r = await probe('https://ipinfo.io/json');
  if (!r.ok || !r.body) return { ok: false, title: '无法确认出口', detail: r.err || `HTTP ${r.status}`, action: 'network' };
  try {
    const j = JSON.parse(r.body);
    return { ok: true, title: `出口 ${j.country || '?'} · ${j.city || ''}`.trim(), detail: `${j.ip || ''}  ${j.org || ''}`.trim(), ip: j.ip, country: j.country, city: j.city, org: j.org, timezone: j.timezone };
  } catch (e) {
    return { ok: false, title: '无法解析出口信息', detail: e.message };
  }
}

async function run(profile) {
  const startedAt = new Date().toISOString();
  const viaGateway = profile && profile.type === 'gateway';
  const cliP = checkCli();
  let auth, network;
  if (viaGateway) {
    const r = await require('./profiles').probe(profile);
    network = r.reachable
      ? { ok: true, title: `网关可达（${r.ms} ms）`, detail: `${profile.baseUrl} · ${r.kind === 'lane' ? 'Lane 团队网关 ' + (r.version || '') : 'Anthropic 兼容接口'}` }
      : { ok: false, title: `网关不可达（${r.error}）`, detail: profile.baseUrl, action: 'network' };
    auth = r.reachable ? { ...r.auth, mode: 'gateway' } : { ok: false, title: '无法验证令牌', detail: '网关不可达', mode: 'gateway' };
  } else {
    auth = await checkAuth();
    network = await checkNetwork(auth.baseUrl);
  }
  const [cli, exit] = await Promise.all([cliP, checkExit()]);
  const segments = [
    { key: 'local', label: '本机', ...cli },
    { key: 'account', label: '账号', ...auth },
    { key: 'network', label: '网络', ...network },
    { key: 'exit', label: '出口', ...exit },
  ];
  const firstBad = segments.find((s) => !s.ok);
  let verdict;
  if (!firstBad) verdict = { ok: true, text: '链路已接通', hint: viaGateway ? `新会话走「${profile.name}」。` : '可以直接在终端里使用 claude。' };
  else if (firstBad.key === 'local') verdict = { ok: false, text: '本机未就绪', hint: firstBad.detail };
  else if (firstBad.key === 'account') verdict = { ok: false, text: viaGateway ? '令牌未通过' : '账号未就绪', hint: firstBad.detail };
  else if (firstBad.key === 'network') verdict = { ok: false, text: viaGateway ? '网关不通' : '网络不通', hint: viaGateway ? '检查网关地址，或联系网关管理员。' : '检查本机网络设置后点“重新检测”。' };
  else verdict = { ok: true, text: '链路已接通', hint: '出口信息查询失败，不影响使用。' };
  return { startedAt, profile: profile ? { id: profile.id, name: profile.name, type: profile.type, baseUrl: profile.baseUrl || null } : null, segments, verdict, platform: `${os.platform()} ${os.arch()}`, hostname: os.hostname() };
}

module.exports = { run };
