#!/usr/bin/env python3
"""agentglass hook installer.

Wires the agentglass event forwarder into your Claude Code settings so every
session streams to the dashboard — no hand-copying required. Zero third-party
deps (stdlib only).

    python3 hooks/install_hooks.py               # install into ~/.claude/settings.json (global)
    python3 hooks/install_hooks.py --uninstall   # remove the agentglass hooks
    python3 hooks/install_hooks.py --project .   # install into <project>/.claude/settings.json instead
    python3 hooks/install_hooks.py --postinstall # non-failing lifecycle mode

Notes:
  * Idempotent — re-running re-points the send_event.py path in place and never
    duplicates entries or disturbs your other hooks (magia, guards, etc.).
  * Worktree-safe — installing from a linked git worktree bakes the *main*
    clone's path into the settings file, so `git worktree remove` cannot leave
    a machine-global hook pointing at a deleted script.
  * Fail-open — the hook command swallows a non-zero exit from the forwarder.
    Telemetry must never gate tool execution.
  * The target settings file is backed up (`*.bak.agentglass.<timestamp>`) before
    any change, and only when there is actually a change to make.
  * `--source-app` is intentionally omitted so each project auto-labels in the
    dashboard by its own working-directory name (send_event.py defaults to the
    cwd basename).
  * `--postinstall` respects `AGENTGLASS_NO_HOOKS=1` and reports errors without
    failing its caller.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time

HOOKS_DIR = os.path.dirname(os.path.abspath(__file__))
MARKER = "send_event.py"  # substring that identifies a hook command as ours

# event -> (matcher or None, attach latest-turn usage for token/cost)
EVENTS = {
    "SessionStart":     (None, False),
    "UserPromptSubmit": (None, False),
    "PreToolUse":       ("*",  False),
    "PostToolUse":      ("*",  False),
    "Notification":     (None, False),
    "SubagentStop":     (None, False),
    "Stop":             (None, True),
    "PreCompact":       (None, False),
    "SessionEnd":       (None, False),
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
            return "py -3" if candidate == "py" else candidate
    return "py -3"


def _git_lines(cwd, *args):
    try:
        out = subprocess.run(["git", "-C", cwd, *args],
                             capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return []
    if out.returncode != 0:
        return []
    return [line for line in out.stdout.splitlines() if line.strip()]


def forwarder_path(hooks_dir=None):
    """Absolute path to send_event.py, resolved to the *main* clone.

    The path we write is absolute and outlives this process — by default in the
    machine-global ~/.claude/settings.json. A linked worktree is disposable:
    `git worktree remove` deletes the script the hook points at, and from then
    on every Claude Code session on the machine hits a dead hook. So map a
    worktree checkout back to the main clone, which sticks around.
    """
    hooks_dir = hooks_dir or HOOKS_DIR
    lines = _git_lines(hooks_dir, "rev-parse", "--path-format=absolute",
                       "--git-common-dir", "--show-toplevel")
    if len(lines) == 2:
        common_dir, toplevel = lines
        # For a linked worktree --git-common-dir points into the main clone;
        # for a normal checkout it is just <toplevel>/.git and this is a no-op.
        main_clone = os.path.dirname(os.path.abspath(common_dir))
        rel = os.path.relpath(hooks_dir, os.path.abspath(toplevel))
        candidate = os.path.normpath(os.path.join(main_clone, rel, "send_event.py"))
        if os.path.isfile(candidate):
            return candidate
    return os.path.join(hooks_dir, "send_event.py")


def _hook_command(python, send_event, event, add_usage):
    # Quote the script path unconditionally: a clone living under a spaced
    # path ("/Users/x/My Projects/…", "C:\Users\…") breaks the hook command
    # on every platform, not just Windows.
    cmd = f'{python} "{send_event}" --event-type {event}'
    if add_usage:
        cmd += " --add-usage"
    # Fail open. Claude Code reads exit code 2 from a PreToolUse hook as "deny
    # this tool call", and python exits 2 when it cannot open the script — so a
    # forwarder that has been moved or deleted would block every tool call in
    # every session, including the ones needed to undo it.
    return cmd + (" || exit /b 0" if os.name == "nt" else " || exit 0")


def do_install(cfg, send_event=None):
    """Append our forwarder to each event, first stripping any prior agentglass
    entry (so a moved clone re-points cleanly). All other hooks are preserved."""
    hooks = cfg.setdefault("hooks", {})
    python = _hook_python()
    send_event = send_event or forwarder_path()
    for event, (matcher, add_chat) in EVENTS.items():
        arr = [e for e in hooks.get(event, []) if not _is_ours(e)]
        cmd = _hook_command(python, send_event, event, add_chat)
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
        print("[agentglass] AGENTGLASS_NO_HOOKS set - skipping hook install. "
              "Run `bun run setup` later to enable.")
        return 0

    path = settings_path(args.project)
    try:
        cfg = load(path)
    except json.JSONDecodeError as e:
        print(f"[agentglass] {path} is not valid JSON ({e}); leaving it untouched. "
              "Fix it and run `bun run setup`.", file=sys.stderr)
        return 0 if args.postinstall else 1

    send_event = forwarder_path()
    before = json.dumps(cfg, sort_keys=True)
    do_uninstall(cfg) if args.uninstall else do_install(cfg, send_event)
    if json.dumps(cfg, sort_keys=True) == before:
        state = "removed" if args.uninstall else "already up to date"
        print(f"[agentglass] hooks {state} in {path}")
        return 0

    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        bak = path + ".bak.agentglass." + time.strftime("%Y%m%d-%H%M%S")
        shutil.copy2(path, bak)
        print(f"[agentglass] backup -> {bak}")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")

    if args.uninstall:
        print(f"[agentglass] hooks removed from {path}")
    else:
        print(f"[agentglass] hooks installed into {path}")
        print(f"[agentglass] forwarder: {send_event}")
        if os.path.dirname(send_event) != HOOKS_DIR:
            print(f"[agentglass] (resolved out of the worktree at {HOOKS_DIR} "
                  "so removing it won't break your hooks)")
        print("[agentglass] start a NEW Claude Code session for it to take effect.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 - lifecycle mode must not fail its caller
        if "--postinstall" in sys.argv:
            print(f"[agentglass] hook install skipped ({e}). Run `bun run setup` to retry.",
                  file=sys.stderr)
            sys.exit(0)
        raise
