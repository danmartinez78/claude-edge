#!/usr/bin/env python3
"""Claude Edge reporter for sessions on other machines. add-machine.js installs it next to
settings.json, with edge.json holding the dashboard URL and this machine's token.

  edge_report.py hook     command hook: send the session's title, model, context and plan,
                          read from its transcript (the dashboard can't read it from here)
  edge_report.py status   status line: forward Claude Code's status data (usage limits, model,
                          context), then print the status line you had before, or a short one
  edge_report.py usage    if installed with --usage: at most every 30 minutes, ask Anthropic for
                          the plan's limits using this machine's Claude login, and send the
                          percentages to the dashboard. The token itself is never sent there.
                          Status lines only run in terminal sessions, so this keeps limits current.
"""
import datetime, json, os, subprocess, sys, time, urllib.error, urllib.request

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
    latest, usage, todos, card = {}, None, None, None
    for line in lines:
        if any(k in line for k in META):
            try:
                o = json.loads(line)
                latest[o["type"]] = o
            except Exception:
                pass
        elif '"type":"assistant"' in line and ('"usage"' in line or "TodoWrite" in line or "update_status" in line):
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
                if isinstance(p, dict) and p.get("type") == "tool_use" and str(p.get("name", "")).endswith("__update_status"):
                    card = {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": p.get("name"), "input": p.get("input")}]}}
    return list(latest.values()) + [x for x in (todos, card, usage) if x]


USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
USAGE_EVERY = 29 * 60  # cron fires every 30 minutes; stay just under so a run isn't skipped


def epoch(v):
    if isinstance(v, (int, float)):
        return v
    return datetime.datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp()


def poll_usage(force=False):
    """Returns a one-line result for the installer to print. Never prints or sends the token."""
    if not CONF.get("usage"):
        return "usage checks are off"
    stamp = os.path.join(HERE, "usage.stamp")
    try:
        if not force and time.time() - os.path.getmtime(stamp) < USAGE_EVERY:
            return "checked recently"
    except OSError:
        pass
    # Count failures too, so a problem can't turn into a request on every hook.
    with open(stamp, "w"):
        pass
    try:
        with open(os.path.join(os.path.dirname(HERE), ".credentials.json")) as f:
            login = json.load(f).get("claudeAiOauth") or {}
    except Exception:
        login = {}
    token = login.get("accessToken")
    if not token:
        return "no Claude login found on this machine"
    # Refreshing could sign Claude Code out, so an expired token waits for Claude Code to renew it.
    if login.get("expiresAt") and login["expiresAt"] < time.time() * 1000:
        return "the Claude login has expired; it renews the next time Claude Code runs"
    req = urllib.request.Request(USAGE_URL, headers={"Authorization": "Bearer " + token,
                                                     "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-edge"})
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        return "the usage service answered HTTP %d" % e.code
    except Exception as e:
        return "couldn't reach the usage service (%s)" % type(e).__name__
    limits = {}
    for name in ("five_hour", "seven_day"):
        w = data.get(name) or {}
        try:
            if w.get("utilization") is not None and w.get("resets_at"):
                limits[name] = {"used_percentage": float(w["utilization"]), "resets_at": epoch(w["resets_at"])}
        except Exception:
            pass
    if not limits:
        return "the usage service sent no limits (fields: %s)" % ", ".join(sorted(data))
    post("/api/status", {"rate_limits": limits}, 1)
    return "sent " + ", ".join("%s %d%%" % (k, v["used_percentage"]) for k, v in limits.items())


def hook():
    try:
        ev = json.load(sys.stdin)
    except Exception:
        return
    if ev.get("session_id") and ev.get("transcript_path"):
        post("/api/meta", {"session_id": ev["session_id"], "lines": meta_lines(ev["transcript_path"])}, 1)
    try:
        poll_usage()
    except Exception:
        pass


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
    {"hook": hook, "status": status,
     "usage": lambda: print(poll_usage("--force" in sys.argv))}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda: None)()
