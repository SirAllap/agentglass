// The release pipeline and the self-updater run code nobody reviews at the
// moment it runs: a third-party action resolved from a moving tag, a token left
// on disk for the next step, an update built from whatever a tag points at
// today. These assert the source, because there is no runner here to ask.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const WF = join(ROOT, ".github", "workflows");
const files = readdirSync(WF).filter((f) => f.endsWith(".yml")).sort();
const wf: Record<string, string> = {};
for (const f of files) wf[f] = await Bun.file(join(WF, f)).text();
const updater = await Bun.file(join(ROOT, "electron", "self-update.sh")).text();
const updaterTs = await Bun.file(join(ROOT, "server", "src", "selfupdate.ts")).text();

const code = (s: string) => s.split("\n").filter((l) => !/^\s*#/.test(l));

describe("workflows", () => {
  test("the directory is not empty, so the loops below assert something", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  test("every third-party action is pinned to a full commit sha and names its release", () => {
    const loose: string[] = [];
    for (const f of files)
      for (const l of code(wf[f])) {
        const m = l.match(/\buses:\s*([^\s#]+)/);
        if (!m || m[1].startsWith("./")) continue;
        if (!/@[0-9a-f]{40}$/.test(m[1]) || !/#\s*v\d/.test(l)) loose.push(`${f}: ${m[1]}`);
      }
    expect(loose).toEqual([]);
  });

  test("no workflow grants a write permission at the top level", () => {
    const wide: string[] = [];
    for (const f of files) {
      const top = code(wf[f]).join("\n").match(/^permissions:\s*\n((?:[ ]{2}\S.*\n?)+)/m);
      if (top && /:\s*write\b/.test(top[1])) wide.push(f);
    }
    expect(wide).toEqual([]);
  });

  test("every workflow states its permissions somewhere above its jobs", () => {
    const silent = files.filter((f) => !/^permissions:/m.test(wf[f]));
    expect(silent).toEqual([]);
  });

  // GitHub refuses a workflow with a repeated key, and the text checks around
  // this one read straight past it: a step with two `with:` blocks, or the same
  // input twice, looks pinned and hardened and never loads.
  test("no mapping repeats a key", () => {
    const dup: string[] = [];
    for (const f of files) {
      const seen = new Map<number, Set<string>>();
      let block = -1; // indent of a `key: |` whose lines are text, not keys
      wf[f].split("\n").forEach((line, n) => {
        const ind = line.length - line.trimStart().length;
        if (block >= 0) { if (!line.trim() || ind > block) return; block = -1; }
        if (!line.trim() || line.trimStart().startsWith("#")) return;
        const m = line.match(/^(\s*)(- )?([A-Za-z_][\w-]*):(\s|$)/);
        if (!m) return;
        const col = m[1].length + (m[2] ? 2 : 0);
        for (const k of [...seen.keys()]) if (k > col || (m[2] && k >= col)) seen.delete(k);
        const keys = seen.get(col) ?? new Set<string>();
        if (keys.has(m[3])) dup.push(`${f}:${n + 1} ${m[3]}`);
        keys.add(m[3]); seen.set(col, keys);
        if (/:\s*[|>][+-]?\s*$/.test(line)) block = m[1].length;
      });
    }
    expect(dup).toEqual([]);
  });

  test("a checkout leaves no token on disk unless the job pushes with it", () => {
    // traffic.yml clones with its own credential and never needs the ambient one.
    const kept: string[] = [];
    for (const f of files) {
      const lines = code(wf[f]);
      lines.forEach((l, i) => {
        if (!/uses:\s*actions\/checkout@/.test(l)) return;
        const step = lines.slice(i, i + 12).join("\n").split(/\n\s*-\s/)[0];
        if (!/persist-credentials:\s*false/.test(step)) kept.push(`${f}:${i + 1}`);
      });
    }
    expect(kept).toEqual([]);
  });
});

describe("self-update", () => {
  test("the log is not at a fixed path in /tmp", () => {
    expect(code(updater).join("\n")).not.toMatch(/\/tmp\//);
    expect(code(updaterTs).join("\n")).not.toMatch(/tmpdir\(\)/);
  });

  test("dependencies install from the lockfile, never re-resolved", () => {
    const installs = code(updater).filter((l) => /\bbun install\b/.test(l));
    expect(installs.length).toBeGreaterThan(0);
    for (const l of installs) expect(l).toContain("--frozen-lockfile");
  });

  test("the tag must be an annotated tag whose commit is the one built", () => {
    const c = code(updater).join("\n");
    expect(c).toMatch(/objecttype/);
    expect(c).toMatch(/verify-tag/);
    expect(c).toMatch(/\^\{commit\}/);
  });
});

// The script itself, against a throwaway origin. It stops at the tag check, well
// before any install, so nothing here touches the developer's app or clone.
describe("self-update.sh on a fixture origin", () => {
  const run = (tagKind: "lightweight" | "annotated") => {
    const dir = mkdtempSync(join(tmpdir(), "agx-upd-"));
    try {
      const origin = join(dir, "origin");
      const home = join(dir, "home");
      const sh = (cwd: string, ...a: string[]) =>
        Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { env: { PATH: process.env.PATH!, HOME: home } });
      mkdirSync(origin, { recursive: true }); mkdirSync(home, { recursive: true });
      sh(origin, "init", "-q");
      sh(origin, "commit", "-q", "--allow-empty", "-m", "one");
      if (tagKind === "annotated") sh(origin, "tag", "-a", "v9.9.9", "-m", "notes");
      else sh(origin, "tag", "v9.9.9");
      const r = Bun.spawnSync(["bash", join(ROOT, "electron", "self-update.sh")], {
        cwd: home,
        env: {
          PATH: process.env.PATH!, HOME: home,
          AGENTGLASS_UPDATE_TAG: "v9.9.9", AGENTGLASS_UPDATE_ORIGIN: origin,
          // The fixture has no web/ directory, so an accepted tag fails at the
          // install step instead of building anything.
          AGENTGLASS_UPDATE_SRC: join(home, "src"),
        },
      });
      const log = join(home, ".cache", "agentglass", "update.log");
      return { status: r.exitCode, text: readFileSync(log, "utf8"), mode: statSync(log).mode & 0o777 };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  test("a lightweight tag is refused before anything is built", () => {
    const r = run("lightweight");
    expect(r.status).toBe(1);
    expect(r.text).toContain("not an annotated release tag");
    expect(r.text).not.toContain("installing dependencies");
  });

  test("an annotated tag passes the check and reaches the install, in a private log", () => {
    const r = run("annotated");
    expect(r.text).toContain("now at ");
    expect(r.text).toContain("installing dependencies");
    expect(r.mode).toBe(0o600);
  });
});
