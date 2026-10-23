#!/usr/bin/env node
'use strict';
// Claude Edge dashboard server: receives Claude Code HTTP hooks, tracks session status,
// holds PermissionRequest hooks open until the dashboard answers, and serves the touch UI.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { loadConfig, CONF_DIR } = require('./config');

const cfg = loadConfig();
const args = process.argv.slice(2);
const DEMO = args.includes('--demo');
const PORT = Number((args.find((a) => a.startsWith('--port=')) || '').slice(7)) || (DEMO ? cfg.port + 1 : cfg.port);
const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
// Where the Claude desktop app keeps per-session metadata (titles, archived state).
const APP_DATA = process.platform === 'win32' ? process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming')
  : process.platform === 'darwin' ? path.join(HOME, 'Library', 'Application Support')
  : process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
// Newer Windows builds of the app keep their data in %LOCALAPPDATA%\Claude-Data\<id>\ instead.
function desktopDirs() {
  const dirs = [path.join(APP_DATA, 'Claude', 'claude-code-sessions')];
  if (process.platform === 'win32') {
    const data = path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Claude-Data');
    for (const d of listDirs(data)) dirs.push(path.join(d, 'claude-code-sessions'));
  }
  return dirs;
}
const INDEX = path.join(__dirname, 'public', 'index.html');
const HISTORY_DAYS = 30;

// ---------- state ----------
const sessions = new Map(); // CLI session id -> session
const pending = new Map();  // request id -> pending permission (holds the hook's HTTP response)
const clients = new Set();  // SSE responses

function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { id, title: null, firstPrompt: null, cwd: null, projectCwd: null, status: 'idle', live: false,
      lastActivity: 0, activity: null, lastPrompt: null, lastMessage: null, transcript: null,
      archived: false, desktop: false, mode: null };
    sessions.set(id, s);
  }
  return s;
}

const clip = (v, n) => (typeof v === 'string' && v.length > n ? v.slice(0, n) + '…' : v);

function clipDeep(v, n = 4000) {
  if (typeof v === 'string') return clip(v, n);
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clipDeep(x, n));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = clipDeep(v[k], n);
    return o;
  }
  return v;
}

function describeTool(name, input = {}) {
  const base = (p) => (p ? String(p).split(/[\\/]/).pop() : '');
  switch (name) {
    case 'Bash': case 'PowerShell': return `$ ${clip(input.command || '', 160)}`;
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return `${name} ${base(input.file_path || input.notebook_path)}`;
    case 'Grep': return `Grep "${clip(input.pattern || '', 60)}"`;
    case 'Glob': return `Glob ${clip(input.pattern || '', 60)}`;
    case 'WebFetch': return `Fetch ${clip(input.url || '', 100)}`;
    case 'WebSearch': return `Search "${clip(input.query || '', 80)}"`;
    case 'Task': case 'Agent': return `Agent: ${clip(input.description || '', 80)}`;
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(name || '');
      return m ? `${m[1]} · ${m[2]}` : name || 'tool';
    }
  }
}

const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.keys(x).sort().reduce((o, key) => ((o[key] = x[key]), o), {}) : x));
const matchKey = (tool, input) => `${tool}|${stable(input || {})}`;

// Sessions on other machines have no transcript we can read, so keep a short log from their hooks.
function logItem(s, item) {
  (s.log = s.log || []).push({ ...item, ts: new Date().toISOString() });
  if (s.log.length > 120) s.log.splice(0, s.log.length - 120);
}

