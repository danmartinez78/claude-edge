#!/usr/bin/env node
'use strict';
// Connects Claude Code on another machine (over SSH) to this dashboard.
//
//   node add-machine.js <name> <ssh-target> [--address <this-PC-ip>]
//   node add-machine.js <name> <ssh-target> --uninstall
//
// <name> is the label shown on the dashboard. <ssh-target> is anything `ssh` accepts
// (user@host, an alias from ~/.ssh/config). The remote machine needs python3.
// Restart the dashboard server afterwards so it listens on the network address.
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { loadConfig, saveConfig, HOOK_EVENTS } = require('./config');

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv.splice(i, 2)[1] : null; };
const uninstall = argv.includes('--uninstall') && argv.splice(argv.indexOf('--uninstall'), 1);
const address = flag('--address');
const [name, target] = argv;
if (!name || !target || !/^[\w.-]{1,40}$/.test(name)) {
  console.error('usage: node add-machine.js <name> <ssh-target> [--address <this-PC-ip>] [--uninstall]');
  process.exit(2);
}

// Pick this PC's LAN address: private ranges, skipping virtual switches, VPNs and Tailscale.
function lanAddress() {
  for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|VirtualBox|VMware|WSL|Tailscale|docker|br-|veth/i.test(ifname)) continue;
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  return null;
}

const cfg = loadConfig();
const host = address || (cfg.listen || [])[0] || lanAddress();
if (!host) { console.error('Could not find this PC\'s LAN address; pass --address.'); process.exit(1); }
cfg.listen = [...new Set([host, ...(cfg.listen || [])])];
cfg.machines = cfg.machines || {};
if (!uninstall && !cfg.machines[name]) cfg.machines[name] = crypto.randomBytes(24).toString('hex');

const url = `http://${host}:${cfg.port}/api/hook`;
const hooks = Object.fromEntries(Object.entries(HOOK_EVENTS).map(([ev, timeout]) =>
  [ev, { type: 'http', url, timeout, headers: { Authorization: `Bearer ${cfg.machines[name] || ''}` } }]));

// Runs on the remote machine: back up settings.json, drop any earlier dashboard hooks,
// add ours, then check the dashboard is reachable from there.
const py = `
import json, os, shutil, time, urllib.request
port = ${JSON.stringify(String(cfg.port))}
hooks = json.loads(${JSON.stringify(JSON.stringify(hooks))})
uninstall = ${uninstall ? 'True' : 'False'}
path = os.path.expanduser(os.path.join(os.environ.get("CLAUDE_CONFIG_DIR", "~/.claude"), "settings.json"))
os.makedirs(os.path.dirname(path), exist_ok=True)
settings = {}
if os.path.exists(path):
    shutil.copy(path, "%s.bak-claude-edge-%d" % (path, int(time.time())))
    with open(path) as f:
        settings = json.load(f)
ours = lambda h: h.get("type") == "http" and str(h.get("url", "")).endswith(":%s/api/hook" % port)
allh = settings.get("hooks", {})
for ev in list(allh):
    groups = [dict(g, hooks=[h for h in g.get("hooks", []) if not ours(h)]) for g in allh[ev]]
    allh[ev] = [g for g in groups if g["hooks"]]
    if not allh[ev]:
        del allh[ev]
if not uninstall:
    for ev, h in hooks.items():
        allh.setdefault(ev, []).append({"hooks": [h]})
if allh:
    settings["hooks"] = allh
else:
    settings.pop("hooks", None)
with open(path, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\\n")
print(("Removed dashboard hooks from " if uninstall else "Installed dashboard hooks in ") + path)
if not uninstall:
    health = list(hooks.values())[0]["url"].replace("/api/hook", "/health")
    try:
        urllib.request.urlopen(health, timeout=4).read()
        print("Dashboard reachable from this machine: " + health)
    except Exception as e:
        print("WARNING: can't reach the dashboard at %s (%s). Check the Windows firewall and that the server was restarted." % (health, e))
`;

const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', target, 'python3', '-'], { input: py, encoding: 'utf8' });
process.stdout.write(r.stdout || '');
if (r.status !== 0) {
  process.stderr.write(r.stderr || '');
  console.error(`\nSSH to ${target} failed (exit ${r.status}). Nothing was saved locally.`);
  process.exit(1);
}
if (uninstall) delete cfg.machines[name];
saveConfig(cfg);
console.log(uninstall ? `Removed ${name}.` : `Added ${name}. Restart the dashboard server if it isn't listening on ${host} yet.`);
