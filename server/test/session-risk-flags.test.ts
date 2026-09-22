/*
 * The flags reach the two places that read them: each change in a session's
 * diff, and the session's own row, which is what its card on the fleet board
 * is drawn from.
 *
 * The row is the one with a cost. The list is polled every few seconds, and
 * parsing every edit of forty sessions on each poll would be the dashboard's
 * most expensive query for a fact that only changes when an edit lands. So the
 * rollup remembers how far into the events table it has read per session and
 * only parses what arrived after — and "after" is by row id, not timestamp,
 * because a backfill inserts old edits late.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-risk-"));
const ROOT = join(dir, "orbit");
mkdirSync(ROOT, { recursive: true });
const saved = { db: process.env.AGENTGLASS_DB, cfg: process.env.XDG_CONFIG_HOME, root: process.env.AGENTGLASS_ROOT };
process.env.AGENTGLASS_DB = join(dir, "risk.db");
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_ROOT = ROOT;

let db: typeof import("../src/db.ts");
const T0 = Date.now() - 3_600_000;
const AWS = "AKIA" + "Q3EXAMPLEKEY7ZZX";

const event = (over: Record<string, unknown> = {}) => ({
  source_app: "orbit",
  session_id: "risk-s1",
  hook_event_type: "PostToolUse",
  tool_name: "Bash",
  tool_use_id: null,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-5",
  is_error: 0,
  error_text: null,
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false,
  summary: "x",
  timestamp: T0,
  payload: { project_path: ROOT },
  chat: null,
  ...over,
});

const write = (session_id: string, file: string, content: string, timestamp: number) =>
  event({ session_id, tool_name: "Write", timestamp,
          payload: { project_path: ROOT, tool_input: { file_path: join(ROOT, file), content } } });
const edit = (session_id: string, file: string, oldS: string, newS: string, timestamp: number) =>
  event({ session_id, tool_name: "Edit", timestamp,
          payload: { project_path: ROOT, tool_input: { file_path: join(ROOT, file), old_string: oldS, new_string: newS } } });

// The rollup is cached per limit for a second; a fresh limit is a fresh read.
let limit = 60;
const bySession = () => {
  process.env.AGENTGLASS_ROOT = ROOT;
  return new Map(db.getSessions(limit++).map((s) => [s.session_id, s]));
};

beforeAll(async () => {
  db = await import("../src/db.ts");
  db.insertEvent(write("risk-s1", "config/settings.yml", `region: eu-west-1\naccess_key: ${AWS}\n`, T0 + 1_000) as any);
  db.insertEvent(edit("risk-s1", "src/authMiddleware.ts", "return next();", "if (!ok) return deny();\nreturn next();", T0 + 2_000) as any);
  db.insertEvent(edit("risk-s1", "src/format.ts", "a", "b", T0 + 3_000) as any);
  db.insertEvent(event({ session_id: "risk-s2", timestamp: T0 + 1_000 }) as any);
});

afterAll(() => {
  for (const [k, v] of [["AGENTGLASS_DB", saved.db], ["XDG_CONFIG_HOME", saved.cfg], ["AGENTGLASS_ROOT", saved.root]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe("each change carries its own flags", () => {
  test("the key names its line, the auth module its word, and a plain edit nothing", () => {
    process.env.AGENTGLASS_ROOT = ROOT;
    const byFile = new Map(db.getChanges(50, "risk-s1").map((c) => [c.file_path.slice(ROOT.length + 1), c]));
    const cfg = byFile.get("config/settings.yml")!;
    expect(cfg.risks?.map((r) => r.kind)).toEqual(["secret"]);
    expect(cfg.risks?.[0].line).toBe(2);
    expect(byFile.get("src/authMiddleware.ts")!.risks?.map((r) => r.kind)).toEqual(["auth"]);
    expect(byFile.get("src/format.ts")!.risks).toBeUndefined();
  });

  test("the session detail's changes are the same objects, so the diff panel gets them too", () => {
    const d = db.getSession("risk-s1");
    expect(d?.changes.some((c) => c.risks?.some((r) => r.kind === "secret"))).toBe(true);
  });
});

describe("the session row rolls them up", () => {
  test("one entry per kind and file, and nothing on a session that edited nothing risky", () => {
    const rows = bySession();
    const s1 = rows.get("risk-s1")!;
    expect(s1.risks?.map((r) => `${r.kind}:${r.file.slice(ROOT.length + 1)}`).sort())
      .toEqual(["auth:src/authMiddleware.ts", "secret:config/settings.yml"]);
    expect(rows.get("risk-s2")).toBeDefined();
    expect(rows.get("risk-s2")!.risks).toBeUndefined();
  });

  test("an edit that lands after the first read is picked up on the next", () => {
    bySession();
    db.insertEvent(write("risk-s2", ".github/workflows/ci.yml", "on: push\n", T0 + 5_000) as any);
    expect(bySession().get("risk-s2")!.risks?.map((r) => r.kind)).toEqual(["ci"]);
  });

  test("a backfilled edit older than everything already read is still counted", () => {
    bySession();
    db.insertEvent(write("risk-s1", "bun.lock", "{}\n", T0 - 60_000) as any);
    expect(bySession().get("risk-s1")!.risks?.map((r) => r.kind).sort()).toEqual(["auth", "deps", "secret"]);
  });

  test("reading again with nothing new changes nothing", () => {
    const a = bySession().get("risk-s1")!.risks;
    const b = bySession().get("risk-s1")!.risks;
    expect(b).toEqual(a);
  });
});

describe("what a first review found", () => {
  test("a flagged edit older than the diff's window is still in the diff the card opens", () => {
    // The card rolls up the whole session; the detail lists only the newest
    // changes. A key written early and followed by a long session must not be
    // a red chip with no file behind it.
    db.insertEvent(write("risk-long", "config/app.yml", `access_key: ${AWS}\n`, T0 + 1_000) as any);
    for (let i = 0; i < 45; i++) db.insertEvent(edit("risk-long", `src/f${i}.ts`, "a", "b", T0 + 2_000 + i) as any);
    process.env.AGENTGLASS_ROOT = ROOT;
    const d = db.getSession("risk-long")!;
    expect(d.changes.some((c) => c.file_path.endsWith("config/app.yml") && c.risks?.[0]?.kind === "secret")).toBe(true);
    expect(d.changes.length).toBe(41);
  });

  test("the directory the agent ran in is not read as part of the path", () => {
    const wt = join(dir, "orbit-sso-login");
    db.insertEvent(event({ session_id: "risk-wt", tool_name: "Edit", timestamp: T0 + 1_000,
      payload: { project_path: ROOT, cwd: wt, tool_input: { file_path: join(wt, "src/format.ts"), old_string: "a", new_string: "b" } } }) as any);
    process.env.AGENTGLASS_ROOT = ROOT;
    expect(db.getChanges(5, "risk-wt")[0].risks).toBeUndefined();
  });

  test("an edit rebuilt from its strings gives no line number, because it does not know one", () => {
    const GH = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    db.insertEvent(edit("risk-edit", "src/client.ts", "const t = null;", `const t = "${GH}";`, T0 + 1_000) as any);
    process.env.AGENTGLASS_ROOT = ROOT;
    const r = db.getChanges(5, "risk-edit")[0].risks!;
    expect(r[0].kind).toBe("secret");
    expect(r[0].line).toBeUndefined();
  });

  test("callers that only want the paths do not pay for the rules", () => {
    process.env.AGENTGLASS_ROOT = ROOT;
    expect(db.getChanges(50, "risk-s1", false).every((c) => c.risks === undefined)).toBe(true);
  });
});

describe("what a second review found", () => {
  test("a flag read on an earlier poll still names its change after a newer flag lands", () => {
    // The roll-up re-ranks what it remembered together with what just arrived,
    // and the change id is what the diff uses to fetch a flagged edit older
    // than its window. Re-ranked without it, the early key was a red chip with
    // no file behind it again as soon as the session raised anything else.
    db.insertEvent(write("risk-carry", "config/app.yml", `access_key: ${AWS}\n`, T0 + 1_000) as any);
    for (let i = 0; i < 45; i++) db.insertEvent(edit("risk-carry", `src/f${i}.ts`, "a", "b", T0 + 2_000 + i) as any);
    bySession();
    db.insertEvent(edit("risk-carry", "src/authGuard.ts", "a", "b", T0 + 3_000) as any);
    const row = bySession().get("risk-carry")!;
    expect(row.risks?.every((r) => typeof r.change === "number")).toBe(true);
    process.env.AGENTGLASS_ROOT = ROOT;
    const d = db.getSession("risk-carry")!;
    expect(d.changes.some((c) => c.file_path.endsWith("config/app.yml") && c.risks?.[0]?.kind === "secret")).toBe(true);
  });

  test("the hourly prune forgets only the sessions whose edits it deleted", () => {
    // It used to forget every session on every run, deleted or not, and the
    // next poll re-parsed the whole edit history of every listed session on
    // the event loop. The kept session's edit is rewritten under the roll-up
    // here, so a re-read would show up as its flag disappearing.
    expect(db.RETENTION_DAYS).toBeGreaterThan(0);
    const OLD = Date.now() - (db.RETENTION_DAYS + 5) * 86_400_000;
    db.insertEvent(write("risk-prune-old", "config/old.yml", `access_key: ${AWS}\n`, OLD) as any);
    db.insertEvent(edit("risk-prune-old", "src/a.ts", "a", "b", T0 + 1_000) as any);
    db.insertEvent(write("risk-prune-keep", "config/keep.yml", `access_key: ${AWS}\n`, T0 + 1_000) as any);
    const before = bySession();
    expect(before.get("risk-prune-old")!.risks?.map((r) => r.kind)).toEqual(["secret"]);
    expect(before.get("risk-prune-keep")!.risks?.map((r) => r.kind)).toEqual(["secret"]);
    db.db.run(`UPDATE events SET payload = ? WHERE session_id = 'risk-prune-keep'`,
      [JSON.stringify({ project_path: ROOT, tool_input: { file_path: join(ROOT, "config/keep.yml"), content: "region: eu-west-1\n" } })]);

    db.pruneOldRows();
    const after = bySession();
    expect(after.get("risk-prune-old")).toBeDefined();
    expect(after.get("risk-prune-old")!.risks).toBeUndefined();
    expect(after.get("risk-prune-keep")!.risks?.map((r) => r.kind)).toEqual(["secret"]);

    // A run that deletes nothing forgets nothing.
    db.pruneOldRows();
    expect(bySession().get("risk-prune-keep")!.risks?.map((r) => r.kind)).toEqual(["secret"]);
  });

  test("the chip and the diff it opens count only edits inside the open project", () => {
    // The change list is scoped to the open project and the roll-up was not:
    // a session that also wrote in another checkout carried that checkout's
    // flag on its card, and the diff fetched a change the list itself hides.
    const OTHER = join(dir, "harbor");
    db.insertEvent(event({ session_id: "risk-scope", tool_name: "Write", timestamp: T0 + 1_000,
      payload: { project_path: OTHER, cwd: OTHER, tool_input: { file_path: join(OTHER, "config/app.yml"), content: `access_key: ${AWS}\n` } } }) as any);
    db.insertEvent(edit("risk-scope", "src/format.ts", "a", "b", T0 + 2_000) as any);
    const row = bySession().get("risk-scope");
    expect(row).toBeDefined();
    expect(row!.risks).toBeUndefined();
    process.env.AGENTGLASS_ROOT = ROOT;
    const d = db.getSession("risk-scope")!;
    expect(d.changes.map((c) => c.file_path)).toEqual([join(ROOT, "src/format.ts")]);
  });

  test("a flagged edit in a worktree added a moment ago reaches the card once git lists it", async () => {
    // The project's checkouts come from `git worktree list`, cached for five
    // seconds. When the roll-up filtered by scope as it READ, an edit in a
    // brand-new worktree was passed over while the list was stale and never
    // read again, because the read marker had moved past it. Scope is now
    // applied when the flags are handed out, so it catches up.
    const repo = join(dir, "fam");
    mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => {
      const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    };
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "init");
    const at = (session_id: string, root: string, file: string, content: string, timestamp: number) =>
      event({ session_id, tool_name: "Write", timestamp,
              payload: { project_path: root, cwd: root, tool_input: { file_path: join(root, file), content } } });
    process.env.AGENTGLASS_ROOT = repo;
    db.insertEvent(at("risk-fam", repo, "src/a.ts", "x\n", T0 + 1_000) as any);
    db.getSessions(limit++);
    const wt = join(dir, "fam-wt");
    git("worktree", "add", "-q", wt);
    db.insertEvent(at("risk-fam", wt, "config/app.yml", `access_key: ${AWS}\n`, T0 + 2_000) as any);
    db.insertEvent(at("risk-fam", repo, "src/b.ts", "y\n", T0 + 3_000) as any);
    db.getSession("risk-fam");
    await Bun.sleep(5_500);
    process.env.AGENTGLASS_ROOT = repo;
    const row = db.getSessions(limit++).find((s) => s.session_id === "risk-fam");
    process.env.AGENTGLASS_ROOT = ROOT;
    expect(row).toBeDefined();
    expect(row!.risks?.map((r) => r.kind)).toEqual(["secret"]);
  }, 15_000);
});

const src = await Bun.file(new URL("../src/db.ts", import.meta.url)).text();
test("the roll-up's first read of a session goes through the session index, not the event-type one", () => {
  // Measured: without the hint SQLite picks idx_events_type and a new session's
  // first read walks every PostToolUse row in the table (21 ms on 28k rows
  // against 1 ms).
  const fn = src.slice(src.indexOf("function attachRisks("), src.indexOf("\n}\n", src.indexOf("function attachRisks(")));
  expect(fn).toContain("INDEXED BY idx_events_session");
});