// ---------- hooks ----------
function onHook(ev, req, res, machine) {
  if (!ev || !ev.session_id) return json(res, 200, {});
  const s = getSession(ev.session_id);
  s.live = true;
  s.lastActivity = Date.now();
  if (machine) s.machine = machine;
  switch (ev.hook_event_name) {
    case 'UserPromptSubmit': if (ev.prompt) logItem(s, { role: 'user', text: clip(ev.prompt, 2000) }); break;
    case 'PreToolUse': logItem(s, { role: 'tool', tool: ev.tool_name, text: describeTool(ev.tool_name, ev.tool_input) }); break;
    case 'Stop': if (ev.last_assistant_message) logItem(s, { role: 'assistant', text: clip(ev.last_assistant_message, 3000) }); break;
  }
  if (ev.cwd) { s.cwd = s.cwd || ev.cwd; if (!s.projectCwd) s.projectCwd = ev.cwd; }
  if (ev.transcript_path) s.transcript = ev.transcript_path;
  if (ev.permission_mode) s.mode = ev.permission_mode;

  switch (ev.hook_event_name) {
    case 'SessionStart':
      s.status = 'idle'; s.activity = null;
      if (ev.session_title) s.title = ev.session_title;
      break;
    case 'UserPromptSubmit':
      s.status = 'working'; s.activity = 'Thinking…'; s.activityTool = null; s.lastPrompt = clip(ev.prompt, 400);
      if (!s.firstPrompt) s.firstPrompt = clip(ev.prompt, 200);
      break;
    case 'PreToolUse':
      s.status = 'working'; s.activity = describeTool(ev.tool_name, ev.tool_input); s.activityTool = ev.tool_name;
      break;
    case 'PostToolUse':
      s.status = 'working';
      resolveWhere((p) => p.sessionId === s.id && p.key === matchKey(ev.tool_name, ev.tool_input));
      break;
    case 'Notification':
      if (ev.notification_type === 'permission_prompt') s.status = 'approval';
      break;
    case 'Stop':
      s.status = 'idle'; s.activity = null; s.lastMessage = clip(ev.last_assistant_message, 800);
      resolveWhere((p) => p.sessionId === s.id);
      break;
    case 'SessionEnd':
      s.status = 'ended'; s.activity = null;
      resolveWhere((p) => p.sessionId === s.id);
      break;
    case 'PermissionRequest':
      return holdPermission(ev, s, res);
  }
  broadcast();
  json(res, 200, {});
}

function holdPermission(ev, s, res) {
  const id = crypto.randomUUID();
  const p = { id, sessionId: s.id, tool: ev.tool_name, input: ev.tool_input || {},
    suggestions: ev.permission_suggestions || [], createdAt: Date.now(), res,
    key: matchKey(ev.tool_name, ev.tool_input) };
  pending.set(id, p);
  s.status = 'approval';
  s.activity = describeTool(ev.tool_name, ev.tool_input);
  s.activityTool = ev.tool_name;
  // If Claude Code cancels the hook (answered in the app, interrupted, timed out), drop it.
  res.on('close', () => {
    if (!pending.delete(id)) return;
    if (s.status === 'approval' && ![...pending.values()].some((p) => p.sessionId === s.id)) s.status = 'working';
    broadcast();
  });
  broadcast();
}

// End held hooks without a decision (the request was settled elsewhere).
function resolveWhere(pred) {
  for (const p of [...pending.values()]) {
    if (!pred(p)) continue;
    pending.delete(p.id);
    if (!p.res.writableEnded) json(p.res, 200, {});
    const s = sessions.get(p.sessionId);
    if (s && s.status === 'approval' && ![...pending.values()].some((q) => q.sessionId === s.id)) s.status = 'working';
  }
}

function decide(id, choice) {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  let decision;
  if (choice === 'deny') {
    decision = { behavior: 'deny', message: 'The user denied this from the Claude Edge dashboard.' };
  } else if (choice === 'allow' || choice === 'always') {
    decision = { behavior: 'allow' };
    if (choice === 'always' && p.suggestions.length) decision.updatedPermissions = p.suggestions;
  }
  // 'defer' sends no decision: the normal in-app prompt handles it.
  json(p.res, 200, decision ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } } : {});
  const s = sessions.get(p.sessionId);
  if (s && decision) s.status = decision.behavior === 'allow' ? 'working' : s.status;
  broadcast();
  return true;
}

// ---------- discovery (desktop titles + transcripts on disk) ----------
const metaCache = new Map(); // file -> mtimeMs
function listDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name)); }
  catch { return []; }
}

function scanDesktop() {
  for (const root of desktopDirs()) for (const a of listDirs(root)) for (const b of listDirs(a)) {
    let files = [];
    try { files = fs.readdirSync(b).filter((f) => /^local_.*\.json$/.test(f)); } catch {}
    for (const f of files) {
      const file = path.join(b, f);
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (metaCache.get(file) === st.mtimeMs) continue;
      metaCache.set(file, st.mtimeMs);
      let m; try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      if (!m.cliSessionId) continue;
      const s = getSession(m.cliSessionId);
      s.desktop = true;
      s.desktopId = m.sessionId;
      if (m.title) s.title = m.title;
      s.cwd = m.cwd || s.cwd;
      s.projectCwd = m.originCwd || m.cwd || s.projectCwd;
      s.archived = !!m.isArchived;
      s.lastActivity = Math.max(s.lastActivity, m.lastActivityAt || 0);
      if (m.permissionMode) s.mode = s.mode || m.permissionMode;
    }
  }
}

