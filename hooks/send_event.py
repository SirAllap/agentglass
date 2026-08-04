#!/usr/bin/env python3
"""agentglass event forwarder.

Reads a Claude Code hook payload on stdin and POSTs a normalized event to the
agentglass server. Zero third-party deps (stdlib only).

Usage (from a Claude Code hook command):
    send_event.py --source-app my-project --event-type PreToolUse
    send_event.py --source-app my-project --event-type Stop --add-usage

Env:
    AGENTGLASS_SERVER   server base url (default http://127.0.0.1:4000)
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

DEFAULT_SERVER = os.environ.get("AGENTGLASS_SERVER", "http://127.0.0.1:4000")

# When a detached send fails, later hook invocations skip the network entirely
# for this long, so a stopped server costs bare interpreter start per tool call.
BREAKER_TTL_S = 30
PAYLOAD_PREFIX = "agentglass-evt-"
PAYLOAD_MAX_AGE_S = 3600

def _agentglass_local_only(url):
    """Refuse to send transcript/telemetry anywhere but this machine.
    AGENTGLASS_SERVER is attacker-influenceable (a repo-local settings.json can
    set it), and the payloads carry full session content. Opt out explicitly
    with AGENTGLASS_ALLOW_REMOTE=1 if you really run the server elsewhere.

    Returns the URL to actually connect to: a `localhost` host is rewritten to
    `127.0.0.1`, because the server binds IPv4-only and on hosts that resolve
    localhost to ::1 first the refused IPv6 connect can cost seconds per event."""
    import os
    from urllib.parse import urlparse, urlunparse
    # Exactly "1": a truthy test would let AGENTGLASS_ALLOW_REMOTE=0 — which
    # reads as "off" — switch the guard off instead of on.
    if os.environ.get("AGENTGLASS_ALLOW_REMOTE") == "1":
        return url
    u = urlparse(url or "")
    if u.scheme not in ("http", "https") or (u.hostname or "") not in ("localhost", "127.0.0.1", "::1"):
        import sys
        sys.stderr.write("[agentglass] refusing non-local server %r\n" % url)
        sys.exit(0)
    if u.hostname == "localhost":
        netloc = "127.0.0.1" + (":%d" % u.port if u.port else "")
        url = urlunparse(u._replace(netloc=netloc))
    return url



def _marker_path():
    return os.path.join(tempfile.gettempdir(), "agentglass-hook-down")


def _breaker_active():
    try:
        return (time.time() - os.path.getmtime(_marker_path())) < BREAKER_TTL_S
    except OSError:
        return False


def _mark_down():
    try:
        with open(_marker_path(), "a"):
            pass
        os.utime(_marker_path(), None)
    except OSError:
        pass


def _mark_up():
    try:
        os.unlink(_marker_path())
    except OSError:
        pass


def _sweep_stale_payloads():
    """Delete payload files a killed child never got to clean up."""
    tmp = tempfile.gettempdir()
    cutoff = time.time() - PAYLOAD_MAX_AGE_S
    try:
        names = os.listdir(tmp)
    except OSError:
        return
    for name in names:
        if not name.startswith(PAYLOAD_PREFIX):
            continue
        path = os.path.join(tmp, name)
        try:
            if os.path.getmtime(path) < cutoff:
                os.unlink(path)
        except OSError:
            pass


def post_event(server, data):
    req = urllib.request.Request(
        server.rstrip("/") + "/ingest",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=3) as resp:
        resp.read()


def send_detached(path, server):
    """Child-process mode: POST a spawned payload file, maintain the breaker."""
    try:
        with open(path, "rb") as f:
            data = f.read()
        post_event(server, data)
    except Exception:
        _mark_down()
    else:
        _mark_up()
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
        _sweep_stale_payloads()


def spawn_detached(server, data):
    """Hand the POST to a detached child so the hook never waits on the network."""
    fd, path = tempfile.mkstemp(prefix=PAYLOAD_PREFIX, suffix=".json")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    flags = 0
    if os.name == "nt":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NO_WINDOW
    try:
        subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "--send-detached", path,
             "--server", server],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            creationflags=flags,
        )
    except Exception:
        try:
            os.unlink(path)
        except OSError:
            pass
        raise


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
    ap.add_argument("--send-detached", default=None, metavar="PATH",
                    help=argparse.SUPPRESS)
    args = ap.parse_args()
    server = _agentglass_local_only(getattr(args, "server", None) or DEFAULT_SERVER)

    if args.send_detached:
        send_detached(args.send_detached, server)
        return

    if _breaker_active():
        # Server known down: drain stdin so Claude Code never sees a broken
        # pipe, and skip the network entirely.
        try:
            sys.stdin.read()
        except OSError:
            pass
        sys.exit(0)

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
    try:
        spawn_detached(server, data)
    except Exception:
        # If the spawn itself fails, degrade to the old inline send rather
        # than silently dropping the event.
        try:
            post_event(server, data)
        except Exception as e:
            # Never block Claude Code on an observability failure.
            print(f"[agentglass] send failed: {e}", file=sys.stderr)

    # Pass hook input straight through so we don't interfere with the hook chain.
    sys.exit(0)


if __name__ == "__main__":
    main()
