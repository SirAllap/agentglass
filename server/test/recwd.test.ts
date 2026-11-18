/*
 * A tab that starts in a repo root and moves its work into a worktree of the
 * same repo keeps its process cwd: the footer must follow the session instead.
 * Pure cases first (the transcript's latest cwd, the same-repo rule, the
 * refusal sentences), then `paneDirs` over a real transcript file, then the
 * `recwd` route on an isolated booted server. All names are invented.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { latestCwdFromTranscript, movedRoot, notePaneAgent, paneDirs, resetTailCache, setPaneRoot } from "../src/panewt.ts";
import { recwdRefusal } from "../src/agentops.ts";
import { startHarness, type Harness } from "./fixtures/workerHarness.ts";

const REPO = "/home/dev/code/orbit";
const WT = "/home/dev/code/orbit-ORBIT-1042";
const OTHER = "/home/dev/code/acme";
/** Two checkouts of orbit are one repo; acme is another. */
const repoOf = (d: string): string | null => d.startsWith(REPO) ? REPO : d.startsWith("/home/dev/code/acme") ? OTHER : null;

const entry = (cwd: string, text = "x") => JSON.stringify({ type: "user", cwd, message: { content: text } });

describe("latestCwdFromTranscript", () => {
  test("the newest entry's cwd wins, a half line and prose are skipped", () => {
    const t = ["half-a-line\"}", entry(REPO), entry(WT), JSON.stringify({ type: "summary" })].join("\n");
    expect(latestCwdFromTranscript(t)).toBe(WT);
  });
  test("nothing with a cwd is null", () => {
    expect(latestCwdFromTranscript("")).toBeNull();
    expect(latestCwdFromTranscript(JSON.stringify({ type: "summary" }))).toBeNull();
  });
});

describe("movedRoot", () => {
  test("a worktree of the same repo replaces the anchor", () => {
    expect(movedRoot([WT], [REPO], repoOf)).toBe(WT);
  });
  test("another repo, the anchor itself and an unplaceable dir never move the tab", () => {
    expect(movedRoot([OTHER], [REPO], repoOf)).toBeNull();
    expect(movedRoot([REPO], [REPO], repoOf)).toBeNull();
    expect(movedRoot(["/gone/dir"], [REPO], repoOf)).toBeNull();
  });
  test("the explicit re-root outranks the transcript", () => {
    expect(movedRoot([`${REPO}-explicit`, WT], [REPO], repoOf)).toBe(`${REPO}-explicit`);
  });
  test("no anchor, no move", () => {
    expect(movedRoot([WT], [null, undefined], repoOf)).toBeNull();
  });
});

describe("paneDirs follows the session's transcript", () => {
  const dir = mkdtempSync(join(tmpdir(), "agx-recwd-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("process in the repo root, session moved to a worktree: the worktree is first", () => {
    resetTailCache();
    const pane = "%9941";
    const tp = join(dir, "s1.jsonl");
    writeFileSync(tp, [entry(REPO), entry(WT)].join("\n") + "\n");
    // The hook reports where the session is NOW, not where the process stands.
    notePaneAgent({ pane, sessionId: "s1", transcriptPath: tp, cwd: WT });
    const r = paneDirs(pane, 1, () => [REPO], undefined, REPO, repoOf);
    expect(r.dirs[0]).toBe(WT);
    expect(r.dirs).toContain(REPO);
    expect(r.agent).toBe("s1");
  });

  test("a session that moved into another repo does not move the tab", () => {
    resetTailCache();
    const pane = "%9942";
    const tp = join(dir, "s2.jsonl");
    writeFileSync(tp, [entry(REPO), entry(OTHER)].join("\n") + "\n");
    notePaneAgent({ pane, sessionId: "s2", transcriptPath: tp, cwd: REPO });
    expect(paneDirs(pane, 1, () => [REPO], undefined, REPO, repoOf).dirs[0]).toBe(REPO);
  });

  test("an explicit re-root wins, and is dropped when the dir is not the tab's repo", () => {
    resetTailCache();
    const pane = "%9943";
    setPaneRoot(pane, `${REPO}-chosen`);
    expect(paneDirs(pane, 1, () => [REPO], undefined, REPO, repoOf).dirs[0]).toBe(`${REPO}-chosen`);
    setPaneRoot(pane, OTHER);
    expect(paneDirs(pane, 1, () => [REPO], undefined, REPO, repoOf).dirs[0]).toBe(REPO);
    resetTailCache();
  });
});

describe("recwdRefusal", () => {
  const isDir = () => true;
  test("a worktree of the tab's repo is fine", () => {
    expect(recwdRefusal(WT, REPO, repoOf, isDir)).toBeNull();
  });
  test("another repo is refused with a sentence that names the repo", () => {
    expect(recwdRefusal(OTHER, REPO, repoOf, isDir)).toContain("not a worktree of this tab's repo (orbit)");
  });
  test("a missing dir and a relative path are refused", () => {
    expect(recwdRefusal(WT, REPO, repoOf, () => false)).toContain("not a directory");
    expect(recwdRefusal("orbit-x", REPO, repoOf, isDir)).toContain("absolute");
  });
});

const have = !!Bun.which("tmux") && !!Bun.which("git") && !!Bun.which("python3");
describe.skipIf(!have)("POST /agents/named/recwd, on an isolated server", () => {
  let h: Harness;
  let root = "", wt = "", stranger = "";
  const git = (cwd: string, ...a: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  beforeAll(async () => {
    h = await startHarness("recwd");
    root = join(h.dir, "orbit"); wt = join(h.dir, "orbit-ORBIT-1042"); stranger = join(h.dir, "acme");
    for (const d of [root, stranger]) { mkdirSync(d); git(d, "init", "-q", "-b", "main"); git(d, "commit", "-q", "--allow-empty", "-m", "init"); }
    git(root, "worktree", "add", "-q", "-b", "ORBIT-1042-thing", wt);
    const d = new Database(join(h.dir, "w.db")); d.run("PRAGMA busy_timeout = 5000");
    d.run("INSERT OR REPLACE INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at, seat_root) VALUES ('recwd-tab', 'claude', ?, '%9998', '@9998', ?, NULL, NULL)", [root, Date.now()]);
    d.close();
  }, SERVER_BOOT_MS);
  afterAll(async () => { await h?.stop(); });

  test("a worktree of its own repo re-roots the row; a stranger repo is refused with a sentence", async () => {
    const no = await h.asPerson("/agents/named/recwd", { name: "recwd-tab", dir: stranger });
    expect(no.ok).toBe(false);
    expect(String(no.error)).toContain("not a worktree of this tab's repo");
    expect((await h.row("recwd-tab"))?.cwd).toBe(root);
    const yes = await h.asPerson("/agents/named/recwd", { name: "recwd-tab", dir: wt });
    expect(yes.ok, String(yes.error)).toBe(true);
    expect((await h.row("recwd-tab"))?.cwd).toBe(wt);
  });
  test("an unknown name is 404", async () => {
    expect((await h.asPerson("/agents/named/recwd", { name: "nobody-here", dir: wt })).ok).toBe(false);
  });
});
