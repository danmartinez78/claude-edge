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
    case 'TodoWrite': { const t = todoSummary(input.todos); return t ? `Plan ${t.done}/${t.total}${t.current ? ` · ${t.current}` : ''}` : 'Updated the plan'; }
    default: {
      if (/__reply$/.test(name || '')) return 'Replied in the thread';
      if (SAY_TOOL.test(name || '')) return 'Messaged another session';
      const m = /^mcp__(?:claude_ai_)?(.+?)__(.+)$/.exec(name || '');
      return m ? `${m[1]} · ${m[2].replace(/[_-]/g, ' ')}` : name || 'tool';
    }
  }
}

const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.keys(x).sort().reduce((o, key) => ((o[key] = x[key]), o), {}) : x));
const matchKey = (tool, input) => `${tool}|${stable(input || {})}`;

// Threads started from a claude.ai Project receive their prompts wrapped in a
// <project_claude_message> envelope: <cited> messages for context (from the coordinator or
// from you) and a <note> with this thread's task. Turn that into readable text and a title.
// A Project's threads all name the same coordinator session, so that groups them. The Project's
// own name only arrives if its instructions add a label like "[project: GO2 Embodied AI]".
const LABEL_RE = /\[project:\s*([^\]\n]{1,60})\]\s*/i;
const THREAD_RE = /\[thread:\s*([^\]\n]{1,90})\]\s*/i;
const stripMd = (t) => t.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
function unwrapEnvelope(raw) {
  if (typeof raw !== 'string' || !/^\s*<project_claude_message\b/.test(raw)) return null;
  const label = (LABEL_RE.exec(raw) || [])[1];
  const thread = [...raw.matchAll(new RegExp(THREAD_RE.source, 'gi'))].map((m) => m[1].trim()).pop(); // latest wins
  const text = raw.replace(new RegExp(LABEL_RE.source, 'gi'), '').replace(new RegExp(THREAD_RE.source, 'gi'), '');
  const coordinator = (/<relay\b[^>]*\bsession="([^"]+)"/.exec(text) || /<project_claude_message\b[^>]*\bsession="([^"]+)"/.exec(text) || [])[1];
  const notes = [...text.matchAll(/<note>([\s\S]*?)<\/note>/g)].map((m) => m[1].trim()).filter(Boolean);
  const yours = [...text.matchAll(/<cited\b([^>]*)>([\s\S]*?)<\/cited>/g)]
    .filter((m) => /author="user"/.test(m[1])).map((m) => m[2].trim()).filter(Boolean);
  const task = notes[notes.length - 1] || '';
  const said = yours[yours.length - 1] || '';
  // "robodan asked to upload X" -> "Upload X"
  const first = (stripMd(task).split(/(?<=[.!?])\s/)[0] || stripMd(said))
    .replace(/^[\w.-]+ (?:asked|wants|would like) (?:you |me )?(?:to )?/i, '').replace(/^./, (c) => c.toUpperCase());
  const parts = [];
  if (said) parts.push(`You: ${said}`);
  if (task) parts.push(`Task from the project: ${task}`);
  return { title: clip(first, 90) || null, text: parts.join('\n\n') || 'Message from the project coordinator',
    coordinator: coordinator || null, label: label ? label.trim() : null, thread: thread || null };
}

const decodeXml = (t) => String(t || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// Project threads are also woken by mentions: <wake><project id="chan_…"><thread ts="…"><message from="human">…
// The project id is the Project itself, so it's the best key to group threads by.
function unwrapWake(raw) {
  if (typeof raw !== 'string' || !/^\s*<wake\b/.test(raw)) return null;
  const project = (/<project\b[^>]*\bid="([^"]+)"/.exec(raw) || [])[1];
  const label = (LABEL_RE.exec(raw) || [])[1];
  const thread = (THREAD_RE.exec(raw) || [])[1];
  const msgs = [...raw.matchAll(/<message\b([^>]*)>([\s\S]*?)<\/message>/g)].map((m) => ({
    human: /\bfrom="human"/.test(m[1]), trigger: /\btrigger="true"/.test(m[1]),
    name: (/\bauthor-name="([^"]+)"/.exec(m[1]) || [])[1],
    text: decodeXml(m[2].replace(new RegExp(LABEL_RE.source, 'gi'), '').replace(new RegExp(THREAD_RE.source, 'gi'), '').trim()) }));
  const m = msgs.filter((x) => x.trigger).pop() || msgs.pop();
  const text = !m ? 'Mentioned in the project' : m.human ? `You: ${m.text}` : `${m.name || 'Another thread'}: ${m.text}`;
  return { title: null, text, project: project || null, label: label ? label.trim() : null, thread: thread ? thread.trim() : null };
}

