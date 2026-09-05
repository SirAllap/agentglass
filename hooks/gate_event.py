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

How long it waits is per hook entry, because patience is not one number: a
`Bash` matcher gating `rm -rf` is worth standing up for, a file write probably
isn't. Each matcher in settings.json carries its own command line, so `--timeout`
on that line is the per-matcher setting.

    { "matcher": "Bash", "hooks": [{ "type": "command", "command":
      "python3 hooks/gate_event.py --source-app my-project --timeout 900" }] }

The server clamps what it is asked for, and its ceiling is the larger of 300s and
its own AGENTGLASS_GATE_TIMEOUT — so a matcher wanting longer than five minutes
needs that raised on the server too, or it is quietly held for five.

Durable across a server restart: the hook picks the request id, so if the
connection drops mid-wait (agentglass restarted, a crash, a proxy hanging up)
it re-attaches to that same request instead of giving up and falling into the
timeout branch. It only gives up once its own deadline has passed.

Deny/allow are returned to Claude Code via the PreToolUse permissionDecision.

Env:
    AGENTGLASS_SERVER   server base url (default http://127.0.0.1:4000)
    AGENTGLASS_GATE_TIMEOUT  seconds to wait for a human (default 300)
    AGENTGLASS_GATE_FAILCLOSED  "1" → an unreachable agentglass DENIES the call
        instead of allowing it. Off by default; with it on, agentglass being
        down blocks every gated call.
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

def _shared_secret():
    """The token the server is running with, or "" when it has none.

    The environment first, then the file — the same order and the same file as
    hooks/statusline.sh, for the same reason. A hook inherits the environment of
    whatever launched Claude Code, which for a desktop icon or a terminal opened
    outside agentglass is nothing at all. Since the desktop app runs its sidecar
    with a token even on loopback (electron/main.js), reading only the
    environment would leave every gate post unauthenticated: /gate answers 401,
    the HTTPError branch below cancels the retry loop, and the call lands in
    fail-open. The gate would stop holding, silently, with nothing on screen to
    say it had.

    0600 and owned by this user, so being able to read it is the check. An
    unreadable file is not an error — a server started without a token wants no
    header at all, and sending one it never asked for changes nothing.
    """
    from_env = os.environ.get("AGENTGLASS_TOKEN", "").strip()
    if from_env:
        return from_env
    config_home = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    try:
        with open(os.path.join(config_home, "agentglass", "token"), encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


# The wait when nothing asks for anything else. Five minutes, not the one minute
# this shipped with: the gate exists for the moments you are not at the desk, and
# a window you cannot win auto-allows the very call it was raised to show you.
#
# The same number lives in GATE_DEFAULT_MS in server/src/gate.ts, because the
# server clamps whatever we send here — two different values means the wait
# somebody configured is not the wait they get. server/test/gate-defaults.test.ts
# reads this line and fails if the two part company, so change them together.
DEFAULT_TIMEOUT = 300


def _seconds(raw, fallback):
    """Seconds from something a human typed into a settings.json, or `fallback`.

    Both sources — the environment and `--timeout` — are hand-edited, and a
    traceback here is a broken gate on every single tool call. So a typo falls
    back rather than raising, and `argparse` is deliberately not asked to do the
    parsing: `type=int` makes it exit 2, and exit 2 from a PreToolUse hook is how
    Claude Code spells *deny*. A mistyped timeout must not block anything.

    Floored at 1s for the same reason the server floors it: a negative wait is an
    instant auto-allow, which is the one outcome nobody asked for.
    """
    try:
        return max(1, int(raw))
    except (TypeError, ValueError):
        return fallback


TIMEOUT = _seconds(os.environ.get("AGENTGLASS_GATE_TIMEOUT"), DEFAULT_TIMEOUT)
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
    # Per-matcher patience. A settings.json entry is already per-matcher — it is
    # the unit the `matcher` key selects — so the hook's own command line is the
    # place a per-matcher setting belongs, and no second config file is needed.
    ap.add_argument("--timeout", default=None,
                    help="seconds to wait for a human, for this matcher only "
                         "(overrides AGENTGLASS_GATE_TIMEOUT, default %d)" % DEFAULT_TIMEOUT)
    args = ap.parse_args()
    server = _agentglass_local_only(getattr(args, "server", None) or DEFAULT_SERVER)
    # `None` falls through to TIMEOUT, which is the env var or the default.
    timeout = _seconds(args.timeout, TIMEOUT)

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
        "timeout_ms": timeout * 1000,
    }).encode("utf-8")

    # Carry the shared secret when the server has one. /gate is the control plane
    # (a POST raises an operator-facing approval prompt), so a token-protected
    # server requires auth here — otherwise any local process could inject spoofed
    # approval prompts. The hook runs on the same machine, so it can read it.
    headers = {"Content-Type": "application/json"}
    token = _shared_secret()
    if token:
        headers["Authorization"] = "Bearer " + token

    base = server.rstrip("/")

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
    deadline = time.monotonic() + timeout + 10
    out = None
    sent = True
    backoff = 0.5
    # The first POST is still allowed to fail fast. "Nothing is listening" is not
    # the same failure as "the thing we were talking to went away": retrying a
    # refused connection for a full timeout would stall every gated tool call on
    # a machine where agentglass simply isn't running.
    try:
        out = submit(timeout + 5)
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
            emit("deny", "agentglass could not be reached and is configured fail-closed, so this call was blocked without a human seeing it. This is an infrastructure problem, not a judgement about the call — report it rather than working around it.")
        allow_silently()  # unreachable / error → never block (default)

    decision = out.get("decision", "allow")
    reason = out.get("reason", "")
    if decision == "deny":
        emit("deny", reason or "A human denied this call in agentglass. Do not retry the same call — take a different approach, or ask them what they would prefer.")
    if decision == "allow" and reason:
        emit("allow", reason)  # explicit approval (skips the normal prompt)
    allow_silently()


if __name__ == "__main__":
    main()
