'use strict';
// Shared config: port + random token, stored outside OneDrive in ~/.claude-edge/config.json.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CONF_DIR = path.join(os.homedir(), '.claude-edge');
const CONF_FILE = path.join(CONF_DIR, 'config.json');

function loadConfig() {
  fs.mkdirSync(CONF_DIR, { recursive: true });
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8')); } catch {}
  let changed = false;
  if (!c.token) { c.token = crypto.randomBytes(24).toString('hex'); changed = true; }
  if (!c.port) { c.port = 47821; changed = true; }
  if (changed) fs.writeFileSync(CONF_FILE, JSON.stringify(c, null, 2));
  return c;
}

function saveConfig(c) {
  fs.writeFileSync(CONF_FILE, JSON.stringify(c, null, 2));
}

// Hook events the dashboard listens to, with timeouts in seconds. PermissionRequest is held
// open while waiting for a tap on the dashboard.
const HOOK_EVENTS = {
  SessionStart: 3, UserPromptSubmit: 3, PreToolUse: 3, PostToolUse: 3,
  PermissionRequest: 600, Notification: 3, Stop: 3, SessionEnd: 2,
};

module.exports = { loadConfig, saveConfig, HOOK_EVENTS, CONF_DIR, CONF_FILE };