// What a UserPromptSubmit really is. Background-task results, slash commands and Project relays
// arrive as "prompts" too; only 'user' is something you typed and may title a session.
function classifyPrompt(raw) {
  if (typeof raw !== 'string') return { kind: 'system', text: null };
  const env = unwrapEnvelope(raw);
  if (env) return { kind: 'project', ...env };
  const wake = unwrapWake(raw);
  if (wake) return { kind: 'project', ...wake };
  const t = raw.trimStart();
  if (t.startsWith('<task-notification>')) {
    const tag = (n) => decodeXml(((new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(t) || [])[1] || '').trim());
    return { kind: 'system', text: clip(tag('summary') || `Background task ${tag('status') || 'finished'}`, 200) };
  }
  const cmd = /<command-name>([^<]+)<\/command-name>/.exec(t);
  if (cmd) return { kind: 'command', text: `${cmd[1].trim()} ${decodeXml((/<command-args>([\s\S]*?)<\/command-args>/.exec(t) || [])[1] || '').trim()}`.trim() };
  if (t.startsWith('<')) return { kind: 'system', text: null }; // reminders, command output and the like
  return { kind: 'user', text: raw };
}

// Bookkeeping tools (thread reactions, status pings, tool lookups) that say nothing about the work.
const QUIET_TOOL = /^(ToolSearch|TaskOutput|TaskStop|TaskList|TaskGet)$|^mcp__.+__(react|unreact|no_reply_needed|update_status|update_message|list_thread_sessions|get_inbox|relay_get_inbox)$/;
const SAY_TOOL = /^mcp__.+__(reply|send_message|post_message|send_direct_message|relay_send_direct_message)$/;

function todoSummary(todos) {
  if (!Array.isArray(todos) || !todos.length) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  const cur = todos.find((t) => t.status === 'in_progress');
  return { done, total: todos.length, current: cur ? clip(cur.activeForm || cur.content || '', 120) : null };
}

// Project names learned from labels, keyed by project id; kept across restarts. A thread can be
// reached both by relays (which name the coordinator session) and by wakes (which name the
// Project), so projectAlias maps a coordinator to its Project once one thread has seen both.
const projectLabels = {};
const projectAlias = {};
const canonProject = (id) => projectAlias[id] || id;

function noteProject(s, p) {
  s.projectThread = true;
  if (p.project) {
    if (s.projectId && s.projectId !== p.project && !s.projectId.startsWith('chan_')) projectAlias[s.projectId] = p.project;
    s.projectId = p.project;
  } else if (p.coordinator) {
    if (s.projectId && s.projectId !== p.coordinator && s.projectId.startsWith('chan_')) projectAlias[p.coordinator] = s.projectId;
    else if (!s.projectId) s.projectId = p.coordinator;
  }
  if (p.label) { s.projectLabel = p.label; if (s.projectId) projectLabels[canonProject(s.projectId)] = p.label; }
  if (p.thread) s.threadTitle = p.thread;
}

// Session details found in transcript lines: the title Claude Code gave it, model, context, cost, plan.
// Local transcripts are read directly; other machines send the same lines from edge_report.py.
function applyMeta(s, o) {
  if (!o || typeof o !== 'object') return;
  switch (o.type) {
    case 'custom-title': if (o.customTitle) s.customTitle = clip(String(o.customTitle), 120); break;
    case 'ai-title': if (o.aiTitle || o.title) s.aiTitle = clip(String(o.aiTitle || o.title), 120); break;
    case 'agent-name': if (o.agentName) s.agentName = clip(String(o.agentName), 120); break;
    case 'summary': if (o.summary) s.summary = clip(String(o.summary), 120); break;
    case 'cost-state':
      if (typeof o.totalCostUSD === 'number') s.cost = o.totalCostUSD;
      if (Object.keys(o.modelUsage || {}).some((k) => /\[1m\]/i.test(k))) s.bigContext = true;
      break;
    case 'assistant': {
      if (o.isSidechain) break;
      const m = o.message || {};
      const u = m.usage;
      if (u && m.model && m.model !== '<synthetic>') {
        s.model = m.model;
        s.ctxTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      }
      for (const part of Array.isArray(m.content) ? m.content : []) {
        if (part && part.type === 'tool_use' && part.name === 'TodoWrite') s.todos = todoSummary((part.input || {}).todos) || s.todos;
      }
      break;
    }
  }
}

