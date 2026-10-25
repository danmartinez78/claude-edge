#!/usr/bin/env node
'use strict';
// Builds the iCUE widget with this PC's dashboard token filled in, then validates and packages it
// with Corsair's CLI (npm install -g icuewidget-cli). Output: icue-widget/dist/, which holds your
// token, so it's git-ignored. Import the .icuewidget file in iCUE.
//
//   node icue-widget/build.js            build, validate, package
//   node icue-widget/build.js --no-token build without the token (to share the widget)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('../config');

const cfg = loadConfig();
const withToken = !process.argv.includes('--no-token');
const SRC = __dirname;
const OUT = path.join(SRC, 'dist', 'ClaudeEdge');

fs.rmSync(path.join(SRC, 'dist'), { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'resources'), { recursive: true });
for (const f of ['manifest.json', 'resources/icon.svg']) fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
if (cfg.port !== 47821) {
  console.error(`The widget is built for port 47821, but the dashboard uses ${cfg.port}. Update SERVER in index.html and the manifest permission.`);
  process.exit(1);
}
let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
if (withToken) html = html.replace(`content="accessToken" data-label="'Access token'" data-type="textfield" data-default="''"`,
  `content="accessToken" data-label="'Access token'" data-type="textfield" data-default="'${cfg.token}'"`);
fs.writeFileSync(path.join(OUT, 'index.html'), html);
console.log(`Built ${manifest.name} ${manifest.version} in ${OUT}${withToken ? ' (with this PC\'s token)' : ''}`);

const cli = (args) => spawnSync('icuewidget', args, { cwd: path.dirname(OUT), stdio: 'inherit', shell: true });
const probe = spawnSync('icuewidget', ['--version'], { shell: true, encoding: 'utf8' });
if (probe.status !== 0) {
  console.log('\nThe iCUE widget CLI isn\'t installed, so the widget wasn\'t validated or packaged. Install it with:\n  npm install -g icuewidget-cli');
  process.exit(0);
}
if (cli(['validate', 'ClaudeEdge']).status !== 0) process.exit(1);
process.exit(cli(['package', 'ClaudeEdge']).status || 0);
