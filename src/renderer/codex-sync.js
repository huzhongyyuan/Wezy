(function (root) {
  const isCodex = p => p.kind === 'codex';
  const key = p => `${p.hostId || 'local'}:${p.sessionId}`;
  function reconcile(projects, sessions, uid) {
    if (!Array.isArray(sessions) || sessions.some(s => !s || typeof s.sessionId !== 'string' || typeof s.cwd !== 'string')) {
      throw new Error('Codex 会话数据无效，已保留上次列表。');
    }
    const byId = new Map(sessions.map(s => [key(s), s]));
    const have = new Set();
    const updated = projects.map(p => {
      if (!isCodex(p) || !p.sessionId) return p;
      have.add(key(p));
      const s = byId.get(key(p));
      if (!s) return { ...p, codexMissing: true };
      return { ...p, name: s.title || s.cwd.split('/').filter(Boolean).pop() || s.sessionId,
        cwd: s.cwd, pinned: s.pinned, archived: s.archived, codexSubagent: s.subagent,
        codexMtime: s.mtime, codexPinRank: s.pinRank ?? null, codexMissing: false,
        hostId:s.hostId, hostLabel:s.hostLabel, remoteStale:s.remoteStale };
    });
    for (const s of sessions) {
      if (have.has(key(s)) || s.subagent) continue;
      have.add(key(s));
      updated.push({ id: uid(), kind: 'codex', sessionId: s.sessionId, cwd: s.cwd,
        name: s.title || s.cwd.split('/').filter(Boolean).pop() || s.sessionId,
        pinned: s.pinned, archived: s.archived, codexSubagent: s.subagent, codexMtime: s.mtime,
        codexPinRank: s.pinRank ?? null, codexMissing: false,
        hostId:s.hostId, hostLabel:s.hostLabel, remoteStale:s.remoteStale });
    }
    return updated;
  }
  function visible(projects, archived = false) {
    return projects.filter(p => isCodex(p) && !p.codexMissing && !p.codexSubagent && !!p.archived === archived)
      .sort((a, b) => {
        const pinGroup = Number(!!b.pinned) - Number(!!a.pinned);
        if (pinGroup) return pinGroup;
        if (a.pinned && b.pinned) {
          const rank = p => Number.isInteger(p.codexPinRank) && p.codexPinRank >= 0 ? p.codexPinRank : Infinity;
          if (rank(a) !== rank(b)) return rank(a) < rank(b) ? -1 : 1;
        }
        return (b.codexMtime || 0) - (a.codexMtime || 0) || String(a.sessionId || a.id).localeCompare(String(b.sessionId || b.id));
      });
  }
  const api = { reconcile, visible };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.codexSync = api;
})(typeof window !== 'undefined' ? window : globalThis);