// What Claude Code hands its status line: limits for the whole account, plus this session's details.
let quota = null;
function onStatus(d, machine) {
  if (!d || typeof d !== 'object') return;
  if (d.rate_limits && (d.rate_limits.five_hour || d.rate_limits.seven_day || d.rate_limits.spend_limit)) {
    quota = { ...d.rate_limits, at: Date.now(), machine: machine || null };
  }
  if (!d.session_id) return;
  const s = getSession(d.session_id);
  if (machine) s.machine = machine;
  if (d.session_name) s.sessionName = clip(String(d.session_name), 120);
  if (d.model) { s.modelName = d.model.display_name || s.modelName; s.model = d.model.id || s.model; }
  const cw = d.context_window || {};
  if (typeof cw.used_percentage === 'number') s.ctxPct = cw.used_percentage;
  if (cw.context_window_size) s.ctxWindow = cw.context_window_size;
  if (d.cost && typeof d.cost.total_cost_usd === 'number') s.cost = d.cost.total_cost_usd;
  if (!s.cwd && (d.workspace || {}).project_dir) s.cwd = s.projectCwd = d.workspace.project_dir;
  s.statusAt = Date.now();
  s.lastActivity = Math.max(s.lastActivity, s.statusAt);
}

function contextPct(s) {
  if (typeof s.ctxPct === 'number' && Date.now() - (s.statusAt || 0) < 30 * 60e3) return Math.round(s.ctxPct);
  if (!s.ctxTokens) return null;
  const win = s.ctxWindow || (s.bigContext || s.ctxTokens > 2e5 || /\[1m\]/i.test(s.model || '') ? 1e6 : 2e5);
  return Math.min(100, Math.round((s.ctxTokens / win) * 100));
}

// "claude-opus-5-5" -> "Opus 5.5"
function modelLabel(s) {
  if (s.modelName && Date.now() - (s.statusAt || 0) < 30 * 60e3) return s.modelName;
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(s.model || '');
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : s.model || null;
}

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
  const kind = ev.hook_event_name === 'UserPromptSubmit' ? classifyPrompt(ev.prompt) : null;
  if (kind && kind.kind === 'project') noteProject(s, kind);
  const quiet = QUIET_TOOL.test(ev.tool_name || '');
  if (ev.hook_event_name === 'PreToolUse' && ev.tool_name === 'TodoWrite') s.todos = todoSummary((ev.tool_input || {}).todos) || s.todos;
  switch (ev.hook_event_name) {
    case 'UserPromptSubmit':
      if (kind.text) logItem(s, { role: kind.kind === 'system' ? 'system' : 'user', text: clip(kind.kind === 'command' ? `You ran ${kind.text}` : kind.text, 2000) });
      break;
    case 'PreToolUse': if (!quiet) logItem(s, { role: 'tool', tool: ev.tool_name, text: describeTool(ev.tool_name, ev.tool_input) }); break;
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
      s.status = 'working'; s.activity = 'Thinking…'; s.activityTool = null;
      if (kind.kind === 'user' || kind.kind === 'project') s.lastPrompt = clip(kind.text, 400);
      if (kind.kind === 'user' && !s.firstPrompt) s.firstPrompt = clip(kind.text, 200);
      break;
    case 'PreToolUse':
      s.status = 'working';
      if (!quiet) { s.activity = describeTool(ev.tool_name, ev.tool_input); s.activityTool = ev.tool_name; }
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

function rawText(o) {
  const c = o.message && o.message.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? (c.find((x) => x.type === 'text') || {}).text : null;
}

// Best available title: the desktop app's, Claude Code's own (status line, then transcript),
// a [thread:] label, the transcript summary, or the first thing you typed. A project thread's
// relayed task is not a title: it's usually a reminder or a handoff note.
function titleOf(s) {
  const first = s.firstPrompt && !s.firstPrompt.startsWith('<') && !s.projectThread ? s.firstPrompt : null;
  return s.title || s.sessionName || s.customTitle || s.aiTitle || s.threadTitle || s.agentName || s.summary || first || null;
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
      if (s.metaMtime !== st.mtimeMs) { s.metaMtime = st.mtimeMs; try { readTailMeta(s, file, st.size); } catch {} }
      if (s.scanned) continue;
      s.scanned = true;
      try {
        for (const line of readHead(file, 128 * 1024).split('\n')) {
          let o; try { o = JSON.parse(line); } catch { continue; }
          if (o.cwd && !s.cwd) s.cwd = o.cwd;
          if (o.type === 'summary' && o.summary && !s.summary) s.summary = o.summary;
          if (o.type === 'user' && !o.isMeta && !s.firstPrompt && !s.projectThread) {
            const k = classifyPrompt(rawText(o));
            if (k.kind === 'project') noteProject(s, k);
            if (k.kind === 'user') s.firstPrompt = clip(k.text, 200);
          }
          if (s.cwd && (s.firstPrompt || s.projectThread)) break;
        }
      } catch {}
      if (!s.projectCwd) s.projectCwd = s.cwd;
    }
  }
}

