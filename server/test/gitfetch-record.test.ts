/*
 * Last-fetch record, range counts and the changelog's count extras, on temp
 * repos with a local bare "remote".
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-fetchrec-")));
process.env.AGENTGLASS_ROOT = dir;
const { fetch, lastFetch, rangeCounts } = await import("../src/gitwork.ts");
const { generateChangelog } = await import("../src/gitinsights.ts");

const G = ["-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", ...G, ...a], { cwd });
let n = 0;
// Each commit one minute after the last: lightweight tags sort by commit date,
// and commits made in the same second would tie.
const commit = (cwd: string, msg: string) => {
  const d = new Date(1_700_000_000_000 + n++ * 60_000).toISOString();
  Bun.spawnSync(["git", ...G, "commit", "-q", "--allow-empty", "-m", msg], { cwd, env: { ...process.env, GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d } });
};
const mk = (name: string): string => {
  const p = join(dir, name); Bun.spawnSync(["mkdir", "-p", p]); git(p, "init", "-q", "-b", "main", "."); return p;
};
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("last fetch", () => {
  it("records time, remotes and how many remote refs moved", () => {
    const bare = join(dir, "origin.git"); git(dir, "init", "-q", "--bare", "-b", "main", bare);
    const up = mk("up"); commit(up, "feat: one"); git(up, "remote", "add", "origin", bare); git(up, "push", "-q", "origin", "main");
    const me = join(dir, "me"); git(dir, "clone", "-q", bare, me);
    expect(lastFetch(me)).toBeNull();
    const t0 = Date.now();
    expect(fetch(me).ok).toBe(true);
    const first = lastFetch(me)!;
    expect(first.remotes).toEqual(["origin"]);
    expect(first.news).toBe(0);
    expect(first.at).toBeGreaterThanOrEqual(t0);
    commit(up, "feat: two"); git(up, "push", "-q", "origin", "main");
    expect(fetch(me, "origin").ok).toBe(true);
    expect(lastFetch(me)!.news).toBe(1);
  });

  it("merges legs of one fetch: remotes are unioned and news summed", () => {
    const a = join(dir, "ra.git"), b = join(dir, "rb.git");
    git(dir, "init", "-q", "--bare", "-b", "main", a); git(dir, "init", "-q", "--bare", "-b", "main", b);
    // `up` pushes; `me` has never fetched, so each remote brings one new ref.
    const up = mk("legs-up"); commit(up, "x");
    git(up, "remote", "add", "alpha", a); git(up, "remote", "add", "beta", b);
    git(up, "push", "-q", "alpha", "main"); git(up, "push", "-q", "beta", "main");
    const me = mk("legs"); git(me, "remote", "add", "alpha", a); git(me, "remote", "add", "beta", b);
    expect(fetch(me, "alpha").ok).toBe(true);
    expect(fetch(me, "beta").ok).toBe(true);
    const rec = lastFetch(me)!;
    expect(rec.remotes.sort()).toEqual(["alpha", "beta"]);
    expect(rec.news).toBe(2);
  });

  it("keeps 50 repositories and drops the oldest", () => {
    const roots: string[] = [];
    for (let i = 0; i < 52; i++) {
      const r = mk(`cap-${i}`); commit(r, "x"); git(r, "remote", "add", "origin", join(dir, "origin.git"));
      roots.push(r); fetch(r);
    }
    expect(lastFetch(roots[0])).toBeNull();
    expect(lastFetch(roots[1])).toBeNull();
    expect(lastFetch(roots[2])).not.toBeNull();
    expect(lastFetch(roots[51])).not.toBeNull();
  });
});

describe("range counts and changelog extras", () => {
  it("counts tag..HEAD for the newest 20 tags only, plus the whole history", async () => {
    const r = mk("tags"); commit(r, "feat: first");
    for (let i = 0; i < 22; i++) {
      git(r, "tag", `v${String(i).padStart(2, "0")}`);
      commit(r, `fix: step ${i}`);
    }
    const c = await rangeCounts(r);
    expect(c.tags.length).toBe(20);
    expect(c.root).toBe(23);
    // newest tag is v21, one commit before HEAD
    expect(c.tags[0]).toMatchObject({ name: "v21", count: 1 });
    expect(c.tags.some((t) => t.name === "v00")).toBe(false);
    expect(typeof c.tags[0].at).toBe("number");
  });

  it("reports sinceCount and the commits the sections do not list", async () => {
    const r = mk("log"); commit(r, "feat: base"); git(r, "tag", "v1");
    commit(r, "fix: a");
    git(r, "checkout", "-q", "-b", "side"); commit(r, "feat: b"); git(r, "checkout", "-q", "main");
    git(r, "merge", "--no-ff", "-q", "-m", "Merge side", "side");
    const cl = await generateChangelog(r, "v1", "HEAD");
    expect(cl.sinceCount).toBe(3); // fix, feat, merge
    expect(cl.unlisted).toBe(1);   // the merge
    expect(cl.sections.flatMap((s) => s.entries).length).toBe(2);
  });
});

describe("auto-fetch record", () => {
  it("lists only the remotes whose fetch succeeded", async () => {
    const src = await Bun.file(new URL("../src/gitwork.ts", import.meta.url)).text();
    const start = src.indexOf("async function fetchOne(");
    const body = src.slice(start, src.indexOf("\nexport function startAutoFetch"));
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("proc.exitCode === 0");
    expect(body).toContain("recordFetch(root, reached,");
    expect(body).not.toContain("recordFetch(root, fetchArgvs(root)");
  });
});
