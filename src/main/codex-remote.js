// Read pinned metadata over existing SSH connections. Never start an app-server
// or resume a task. Remote clicks are routed to the owning desktop host.
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const local = require('./codex-sessions');
const quote = s => "'" + s.replace(/'/g, "'\\''") + "'";
const PIN = '01984de2-8f74-7c91-a3b2-5c5e937cf318';
const probe = `import sys,json,sqlite3,pathlib,socket
from urllib.parse import quote
h=pathlib.Path(sys.argv[1]).resolve()
c=sqlite3.connect('file:'+quote(str(h/'state_5.sqlite'))+'?mode=ro',uri=True,timeout=2)
c.row_factory=sqlite3.Row
cols={r['name'] for r in c.execute('pragma table_info(threads)')}
native='thread_section_id' in cols and 'section_position' in cols
if ('thread_section_id' in cols)!=('section_position' in cols): raise RuntimeError('incomplete section schema')
pin="thread_section_id = '${PIN}'" if native else 'is_pinned=1'
order='section_position asc, updated_at desc, id' if native else 'updated_at desc, id'
rows=[dict(r) for r in c.execute("select id,cwd,coalesce(nullif(name,''),title) as title,updated_at from threads where archived=0 and ("+pin+") and source not like '%subagent%' order by "+order)]
print(json.dumps({'identity':socket.gethostname()+':'+str(h),'native':native,'rows':rows}))
`;

function sources(state) {
  const homes = Object.keys(state['app-server-migrated-pinned-thread-ids-by-host'] || {});
  return (state['codex-managed-remote-connections'] || []).flatMap(c => {
    if (c.source !== 'discovered' || typeof c.hostId !== 'string' || typeof c.alias !== 'string') return [];
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(c.alias)) throw Error('远端 SSH 别名无效');
    const paths = homes.filter(k => k.startsWith(c.hostId + ':/')).map(k => k.slice(c.hostId.length + 1));
    if (paths.length > 1) throw Error(`${c.alias} 有多个 Codex 数据目录，无法确定桌面来源`);
    return paths.length ? [{hostId:c.hostId, alias:c.alias, home:paths[0], label:c.displayName || c.alias}] : [];
  }).sort((a,b) => Number(b.hostId === state['selected-remote-host-id']) - Number(a.hostId === state['selected-remote-host-id']));
}

function readRemote(source) {
  return new Promise((resolve,reject) => {
    execFile('/usr/bin/ssh', ['-o','BatchMode=yes','-o','ConnectTimeout=5','-o','ConnectionAttempts=1',source.alias,
      'python3 -c ' + quote(probe) + ' ' + quote(source.home)],
    {encoding:'utf8',timeout:10000,maxBuffer:4<<20}, (error,out) => {
      if (error) return reject(Error(`${source.label}：远端置顶读取失败（${error.killed ? '超时' : 'SSH / 数据库错误'}）`));
      try {
        const result=JSON.parse(out);
        if (typeof result.identity !== 'string' || !Array.isArray(result.rows) || result.rows.some(r=>typeof r.id!=='string'||typeof r.cwd!=='string')) throw Error('schema');
        resolve(result);
      } catch { reject(Error(`${source.label}：远端置顶返回格式异常`)); }
    });
  });
}

const key = r => `${r.hostId || 'local'}:${r.sessionId}`;
function ordered(rows,state) {
  const pins=rows.filter(r=>r.pinned&&!r.archived&&!r.subagent);
  const byKey=new Map(pins.map(r=>[key(r),r]));
  const byId=new Map();
  for(const r of pins) { const a=byId.get(r.sessionId)||[];a.push(r);byId.set(r.sessionId,a); }
  const atoms=state['electron-persisted-atom-state']||{};
  const stored=atoms['unified-sidebar-pinned-order-v1'];
  const legacy=atoms['app-server-pinned-thread-order-v1']||[];
  if ((stored!==undefined&&!Array.isArray(stored))||!Array.isArray(legacy)) throw Error('桌面跨主机置顶顺序格式异常');
  const slots=[],seen=new Set();
  for(const v of stored===undefined?legacy:stored) {
    if(typeof v!=='string') throw Error('桌面跨主机置顶顺序格式异常');
    let r;
    if(stored===undefined) r=byId.get(v)?.length===1?byId.get(v)[0]:null;
    else if(v.startsWith('codex:thread:')) {
      const k=v.slice('codex:thread:'.length);r=byKey.get(k);
      // Desktop migration stored remote UUIDs under local; resolve only when
      // the current metadata gives exactly one owner, never by title/recency.
      if(!r&&k.startsWith('local:')) {const a=byId.get(k.slice(6));if(a?.length===1)r=a[0];}
    }
    if(r&&!seen.has(key(r))) {slots.push(r);seen.add(key(r));}
  }
  for(const r of pins) if(!seen.has(key(r))) {slots.push(r);seen.add(key(r));}
  const groups=new Map();
  for(const r of slots) {const h=r.hostId||'local',a=groups.get(h)||[];a.push(r);groups.set(h,a);}
  for(const a of groups.values()) a.sort((a,b)=>(a.pinRank??Infinity)-(b.pinRank??Infinity));
  const ranks=new Map(slots.map((r,i)=>[key(groups.get(r.hostId||'local').shift()),i]));
  return rows.map(r=>({...r,pinRank:ranks.get(key(r))??null}));
}

function createReader(read = readRemote, now = Date.now) {
  const cache=new Map();
  const lastState=new Map();
  return async function list(home=process.env.CODEX_HOME||path.join(os.homedir(),'.codex')) {
    const localRows=await local.listSessions(home);
    let state={},configWarning=null;
    try {
      state=JSON.parse(await fs.readFile(path.join(home,'.codex-global-state.json'),'utf8'));
      if(!state||typeof state!=='object'||Array.isArray(state))throw Error('invalid state');
      sources(state); ordered([],state);
      lastState.set(home,state);
    } catch(e) {
      if(e.code!=='ENOENT') {
        configWarning='无法读取桌面跨主机配置：'+e.message+'；本机分组仍同步，远端配置保留上次结果';
        state=lastState.get(home)||{};
      }
    }
    const configured=sources(state);
    const result=await Promise.all(configured.map(async s=>{
      const cacheKey=s.hostId+':'+s.home;let c=cache.get(cacheKey);
      if(!c||now()-c.checked>=60000) {
        try {c={checked:now(),verified:now(),data:await read(s),error:null};}
        catch(e) {c={...c,checked:now(),error:String(e.message||e)};}
        cache.set(cacheKey,c);
      }
      return {source:s,...c};
    }));
    const identities=new Set(),warnings=configWarning?[configWarning]:[],remote=[];
    // A successful alias is preferable to an older cached copy of that host.
    result.sort((a,b)=>Number(!!a.error)-Number(!!b.error));
    for(const c of result) {
      if(c.error)warnings.push(c.error);
      if(!c.data||identities.has(c.data.identity))continue;
      identities.add(c.data.identity);
      remote.push(...c.data.rows.map((r,i)=>({sessionId:r.id,cwd:r.cwd,title:r.title||r.id,mtime:r.updated_at*1000,
        pinned:true,archived:false,subagent:false,pinRank:c.data.native?i:null,hostId:c.source.hostId,hostLabel:c.source.label,
        remoteStale:!!c.error||!!configWarning,verifiedAt:c.verified})));
    }
    return {sessions:ordered([...localRows,...remote],state),warnings};
  };
}
module.exports={listSessions:createReader(),createReader,sources,ordered,readRemote,probe};
