#!/usr/bin/env python3
"""agentglass control-plane gate (OPT-IN).

A PreToolUse hook that holds a tool call until you approve or deny it from the
agentglass dashboard. Point a project's PreToolUse hook at this to gate its
tools remotely.

    python3 hooks/gate_event.py --source-app my-project

Safety by design — it NEVER blocks your agents by accident:
  * if agentglass is unreachable or errors → allow (exit 0, no output)
  * if no one decides within the timeout → the server auto-allows
  * only sessions wired to this hook are gated; everything else is untouched

Durable across a server restart: the hook picks the request id, so if the
connection drops mid-wait (agentglass restarted, a crash, a proxy hanging up)
it re-attaches to that same request instead of giving up and falling into the
timeout branch. It only gives up once its own deadline has passed.

Deny/allow are returned to Claude Code via the PreToolUse permissionDecision.

Env:
    AGENTGLASS_SERVER   server base url (default http://localhost:4000)
    AGENTGLASS_GATE_TIMEOUT  seconds to wait for a human (default 60)
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

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

TIMEOUT = int(os.environ.get("AGENTGLASS_GATE_TIMEOUT", "60"))
# Default is fail-open: if agentglass is unreachable, allow (never block agents
# by accident). Set this to invert it — an unreachable control plane DENIES the
# tool call. Opt-in, because with agentglass down every gated call is blocked.
FAIL_CLOSED = os.environ.get("AGENTGLASS_GATE_FAILCLOSED") == "1"


def allow_silently():
    # No output + exit 0 → Claude Code proceeds as normal (default behaviour).
    sys.exit(0)


def emit(decision: str, reason: str):
    # Explicit PreToolUse decision. "deny" blocks the tool; "allow" approves it.
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


def main():
    # agentglass's own internal `claude` calls bypass the gate (allow silently).
    if os.environ.get("AGENTGLASS_INTERNAL"):
        allow_silently()
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-app", default=os.path.basename(os.getcwd()))
    ap.add_argument("--server", default=DEFAULT_SERVER)
    args = ap.parse_args()
    _agentglass_local_only(getattr(args, "server", None) or DEFAULT_SERVER)

    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        allow_silently()

    # The id is ours, not the server's. That is what makes a dropped connection
    # recoverable: without it there is no name for the request we were waiting
    # on, and a restart mid-wait can only be read as "no answer".
    gate_id = str(uuid.uuid4())
    body = json.dumps({
        "id": gate_id,
        "source_app": args.source_app,
        "session_id": payload.get("session_id") or "unknown",
        "tool_name": payload.get("tool_name") or "?",
        "tool_input": payload.get("tool_input") or {},
        "timeout_ms": TIMEOUT * 1000,
    }).encode("utf-8")

    # Carry the shared secret when the server has one. /gate is the control plane
    # (a POST raises an operator-facing approval prompt), so a token-protected
    # server requires auth here — otherwise any local process could inject spoofed
    # approval prompts. The hook runs on the same machine and reads it from env.
    headers = {"Content-Type": "application/json"}
    token = os.environ.get("AGENTGLASS_TOKEN", "").strip()
    if token:
        headers["Authorization"] = "Bearer " + token

    base = args.server.rstrip("/")

    def submit(remaining):
        """POST the request. Idempotent on our id: the server re-attaches to a
        live request rather than raising a second prompt for the same call."""
        req = urllib.request.Request(base + "/gate", data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=remaining) as resp:
            return json.loads(resp.read())

    def reattach(remaining):
        """Long-poll the request we already sent. 404 means the server has no
        record of it — it never arrived — so the caller re-submits."""
        url = base + "/gate/status?" + urllib.parse.urlencode({"id": gate_id})
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=remaining) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise

    # Our own deadline, a little past the server's, so a decision that lands
    # just as the window closes still reaches us. Every drop inside it is a
    # reconnect, not a verdict: the request is persisted server-side, so giving
    # up early would convert "a human is deciding" into a silent auto-allow.
    deadline = time.monotonic() + TIMEOUT + 10
    out = None
    sent = True
    backoff = 0.5
    # The first POST is still allowed to fail fast. "Nothing is listening" is not
    # the same failure as "the thing we were talking to went away": retrying a
    # refused connection for a full timeout would stall every gated tool call on
    # a machine where agentglass simply isn't running.
    try:
        out = submit(TIMEOUT + 5)
    except urllib.error.HTTPError:
        # The server answered, just not with a decision — retrying won't help.
        deadline = time.monotonic()
    except urllib.error.URLError as e:
        if isinstance(e.reason, ConnectionRefusedError):
            deadline = time.monotonic()  # nobody home — skip the retry loop
    except Exception:
        pass  # connected, then dropped — worth re-attaching

    while out is None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(backoff, remaining))
        backoff = min(backoff * 2, 5)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            out = reattach(remaining) if sent else submit(remaining)
            if out is None:
                sent = False  # 404 — the POST never landed, so send it again
        except Exception:
            sent = True  # dropped again mid-wait — keep re-attaching

    if out is None:
        if FAIL_CLOSED:
            emit("deny", "agentglass unreachable (fail-closed)")
        allow_silently()  # unreachable / error → never block (default)

    decision = out.get("decision", "allow")
    reason = out.get("reason", "")
    if decision == "deny":
        emit("deny", reason or "denied from agentglass")
    if decision == "allow" and reason:
        emit("allow", reason)  # explicit approval (skips the normal prompt)
    allow_silently()


if __name__ == "__main__":
    main()
