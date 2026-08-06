#!/usr/bin/env python3
"""agentglass event forwarder.

Reads a Claude Code or Kimi Code CLI hook payload on stdin and POSTs a
normalized event to the agentglass server. Zero third-party deps (stdlib only).

Usage (from a Claude Code hook command):
    send_event.py --source-app my-project --event-type PreToolUse
    send_event.py --source-app my-project --event-type Stop --add-chat
    send_event.py --model-name kimi-code/k3

Env:
    AGENTGLASS_SERVER   server base url (default http://127.0.0.1:4000)
"""
import argparse
import json
import os
import sys
import urllib.request

DEFAULT_SERVER = os.environ.get("AGENTGLASS_SERVER", "http://127.0.0.1:4000")

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



def read_transcript(path):
    """Return (chat_lines, model_name) from a Claude Code transcript JSONL."""
    chat, model = [], None
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                chat.append(obj)
                msg = obj.get("message") or {}
                if isinstance(msg, dict) and msg.get("model"):
                    model = msg["model"]
    except OSError:
        pass
    return chat, model


def main():
    # agentglass's own internal `claude` calls (e.g. the diff walkthrough) set
    # this env so they aren't re-ingested as phantom sessions in the dashboard.
    if os.environ.get("AGENTGLASS_INTERNAL"):
        return
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-app", default=os.path.basename(os.getcwd()))
    ap.add_argument("--event-type", default=None)
    ap.add_argument("--model-name", default=None,
                    help="fallback model when the hook payload omits it")
    ap.add_argument("--server", default=DEFAULT_SERVER)
    ap.add_argument("--add-chat", action="store_true",
                    help="attach the transcript so tokens/cost can be computed")
    args = ap.parse_args()
    server = _agentglass_local_only(getattr(args, "server", None) or DEFAULT_SERVER)

    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        payload = {}

    session_id = payload.get("session_id") or payload.get("sessionId") or "unknown"
    event_type = args.event_type or payload.get("hook_event_name") or "Unknown"
    model_name = payload.get("model") or payload.get("model_name") or args.model_name

    chat = None
    if args.add_chat:
        tpath = payload.get("transcript_path") or payload.get("transcriptPath")
        if tpath:
            chat, tmodel = read_transcript(tpath)
            model_name = model_name or tmodel

    body = {
        "source_app": args.source_app,
        "session_id": session_id,
        "hook_event_type": event_type,
        "payload": payload,
        "model_name": model_name,
    }
    # Which tmux pane this agent is in. Nothing in the payload says so, and
    # nothing on the server can work it out: several agents share one working
    # directory, so a pane cannot be matched by cwd, and the session id in the
    # process environment is the one it LAUNCHED with — on a resumed session it
    # names a transcript that does not exist. This hook, though, is a child of
    # the agent, so it simply inherits the answer.
    pane = os.environ.get("TMUX_PANE")
    if pane:
        body["tmux_pane"] = pane
    if chat is not None:
        body["chat"] = chat

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        server.rstrip("/") + "/ingest",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            resp.read()
    except Exception as e:
        # Never block Claude Code on an observability failure.
        print(f"[agentglass] send failed: {e}", file=sys.stderr)

    # Pass hook input straight through so we don't interfere with the hook chain.
    sys.exit(0)


if __name__ == "__main__":
    main()