// Titles, model, context, cost and plan from the end of a local transcript.
function readTailMeta(s, file, size) {
  const len = Math.min(size, 256 * 1024);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(len);
  try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
  const lines = buf.toString('utf8').split('\n');
  if (len < size) lines.shift();
  for (const line of lines) {
    if (!/"type":"(custom-title|ai-title|agent-name|summary|cost-state|assistant)"/.test(line)) continue;
    if (line.includes('"type":"assistant"') && !line.includes('"usage"') && !line.includes('TodoWrite')) continue;
    try { applyMeta(s, JSON.parse(line)); } catch {}
  }
}

// ---------- usage: tokens and estimated cost per day, from local transcripts ----------
// Read incrementally: each file is parsed once, then only what was appended since.
const usageFiles = new Map(); // file -> { offset, ids: Set, cost, project }
const usageDays = new Map();  // 'YYYY-MM-DD' -> { tokens, cost, models: {}, projects: {} }
let usageBusy = false, usageReady = false;

const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function addUsage(day, field, key, n) {
  const d = usageDays.get(day) || { tokens: 0, cost: 0, models: {}, projects: {} };
  usageDays.set(day, d);
  d[field] += n;
  if (key) { d.models[key.model] = (d.models[key.model] || 0) + (field === 'tokens' ? n : 0); d.projects[key.project] = (d.projects[key.project] || 0) + (field === 'tokens' ? n : 0); }
}

function transcriptFiles() {
  const out = [];
  for (const dir of listDirs(PROJECTS_DIR)) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ file: path.join(dir, e.name), session: e.name.slice(0, -6) });
      // Subagents spend tokens too; their transcripts sit in <session>/subagents/.
      if (e.isDirectory()) {
        const sub = path.join(dir, e.name, 'subagents');
        try { for (const f of fs.readdirSync(sub)) if (f.endsWith('.jsonl')) out.push({ file: path.join(sub, f), session: e.name }); } catch {}
      }
    }
  }
  return out;
}

async function scanUsage() {
  if (usageBusy) return;
  usageBusy = true;
  const cutoff = Date.now() - HISTORY_DAYS * 864e5;
  try {
    for (const { file, session } of transcriptFiles()) {
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      let u = usageFiles.get(file);
      if (!u) { u = { offset: 0, ids: new Set(), cost: 0, lastTs: st.mtimeMs, rest: '' }; usageFiles.set(file, u); }
      if (st.size <= u.offset) continue;
      const s = sessions.get(session);
      const project = projectName(s ? s.projectCwd || s.cwd : path.basename(path.dirname(file)));
      const fh = await fs.promises.open(file, 'r');
      try {
        const CHUNK = 4 << 20;
        while (u.offset < st.size) {
          const buf = Buffer.alloc(Math.min(CHUNK, st.size - u.offset));
          const { bytesRead } = await fh.read(buf, 0, buf.length, u.offset);
          if (!bytesRead) break;
          u.offset += bytesRead;
          const lines = (u.rest + buf.toString('utf8', 0, bytesRead)).split('\n');
          u.rest = lines.pop();
          for (const line of lines) usageLine(u, line, project, cutoff);
        }
      } finally { await fh.close(); }
    }
  } catch (e) { console.error('usage scan failed', e.message); }
  usageBusy = false;
  usageReady = true;
  broadcast();
}

