// Git panel controls that answered wrongly: a pushed-but-unmerged branch read as
// merged, a snapshot restore that aborted in the case its dialog promises, a
// rebase footer and a bisect readout that counted something else than git does,
// and a tag list cached against refs that never include tags.
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-g1b-")));
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_DB = join(dir, "g.db");

function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
function commit(cwd: string, file: string, body: string, msg: string) {
  writeFileSync(join(cwd, file), body);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", msg);
}
function init(path: string) {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  git(path, "config", "user.email", "t@example.com");
  git(path, "config", "user.name", "t");
}

let gw: typeof import("../src/gitwork.ts");
const ORIGIN = join(dir, "origin.git");
const REPO = join(dir, "orbit");

beforeAll(async () => {
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", ORIGIN]);
  init(REPO);
  git(REPO, "remote", "add", "origin", ORIGIN);
  commit(REPO, "README", "x\n", "root");
  git(REPO, "push", "-q", "-u", "origin", "main");
  gw = await import("../src/gitwork.ts");
});

describe("mergedIntoTrunk", () => {
  test("a branch pushed to its own remote branch but not merged is not merged", async () => {
    git(REPO, "checkout", "-q", "-b", "feature-pushed");
    commit(REPO, "f.txt", "work\n", "pushed work");
    git(REPO, "push", "-q", "-u", "origin", "feature-pushed");
    git(REPO, "checkout", "-q", "main");
    git(REPO, "checkout", "-q", "-b", "feature-landed");
    commit(REPO, "g.txt", "done\n", "landed work");
    git(REPO, "checkout", "-q", "main");
    git(REPO, "merge", "-q", "--no-ff", "-m", "merge landed", "feature-landed");
    git(REPO, "push", "-q", "origin", "main");
    const deadline = Date.now() + 3000;
    let landed;
    for (;;) {
      const b = (await gw.branches(REPO)).branches;
      landed = b.find((x) => x.name === "feature-landed");
      if (landed?.mergedIntoTrunk === true || Date.now() > deadline) break;
      await Bun.sleep(25);
    }
    const b = (await gw.branches(REPO)).branches;
    expect(landed?.mergedIntoTrunk).toBe(true);
    expect(b.find((x) => x.name === "feature-pushed")?.mergedIntoTrunk).toBe(false);
  });
});

describe("snapshot restore", () => {
  test("replaces a modified file at a path the snapshot also holds", () => {
    git(REPO, "checkout", "-q", "main");
    writeFileSync(join(REPO, "README"), "snapshot version\n");
    const snap = gw.createSnapshot(REPO, "before");
    expect(snap.ok).toBe(true);
    git(REPO, "checkout", "--", "README");
    writeFileSync(join(REPO, "README"), "edited since\n");
    const r = gw.restoreSnapshot(REPO, snap.sha);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(REPO, "README"), "utf8")).toBe("snapshot version\n");
    git(REPO, "checkout", "--", "README");
  });

  test("leaves an edit to a file the snapshot never touched alone", () => {
    writeFileSync(join(REPO, "README"), "snapshot version\n");
    const snap = gw.createSnapshot(REPO, "delta");
    git(REPO, "checkout", "--", "README");
    commit(REPO, "other.txt", "base\n", "other");
    writeFileSync(join(REPO, "other.txt"), "edited since the snapshot\n");
    writeFileSync(join(REPO, "README"), "edited too\n");
    expect(gw.restoreSnapshot(REPO, snap.sha).ok).toBe(true);
    expect(readFileSync(join(REPO, "other.txt"), "utf8")).toBe("edited since the snapshot\n");
    expect(readFileSync(join(REPO, "README"), "utf8")).toBe("snapshot version\n");
    git(REPO, "checkout", "--", "README", "other.txt");
  });

  test("a second file already equal to the snapshot but dirty does not make apply refuse", () => {
    commit(REPO, "second.txt", "base\n", "second");
    writeFileSync(join(REPO, "README"), "snapshot one\n");
    writeFileSync(join(REPO, "second.txt"), "snapshot two\n");
    const snap = gw.createSnapshot(REPO, "two files");
    git(REPO, "checkout", "--", "README", "second.txt");
    writeFileSync(join(REPO, "README"), "edited since\n");
    writeFileSync(join(REPO, "second.txt"), "snapshot two\n");
    const r = gw.restoreSnapshot(REPO, snap.sha);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(REPO, "README"), "utf8")).toBe("snapshot one\n");
    expect(readFileSync(join(REPO, "second.txt"), "utf8")).toBe("snapshot two\n");
    git(REPO, "checkout", "--", "README", "second.txt");
  });

  test("restores onto a clean tree", () => {
    writeFileSync(join(REPO, "README"), "clean case\n");
    const snap = gw.createSnapshot(REPO, "clean");
    git(REPO, "checkout", "--", "README");
    expect(gw.restoreSnapshot(REPO, snap.sha).ok).toBe(true);
    expect(readFileSync(join(REPO, "README"), "utf8")).toBe("clean case\n");
    git(REPO, "checkout", "--", "README");
  });
});

describe("rebase footer count", () => {
  test("counts the commits no remote has, not the steps above the base", () => {
    git(REPO, "checkout", "-q", "-b", "stack");
    commit(REPO, "a.txt", "1\n", "a");
    commit(REPO, "b.txt", "2\n", "b");
    git(REPO, "push", "-q", "-u", "origin", "stack");
    commit(REPO, "c.txt", "3\n", "c");
    commit(REPO, "d.txt", "4\n", "d");
    const r = gw.rebaseSteps(REPO, "main");
    expect(r.steps?.length).toBe(4);
    expect(r.unpushed).toBe(2);
    git(REPO, "checkout", "-q", "main");
  });
});

describe("bisect numbers", () => {
  test("remaining and steps are git's own", () => {
    const R = join(dir, "bis");
    init(R);
    for (let i = 0; i < 16; i++) commit(R, "f", `${i}\n`, `c${i}`);
    git(R, "bisect", "start", "HEAD", "HEAD~15");
    // The midpoint is checked out; marking it moves the bounds once.
    const out = Bun.spawnSync(["git", "bisect", "good"], { cwd: R, stdout: "pipe" }).stdout.toString();
    const m = /(\d+) revisions? left to test after this \(roughly (\d+) steps?\)/.exec(out);
    const st = gw.bisectStatus(R);
    expect(m).not.toBeNull();
    expect(st.remaining).toBe(Number(m![1]));
    expect(st.steps).toBe(Number(m![2]));
    git(R, "bisect", "reset");
  });
});

test("the tags cache is keyed on a fingerprint that includes refs/tags", async () => {
  const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
  const i = src.indexOf("async function refsFingerprint(");
  const fn = src.slice(i, src.indexOf("\n}\n", i));
  expect(fn).toContain('"refs/tags"');
});
