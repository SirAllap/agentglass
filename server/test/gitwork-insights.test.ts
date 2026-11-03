/*
 * Insights + changelog — repoStats over a dated fixture, and the
 * conventional-commits grouping in generateChangelog.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identify } from "./gitIdentity.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-insights-")));
process.env.AGENTGLASS_ROOT = dir;
const { repoStats, generateChangelog, parseNumstatZ } = await import("../src/gitinsights.ts");

let repo = "";
const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd: repo });

// Dated relative to today: the window is the last 90 days, so a written-down date ages out. Larger n is more recent.
const ago = (n: number): string => new Date(Date.now() - (10 - n) * 86_400_000).toISOString();

function commit(file: string, msg: string, when: string): void {
  writeFileSync(join(repo, file), msg + "\n");
  git("add", "-A");
  // --since/--until filter on COMMITTER date; --date only sets the author's.
  const env = { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-qm", msg], { cwd: repo, env });
}

function build(): void {
  repo = join(dir, `r-${Math.random().toString(36).slice(2)}`);
  Bun.spawnSync(["mkdir", "-p", repo]);
  git("init", "-q", "-b", "main", ".");
  identify(repo);
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/*
 * A commit date a given number of days back from now. Every test whose
 * question is asked through repoStats's window uses it: the window is
 * "N days ago", measured from today, so a fixture pinned to a calendar date
 * passes until the window moves past it and then fails on a date rather than
 * on a change. The two tests below did exactly that on 2026-09-29, ninety days
 * after the 2026-07-01 they were written against. Whole days apart, so each
 * commit lands on its own UTC day, which is what churn buckets by.
 */
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();

describe("repo insights", () => {
  beforeEach(build);

  it("counts commits per author and aggregates lines", async () => {
    commit("a.txt", "feat: first", at(3));
    commit("a.txt", "fix: second", at(2));
    commit("b.txt", "chore: third", at(1));
    const s = await repoStats(repo, 90);
    expect(s.error).toBeUndefined();
    expect(s.churn.length).toBe(3);
    expect(s.churn.reduce((n, d) => n + d.commits, 0)).toBe(3);
    expect(s.commitsPerDay).toBe(1);
    expect(s.contributors).toHaveLength(1);
    expect(s.contributors[0].commits).toBe(3);
    // Commit 1 adds a line, commit 2 replaces it (1+1), commit 3 adds one.
    expect(s.linesChanged).toBe(4);
    expect(s.filesTouched).toBe(2);
    expect(s.hotspots[0].path).toBe("a.txt");
    // The numstat marker carried the record separator, so no commit was ever
    // matched to its day, its author or its file: all three read zero.
    expect(s.churn.reduce((n, d) => n + d.added + d.deleted, 0)).toBe(4);
    expect(s.contributors[0].added + s.contributors[0].deleted).toBe(4);
    expect(s.hotspots.find((h) => h.path === "a.txt")!.commits).toBe(2);
  });

  it("honors the days window", async () => {
    /*
     * Dated relative to today, not written down.
     *
     * The fixture used to commit on fixed dates and ask for a 14-day window,
     * which passed for as long as those dates were inside it and then started
     * failing on the day the window moved past them — a suite that goes red on
     * a calendar rather than on a change. The question being asked is "does the
     * window exclude what is outside it", and that is a question about
     * distances, not about August.
     */
    const recent = at(2);
    commit("a.txt", "feat: old", at(60));
    commit("b.txt", "feat: new", recent);
    const s = await repoStats(repo, 14);
    expect(s.churn.reduce((n, d) => n + d.commits, 0)).toBe(1);
    expect(s.churn[0].date).toBe(recent.slice(0, 10));
  });

  it("cuts by whole UTC days so the tiles and the `days` bars cover the same commits", async () => {
    const midnight = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    commit("a.txt", "feat: just outside", iso(midnight - 6 * 86_400_000 - 1000)); // last second of day 7 back
    commit("b.txt", "feat: first second inside", iso(midnight - 6 * 86_400_000)); // first second of day 6 back
    const s = await repoStats(repo, 7);
    expect(s.churn.reduce((n, d) => n + d.commits, 0)).toBe(1);
    expect(s.churn[0].date).toBe(iso(midnight - 6 * 86_400_000).slice(0, 10));
  });

  it("treats a merge-heavy repo without merges", async () => {
    commit("a.txt", "feat: one", at(1));
    const s = await repoStats(repo, 90);
    expect(s.churn).toHaveLength(1);
    expect(s.contributors[0].commits).toBe(1);
  });
});