function usageLine(u, line, project, cutoff) {
  if (line.includes('"type":"cost-state"')) {
    // Claude Code's own running cost estimate for the session; count what it added since last time.
    let o; try { o = JSON.parse(line); } catch { return; }
    const c = Number(o.totalCostUSD) || 0;
    if (c > u.cost && u.lastTs >= cutoff) addUsage(dayKey(u.lastTs), 'cost', null, c - u.cost);
    u.cost = c;
    return;
  }
  if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) return;
  let o; try { o = JSON.parse(line); } catch { return; }
  const m = o.message || {}, use = m.usage;
  if (!use || m.model === '<synthetic>') return;
  const ts = Date.parse(o.timestamp) || u.lastTs;
  u.lastTs = ts;
  const id = m.id || o.requestId || o.uuid;
  if (id && u.ids.has(id)) return; // one message is written as several lines
  if (id) u.ids.add(id);
  if (ts < cutoff) return;
  const n = (use.input_tokens || 0) + (use.output_tokens || 0) + (use.cache_creation_input_tokens || 0) + (use.cache_read_input_tokens || 0);
  addUsage(dayKey(ts), 'tokens', { model: modelLabel({ model: m.model }) || m.model, project }, n);
}

function usageSnapshot() {
  const days = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const models = {}, projects = {};
  let total = 0, cost = 0, week = 0;
  const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const k = dayKey(d), v = usageDays.get(k) || { tokens: 0, cost: 0, models: {}, projects: {} };
    days.push({ day: k, tokens: v.tokens, cost: Math.round(v.cost * 100) / 100 });
    total += v.tokens; cost += v.cost;
    if (d >= monday) week += v.tokens;
    for (const [n, x] of Object.entries(v.models)) models[n] = (models[n] || 0) + x;
    for (const [n, x] of Object.entries(v.projects)) projects[n] = (projects[n] || 0) + x;
  }
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, tokens]) => ({ name, tokens }));
  return { ready: usageReady, days, total, week, today: days[days.length - 1], cost: Math.round(cost * 100) / 100,
    models: top(models), projects: top(projects), quota };
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
      const t = rawText(o);
      if (!t) continue; // tool results
      const k = classifyPrompt(t);
      if (k.text) items.push({ role: k.kind === 'system' ? 'system' : 'user', text: clip(k.kind === 'command' ? `You ran ${k.text}` : k.text, 2000), ts: o.timestamp });
    } else if (o.type === 'assistant' && Array.isArray(o.message && o.message.content)) {
      for (const part of o.message.content) {
        if (part.type === 'text' && part.text && part.text.trim()) items.push({ role: 'assistant', text: clip(part.text, 3000), ts: o.timestamp });
        else if (part.type === 'tool_use' && !QUIET_TOOL.test(part.name)) items.push({ role: 'tool', tool: part.name, text: describeTool(part.name, part.input), ts: o.timestamp });
      }
    }
  }
  return items.slice(-maxItems);
}

