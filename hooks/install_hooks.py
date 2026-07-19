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
import shutil
import sys
import time

HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))
SEND_EVENT = os.path.join(HOOKS_DIR, "send_event.py")
MARKER = "send_event.py"  # substring that identifies a hook command as ours

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
