#!/usr/bin/env node
'use strict';
// Adds (or with --uninstall removes) the dashboard's HTTP hooks in ~/.claude/settings.json.
// Backs the file up first and only touches hook entries pointing at this dashboard.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadConfig } = require('./config');

const cfg = loadConfig();
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const URL = `http://127.0.0.1:${cfg.port}/api/hook`;
const uninstall = process.argv.includes('--uninstall');

// Seconds. PermissionRequest is held open while waiting for a tap on the dashboard.
const EVENTS = {
  SessionStart: 3, UserPromptSubmit: 3, PreToolUse: 3, PostToolUse: 3,
  PermissionRequest: 600, Notification: 3, Stop: 3, SessionEnd: 2,
};

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

fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(uninstall ? `Removed Claude Edge hooks from ${SETTINGS}` : `Installed Claude Edge hooks in ${SETTINGS} -> ${URL}`);
