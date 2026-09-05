#!/usr/bin/env python3
"""
Turn the agent's event stream into something worth watching.

`claude -p` prints nothing at all until it is finished, so a pane running it is
a blank rectangle for the length of the task — which is the opposite of the
point. `--output-format stream-json --verbose` does emit as it goes, but it
emits JSON: measured at roughly two hundred characters a line, most of it
identifiers. Watching that tells you the process is alive and nothing else.

So the stream goes through here on its way to the pane. One short line per
event, in the order things happened: which tool, on which file, and the first
words of anything it says. The raw stream is teed to a file untouched, because
the run's recorded outcome has to be the agent's own words rather than this
summary of them.

Deliberately not pretty. It is a counter you glance at to see whether it is
reading, editing, or stuck on the same file for ten minutes.
"""
import json
import re
import sys


def tail(path: str, keep: int = 60) -> str:
    """The END of a path, which is the part that differs between two of them."""
    return path if len(path) <= keep else "…" + path[-(keep - 1):]


def head(cmd: str, keep: int = 110) -> str:
    """
    The START of a command, which is the opposite rule and the right one.

    A path is identified by its last segment; a command is identified by its
    first word. Cutting commands from the left produced fourteen rows reading
    `Bash …ass-understudy-the-tracker-fence-does-no`, which is the middle of a
    directory name and tells you nothing about what it ran.
    """
    return cmd if len(cmd) <= keep else cmd[:keep - 1] + "…"


# What a shell command is actually doing, in the order these are tried.
# Deliberately a short list: the point is to recognise the handful of things a
# coding agent does over and over, not to parse shell.
SHELL_MEANS = [
    (re.compile(r"\b(bun|npm|yarn|pnpm)\s+(run\s+)?test\b"), "running the tests"),
    (re.compile(r"\btsc\b|\btypecheck\b"), "checking the types"),
    (re.compile(r"\bgit\s+(commit)\b"), "committing"),
    (re.compile(r"\bgit\s+(diff|show)\b"), "reading its own changes"),
    (re.compile(r"\bgit\s+(status)\b"), "checking what it has changed"),
    (re.compile(r"\bgit\s+(checkout|restore|reset)\b"), "undoing something"),
    (re.compile(r"\b(grep|rg|ag)\b"), None),          # handled with its pattern
    (re.compile(r"\b(cat|head|tail|sed -n|less)\b"), None),
    (re.compile(r"\b(find|ls)\b"), "looking around the files"),
    (re.compile(r"\b(mkdir|cp|mv|rm)\b"), "moving files about"),
    (re.compile(r"\bmake\b"), "running make"),
]

QUOTED = re.compile(r"""["']([^"']{2,60})["']""")


def file_in(cmd: str) -> str:
    """The likeliest filename in a command, for the ones that read or search."""
    for word in reversed(cmd.split()):
        # No backtick in this set on purpose: this file is embedded verbatim
        # inside a TypeScript template literal, and a backtick followed by a
        # semicolon here ended that literal early when the copy was made.
        base = word.strip("\"';|&()")
        if "/" in base or re.search(r"\.[a-z]{2,4}$", base):
            return tail(base, 40)
    return ""


def shell_means(cmd: str) -> str:
    """A sentence for a command, or the command's first word if none fits."""
    for pattern, said in SHELL_MEANS:
        if not pattern.search(cmd):
            continue
        if said:
            return said
        if pattern.pattern.startswith(r"\b(grep"):
            found = QUOTED.search(cmd)
            where = file_in(cmd)
            what = f'looking for "{found.group(1)}"' if found else "searching"
            return f"{what} in {where}" if where else what
        where = file_in(cmd)
        return f"reading {where}" if where else "reading a file"
    first = cmd.split()[0] if cmd.split() else "something"
    return f"running {tail(first, 20)}"


# The tools an agent uses most, said as a person would say them.
TOOL_MEANS = {
    "Read": "reading", "Write": "writing", "Edit": "editing",
    "NotebookEdit": "editing", "Glob": "finding", "Grep": "looking for",
    "TodoWrite": "planning", "Task": "asking another agent", "WebFetch": "fetching a page",
}


def describe(ev: dict) -> str | None:
    kind = ev.get("type")

    if kind == "assistant":
        out = []
        for block in ev.get("message", {}).get("content", []) or []:
            if block.get("type") == "text":
                said = " ".join((block.get("text") or "").split())
                # Its own words, marked and kept whole-ish: this is the line
                # that says WHY, and everything else is only what it touched.
                if said:
                    out.append("\n▸ " + said[:220])
            elif block.get("type") == "tool_use":
                name = block.get("name", "?")
                arg = block.get("input", {}) or {}
                path = arg.get("file_path") or arg.get("path")
                cmd = arg.get("command")
                pattern = arg.get("pattern")
                if name == "Bash" and cmd:
                    out.append("   " + shell_means(" ".join(str(cmd).split())))
                elif path:
                    verb = TOOL_MEANS.get(name, name.lower())
                    out.append(f"   {verb} {tail(' '.join(str(path).split()), 50)}")
                elif pattern:
                    verb = TOOL_MEANS.get(name, name.lower())
                    out.append(f'   {verb} "{head(" ".join(str(pattern).split()), 50)}"')
                else:
                    out.append("   " + TOOL_MEANS.get(name, name.lower()))
        return "\n".join(out) if out else None

    if kind == "user":
        # Tool results: only whether it worked, never the body. A file's
        # contents scrolling past hides the thing you were watching for.
        for block in ev.get("message", {}).get("content", []) or []:
            if block.get("type") == "tool_result" and block.get("is_error"):
                return "   ↳ that did not work"
        return None

    if kind == "rate_limit_event":
        """
        The one event that explains a run stopping for no visible reason.

        A run of the understudy died after thirty minutes with 782KB of work
        and nothing committed. Nothing on screen said why: the pane simply
        stopped. This was in the stream all along and the formatter dropped it,
        which is the worst thing a formatter can do with the only line that
        answers "what happened".
        """
        info = ev.get("rate_limit_info", {}) or {}
        why = info.get("overageDisabledReason") or info.get("overageStatus") or ""
        kind_of = info.get("rateLimitType") or "usage"
        when = info.get("resetsAt")
        at = ""
        if isinstance(when, (int, float)):
            import time as _t
            at = _t.strftime(" — resets %H:%M", _t.localtime(when))
        return f"\n! {kind_of} limit reached ({why}){at}"

    if kind == "result":
        cost = ev.get("total_cost_usd")
        turns = ev.get("num_turns")
        bits = [b for b in (f"{turns} steps" if turns else "",
                            f"${cost:.2f}" if isinstance(cost, (int, float)) else "") if b]
        return f"\n— finished ({', '.join(bits)})" if bits else "\n— finished"

    return None


def main() -> int:
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            ev = json.loads(raw)
        except json.JSONDecodeError:
            # Not everything on this stream is an event: hooks and the runtime
            # write plain lines too, and dropping them would hide a crash.
            print(raw[:160], flush=True)
            continue
        line = describe(ev)
        if line:
            print(line, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
