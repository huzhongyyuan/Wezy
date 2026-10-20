// 用量统计：读取本机 ~/.claude/projects/**/*.jsonl 里的 assistant 消息 usage 字段，按天汇总。
// 只读本地文件，不上传任何内容。
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const ROOT = path.join(os.homedir(), '.claude', 'projects');

function listJsonl(dir, sinceMs, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJsonl(p, sinceMs, out);
    else if (e.name.endsWith('.jsonl')) {
      try { if (fs.statSync(p).mtimeMs >= sinceMs) out.push(p); } catch { /* ignore */ }
    }
  }
  return out;
}

function dayKey(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function scanFile(file, acc, seen) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  const sessionsInFile = new Set();
  for await (const line of rl) {
    if (!line || line[0] !== '{') continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type !== 'assistant' || !j.message || !j.message.usage) continue;
    const key = `${j.message.id || ''}:${j.requestId || ''}:${j.uuid || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const u = j.message.usage;
    const ts = j.timestamp ? new Date(j.timestamp) : null;
    if (!ts || isNaN(ts)) continue;
    const dk = dayKey(ts);
    const model = j.message.model || 'unknown';
    if (model === '<synthetic>') continue; // Claude Code 本地生成的占位消息，不计费
    const bucket = acc.days[dk] || (acc.days[dk] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, models: {} });
    bucket.input += u.input_tokens || 0;
    bucket.output += u.output_tokens || 0;
    bucket.cacheRead += u.cache_read_input_tokens || 0;
    bucket.cacheWrite += u.cache_creation_input_tokens || 0;
    bucket.messages += 1;
    bucket.models[model] = (bucket.models[model] || 0) + (u.output_tokens || 0);
    if (j.sessionId) sessionsInFile.add(j.sessionId);
  }
  acc.sessions += sessionsInFile.size;
}

function sumRange(days, from) {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, models: {} };
  for (const [k, v] of Object.entries(days)) {
    if (k < from) continue;
    out.input += v.input; out.output += v.output; out.cacheRead += v.cacheRead; out.cacheWrite += v.cacheWrite; out.messages += v.messages;
    for (const [m, n] of Object.entries(v.models)) out.models[m] = (out.models[m] || 0) + n;
  }
  return out;
}

async function summary(daysBack = 30) {
  const now = new Date();
  const since = new Date(now.getTime() - daysBack * 86400e3);
  const files = listJsonl(ROOT, since.getTime());
  const acc = { days: {}, sessions: 0 };
  const seen = new Set();
  for (const f of files) { try { await scanFile(f, acc, seen); } catch { /* skip broken file */ } }
  const today = dayKey(now);
  const d7 = dayKey(new Date(now.getTime() - 6 * 86400e3));
  const d30 = dayKey(since);
  const series = [];
  for (let i = 13; i >= 0; i--) {
    const k = dayKey(new Date(now.getTime() - i * 86400e3));
    const v = acc.days[k] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
    series.push({ day: k, output: v.output, input: v.input + v.cacheRead + v.cacheWrite, messages: v.messages });
  }
  return {
    scannedFiles: files.length, sessions: acc.sessions, source: ROOT, generatedAt: now.toISOString(),
    today: sumRange(acc.days, today), last7: sumRange(acc.days, d7), last30: sumRange(acc.days, d30), series,
  };
}

module.exports = { summary };
