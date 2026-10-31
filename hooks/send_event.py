#!/usr/bin/env python3
"""agentglass event forwarder.

Reads a Claude Code or Kimi Code CLI hook payload on stdin and POSTs a
normalized event to the agentglass server. Zero third-party deps (stdlib only).

Usage (from a Claude Code hook command):
    send_event.py --source-app my-project --event-type PreToolUse
    send_event.py --source-app my-project --event-type Stop --add-chat
    send_event.py --model-name kimi-code/k3

Env:
    AGENTGLASS_SERVER      server base url (default http://127.0.0.1:4000)
    AGENTGLASS_NO_STATUS_NUDGE  set to swallow the Crew self-report reminder the server may send
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

def _default_server(host):
    """http://<host>:<port> of the running server. The port is the one it wrote
    at bind (next to the token file), because the app moves to another port when
    4000 is taken and the AGENTGLASS_PORT an agent pane inherits can be stale;
    then AGENTGLASS_PORT, then 4000. No probe: a hook cannot pay a round trip."""
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    port = ""
    try:
        with open(os.path.join(base, "agentglass", "port"), encoding="utf-8") as f:
            port = f.read().strip()
    except OSError:
        pass
    if not (port.isdigit() and 0 < int(port) < 65536):
        port = os.environ.get("AGENTGLASS_PORT", "").strip()
    if not (port.isdigit() and 0 < int(port) < 65536):
        port = "4000"
    return f"http://{host}:{port}"


DEFAULT_SERVER = (os.environ.get("AGENTGLASS_SERVER") or _default_server("127.0.0.1"))

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


RULES_TIMEOUT = 2


def rules_verdict(server, headers, payload):
    """("deny"|"ask", reason) when an agentglass rule decides this call, else None.

    "never" denies. "ask" asks the person in Claude Code's own prompt, unless
    the gate hook is installed: it holds an "ask" in agentglass itself, and two
    prompts for one call is one too many. Anything else passes. An unreachable
    server passes too, and says so on stderr: a stopped app must not stop every
    agent on the machine.
    """
    cwd = payload.get("cwd") or os.getcwd()
    tool = payload.get("tool_name") or ""
    if not tool or not cwd.startswith("/"):
        return None
    fields = {
        "root": cwd,
        "tool": tool,
        "input": json.dumps(payload.get("tool_input") or {})[:8000],
        # Only a session that would stop for this call gets a suggestion for it.
        "mode": payload.get("permission_mode") or "",
    }
    # A Flight plan builder's tab starts with its worktree in the environment: the server holds its file writes inside it.
    bound = os.environ.get("AGENTGLASS_BUILDER_WORKTREE") or ""
    if bound.startswith("/"):
        fields["bound"] = bound
    q = urllib.parse.urlencode(fields)
    try:
        req = urllib.request.Request(server.rstrip("/") + "/agent-rules/check?" + q, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=RULES_TIMEOUT) as resp:
            out = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"[agentglass] rules check answered {e.code}; this call was not checked", file=sys.stderr)
        return None
    except Exception as e:
        print(f"[agentglass] rules check skipped, server unreachable ({e}); this call was not checked", file=sys.stderr)
        return None
    decision = out.get("decision")
    reason = out.get("reason") or "an agentglass rule for this project"
    if decision == "never":
        return ("deny", reason + " Do not retry it or work around it; ask the person if it has to happen.")
    if decision == "ask" and not out.get("gated"):
        return ("ask", reason)
    return None


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
        # And which tmux server: a pane id is only one server's, and this hook
        # fires from every tmux on the machine — `%2` in the person's own tmux
        # and `%2` on the app's engine are two panes. $TMUX is
        # "<socket path>,<server pid>,<session index>"; the first two name the
        # server for its life.
        tmux_server = os.environ.get("TMUX", "").rsplit(",", 1)[0]
        if "," in tmux_server and tmux_server.rsplit(",", 1)[1].isdigit():
            body["tmux_server"] = tmux_server
    if chat is not None:
        body["chat"] = chat
    # What this session is to the app, when it is not a person's agent: the
    # Lantern's own chat says so in its environment, and the server then never
    # counts it as waiting on anybody, nor reminds it to say what it is on.
    role = os.environ.get("AGENTGLASS_ROLE")
    if role:
        body["role"] = role

    data = json.dumps(body).encode("utf-8")
    # Carry the shared secret when the server has one, the same way gate_event.py
    # does. /ingest is tokenless only for a sender on the server's own machine:
    # appending drives a notification on the desk and on the paired phone, so
    # from off-box it needs the credential like anything else. A hook posting to
    # localhost — the only thing _agentglass_local_only permits unless
    # AGENTGLASS_ALLOW_REMOTE is set — never reaches that check, and sending the
    # header there costs nothing.
    headers = {"Content-Type": "application/json"}
    token = os.environ.get("AGENTGLASS_TOKEN", "").strip()
    if token:
        headers["Authorization"] = "Bearer " + token
    # THE AGENT RULES, before anything else is sent: a "never" the person set
    # for this project blocks the call here, in a session agentglass never
    # launched. Asked first so the block is not late behind the ingest post.
    verdict = rules_verdict(server, headers, payload) if event_type == "PreToolUse" else None

    req = urllib.request.Request(
        server.rstrip("/") + "/ingest",
        data=data,
        headers=headers,
        method="POST",
    )
    answer = b""
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            answer = resp.read()
    except Exception as e:
        # Never block Claude Code on an observability failure.
        print(f"[agentglass] send failed: {e}", file=sys.stderr)

    # THE CREW REMINDER. On a prompt the server may answer with one line asking
    # this session to say what it is working on (POST /agents/status); printed
    # to stdout, which Claude Code shows the session as context for this turn —
    # the same channel the memory-save reminder already uses. The server
    # decides when (settings, and whether this session already answered); the
    # hook only carries it. Never on any other event, and never when the
    # machine says not to.
    if event_type == "UserPromptSubmit" and not os.environ.get("AGENTGLASS_NO_STATUS_NUDGE"):
        try:
            remind = json.loads(answer.decode("utf-8", "replace")).get("remind") if answer else None
            if isinstance(remind, str) and remind.strip():
                print(remind.strip())
        except Exception:
            pass  # a reminder that cannot be read must never cost the event it rode in on

    # NOTICES PARKED FOR THIS SEAT. A notice is never typed over text the person
    # is writing (server/src/seatnotice.ts); the server hands the parked ones
    # back on the seat's next prompt and this prints them as context. A hook
    # only runs on a turn: an idle seat is woken once its box empties.
    if event_type == "UserPromptSubmit":
        try:
            notices = json.loads(answer.decode("utf-8", "replace")).get("notices") if answer else None
            for n in notices if isinstance(notices, list) else []:
                if isinstance(n, str) and n.strip():
                    print(n.strip())
        except Exception:
            pass  # same rule as the reminder above

    if verdict:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": verdict[0],
            "permissionDecisionReason": verdict[1],
        }}))

    # Pass hook input straight through so we don't interfere with the hook chain.
    sys.exit(0)


if __name__ == "__main__":
    main()