function readHead(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(bytes); const n = fs.readSync(fd, buf, 0, bytes, 0); return buf.toString('utf8', 0, n); }
  finally { fs.closeSync(fd); }
}

function promptText(o) {
  const c = o.message && o.message.content;
  const t = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((x) => x.type === 'text') || {}).text : null;
  return t && !t.startsWith('<') ? t : null;
}

function scanTranscripts() {
  const cutoff = Date.now() - HISTORY_DAYS * 864e5;
  for (const dir of listDirs(PROJECTS_DIR)) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch {}
    for (const f of files) {
      const file = path.join(dir, f);
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      const s = getSession(f.slice(0, -6));
      s.transcript = s.transcript || file;
      s.lastActivity = Math.max(s.lastActivity, st.mtimeMs);
      if (s.scanned) continue;
      s.scanned = true;
      try {
        for (const line of readHead(file, 128 * 1024).split('\n')) {
          let o; try { o = JSON.parse(line); } catch { continue; }
          if (o.cwd && !s.cwd) s.cwd = o.cwd;
          if (o.type === 'summary' && o.summary && !s.summary) s.summary = o.summary;
          if (o.type === 'user' && !o.isMeta && !s.firstPrompt) { const t = promptText(o); if (t) s.firstPrompt = clip(t, 200); }
          if (s.cwd && s.firstPrompt) break;
        }
      } catch {}
      if (!s.projectCwd) s.projectCwd = s.cwd;
    }
  }
}

function scan() {
  try { scanDesktop(); scanTranscripts(); } catch (e) { console.error('scan failed', e.message); }
  broadcast();
}

function transcriptTail(s, maxItems = 60) {
  const file = s.transcript;
  if (!file || !path.resolve(file).toLowerCase().startsWith(path.resolve(PROJECTS_DIR).toLowerCase())) return [];
  let st; try { st = fs.statSync(file); } catch { return []; }
  const len = Math.min(st.size, 768 * 1024);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(len);
  try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
  const lines = buf.toString('utf8').split('\n');
  if (len < st.size) lines.shift();
  const items = [];
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.isMeta || o.isSidechain) continue;
    if (o.type === 'user') {
      const t = promptText(o);
      if (t) items.push({ role: 'user', text: clip(t, 2000), ts: o.timestamp });
    } else if (o.type === 'assistant' && Array.isArray(o.message && o.message.content)) {
      for (const part of o.message.content) {
        if (part.type === 'text' && part.text && part.text.trim()) items.push({ role: 'assistant', text: clip(part.text, 3000), ts: o.timestamp });
        else if (part.type === 'tool_use') items.push({ role: 'tool', tool: part.name, text: describeTool(part.name, part.input), ts: o.timestamp });
      }
    }
  }
  return items.slice(-maxItems);
}

// ---------- snapshot + SSE ----------
// Worktree sessions (Remote Control, desktop app) run in <repo>/.claude/worktrees/<name>; group them with the repo.
const projectDir = (cwd) => String(cwd || '').replace(/[\\/]+\.claude[\\/]worktrees[\\/][^\\/]+[\\/]*$/, '');
const projectName = (cwd) => (cwd ? projectDir(cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop() : 'Unknown');

function snapshot() {
  const cutoff = Date.now() - HISTORY_DAYS * 864e5;
  const pendingBySession = {};
  for (const p of pending.values()) pendingBySession[p.sessionId] = (pendingBySession[p.sessionId] || 0) + 1;
  const list = [];
  for (const s of sessions.values()) {
    if (s.archived && !pendingBySession[s.id]) continue;
    if (!s.live && s.lastActivity < cutoff) continue;
    let status = s.status;
    if (pendingBySession[s.id]) status = 'approval';
    else if (status === 'approval' && Date.now() - s.lastActivity > 10 * 60e3) status = 'idle';
    else if (status === 'working' && Date.now() - s.lastActivity > 15 * 60e3) status = 'stale';
    const dir = projectDir(s.projectCwd || s.cwd);
    const fallback = `Session in ${projectName(dir)}${s.machine ? ` on ${s.machine}` : ''}`;
    list.push({ id: s.id, title: s.title || s.summary || s.firstPrompt || fallback, untitled: !(s.title || s.summary || s.firstPrompt), machine: s.machine || null,
      project: s.machine ? `${s.machine}:${dir}` : dir, projectPath: dir, projectName: projectName(dir),
      status, live: s.live, desktop: s.desktop, lastActivity: s.lastActivity, activity: s.activity, activityTool: s.activityTool,
      lastPrompt: s.lastPrompt, lastMessage: s.lastMessage, mode: s.mode, pending: pendingBySession[s.id] || 0 });
  }
  list.sort((a, b) => b.lastActivity - a.lastActivity);
  const pend = [...pending.values()].sort((a, b) => a.createdAt - b.createdAt).map((p) => {
    const s = sessions.get(p.sessionId) || {};
    return { id: p.id, sessionId: p.sessionId, tool: p.tool, input: clipDeep(p.input), suggestions: p.suggestions,
      createdAt: p.createdAt, summary: describeTool(p.tool, p.input),
      sessionTitle: s.title || s.firstPrompt || `Session in ${projectName(s.projectCwd || s.cwd)}`, projectName: projectName(s.projectCwd || s.cwd), machine: s.machine || null };
  });
  return { now: Date.now(), sessions: list, pending: pend };
}

let bcTimer = null;
function broadcast() {
  if (bcTimer) return;
  bcTimer = setTimeout(() => {
    bcTimer = null;
    const data = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const c of clients) c.write(data);
    saveState();
  }, 80);
}

