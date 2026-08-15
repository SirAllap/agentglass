/*
 * Guided bisect: start (bad/good), walk the candidates marking each until git
 * converges on the first bad commit, reset. The fixture plants the "bug" in
 * exactly one commit (a marker line in bug.txt), so the walk simulates a
 * human: read the checked-out file, mark good when the marker is absent and
 * bad when present, and expect the verdict to land on that commit.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identify } from "./gitIdentity.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-bisect-")));
process.env.AGENTGLASS_ROOT = dir;
const { bisectStatus, bisectStart, bisectMark, bisectReset } = await import("../src/gitwork.ts");

let repo = "";
const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
const subj = (ref = "HEAD") => git("log", "-1", "--format=%s", ref).stdout.toString().trim();

/** Five commits; "third" is the only one that carries the bug. Each commit
 *  must actually change bug.txt (git skips empty commits, which silently
 *  shrank the range to three and made HEAD~4 not exist). */
function build(): void {
  repo = join(dir, `r-${Math.random().toString(36).slice(2)}`);
  Bun.spawnSync(["mkdir", "-p", repo]);
  git("init", "-q", "-b", "main", ".");
  identify(repo);
  for (const [msg, bug] of [["first", "no"], ["second", "no"], ["third", "yes"], ["fourth", "no"], ["fifth", "no"]]) {
    writeFileSync(join(repo, "bug.txt"), `${bug}\n${msg}\n`);
    git("add", "-A");
    git("commit", "-qm", msg);
  }
}

/** Play the bisect like a person: mark good when the marker is absent. */
function walkToVerdict(): { verdict: string; steps: number } {
  let steps = 0;
  for (;;) {
    const st = bisectStatus(repo);
    expect(st.ok).toBe(true);
    expect(st.bisecting).toBe(true);
    if (st.firstBad) return { verdict: st.firstBad.subject, steps };
    expect(st.current?.sha).toHaveLength(40);
    expect(steps++).toBeLessThan(10);
    const buggy = readFileSync(join(repo, "bug.txt"), "utf8").includes("yes");
    const r = bisectMark(repo, buggy ? "bad" : "good");
    expect(r.ok).toBe(true);
  }
}

beforeEach(build);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("bisect", () => {
  it("reports not bisecting on a plain repo", () => {
    const st = bisectStatus(repo);
    expect(st).toEqual({ ok: true, bisecting: false });
  });

  it("refuses an unknown bad ref", () => {
    const r = bisectStart(repo, "nope", "HEAD~4");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not a commit");
    expect(bisectStatus(repo).bisecting).toBe(false);
  });

  it("starts and lands on the first bad commit", () => {
    const r = bisectStart(repo, "HEAD", "HEAD~4");
    expect(r.ok).toBe(true);
    const st = bisectStatus(repo);
    expect(st.bisecting).toBe(true);
    expect(st.remaining).toBeGreaterThan(0);
    const { verdict, steps } = walkToVerdict();
    expect(verdict).toBe("third");
    expect(steps).toBeGreaterThan(0);
    expect(bisectStatus(repo).bisecting).toBe(true); // git keeps state until reset
  });

  it("reset returns to the branch tip and clears the state", () => {
    bisectStart(repo, "HEAD", "HEAD~4");
    walkToVerdict();
    const r = bisectReset(repo);
    expect(r.ok).toBe(true);
    expect(bisectStatus(repo)).toEqual({ ok: true, bisecting: false });
    expect(subj()).toBe("fifth");
  });

  it("rejects a mark that is not good or bad", () => {
    const r = bisectMark(repo, "maybe");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("mark must be good or bad");
  });

  it("mid-walk reset returns to the branch", () => {
    bisectStart(repo, "HEAD", "HEAD~4");
    // Step part-way through the walk, then abandon.
    for (let i = 0; i < 2; i++) {
      const st = bisectStatus(repo);
      expect(st.bisecting).toBe(true);
      const buggy = readFileSync(join(repo, "bug.txt"), "utf8").includes("yes");
      expect(bisectMark(repo, buggy ? "bad" : "good").ok).toBe(true);
    }
    expect(bisectStatus(repo).bisecting).toBe(true);
    const r = bisectReset(repo);
    expect(r.ok).toBe(true);
    expect(bisectStatus(repo)).toEqual({ ok: true, bisecting: false });
    expect(subj()).toBe("fifth");
  });

  it("status on a root that is no repo", () => {
    expect(bisectStatus("/nope")).toEqual({ ok: false, bisecting: false, error: "not a git repository root" });
  });

  it("BISECT_LOG drives treeState", () => {
    bisectStart(repo, "HEAD", "HEAD~4");
    const gd = git("rev-parse", "--git-dir").stdout.toString().trim();
    expect(existsSync(join(repo, gd, "BISECT_LOG"))).toBe(true);
  });
});
