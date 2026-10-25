#!/usr/bin/env node
'use strict';
// Status line for Claude Code on this PC (install-hooks.js sets it up). Claude Code pipes it the
// session's status data: usage limits, model, context. Forward that to the dashboard, then print
// the status line you had before, or a short one.
const http = require('http');
const { execSync } = require('child_process');
const { loadConfig } = require('./config');

const cfg = loadConfig();
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let data = {};
  try { data = JSON.parse(raw); } catch {}
  const req = http.request({ host: '127.0.0.1', port: cfg.port, path: '/api/status', method: 'POST', timeout: 800,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` } });
  req.on('error', () => {}).on('timeout', () => req.destroy()).on('close', print);
  req.end(raw || '{}');

  function print() {
    if (cfg.prevStatusLine) {
      try { process.stdout.write(execSync(cfg.prevStatusLine, { input: raw, encoding: 'utf8', timeout: 5000 })); } catch {}
      return;
    }
    const parts = [data.model && data.model.display_name];
    const ctx = data.context_window && data.context_window.used_percentage;
    if (ctx != null) parts.push(`${Math.round(ctx)}% context`);
    const five = data.rate_limits && data.rate_limits.five_hour && data.rate_limits.five_hour.used_percentage;
    if (five != null) parts.push(`5h ${Math.round(five)}%`);
    console.log(parts.filter(Boolean).join(' · '));
  }
});
