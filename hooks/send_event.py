#!/usr/bin/env python3
"""agentglass event forwarder.

Reads a Claude Code or Kimi Code CLI hook payload on stdin and POSTs a
normalized event to the agentglass server. Zero third-party deps (stdlib only).

Usage (from a Claude Code hook command):
    send_event.py --source-app my-project --event-type PreToolUse
    send_event.py --source-app my-project --event-type Stop --add-chat
    send_event.py --model-name kimi-code/k3

Env:
    AGENTGLASS_SERVER   server base url (default http://localhost:4000)
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.request

DEFAULT_SERVER = os.environ.get("AGENTGLASS_SERVER", "http://localhost:4000")

# What each event means to a tmux tab. None clears the mark: the user is driving
# this window again, so it has nothing to ask for.
TMUX_STATE = {
    "Stop": "done",
    "Notification": "waiting",
    "UserPromptSubmit": None,
    "SessionStart": None,
    "SessionEnd": None,
}


def mark_tmux_window(event_type):
    """Tell the tmux window this agent runs in what it wants, if anything.

    The terminal panel draws tmux's windows as tabs and flashes the ones with a
    state set, which is the only way to see which of four agents stopped when
    all four are off screen. The mark is a plain tmux user option, so tmux is
    the one holding the state and anything else can read or set it too.

    Best effort throughout: an agent must never fail a turn because a status
    colour could not be set.
    """
    if event_type not in TMUX_STATE:
        return
    pane = os.environ.get("TMUX_PANE")
    if not pane or not os.environ.get("TMUX"):
        return
    tmux = shutil.which("tmux")
    if not tmux:
        return
    state = TMUX_STATE[event_type]
    try:
        if state is None:
            subprocess.run([tmux, "set-option", "-w", "-q", "-t", pane, "-u", "@ai_state"],
                           timeout=2, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        # Don't flash the window the user is already looking at, as long as
        # somebody is there to look: a state set on a detached session still has
        # to be waiting when its user comes back.
        #
        # Two calls rather than one command list. `display-message ; list-clients`
        # answers only the first half from a hook's context, which is how this
        # went out flagging the window it was told to leave alone.
        # (`#{session_attached}` is no use either: it reports 0 whenever the
        # command has no client of its own, which is always the case here.)
        current = subprocess.run([tmux, "display-message", "-p", "-t", pane, "#{window_active}"],
                                 capture_output=True, text=True, timeout=2)
        if current.stdout.strip() == "1":
            seen = subprocess.run([tmux, "list-clients", "-F", "c"],
                                  capture_output=True, text=True, timeout=2)
            if seen.stdout.strip():
                return
        subprocess.run([tmux, "set-option", "-w", "-q", "-t", pane, "@ai_state", state],
                       timeout=2, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass

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
    _agentglass_local_only(getattr(args, "server", None) or DEFAULT_SERVER)

    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        payload = {}

    session_id = payload.get("session_id") or payload.get("sessionId") or "unknown"
    event_type = args.event_type or payload.get("hook_event_name") or "Unknown"
    model_name = payload.get("model") or payload.get("model_name") or args.model_name

    # Before the POST: the tab should light up the moment the turn ends, not
    # after a server round trip that may be timing out.
    mark_tmux_window(event_type)

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
    if chat is not None:
        body["chat"] = chat

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
