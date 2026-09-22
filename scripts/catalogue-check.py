#!/usr/bin/env python3
"""Re-derive a catalogue pull request's entry from the pull request itself.

    python3 scripts/catalogue-check.py <base plugins.json> <head plugins.json>

The approval workflow writes an entry and pushes it on a branch; this is the
check that branch has to pass before it merges, and it trusts nothing the
approval run said about itself. It reads the two versions of the catalogue,
finds what changed, clones the named repository at the pinned commit, and
checks that the entry is what that commit holds:

  - exactly one entry is added or replaced, and nothing else in the file moves;
  - a replaced entry keeps its repository (a new version, not a new owner);
  - the ref is a full commit and the hash is a sha256;
  - the id, the publisher and the scope are the manifest's at that commit;
  - a fresh clone at that commit validates and hashes to the pinned hash;
  - `verified` is false, and the project's name is not a stranger's byline;
  - the preview, if any, is read at the pinned commit.

It clones a stranger's repository, and like every other job that does, it
runs nothing from it: the manifest is read and the tree is hashed.

Exit 0 when the entry holds, 1 when it does not, 2 when the input is not
two catalogues. One line per problem, each an `::error::` for the run's page.
"""
import json
import os
import re
import subprocess
import sys
import tempfile

CLI = os.environ.get("AGENTGLASS_PLUGIN_CLI") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bin", "agentglass-plugin")
# Used with `fullmatch`, never `match`: Python's `$` matches before a newline
# at the end, and every one of these guards a value compared or fetched as is.
GITHUB_REPO = re.compile(r"^https://github\.com/([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+?)(?:\.git)?/?$")
SHA1 = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def squash(s):
    """A name with its spelling taken out: case, spaces and punctuation."""
    return re.sub(r"[^a-z0-9]", "", str(s).casefold())


def same_repo(a, b):
    ma, mb = GITHUB_REPO.fullmatch(a or ""), GITHUB_REPO.fullmatch(b or "")
    if ma and mb:
        return (ma.group(1).casefold(), ma.group(2).casefold()) == (mb.group(1).casefold(), mb.group(2).casefold())
    return (a or "").rstrip("/").removesuffix(".git") == (b or "").rstrip("/").removesuffix(".git")


def cli(verb, folder):
    r = subprocess.run([sys.executable, CLI, verb, folder], capture_output=True, text=True)
    try:
        return json.loads(r.stdout or "{}")
    except json.JSONDecodeError:
        return {"ok": False, "error": f"{verb} printed no answer: {r.stderr.strip()[-200:]}"}


def clone_at(url, sha, into):
    """A fresh clone of exactly one commit. `--branch` takes a branch or a
    tag and not a commit; GitHub serves a fetch by commit id, which is what
    lets an entry pin one. Checked out with the line endings the app uses,
    so the bytes hashed here are the bytes an install hashes."""
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    for args in (["init", "-q", into],
                 ["-C", into, "fetch", "-q", "--depth", "1", "--", url, sha],
                 ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "-C", into, "checkout", "-q", "FETCH_HEAD"]):
        r = subprocess.run(["git", *args], capture_output=True, text=True, env=env)
        if r.returncode != 0:
            return (r.stderr.strip().splitlines() or ["git failed"])[-1][:300]
    return None


def check(base, head):
    """The problems with this change, as sentences. Empty means it holds."""
    problems = []
    if head.get("name") != base.get("name") or head.get("owner") != base.get("owner"):
        problems.append("the catalogue's own name or owner changed; an entry does not get to do that")
    owner = str(base.get("owner", ""))
    before = {p.get("id"): p for p in base.get("plugins") or []}
    after_list = head.get("plugins") or []
    after = {}
    for p in after_list:
        if p.get("id") in after:
            problems.append(f"{p.get('id')!r} is listed twice")
        after[p.get("id")] = p
    gone = sorted(str(i) for i in before if i not in after)
    if gone:
        problems.append(f"removes {', '.join(gone)}; a listing adds or replaces one entry and removes none")
    changed = [p for i, p in after.items() if before.get(i) != p]
    if len(changed) != 1:
        problems.append(f"changes {len(changed)} entries; a listing changes exactly one")
    if problems:
        return problems

    e = changed[0]
    eid = e.get("id")
    src = e.get("source") or {}
    url, ref = src.get("url", ""), src.get("ref")
    if eid in before and not same_repo(before[eid]["source"].get("url"), url):
        problems.append(f"{eid!r} is listed from {before[eid]['source'].get('url')}; a different repository cannot take its place")
    m = GITHUB_REPO.fullmatch(url or "")
    if src.get("kind") != "git" or not m:
        problems.append("the source is not a public GitHub repository")
    if not isinstance(ref, str) or not SHA1.fullmatch(ref):
        problems.append("the source is not pinned to a full commit")
    if not isinstance(e.get("sha256"), str) or not SHA256.fullmatch(e["sha256"]):
        problems.append("the entry carries no content hash")
    if e.get("verified") is not False:
        problems.append("`verified` is the catalogue's word, and a listing sets it false")
    source_owner = m.group(1) if m else ""
    said = squash(e.get("publisher", ""))
    if any(r and r in said for r in ("agentglass", squash(owner))) and source_owner.casefold() != owner.casefold():
        problems.append(f"the publisher is a name this catalogue reserves for {owner}'s own repositories")
    if e.get("preview") is not None and m and isinstance(ref, str):
        want = f"https://raw.githubusercontent.com/{m.group(1)}/{m.group(2)}/{ref}/"
        if not str(e["preview"]).startswith(want):
            problems.append("the preview is not read at the pinned commit")
    if problems:
        return problems

    with tempfile.TemporaryDirectory(prefix="agx-catalogue-") as tmp:
        folder = os.path.join(tmp, "plugin")
        why = clone_at(url, ref, folder)
        if why:
            return [f"could not fetch {url} at {ref}: {why}"]
        got = subprocess.run(["git", "-C", folder, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        if got != ref:
            return [f"the fetch resolved to {got or 'nothing'}, not {ref}"]
        v = cli("validate", folder)
        if not v.get("ok"):
            return [f"the manifest at {ref[:12]} is not one the app accepts: {v.get('error')}"]
        if v.get("name") != eid:
            problems.append(f"the id is {eid!r} and the manifest at that commit is named {v.get('name')!r}; the app installs into the manifest's name")
        if v.get("publisher") != e.get("publisher"):
            problems.append("the publisher is not the manifest's")
        if v.get("scope") != e.get("scope"):
            problems.append(f"the entry says scope {e.get('scope')!r} and the manifest asks for {v.get('scope')!r}")
        h = cli("hash", folder)
        if not h.get("ok"):
            problems.append(f"the tree at that commit cannot be hashed: {h.get('error')}")
        elif h.get("sha256") != e.get("sha256"):
            problems.append(f"the tree at {ref[:12]} hashes to {h.get('sha256')}, not the pinned {e.get('sha256')}")
    return problems


def main():
    if len(sys.argv) != 3:
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2
    try:
        base, head = (json.load(open(p, encoding="utf-8")) for p in sys.argv[1:3])
    except (OSError, json.JSONDecodeError) as e:
        print(f"::error::not two catalogues: {e}")
        return 2
    problems = check(base, head)
    for p in problems:
        print(f"::error::{p}")
    if not problems:
        print("one entry, pinned, and the commit it names is what it says")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
