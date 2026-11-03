"""The tab's reading of a headless OpenCode turn.

`opencode run --format json` writes one JSON object per line: a `text` part is
what it is saying, a `tool_use` part is a call and its result, an `error` part
is why it stopped. The pane used to show those bytes. The wrapper tees the raw
stream into the turn's `out` file first, so this only has to read it: the tab
gets lines, the file keeps the events, and nothing is lost by the reading.

The shapes are the ones recorded in server/test/fixtures/fakeEngines.ts
(OpenCode 1.18.32). A line that is not JSON is printed as it came, because an
engine that is signed out or rate-limited says so in prose and that sentence
is the whole answer.

Usage: opencodeview.py <rc> <out>
  rc   read once at the end, for how the turn ended
  out  printed in the footer, so the raw events can be found again
"""

import json
import sys
import time


def say(line: str) -> None:
    # Unbuffered: a turn is read as it happens, not when the buffer fills.
    print(line, flush=True)


def clip(value, limit: int = 160) -> str:
    text = " ".join(str(value).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def one_line_input(state: dict) -> str:
    args = state.get("input")
    if not isinstance(args, dict):
        return clip(args) if args else ""
    # The field that names the work, before the first string that happens to
    # be in the dict: `{"oldString": ..., "filePath": ...}` reads as the old
    # text otherwise.
    pattern = args.get("pattern")
    if isinstance(pattern, str) and pattern.strip():
        where = args.get("path")
        return clip(pattern + (f"  {where}" if isinstance(where, str) and where.strip() else ""), 140)
    for key in ("command", "cmd", "filePath", "path", "query", "url", "description", "prompt"):
        value = args.get(key)
        if isinstance(value, list):
            return clip(" ; ".join(str(v) for v in value), 140)
        if isinstance(value, str) and value.strip():
            return clip(value, 140)
    for value in args.values():
        if isinstance(value, str) and value.strip():
            return clip(value, 140)
    return ""


def result_summary(state: dict) -> str:
    if not isinstance(state, dict):
        return ""
    summary = ""
    error = state.get("error")
    if isinstance(error, str) and error.strip():
        summary = clip(error.strip().splitlines()[0])
    else:
        output = state.get("output")
        if isinstance(output, str) and output.strip():
            lines = output.strip().splitlines()
            summary = clip(lines[0])
            if len(lines) > 1:
                summary += f" (+{len(lines) - 1} lines)"
    metadata = state.get("metadata")
    if isinstance(metadata, dict) and metadata.get("exit") not in (None, 0):
        summary = f"exit {metadata['exit']}" + (f" · {summary}" if summary else "")
    if not summary:
        summary = {"completed": "ok", "error": "failed"}.get(state.get("status"), "")
    return summary


def duration(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes, rest = divmod(int(seconds), 60)
    return f"{minutes}m {rest:02d}s"


def count(n: int) -> str:
    return f"{n / 1000:.1f}k".replace(".0k", "k") if n >= 1000 else str(n)


def main() -> None:
    rc_path = sys.argv[1] if len(sys.argv) > 1 else ""
    out_path = sys.argv[2] if len(sys.argv) > 2 else ""
    started = time.monotonic()
    tools = 0
    tokens = 0
    cost = 0.0
    last_text = ""
    say("headless opencode worker · one turn · this tab cannot be typed to")
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            say(line)
            continue
        if not isinstance(event, dict):
            say(line)
            continue
        kind = event.get("type")
        part = event.get("part") if isinstance(event.get("part"), dict) else {}
        if kind == "text":
            text = part.get("text") if isinstance(part.get("text"), str) else event.get("text")
            if isinstance(text, str) and text.strip() and text != last_text:
                last_text = text
                say("")
                say(text.rstrip())
        elif kind == "tool_use" or part.get("type") == "tool":
            state = part.get("state") if isinstance(part.get("state"), dict) else {}
            tool = part.get("tool") or event.get("tool") or "tool"
            args = one_line_input(state)
            tools += 1
            say(f"→ {tool}" + (f"  {args}" if args else ""))
            summary = result_summary(state)
            if summary:
                mark = {"completed": "✓", "error": "✗"}.get(state.get("status"), "…")
                say(f"   {mark} {summary}")
        elif kind == "error":
            error = event.get("error")
            message = ""
            if isinstance(error, dict):
                data = error.get("data")
                if isinstance(data, dict):
                    message = data.get("message") or ""
                message = message or error.get("message") or error.get("name") or ""
            elif isinstance(error, str):
                message = error
            say(f"! error  {clip(message or 'the engine reported an error', 200)}")
        elif kind == "step_finish":
            used = part.get("tokens")
            if isinstance(used, dict):
                for key in ("input", "output", "reasoning"):
                    if isinstance(used.get(key), (int, float)):
                        tokens += int(used[key])
                cached = used.get("cache")
                if isinstance(cached, dict):
                    for key in ("read", "write"):
                        if isinstance(cached.get(key), (int, float)):
                            tokens += int(cached[key])
            spent = part.get("cost")
            if isinstance(spent, (int, float)):
                cost += spent
        # Every other kind of event is in the raw file and says nothing a
        # person reads: step_start, reasoning, and whatever comes next.

    exit_code = None
    try:
        with open(rc_path, encoding="utf-8") as handle:
            written = handle.read().strip()
        if written.isdigit():
            exit_code = int(written)
    except OSError:
        pass
    if exit_code is None:
        facts = ["ended without an exit status"]
    else:
        facts = ["done" if exit_code == 0 else "failed", f"exit {exit_code}"]
    facts.append(duration(time.monotonic() - started))
    if tools:
        facts.append(f"{tools} tool{'s' if tools != 1 else ''}")
    if tokens:
        facts.append(f"{count(tokens)} tokens")
    if cost:
        facts.append(f"${cost:.4f}")
    say("")
    say("── " + " · ".join(facts))
    if out_path:
        say(f"raw events: {out_path}")


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        # The window was closed mid-turn; the file has the events.
        pass