// Sessions from other machines exist only as hook events, so keep them across restarts.
const STATE_FILE = path.join(CONF_DIR, 'remote-sessions.json');
let saveTimer = null;
function saveState() {
  if (DEMO || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const keep = [...sessions.values()].filter((s) => s.machine && Date.now() - s.lastActivity < HISTORY_DAYS * 864e5)
      .map(({ demoTranscript, ...s }) => s);
    fs.writeFile(STATE_FILE, JSON.stringify(keep), () => {});
  }, 2000);
}
function loadState() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
  for (const s of list) {
    // Whatever it was doing before the restart is unknown now.
    if (s.status === 'working' || s.status === 'approval') { s.status = 'idle'; s.activity = null; }
    sessions.set(s.id, s);
  }
}

// ---------- http ----------
function json(res, code, body) {
  if (res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 5e6) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Extra addresses to listen on (e.g. this PC's LAN IP) so hooks on other machines can reach us.
const LISTEN = ['127.0.0.1', ...(DEMO ? [] : cfg.listen || [])];
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, ...LISTEN.map((a) => `${a}:${PORT}`), `${os.hostname().toLowerCase()}:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));

function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// The main token can do everything. Each remote machine gets its own token that can only
// send hook events, so one sniffed off the LAN can't approve anything.
function authorize(req, url) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : req.headers['x-edge-token'] || url.searchParams.get('t');
  if (same(tok, cfg.token)) return { admin: true };
  for (const [machine, t] of Object.entries(cfg.machines || {})) if (same(tok, t)) return { machine };
  return null;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
  if (!ALLOWED_HOSTS.has(String(req.headers.host).toLowerCase())) return json(res, 403, { error: 'bad host' });
  if (req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) return json(res, 403, { error: 'bad origin' });

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(INDEX).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
  if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
  const who = authorize(req, url);
  if (!who) return json(res, 401, { error: 'unauthorized' });

  try {
    if (req.method === 'POST' && url.pathname === '/api/hook') return onHook(await readBody(req), req, res, who.machine);
    if (!who.admin) return json(res, 403, { error: 'forbidden' });
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/decide') {
      const b = await readBody(req);
      if (!['allow', 'always', 'deny', 'defer'].includes(b.choice)) return json(res, 400, { error: 'bad choice' });
      return json(res, decide(b.id, b.choice) ? 200 : 410, {});
    }
    if (req.method === 'GET' && url.pathname === '/api/transcript') {
      const s = sessions.get(url.searchParams.get('id') || '');
      const items = !s ? [] : s.demoTranscript || (s.machine ? [] : transcriptTail(s));
      return json(res, 200, { items: items.length ? items : (s && s.log) || [] });
    }
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
  json(res, 404, { error: 'not found' });
}

setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20e3);
LISTEN.forEach((addr, i) => {
  const server = http.createServer((req, res) => handle(req, res).catch((e) => json(res, 500, { error: e.message })));
  server.timeout = 0;
  server.requestTimeout = 0;
  server.on('error', (e) => {
    if (i > 0) return console.error(`Can't listen on ${addr}:${PORT} (${e.code}); remote machines won't reach this dashboard.`);
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use (dashboard already running?)` : e.message);
    process.exit(1);
  });
  server.listen(PORT, addr, () => {
    if (i > 0) return console.log(`Also listening for remote machines on http://${addr}:${PORT}`);
    // Only show the token-bearing URL on an interactive terminal, never in a log file.
    const where = process.stdout.isTTY ? `#t=${cfg.token}` : '#t=<token from ~/.claude-edge/config.json>';
    console.log(`Claude Edge${DEMO ? ' (demo)' : ''} on http://127.0.0.1:${PORT}/${where}`);
    if (DEMO) return seedDemo();
    loadState();
    scan();
    setInterval(scan, 10e3);
  });
});

