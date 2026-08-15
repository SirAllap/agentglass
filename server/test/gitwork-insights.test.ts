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
const { repoStats, generateChangelog } = await import("../src/gitinsights.ts");

let repo = "";
const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd: repo });

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

describe("repo insights", () => {
  beforeEach(build);

  it("counts commits per author and aggregates lines", async () => {
    commit("a.txt", "feat: first", "2026-07-01T10:00:00+00:00");
    commit("a.txt", "fix: second", "2026-07-02T10:00:00+00:00");
    commit("b.txt", "chore: third", "2026-07-03T10:00:00+00:00");
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
    const day = 86_400_000;
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day).toISOString();
    const recent = at(2);
    commit("a.txt", "feat: old", at(60));
    commit("b.txt", "feat: new", recent);
    const s = await repoStats(repo, 14);
    expect(s.churn.reduce((n, d) => n + d.commits, 0)).toBe(1);
    expect(s.churn[0].date).toBe(recent.slice(0, 10));
  });

  it("treats a merge-heavy repo without merges", async () => {
    commit("a.txt", "feat: one", "2026-07-01T10:00:00+00:00");
    const s = await repoStats(repo, 90);
    expect(s.churn).toHaveLength(1);
    expect(s.contributors[0].commits).toBe(1);
  });
});

describe("changelog", () => {
  beforeEach(build);

  it("groups conventional commits, breaking first", async () => {
    commit("a.txt", "feat: add widget", "2026-07-01T10:00:00+00:00");
    commit("b.txt", "fix(api): return null", "2026-07-02T10:00:00+00:00");
    commit("c.txt", "feat!: drop v1", "2026-07-03T10:00:00+00:00");
    commit("d.txt", "plain sentence", "2026-07-04T10:00:00+00:00");
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
    commit("a.txt", "feat: old", "2026-07-01T10:00:00+00:00");
    commit("b.txt", "feat: new", "2026-07-02T10:00:00+00:00");
    const from = git("rev-parse", "HEAD~1").stdout.toString().trim();
    const c = await generateChangelog(repo, from, "HEAD");
    expect(c.from).toBe(from);
    expect(c.sections[0].entries.map((e) => e.subject)).toEqual(["new"]);
  });
});