describe("repo insights: truth", () => {
  beforeEach(build);

  it("counts every commit in the window when an old-dated commit sits in the middle of the history", async () => {
    // Plain --since stops at the first commit older than the cutoff and hides
    // everything behind it: a rebased or imported commit is enough.
    commit("a.txt", "chore: old base", at(400));
    commit("b.txt", "feat: recent one", at(5));
    commit("c.txt", "chore: stale date", at(300));
    commit("d.txt", "feat: recent two", at(3));
    commit("e.txt", "feat: recent three", at(2));
    const s7 = await repoStats(repo, 7);
    expect(s7.churn.reduce((n, d) => n + d.commits, 0)).toBe(3);
    const s90 = await repoStats(repo, 90);
    expect(s90.churn.reduce((n, d) => n + d.commits, 0)).toBe(3);
    expect(s90.filesTouched).toBe(3);
  });

  it("keeps a commit authored inside the window but recorded before it", async () => {
    writeFileSync(join(repo, "skew.txt"), "x\n");
    git("add", "-A");
    const env = { ...process.env, GIT_AUTHOR_DATE: at(2), GIT_COMMITTER_DATE: at(200) };
    Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-qm", "feat: skewed"], { cwd: repo, env });
    commit("b.txt", "feat: normal", at(1));
    const s = await repoStats(repo, 7);
    expect(s.churn.reduce((n, d) => n + d.commits, 0)).toBe(2);
    expect(s.hotspots.map((h) => h.path)).toContain("skew.txt");
  });

  it("reads a brace rename as its new path", async () => {
    Bun.spawnSync(["mkdir", "-p", join(repo, "src/api"), join(repo, "old")]);
    commit("src/api/m4.ts", "feat: add", at(4));
    commit("old/x.ts", "feat: add x", at(3));
    git("mv", "src/api/m4.ts", "src/api/m4-new.ts");
    git("mv", "old", "fresh");
    commit("fresh/x.ts", "refactor: move", at(2));
    const s = await repoStats(repo, 30);
    const paths = s.hotspots.map((h) => h.path);
    expect(paths).toContain("src/api/m4-new.ts");
    expect(paths).toContain("fresh/x.ts");
    expect(paths.some((p) => p.includes("{") || p.includes("=>"))).toBe(false);
  });

  it("answers an empty repository cleanly, for stats and changelog", async () => {
    const s = await repoStats(repo, 30);
    expect(s.empty).toBe(true);
    expect(s.error).toBeUndefined();
    const c = await generateChangelog(repo, "", "");
    expect(c.empty).toBe(true);
    expect(c.error).toBeUndefined();
  });

  it("keeps a bad revision as a changelog error, apart from the empty answer", async () => {
    commit("a.txt", "feat: one", at(1));
    const c = await generateChangelog(repo, "", "nope");
    expect(c.empty).toBeUndefined();
    expect(c.error).toContain("nope");
  });
});

describe("changelog", () => {
  beforeEach(build);

  it("groups conventional commits, breaking first", async () => {
    commit("a.txt", "feat: add widget", ago(1));
    commit("b.txt", "fix(api): return null", ago(2));
    commit("c.txt", "feat!: drop v1", ago(3));
    commit("d.txt", "plain sentence", ago(4));
    const c = await generateChangelog(repo, "", "");
    expect(c.error).toBeUndefined();
    expect(c.sections.map((s) => s.title)).toEqual(["Breaking changes", "Features", "Fixes", "Other"]);
    const breaking = c.sections[0].entries;
    expect(breaking).toHaveLength(1);
    expect(breaking[0].subject).toBe("drop v1");
    const feats = c.sections[1].entries;
    expect(feats).toHaveLength(1);
    expect(feats[0].subject).toBe("add widget");
    const fixes = c.sections[2].entries;
    expect(fixes[0].scope).toBe("api");
    expect(fixes[0].subject).toBe("return null");
    expect(c.sections[3].entries[0].subject).toBe("plain sentence");
  });

  it("respects a from..to range", async () => {
    commit("a.txt", "feat: old", ago(1));
    commit("b.txt", "feat: new", ago(2));
    const from = git("rev-parse", "HEAD~1").stdout.toString().trim();
    const c = await generateChangelog(repo, from, "HEAD");
    expect(c.from).toBe(from);
    expect(c.sections[0].entries.map((e) => e.subject)).toEqual(["new"]);
  });
});

describe("parseNumstatZ", () => {
  it("takes the new path of a rename and survives a commit with no rows", () => {
    const out = ":AGX:aaa\0\n1\t0\tp\0:AGX:bbb\0:AGX:ccc\0\n0\t0\t\0src/{a => b}/x.ts\0src/b/x.ts\0-\t-\tbin.png\0";
    expect(parseNumstatZ(out)).toEqual([
      { sha: "aaa", added: 1, deleted: 0, path: "p" },
      { sha: "ccc", added: 0, deleted: 0, path: "src/b/x.ts", renamedFrom: "src/{a => b}/x.ts" },
      { sha: "ccc", added: 0, deleted: 0, path: "bin.png" },
    ]);
  });
});
