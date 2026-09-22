/*
 * The shared-tree flag, end to end: hooks in, the Diff view's list out.
 *
 * sharedtree.ts is tested as a function; this is the wiring around it, which
 * is where a correct function most easily says nothing — the list is read from
 * a cache, the checkouts come from a sweep, the liveness from the rollup, and a
 * field that is computed and never attached looks exactly like "no tree is
 * shared". Two sessions edit one file in a repo while a third works in a linked
 * worktree of it: the repo has to come back with the first two as its authors
 * and that file as their overlap, and the worktree with the third alone.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import type { ChangeRowsResult } from "../../shared/types.ts";

let dir = "", repo = "", linked = "", base = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });

const edit = (session_id: string, file_path: string) => fetch(base + "/ingest", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    source_app: "orbit", session_id, hook_event_type: "PostToolUse", timestamp: Date.now(),
    payload: { tool_name: "Edit", cwd: repo, tool_input: { file_path, old_string: "1", new_string: "2" } },
  }),
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-shared-tree-"));
  repo = join(dir, "orbit");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(dir, "init", "-q", "-b", "main", "orbit");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "src", "app.ts"), "export const a = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  linked = join(dir, "orbit-WEB-1042");
  git(repo, "worktree", "add", "-q", "-b", "feat/web-1042", linked);
  // Uncommitted work in both, so both checkouts have rows to head.
  writeFileSync(join(repo, "src", "app.ts"), "export const a = 2;\n");
  writeFileSync(join(linked, "src", "app.ts"), "export const a = 3;\n");

  const port = 4960 + Math.floor(Math.random() * 30);
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      LANG: process.env.LANG || "C.UTF-8",
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      TMUX_TMPDIR: join(dir, "tmux"),
      AGENTGLASS_STATE_DIR: join(dir, "state"),
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "agents.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TMUX_SOCKET: `agx-shared-tree-${process.pid}`,
    },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  await edit("sess-a", join(repo, "src", "app.ts"));
  await edit("sess-b", join(repo, "src", "app.ts"));
  await edit("sess-c", join(linked, "src", "app.ts"));
}, SERVER_BOOT_MS);

afterAll(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test("two sessions in one checkout are both its authors; the one in its own worktree is that worktree's alone", async () => {
  const r = (await (await fetch(base + "/git/changes-v2?mode=working")).json()) as ChangeRowsResult;
  // Both checkouts are listed — the flag qualifies the list, it does not filter it.
  expect(new Set(r.rows.map((x) => x.repoRoot))).toEqual(new Set([repo, linked]));
  const by = new Map((r.authors ?? []).map((t) => [t.root, t]));
  const s = by.get(repo);
  expect(s).toBeDefined();
  expect(s!.branch).toBe("main");
  expect(s!.sessions.map((x) => x.id).sort()).toEqual(["sess-a", "sess-b"]);
  expect(s!.overlap).toEqual(["src/app.ts"]);
  // The worktree has one author, and the heading gets to say so.
  expect(by.get(linked)?.sessions.map((x) => x.id)).toEqual(["sess-c"]);
  expect(by.get(linked)?.overlap).toEqual([]);
});

test("committed mode is history and carries no flag", async () => {
  const r = (await (await fetch(base + "/git/changes-v2?mode=committed")).json()) as ChangeRowsResult;
  expect(r.authors).toBeUndefined();
});
