// The requirements page is only worth opening if the catalogue tells the truth.
//
// Two ways it stops being true, and both are silent. A tool the app started
// shelling out to and nobody added: the feature quietly does nothing and the
// page says everything is fine — which is what happened when the Tasks view
// arrived and `task` was not listed. And an entry whose binary the app no
// longer calls: a reader installs something for no reason.
//
// So the catalogue is checked against the source rather than against a second
// list that would drift the same way.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEPS, isRemoteScript } from "../../shared/deps.ts";

const SRC = join(import.meta.dir, "..", "src");

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}
const ALL = sources(SRC).map((f) => readFileSync(f, "utf8")).join("\n");

/** Binaries the server spawns or probes for, read out of the code itself. */
function spawned(): Set<string> {
  const found = new Set<string>();
  for (const re of [/Bun\.which\(\s*"([a-z0-9_.-]+)"/g, /spawnSync\(\s*\[\s*"([a-z0-9_.-]+)"/g, /Bun\.spawn\(\s*\[\s*"([a-z0-9_.-]+)"/g]) {
    for (const m of ALL.matchAll(re)) found.add(m[1]!);
  }
  return found;
}

describe("the requirements catalogue matches what the app actually runs", () => {
  test("every catalogued binary is still called somewhere", () => {
    // An entry nobody calls asks a reader to install something for nothing.
    const stale = DEPS.filter((d) => !ALL.includes(`"${d.bin}"`)).map((d) => d.id);
    expect(stale).toEqual([]);
  });

  test("Taskwarrior is listed, because the Tasks view shells out to it", () => {
    // The regression that prompted this file: a whole integration landed and
    // the page that answers "what am I missing" did not mention it.
    expect(ALL).toContain('Bun.which("task"');
    const task = DEPS.find((d) => d.id === "task");
    expect(task?.bin).toBe("task");
    // Optional, not required: the GitHub half of that view works without it.
    expect(task?.required).toBe(false);
  });

  test("ss is listed, because the ports panel has no other way to look", () => {
    expect(ALL).toContain('spawnSync(["ss"');
    expect(DEPS.some((d) => d.bin === "ss")).toBe(true);
  });

  test("each entry says what stops working, and links the project, not a package manager", () => {
    for (const d of DEPS) {
      expect(d.what.length).toBeGreaterThan(20);
      expect(d.url).toMatch(/^https:\/\//);
      // The catalogue's own rule, and the reason it holds: there is one macOS,
      // one Windows and an unbounded number of Linuxes, so an install line is
      // wrong for most readers and stale for the rest.
      expect(d.url).not.toMatch(/\b(apt|dnf|pacman|brew|apk|yum)\b/);
    }
  });

  /**
   * Every binary the app runs is either catalogued or exempt ON PURPOSE.
   *
   * The check above this one runs catalogue → source, and that direction alone
   * is what let three tools go missing: `tailscale`, `codex` and `agy` were all
   * being spawned, all gating a whole feature, and none of them listed. Nothing
   * failed, because nothing was asking this question.
   *
   * The exemptions are the point. A tool leaves this list by having a reason
   * written next to it, so "it is not in the catalogue" stops being something
   * that happens by omission and becomes something somebody decided.
   */
  const EXEMPT: Record<string, string> = {
    // Faster search and file-finding. Without them it falls back to `git grep`
    // and `git ls-tree`, so nothing stands down — the feature is there either
    // way, and the panel reports which one answered. This was the catalogue's
    // own call before this test existed and it still holds.
    rg: "search falls back to `git grep`; nothing stands down",
    fd: "file-finding falls back to `git ls-tree`; nothing stands down",
    fdfind: "the Debian name for fd, looked for beside it",
    // POSIX furniture. A machine without these is not a machine this app can be
    // told to run on, and a row for `cp` would be noise on a page whose value
    // is that everything on it is worth reading.
    sh: "POSIX; present anywhere this runs",
    cp: "POSIX; present anywhere this runs",
    du: "POSIX; present anywhere this runs",
    ps: "POSIX; present anywhere this runs, and the fallback when /proc is absent",
    // Probed as the older alias beside `python3`, which IS catalogued.
    python: "tried alongside python3, which has the row",
    /*
     * The runtime this server is already executing in.
     *
     * The work loop runs the person's own test command inside the worktree it
     * cut, and that command is `bun test` — his, not a guess at one, because
     * "compiling is not evidence" and only his suite decides whether a run
     * actually finished. A requirements row telling somebody to install the
     * thing currently interpreting that page would be furniture.
     */
    bun: "the runtime this server runs in; the work loop runs his own `bun test`",
    // Handing a file to the desktop's own viewer. Every desktop has one of
    // these and the finder says which it used; with none, the preview pane
    // says so and the file simply stays where it is — nothing else changes.
    open: "the macOS opener; the finder falls back to saying it cannot",
    gio: "the GNOME opener, tried beside xdg-open, which has the row",
  };

  test("every binary the app runs is catalogued, or exempt with a reason", () => {
    const catalogued = new Set(DEPS.map((d) => d.bin));
    const unexplained = [...spawned()]
      .filter((bin) => !catalogued.has(bin) && !(bin in EXEMPT))
      .sort();
    // The message names them, because "expected [] to equal [x]" on a list of
    // binaries is a puzzle and this is meant to be read by whoever added one.
    expect(unexplained.join(", ") || null).toBeNull();
  });

  test("no exemption outlives the code that earned it", () => {
    // An exemption for something the app no longer runs is a note about a
    // decision nobody can check any more.
    const run = spawned();
    const stale = Object.keys(EXEMPT).filter((bin) => !run.has(bin)).sort();
    expect(stale.join(", ") || null).toBeNull();
  });

  test("the agent CLIs are listed, because each is a whole engine", () => {
    // The gap this test was written for. `codex` and `agy` are chat engines
    // beside Claude Code: absent, the engine is simply not offered, which is
    // exactly the shape `task` has and the reason `task` earned its row.
    for (const id of ["codex", "agy"]) {
      const d = DEPS.find((x) => x.id === id);
      expect(d?.required).toBe(false);
      expect(ALL).toContain(`Bun.which("${d?.bin}")`);
    }
  });

  test("Tailscale is listed, because remote access has no other route", () => {
    expect(ALL).toContain('Bun.which("tailscale"');
    expect(DEPS.some((d) => d.bin === "tailscale")).toBe(true);
  });

  test("every required tool can be offered, not just linked", () => {
    /**
     * The gap this closes. `git` and `python3` are in every distribution, so
     * the per-manager table covered them and it looked finished — but the
     * required tool most likely to be missing on a fresh machine is the Claude
     * CLI, which no distribution packages, and the page offered it a link and
     * nothing else. "Install the things this app cannot run without" has to
     * work for all three or it does not work.
     *
     * Asserted on the catalogue rather than on a resolved line, because the
     * resolved line depends on which package manager the test machine happens
     * to have, and that is not what is being claimed here.
     */
    for (const d of DEPS.filter((x) => x.required)) {
      const offerable = !!d.installer || Object.keys(d.pkg ?? {}).length > 0;
      expect(offerable ? null : `${d.id} is required and has no way to install it`).toBeNull();
    }
  });

  test("Docker keeps its link on purpose, and says why in the catalogue", () => {
    // The honest limit of the feature: Docker's install is a repository and a
    // key, and a fabricated one-liner would fetch the wrong daemon. If someone
    // later gives it an apt line, this fails and they have to mean it.
    const docker = DEPS.find((d) => d.id === "docker");
    expect(docker?.pkg).toBeUndefined();
    expect(docker?.installer).toBeUndefined();
  });

  test("a script fetched off the internet is told apart from a package install", () => {
    // Drives the extra sentence the console shows. Both are typed rather than
    // run, but only one of them asks you to trust something you cannot read yet.
    expect(isRemoteScript("curl -fsSL https://claude.ai/install.sh | bash")).toBe(true);
    expect(isRemoteScript("wget -qO- https://example.com/i.sh | sudo sh")).toBe(true);
    expect(isRemoteScript("sudo apt-get install -y git")).toBe(false);
    expect(isRemoteScript("brew install tmux")).toBe(false);
    // A download that does NOT pipe into a shell is not this: it leaves a file
    // on disk that a person can read before running it.
    expect(isRemoteScript("curl -fsSL https://example.com/x.sh -o x.sh")).toBe(false);
  });

  test("the Claude CLI carries the command its own docs recommend", () => {
    const claude = DEPS.find((d) => d.id === "claude");
    expect(claude?.installer).toBe("curl -fsSL https://claude.ai/install.sh | bash");
    // Taken from the setup page, which also moved host — the old docs.claude.com
    // path only reaches it through a redirect.
    expect(claude?.url).toBe("https://code.claude.com/docs/en/setup");
  });

  test("no id is listed twice and every id has a binary", () => {
    const ids = DEPS.map((d) => d.id);
    expect(ids.length).toBe(new Set(ids).size);
    for (const d of DEPS) expect(d.bin.trim()).not.toBe("");
  });
});
