#!/usr/bin/env python3
"""agentglass hook installer.

Wires the agentglass event forwarder into your Claude Code settings so every
session streams to the dashboard — no hand-copying required. Zero third-party
deps (stdlib only).

    python3 hooks/install_hooks.py               # install into ~/.claude/settings.json (global)
    python3 hooks/install_hooks.py --uninstall   # remove the agentglass hooks
    python3 hooks/install_hooks.py --project .   # install into <project>/.claude/settings.json instead
    python3 hooks/install_hooks.py --postinstall # lifecycle mode used by `bun install`

Notes:
  * Idempotent — re-running re-points the send_event.py path in place and never
    duplicates entries or disturbs your other hooks (magia, guards, etc.).
  * It also takes the `statusLine` slot, CHAINING whatever was there: Claude Code
    pipes `rate_limits` to that command on every turn, which is the plan usage
    the dashboard would otherwise pay a rate-limited endpoint for. Your own
    status line is passed the same stdin, owns the output, and comes back
    untouched on --uninstall. POSIX only; skipped on Windows.
  * The target settings file is backed up (`*.bak.agentglass.<timestamp>`) before
    any change, and only when there is actually a change to make.
  * `--source-app` is intentionally omitted so each project auto-labels in the
    dashboard by its own working-directory name (send_event.py defaults to the
    cwd basename).
  * `--postinstall` respects `AGENTGLASS_NO_HOOKS=1` (skips) and never fails the
    install, so `bun install` stays green even without Python or write access.
"""
import argparse
import json
import os
import re
import shlex
import shutil
import sys
import time

HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))
SEND_EVENT = os.path.join(HOOKS_DIR, "send_event.py")
MARKER = "send_event.py"  # substring that identifies a hook command as ours

STATUSLINE = os.path.join(HOOKS_DIR, "statusline.sh")
# Our status line, recognised by SHAPE rather than by a filename substring.
#
# This was `"statusline.sh" in cmd`, and the collision it caused is the kind
# that eats somebody's config in silence: a status line of their own called
# `mi-statusline.sh`, `custom-statusline.sh` or the widely used
# `ccstatusline.sh` all CONTAIN "statusline.sh". The installer read them as
# ours, tried to unwrap a command that was never wrapped, found no third
# argument, and dropped it. Nothing failed and nothing was said; their status
# line was simply gone after installing.
#
# The path is not usable as the marker either — the repo moves, and an install
# from an older checkout has to stay recognisable. So: our command always
# begins `sh "…/hooks/statusline.sh"`, and that shape is what is matched.
SL_RE = re.compile(r'^sh\s+"(?:.*/)?hooks/statusline\.sh"')


def _is_ours_statusline(cmd):
    return bool(cmd) and SL_RE.match(cmd.strip()) is not None

# event -> (matcher or None, attach transcript for token/cost)
EVENTS = {
    "SessionStart":     (None, False),
    "UserPromptSubmit": (None, False),
    "PreToolUse":       ("*",  False),
    "PostToolUse":      ("*",  False),
    "Notification":     (None, False),
    "SubagentStop":     (None, True),
    "Stop":             (None, True),
    "PreCompact":       (None, False),
    "SessionEnd":       (None, True),
}


def settings_path(project):
    base = os.path.join(project, ".claude") if project else os.path.expanduser("~/.claude")
    return os.path.join(base, "settings.json")


def _is_ours(entry):
    return any(MARKER in h.get("command", "") for h in entry.get("hooks", []))


def load(path):
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read().strip()
    return json.loads(raw) if raw else {}


def _hook_python():
    """Interpreter name written into Claude Code hook commands.

    On Windows most installs expose `py` (launcher) and/or `python`, not
    `python3`. Prefer those at install time. Deliberately avoid
    `sys.executable` so a later-deleted venv does not break every hook.
    """
    if os.name != "nt":
        return "python3"
    for candidate in ("py", "python"):
        if shutil.which(candidate):
            return candidate
    return "py"


def _statusline_command(chained):
    """Our forwarder, told what it is wrapping.

    The wrapped command travels as a quoted argument rather than being stashed
    somewhere out of sight: it is then visible in the same settings.json the
    user is reading, and uninstall has everything it needs to put things back
    without consulting any state of ours.
    """
    cmd = 'sh "%s"' % STATUSLINE
    return cmd + " " + shlex.quote(chained) if chained else cmd


def _chained_from(cmd):
    """What our wrapper was told to call, so re-installing re-points the script
    path without forgetting the status line it wraps."""
    if not _is_ours_statusline(cmd):
        return None
    try:
        parts = shlex.split(cmd)
    except ValueError:
        return None
    return parts[2] if len(parts) >= 3 else None


