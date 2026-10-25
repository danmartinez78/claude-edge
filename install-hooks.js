#!/usr/bin/env node
'use strict';
// Adds (or with --uninstall removes) the dashboard's HTTP hooks in ~/.claude/settings.json.
// Backs the file up first and only touches hook entries pointing at this dashboard.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadConfig, saveConfig, HOOK_EVENTS: EVENTS } = require('./config');

const cfg = loadConfig();
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const URL = `http://127.0.0.1:${cfg.port}/api/hook`;
const uninstall = process.argv.includes('--uninstall');

let settings = {};
if (fs.existsSync(SETTINGS)) {
  const raw = fs.readFileSync(SETTINGS, 'utf8');
  settings = JSON.parse(raw);
  fs.writeFileSync(`${SETTINGS}.bak-claude-edge-${Date.now()}`, raw);
}
settings.hooks = settings.hooks || {};

const ours = (h) => h && h.type === 'http' && typeof h.url === 'string' && h.url.endsWith(`:${cfg.port}/api/hook`);
for (const ev of Object.keys(settings.hooks)) {
  settings.hooks[ev] = settings.hooks[ev]
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(h)) }))
    .filter((g) => g.hooks.length);
  if (!settings.hooks[ev].length) delete settings.hooks[ev];
}

if (!uninstall) {
  for (const [ev, timeout] of Object.entries(EVENTS)) {
    (settings.hooks[ev] = settings.hooks[ev] || []).push({
      hooks: [{ type: 'http', url: URL, timeout, headers: { Authorization: `Bearer ${cfg.token}` } }],
    });
  }
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

// The status line is how Claude Code shares usage limits, model and context. Ours forwards that
// data and then runs whatever status line was there before, so nothing visible changes.
const STATUS = path.join(__dirname, 'statusline.js');
const ourStatus = (sl) => sl && typeof sl.command === 'string' && sl.command.includes(STATUS);
if (uninstall) {
  if (ourStatus(settings.statusLine)) {
    if (cfg.prevStatusLine) settings.statusLine = { type: 'command', command: cfg.prevStatusLine };
    else delete settings.statusLine;
  }
  delete cfg.prevStatusLine;
} else if (!ourStatus(settings.statusLine)) {
  if (settings.statusLine && settings.statusLine.command) cfg.prevStatusLine = settings.statusLine.command;
  settings.statusLine = { type: 'command', command: `node "${STATUS}"` };
}
saveConfig(cfg);

fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(uninstall ? `Removed Claude Edge hooks and status line from ${SETTINGS}` : `Installed Claude Edge hooks and status line in ${SETTINGS} -> ${URL}`);
