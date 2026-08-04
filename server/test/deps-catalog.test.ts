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

  test("the tools with a working fallback are deliberately absent", () => {
    // rg and fd make search faster; without them it falls back to `git grep`
    // and a walk, so nothing stands down and neither earns a row. Written down
    // because the next person to read the spawn list will wonder why.
    expect(ALL).toContain('Bun.which("rg")');
    expect(ALL).toContain('Bun.which("fd")');
    expect(DEPS.some((d) => d.bin === "rg" || d.bin === "fd")).toBe(false);
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