def install_statusline(cfg):
    """Take the statusLine slot, chaining whatever was there.

    Unlike hooks, statusLine is a single slot rather than a list, so there is no
    way to add to it without owning it. Owning it is only acceptable because the
    previous command is called on every render with the same stdin and owns the
    output — see hooks/statusline.sh, where every path out still runs the chain.

    Skipped on Windows: the forwarder is POSIX sh, and a status line that fails
    is one the user sees on every single render. The usage endpoint poll keeps
    working there, just without the free feed.
    """
    if os.name == "nt":
        return
    if not os.path.exists(STATUSLINE):
        return
    current = cfg.get("statusLine")
    cur_cmd = current.get("command") if isinstance(current, dict) else None
    # Already ours: re-point the script path, keep what it wraps.
    chained = _chained_from(cur_cmd) if _is_ours_statusline(cur_cmd) else cur_cmd
    cfg["statusLine"] = {"type": "command", "command": _statusline_command(chained)}


def uninstall_statusline(cfg):
    """Give the status line back. Ours goes, whatever it wrapped returns, and a
    slot that was empty before us is left empty."""
    current = cfg.get("statusLine")
    cur_cmd = current.get("command") if isinstance(current, dict) else None
    if not _is_ours_statusline(cur_cmd):
        return
    chained = _chained_from(cur_cmd)
    if chained:
        cfg["statusLine"] = {"type": "command", "command": chained}
    else:
        del cfg["statusLine"]


def do_install(cfg):
    """Append our forwarder to each event, first stripping any prior agentglass
    entry (so a moved clone re-points cleanly). All other hooks are preserved."""
    hooks = cfg.setdefault("hooks", {})
    python = _hook_python()
    for event, (matcher, add_chat) in EVENTS.items():
        arr = [e for e in hooks.get(event, []) if not _is_ours(e)]
        # Quote the script path unconditionally: a clone living under a spaced
        # path ("/Users/x/My Projects/…", "C:\Users\…") breaks the hook command
        # on every platform, not just Windows.
        cmd = f'{python} "{SEND_EVENT}" --event-type {event}'
        if add_chat:
            cmd += " --add-chat"
        entry = {"hooks": [{"type": "command", "command": cmd}]}
        if matcher is not None:
            entry["matcher"] = matcher
        arr.append(entry)
        hooks[event] = arr
    install_statusline(cfg)


def do_uninstall(cfg):
    """Drop only our entries; leave everyone else's hooks untouched."""
    hooks = cfg.get("hooks", {})
    for event in list(hooks.keys()):
        kept = [e for e in hooks[event] if not _is_ours(e)]
        if kept:
            hooks[event] = kept
        else:
            del hooks[event]
    if "hooks" in cfg and not cfg["hooks"]:
        del cfg["hooks"]
    uninstall_statusline(cfg)


def main():
    ap = argparse.ArgumentParser(description="Install or remove agentglass Claude Code hooks.")
    ap.add_argument("--uninstall", action="store_true", help="remove the agentglass hooks")
    ap.add_argument("--project", default=None,
                    help="target <project>/.claude/settings.json instead of the global ~/.claude one")
    ap.add_argument("--postinstall", action="store_true",
                    help="lifecycle mode: honor AGENTGLASS_NO_HOOKS and never fail the install")
    args = ap.parse_args()

    if args.postinstall and os.environ.get("AGENTGLASS_NO_HOOKS"):
        print("[agentglass] AGENTGLASS_NO_HOOKS set — skipping hook install. "
              "Run `bun run setup` later to enable.")
        return 0

    path = settings_path(args.project)
    try:
        cfg = load(path)
    except json.JSONDecodeError as e:
        print(f"[agentglass] {path} is not valid JSON ({e}); leaving it untouched. "
              "Fix it and run `bun run setup`.", file=sys.stderr)
        return 0 if args.postinstall else 1

    before = json.dumps(cfg, sort_keys=True)
    do_uninstall(cfg) if args.uninstall else do_install(cfg)
    if json.dumps(cfg, sort_keys=True) == before:
        state = "removed" if args.uninstall else "already up to date"
        print(f"[agentglass] hooks {state} in {path}")
        return 0

    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        bak = path + ".bak.agentglass." + time.strftime("%Y%m%d-%H%M%S")
        shutil.copy2(path, bak)
        print(f"[agentglass] backup → {bak}")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")

    if args.uninstall:
        print(f"[agentglass] hooks removed from {path}")
    else:
        print(f"[agentglass] hooks installed into {path}")
        print(f"[agentglass] forwarder: {SEND_EVENT}")
        print("[agentglass] start a NEW Claude Code session for it to take effect.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 — postinstall must never break `bun install`
        if "--postinstall" in sys.argv:
            print(f"[agentglass] hook install skipped ({e}). Run `bun run setup` to retry.",
                  file=sys.stderr)
            sys.exit(0)
        raise
