"""Every verb and flag `bin/agentglass-browser` accepts, as JSON on stdout.

The parser is built inside `main()`, so it is captured by intercepting
`parse_args` and running the CLI as `__main__`; the CLI is not changed, and a
flag or verb added there shows up here without anybody editing this file.
"""
import argparse
import json
import runpy
import sys

captured = {}


def spy(self, *a, **k):
    captured["ap"] = self
    raise SystemExit(0)


argparse.ArgumentParser.parse_args = spy
try:
    runpy.run_path(sys.argv[1], run_name="__main__")
except SystemExit:
    pass

ap = captured.get("ap")
if ap is None:
    print("could not capture the parser", file=sys.stderr)
    sys.exit(1)


def describe(parser):
    groups = [
        {"required": bool(g.required), "dests": [a.dest for a in g._group_actions]}
        for g in parser._mutually_exclusive_groups
    ]
    options, positionals = [], []
    for a in parser._actions:
        if isinstance(a, (argparse._SubParsersAction, argparse._HelpAction)):
            continue
        if a.option_strings:
            options.append({
                "flags": list(a.option_strings),
                "dest": a.dest,
                "kind": "flag" if isinstance(a, (argparse._StoreTrueAction, argparse._StoreFalseAction))
                        else "append" if isinstance(a, argparse._AppendAction) else "value",
                "nargs": None if isinstance(a.nargs, int) else a.nargs,
                "type": getattr(a.type, "__name__", None),
                "choices": list(a.choices) if a.choices else None,
                "group": next((i for i, g in enumerate(groups) if a.dest in g["dests"]), None),
                "required": bool(a.required),
            })
        else:
            positionals.append({
                "dest": a.dest,
                "nargs": None if isinstance(a.nargs, int) else a.nargs,
                "type": getattr(a.type, "__name__", None),
                "choices": list(a.choices) if a.choices else None,
            })
    return {"options": options, "positionals": positionals, "groups": groups}


sub = next(a for a in ap._actions if isinstance(a, argparse._SubParsersAction))
json.dump({"globals": describe(ap), "verbs": {n: describe(p) for n, p in sub.choices.items()}}, sys.stdout)
