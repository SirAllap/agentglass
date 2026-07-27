#!/usr/bin/env python3
"""agentglass event forwarder.

Reads a Claude Code hook payload on stdin and POSTs a normalized event to the
agentglass server. Zero third-party deps (stdlib only).

Usage (from a Claude Code hook command):
    send_event.py --source-app my-project --event-type PreToolUse
    send_event.py --source-app my-project --event-type Stop --add-usage

Env:
    AGENTGLASS_SERVER   server base url (default http://localhost:4000)
"""
import argparse
import json
import os
import sys
import urllib.request

DEFAULT_SERVER = os.environ.get("AGENTGLASS_SERVER", "http://localhost:4000")

def _agentglass_local_only(url):
    """Refuse to send transcript/telemetry anywhere but this machine.
    AGENTGLASS_SERVER is attacker-influenceable (a repo-local settings.json can
    set it), and the payloads carry full session content. Opt out explicitly
    with AGENTGLASS_ALLOW_REMOTE=1 if you really run the server elsewhere."""
    import os
    from urllib.parse import urlparse
    if os.environ.get("AGENTGLASS_ALLOW_REMOTE"):
        return
    u = urlparse(url or "")
    if u.scheme not in ("http", "https") or (u.hostname or "") not in ("localhost", "127.0.0.1", "::1"):
        import sys
        sys.stderr.write("[agentglass] refusing non-local server %r\n" % url)
        sys.exit(0)



def reverse_lines(path, block_size=64 * 1024):
    """Yield binary lines newest-first without loading the transcript."""
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        pos = f.tell()
        pending = b""
        while pos:
            size = min(block_size, pos)
            pos -= size
            f.seek(pos)
            parts = (f.read(size) + pending).split(b"\n")
            pending = parts[0]
            for line in reversed(parts[1:]):
                if line.strip():
                    yield line
        if pending.strip():
            yield pending


def read_latest_usage(path):
    """Return the newest assistant turn's usage and model without retaining chat."""
    try:
        for raw in reverse_lines(path):
            try:
                obj = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            msg = obj.get("message") or {}
            if not isinstance(msg, dict):
                continue
            usage = msg.get("usage")
            if isinstance(usage, dict):
                return usage, msg.get("model")
    except OSError:
        pass
    return None, None


def main():
    # agentglass's own internal `claude` calls (e.g. the diff walkthrough) set
    # this env so they aren't re-ingested as phantom sessions in the dashboard.
    if os.environ.get("AGENTGLASS_INTERNAL"):
        return
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-app", default=os.path.basename(os.getcwd()))
    ap.add_argument("--event-type", default=None)
    ap.add_argument("--server", default=DEFAULT_SERVER)
    ap.add_argument("--add-usage", action="store_true",
                    help="attach only the latest turn's usage for token/cost computation")
    # Existing installations may still invoke the old flag until setup is rerun.
    ap.add_argument("--add-chat", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args()
    _agentglass_local_only(getattr(args, "server", None) or DEFAULT_SERVER)

    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        payload = {}

    session_id = payload.get("session_id") or payload.get("sessionId") or "unknown"
    event_type = args.event_type or payload.get("hook_event_name") or "Unknown"
    model_name = payload.get("model") or payload.get("model_name")

    usage = None
    if args.add_usage or args.add_chat:
        tpath = payload.get("transcript_path") or payload.get("transcriptPath")
        if tpath:
            usage, tmodel = read_latest_usage(tpath)
            model_name = model_name or tmodel
            if usage:
                payload["usage"] = usage

    body = {
        "source_app": args.source_app,
        "session_id": session_id,
        "hook_event_type": event_type,
        "payload": payload,
        "model_name": model_name,
    }
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        args.server.rstrip("/") + "/ingest",
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