// ---------- risk labels for permission requests ----------
// Flags worth a second look. Irreversible ones need a press-and-hold on the dashboard.
const RISKS = [
  ['irreversible', /\brm\s+(-\w*[rf]\w*\s+)+|\bgit\s+(reset\s+--hard|clean\s+-\w*f|push\b[^\n]*(\s--force\b|\s-f\b|--force-with-lease))|\bgit\s+branch\s+-D\b|\bdrop\s+(table|database)\b|\btruncate\s+table\b|\bmkfs\b|\bdd\s+if=|\b(shutdown|reboot|poweroff)\b|\bdocker\s+(rm|rmi|volume\s+rm|system\s+prune)\b|\bkubectl\s+delete\b|\bterraform\s+destroy\b|Remove-Item\b[^\n]*-Recurse/i],
  ['publishes', /\bgit\s+push\b|\b(npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bcargo\s+publish\b|\bgh\s+(pr\s+(create|merge)|release\s+create|repo\s+create)\b|\bdocker\s+push\b|\bdeploy\b/i],
  ['network', /\b(curl|wget|ssh|scp|rsync|Invoke-WebRequest|iwr)\b/i],
  ['privileged', /\bsudo\b|\bchmod\s+-R\b|\bchown\s+-R\b/i],
];
function riskOf(tool, input = {}, cwd) {
  const flags = [];
  if (tool === 'Bash' || tool === 'PowerShell') {
    for (const [name, re] of RISKS) if (re.test(input.command || '')) flags.push(name);
  }
  if (tool === 'WebFetch') flags.push('network');
  const file = input.file_path || input.notebook_path;
  // Paths may come from another OS, so compare them as plain strings.
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (file && cwd && !(norm(file) + '/').startsWith(norm(projectDir(cwd)) + '/')) flags.push('outside the project');
  if (/^mcp__.+__(delete|remove|destroy|drop|purge|trash|redeploy|restart|shutdown|reboot)/i.test(tool || '')) flags.push('irreversible');
  return { risks: [...new Set(flags)], hold: flags.includes('irreversible') };
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
  // A Project without a label is named after the repo most of its threads work in.
  const repoVotes = {};
  for (const s of sessions.values()) {
    if (!s.projectThread || !s.projectId) continue;
    const k = canonProject(s.projectId), n = projectName(projectDir(s.projectCwd || s.cwd));
    if (!s.cwd && !s.projectCwd) continue;
    (repoVotes[k] = repoVotes[k] || {})[n] = (repoVotes[k][n] || 0) + 1;
  }
  const projectTitle = (k) => projectLabels[k] || Object.entries(repoVotes[k] || {}).sort((a, b) => b[1] - a[1]).map(([n]) => n)[0] || null;
  for (const s of sessions.values()) {
    if (s.archived && !pendingBySession[s.id]) continue;
    if (!s.live && s.lastActivity < cutoff) continue;
    let status = s.status;
    if (pendingBySession[s.id]) status = 'approval';
    else if (status === 'approval' && Date.now() - s.lastActivity > 10 * 60e3) status = 'idle';
    else if (status === 'working' && Date.now() - s.lastActivity > 15 * 60e3) status = 'stale';
    const dir = projectDir(s.projectCwd || s.cwd);
    const fallback = `${s.projectThread ? 'Thread' : 'Session'} in ${projectName(dir)}${s.machine ? ` on ${s.machine}` : ''}`;
    // Prompts saved before they were classified may still be raw envelopes or notifications.
    const k = s.lastPrompt && s.lastPrompt.startsWith('<') ? classifyPrompt(s.lastPrompt) : null;
    const lastPrompt = k ? (k.kind === 'project' ? k.text : null) : s.lastPrompt;
    const pkey = canonProject(s.projectId || 'unknown');
    const group = s.projectThread
      ? { groupKind: 'project', groupKey: `project:${pkey}`, groupName: projectTitle(pkey) || s.projectLabel || 'Unnamed project', groupLabeled: !!projectLabels[pkey] }
      : { groupKind: 'standalone', groupKey: 'standalone', groupName: 'Standalone sessions' };
    const title = titleOf(s);
    list.push({ id: s.id, title: title || fallback, untitled: !title, machine: s.machine || null, projectThread: !!s.projectThread, ...group,
      project: s.machine ? `${s.machine}:${dir}` : dir, projectPath: dir, projectName: projectName(dir),
      status, live: s.live, desktop: s.desktop, lastActivity: s.lastActivity, activity: s.activity, activityTool: s.activityTool,
      lastPrompt, lastMessage: s.lastMessage, mode: s.mode, pending: pendingBySession[s.id] || 0,
      model: modelLabel(s), context: contextPct(s), cost: typeof s.cost === 'number' ? Math.round(s.cost * 100) / 100 : null, plan: s.todos || null });
  }
  list.sort((a, b) => b.lastActivity - a.lastActivity);
  const pend = [...pending.values()].sort((a, b) => a.createdAt - b.createdAt).map((p) => {
    const s = sessions.get(p.sessionId) || {};
    return { id: p.id, sessionId: p.sessionId, tool: p.tool, input: clipDeep(p.input), suggestions: p.suggestions,
      createdAt: p.createdAt, summary: describeTool(p.tool, p.input), ...riskOf(p.tool, p.input, s.projectCwd || s.cwd),
      sessionTitle: titleOf(s) || `Session in ${projectName(s.projectCwd || s.cwd)}`, projectName: projectName(s.projectCwd || s.cwd), machine: s.machine || null };
  });
  let build = null; try { build = fs.statSync(INDEX).mtimeMs; } catch {}
  return { now: Date.now(), build, sessions: list, pending: pend, usage: usageSnapshot() };
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
    fs.writeFile(STATE_FILE, JSON.stringify({ sessions: keep, labels: projectLabels, aliases: projectAlias, quota }), () => {});
  }, 2000);
}
function loadState() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
  const list = Array.isArray(saved) ? saved : saved.sessions || [];
  Object.assign(projectLabels, saved.labels || {});
  Object.assign(projectAlias, saved.aliases || {});
  if (saved.quota) quota = saved.quota;
  for (const s of list) {
    // Whatever it was doing before the restart is unknown now.
    if (s.status === 'working' || s.status === 'approval') { s.status = 'idle'; s.activity = null; }
    // Sessions saved before prompts were classified: re-read what they started with.
    const k = classifyPrompt(s.firstPrompt);
    if (k.kind === 'project') noteProject(s, k);
    if (k.kind !== 'user') s.firstPrompt = null;
    delete s.envelopeTitle;
    for (const i of s.log || []) {
      if (i.role !== 'user' || !i.text || !i.text.startsWith('<')) continue;
      const c = classifyPrompt(i.text);
      i.role = c.kind === 'system' ? 'system' : 'user';
      i.text = c.kind === 'command' ? `You ran ${c.text}` : c.text;
    }
    s.log = (s.log || []).filter((i) => i.text && !(i.role === 'tool' && QUIET_TOOL.test(i.tool || '')));
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
    if (req.method === 'POST' && url.pathname === '/api/status') { onStatus(await readBody(req), who.machine); broadcast(); return json(res, 200, {}); }
    if (req.method === 'POST' && url.pathname === '/api/meta') {
      const b = await readBody(req);
      if (b.session_id && Array.isArray(b.lines)) {
        const s = getSession(String(b.session_id));
        if (who.machine) s.machine = who.machine;
        s.lastActivity = Math.max(s.lastActivity, Date.now());
        for (const o of b.lines.slice(0, 20)) applyMeta(s, o);
        broadcast();
      }
      return json(res, 200, {});
    }
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
    scanUsage();
    setInterval(scanUsage, 60e3);
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
  Object.assign(sessions.get('d1'), { model: 'claude-opus-5-5', ctxTokens: 61e3, todos: { done: 2, total: 5, current: 'Running the integration tests' } });
  Object.assign(sessions.get('d2'), { model: 'claude-sonnet-5-5', ctxTokens: 23e3 });
  Object.assign(sessions.get('d3'), { model: 'claude-opus-5-5', ctxTokens: 142e3 });
  Object.assign(sessions.get('d4'), { model: 'claude-opus-5-5', ctxTokens: 168e3, todos: { done: 3, total: 6, current: 'Adding damping near singular poses' } });
  quota = { five_hour: { used_percentage: 46, resets_at: Math.round(t / 1000) + 2.3 * 3600 }, seven_day: { used_percentage: 63, resets_at: Math.round(t / 1000) + 2.6 * 86400 }, at: t };
  for (let i = 0; i < HISTORY_DAYS; i++) {
    const day = dayKey(t - i * 864e5), wk = new Date(t - i * 864e5).getDay() % 6 === 0;
    const tokens = Math.round((wk ? 4e6 : 14e6) * (0.4 + Math.random()) * (i === 0 ? 0.6 : 1));
    usageDays.set(day, { tokens, cost: tokens / 1e6 * 1.9, models: { 'Opus 5.5': tokens * 0.8, 'Sonnet 5.5': tokens * 0.2 },
      projects: { 'aurora-api': tokens * 0.5, 'robot-arm': tokens * 0.3, 'pixel-forge': tokens * 0.2 } });
  }
  usageReady = true;
  projectLabels['demo-coordinator'] = 'Aurora launch';
  for (const id of ['d1', 'd2']) Object.assign(sessions.get(id), { projectThread: true, projectId: 'demo-coordinator' });
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
  hold('d1', 'Bash', { command: 'git push --force origin rate-limit', description: 'Overwrite the remote branch with the rebased one' }, []);
  sessions.get('d1').status = 'approval';
  // Keep the working sessions looking busy.
  const steps = [['Read', 'Read kinematics.py'], ['Edit', 'Edit solver.py'], ['Bash', '$ pytest tests/test_ik.py -q'], ['Grep', 'Grep "singular"']];
  let i = 0;
  setInterval(() => { const s = sessions.get('d4'); [s.activityTool, s.activity] = steps[i++ % steps.length]; s.lastActivity = Date.now(); broadcast(); }, 3500);
  broadcast();
}
