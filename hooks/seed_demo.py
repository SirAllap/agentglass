#!/usr/bin/env python3
"""Seed the dashboard with a burst of realistic demo events (no Claude needed).

    python3 hooks/seed_demo.py            # steady stream for ~30s
    python3 hooks/seed_demo.py --once     # one batch and exit
"""
import argparse
import json
import os
import random
import time
import urllib.request

SERVER = os.environ.get("AGENTGLASS_SERVER", "http://127.0.0.1:4000")

def _agentglass_local_only(url):
    """Refuse to send transcript/telemetry anywhere but this machine.
    AGENTGLASS_SERVER is attacker-influenceable (a repo-local settings.json can
    set it), and the payloads carry full session content. Opt out explicitly
    with AGENTGLASS_ALLOW_REMOTE=1 if you really run the server elsewhere."""
    import os
    from urllib.parse import urlparse, urlunparse
    # Exactly "1": a truthy test would let AGENTGLASS_ALLOW_REMOTE=0 — which
    # reads as "off" to every person who writes it — switch the guard off
    # instead of on. So would "false", "no" and "off".
    if os.environ.get("AGENTGLASS_ALLOW_REMOTE") == "1":
        return url
    u = urlparse(url or "")
    if u.scheme not in ("http", "https") or (u.hostname or "") not in ("localhost", "127.0.0.1", "::1"):
        import sys
        sys.stderr.write("[agentglass] refusing non-local server %r\n" % url)
        sys.exit(0)
    # `localhost` is still allowed above — it is this machine, which is the only
    # thing the guard is about. It is rewritten because of what it costs: the
    # server binds IPv4-only, and on a host whose resolver answers ::1 first
    # every event pays a refused IPv6 connect before falling back. That is
    # microseconds on most machines and seconds on some. Rewriting here rather
    # than only in the default means an install that already wrote `localhost`
    # into its settings.json gets the fix without re-running setup.
    if u.hostname == "localhost":
        netloc = "127.0.0.1" + (":%d" % u.port if u.port else "")
        url = urlunparse(u._replace(netloc=netloc))
    return url

APPS = ["api-refactor", "docs-agent", "test-writer", "migration"]
MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]
TOOLS = ["Bash", "Read", "Edit", "Grep", "Write", "WebFetch", "Task"]
_seed = random.Random(7)


def post(body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(SERVER.rstrip("/") + "/ingest", data=data,
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=2).read()
    except Exception as e:
        print("post failed:", e)


def session():
    app = _seed.choice(APPS)
    sid = f"{app}-{_seed.randint(1000,9999)}"
    model = _seed.choice(MODELS)
    post({"source_app": app, "session_id": sid, "hook_event_type": "SessionStart", "model_name": model})
    post({"source_app": app, "session_id": sid, "hook_event_type": "UserPromptSubmit", "model_name": model,
          "payload": {"prompt": "do the thing"}})
    for _ in range(_seed.randint(3, 8)):
        tool = _seed.choice(TOOLS)
        tid = f"t{_seed.randint(0,99999)}"
        post({"source_app": app, "session_id": sid, "hook_event_type": "PreToolUse", "model_name": model,
              "payload": {"tool_name": tool, "tool_use_id": tid}})
        time.sleep(_seed.uniform(0.05, 0.4))
        err = _seed.random() < 0.12
        post({"source_app": app, "session_id": sid,
              "hook_event_type": "PostToolUseFailure" if err else "PostToolUse", "model_name": model,
              "payload": {"tool_name": tool, "tool_use_id": tid, **({"error": "command failed"} if err else {})}})
    # final Stop with cumulative token usage
    itok, otok = _seed.randint(3000, 40000), _seed.randint(1000, 15000)
    post({"source_app": app, "session_id": sid, "hook_event_type": "Stop", "model_name": model,
          "chat": [{"message": {"model": model, "usage": {
              "input_tokens": itok, "output_tokens": otok,
              "cache_read_input_tokens": _seed.randint(0, 60000)}}}]})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--seconds", type=int, default=30)
    args = ap.parse_args()
    global SERVER
    SERVER = _agentglass_local_only(SERVER)
    print(f"seeding → {SERVER}")
    if args.once:
        session()
        return
    end = time.time() + args.seconds
    while time.time() < end:
        session()
        time.sleep(_seed.uniform(0.3, 1.2))
    print("done")


if __name__ == "__main__":
    main()
