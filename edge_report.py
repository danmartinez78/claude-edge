#!/usr/bin/env python3
"""Claude Edge reporter for sessions on other machines. add-machine.js installs it next to
settings.json, with edge.json holding the dashboard URL and this machine's token.

  edge_report.py hook     command hook: send the session's title, model, context and plan,
                          read from its transcript (the dashboard can't read it from here)
  edge_report.py status   status line: forward Claude Code's status data (usage limits, model,
                          context), then print the status line you had before, or a short one
"""
import json, os, subprocess, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
try:
    with open(os.path.join(HERE, "edge.json")) as f:
        CONF = json.load(f)
except Exception:
    CONF = {}


def post(path, body, timeout):
    if not CONF.get("url"):
        return
    req = urllib.request.Request(CONF["url"] + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + CONF.get("token", "")})
    try:
        urllib.request.urlopen(req, timeout=timeout).read()
    except Exception:
        pass  # the dashboard being off must never get in the way


META = ('"type":"custom-title"', '"type":"ai-title"', '"type":"agent-name"', '"type":"summary"', '"type":"cost-state"')
TAIL = 256 * 1024


def meta_lines(path):
    """The few transcript lines the dashboard needs, with message content stripped."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - TAIL))
            lines = f.read().decode("utf-8", "replace").split("\n")
    except Exception:
        return []
    if size > TAIL:
        lines = lines[1:]
    latest, usage, todos = {}, None, None
    for line in lines:
        if any(k in line for k in META):
            try:
                o = json.loads(line)
                latest[o["type"]] = o
            except Exception:
                pass
        elif '"type":"assistant"' in line and ('"usage"' in line or "TodoWrite" in line):
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("isSidechain"):
                continue
            m = o.get("message") or {}
            if m.get("usage") and m.get("model") != "<synthetic>":
                usage = {"type": "assistant", "timestamp": o.get("timestamp"),
                         "message": {"model": m.get("model"), "usage": m.get("usage"), "content": []}}
            for p in m.get("content") or []:
                if isinstance(p, dict) and p.get("type") == "tool_use" and p.get("name") == "TodoWrite":
                    todos = {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "TodoWrite", "input": p.get("input")}]}}
    return list(latest.values()) + [x for x in (todos, usage) if x]


def hook():
    try:
        ev = json.load(sys.stdin)
    except Exception:
        return
    if ev.get("session_id") and ev.get("transcript_path"):
        post("/api/meta", {"session_id": ev["session_id"], "lines": meta_lines(ev["transcript_path"])}, 2)


def status():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw)
    except Exception:
        data = {}
    post("/api/status", data, 0.8)
    prev = CONF.get("prev_status")
    if prev:
        r = subprocess.run(prev, shell=True, input=raw, capture_output=True, text=True)
        sys.stdout.write(r.stdout)
        return
    parts = [(data.get("model") or {}).get("display_name") or ""]
    ctx = (data.get("context_window") or {}).get("used_percentage")
    if ctx is not None:
        parts.append("%d%% context" % ctx)
    five = ((data.get("rate_limits") or {}).get("five_hour") or {}).get("used_percentage")
    if five is not None:
        parts.append("5h %d%%" % five)
    print(" · ".join(p for p in parts if p))


if __name__ == "__main__":
    {"hook": hook, "status": status}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda: None)()