// ---------- demo mode: made-up sessions, no hooks or disk access ----------
function seedDemo() {
  const t = Date.now();
  const add = (id, o) => Object.assign(getSession(id), { live: true, ...o });
  add('d1', { title: 'Add rate limiting to the public API', projectCwd: '/home/dev/aurora-api', status: 'working', lastActivity: t - 40e3,
    lastPrompt: 'Use a sliding window per API key and return Retry-After headers', activityTool: 'Bash', activity: '$ npm test -- rate-limit' });
  add('d2', { title: 'Fix flaky upload test', projectCwd: '/home/dev/aurora-api', status: 'idle', lastActivity: t - 6 * 60e3,
    lastMessage: 'The test raced the S3 mock. I now await the multipart completion event, and it passed 50 runs in a row.' });
  add('d3', { title: 'Shader hot-reload for the editor', projectCwd: '/home/dev/pixel-forge', status: 'approval', lastActivity: t - 20e3,
    lastPrompt: 'Watch the shaders folder and recompile on save', activityTool: 'Edit', activity: 'Edit watcher.ts' });
  add('d4', { title: 'Inverse kinematics for the 6-DOF arm', projectCwd: '/home/dev/robot-arm', status: 'working', lastActivity: t - 5e3,
    lastPrompt: 'Switch the solver to damped least squares near singularities', activityTool: 'Grep', activity: 'Grep "jacobian"' });
  add('d5', { title: 'Write the v0.4 release notes', projectCwd: '/home/dev/pixel-forge', status: 'idle', live: false, lastActivity: t - 3 * 3600e3,
    lastMessage: 'Drafted release notes covering the new tile editor, palette import and 23 bug fixes.' });
  sessions.get('d4').demoTranscript = [
    { role: 'user', text: 'Switch the solver to damped least squares near singularities' },
    { role: 'assistant', text: "I'll look at how the current solver builds the **Jacobian**, then add damping that ramps up as the arm nears a singular pose." },
    { role: 'tool', tool: 'Grep', text: 'Grep "jacobian"' }, { role: 'tool', tool: 'Read', text: 'Read solver.py' },
    { role: 'assistant', text: 'The solver inverts `J` directly, which blows up when the wrist aligns. Damped least squares replaces it with `Jᵀ(JJᵀ + λ²I)⁻¹`.' },
  ];
  const hold = (sessionId, tool, input, suggestions) => {
    const id = crypto.randomUUID();
    pending.set(id, { id, sessionId, tool, input, suggestions, createdAt: t - 20e3, key: '', res: { writableEnded: true, on() {} } });
  };
  hold('d3', 'Edit', { file_path: '/home/dev/pixel-forge/src/watcher.ts',
    old_string: "watch('shaders', () => reload());",
    new_string: "watch('shaders', { debounce: 120 }, async (file) => {\n  await compileShader(file);\n  editor.refresh(file);\n});" },
    [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
  hold('d1', 'Bash', { command: 'docker compose up -d redis && npm run test:integration', description: 'Start Redis and run the integration tests' },
    [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'docker compose up:*' }], behavior: 'allow', destination: 'localSettings' }]);
  sessions.get('d1').status = 'approval';
  // Keep the working sessions looking busy.
  const steps = [['Read', 'Read kinematics.py'], ['Edit', 'Edit solver.py'], ['Bash', '$ pytest tests/test_ik.py -q'], ['Grep', 'Grep "singular"']];
  let i = 0;
  setInterval(() => { const s = sessions.get('d4'); [s.activityTool, s.activity] = steps[i++ % steps.length]; s.lastActivity = Date.now(); broadcast(); }, 3500);
  broadcast();
}
