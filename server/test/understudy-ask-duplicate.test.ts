/*
 * The queue rejects a task that is already in it.
 *
 * Queuing the same title twice for the same checkout used to write two rows,
 * and the second one is duplicate work sitting there waiting for somebody to
 * notice. `POST /understudy/work/ask` now refuses a second pending row with
 * the same title and repo, and says which one it already has.
 *
 * Two things that share a title are deliberately NOT duplicates, and both are
 * exercised here: the same title in a DIFFERENT checkout, and a title that was
 * already worked and closed — if it is needed again, asking again is fine.
 *
 * Through the route, not the bare function: the refusal is a property of what
 * `POST /understudy/work/ask` answers, and a unit test on `Sources.ask` alone
 * would not prove the HTTP caller ever sees it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "machine-token-for-the-dupe-test";

let dir = "", dbFile = "", base = "";
let root = "", sibling = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-ask-dupe-"));
  dbFile = join(dir, "dupe.db");

  // A real checkout, and a real sibling worktree of it — the fence
  // (`isOpenProjectPath`) and discovery (`openProjectRepos`) both work off
  // real git, so a repo the test invents has to be one too.
  root = join(dir, "widget");
  execFileSync("git", ["init", "-q", root]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["commit", "-q", "--allow-empty", "-m", "init"]);
  sibling = join(dir, "widget-feature");
  git(root, ["worktree", "add", "-q", "-b", "feature", sibling]);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    // Named, never `...process.env` — a leaked variable here would point this
    // server at a real database or a real paired-devices file.
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      // State (audit log, ledgers, engine conf) jailed too: without this a booted
      // server writes into the developer's real ~/.local/state/agentglass.
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: dbFile,
      AGENTGLASS_TOKEN: TOKEN,
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
    },
    // Started from inside the checkout, so `openProjectRepos()` finds it and
    // its sibling worktree the same way a real install finds the checkout it
    // is running from — see the note on `here` in `openProjectRepos`.
    cwd: root,
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  if (!(await fetch(base + "/health").then((r) => r.ok).catch(() => false))) {
    throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
  }
}, SERVER_BOOT_MS);

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const ask = (title: string, repo: string) =>
  fetch(base + "/understudy/work/ask", { method: "POST", headers, body: JSON.stringify({ title, repo }) })
    .then(async (r) => ({ status: r.status, body: await r.json() as Record<string, unknown> }));

/** Marks a queued row as taken — the same state a finished, closed run leaves
 *  it in — without running the loop machinery just to get there. */
function markTaken(id: number): void {
  const db = new Database(dbFile);
  try {
    db.query("UPDATE understudy_asked SET taken_at = ? WHERE id = ?").run(Date.now(), id);
  } finally {
    db.close();
  }
}

describe("the queue refuses a task it already has", () => {
  test("a second row with the same title and checkout is refused, and names the first", async () => {
    const first = await ask("Tidy the widget", root);
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    const id = first.body.id as number;
    expect(id).toBeGreaterThan(0);

    const second = await ask("Tidy the widget", root);
    expect(second.status).toBe(409);
    expect(second.body.ok).toBe(false);
    expect(second.body.id).toBe(id);
    expect(String(second.body.error)).toContain(String(id));
  });

  test("the same title in a different checkout is not a duplicate", async () => {
    const there = await ask("Paint the fence", sibling);
    expect(there.status).toBe(200);
    expect(there.body.ok).toBe(true);

    const here = await ask("Paint the fence", root);
    expect(here.status).toBe(200);
    expect(here.body.ok).toBe(true);
    expect(here.body.id).not.toBe(there.body.id);
  });

  test("a title that was already worked and closed can be asked again", async () => {
    const first = await ask("Ship the release", root);
    expect(first.status).toBe(200);
    markTaken(first.body.id as number);

    const again = await ask("Ship the release", root);
    expect(again.status).toBe(200);
    expect(again.body.ok).toBe(true);
    expect(again.body.id).not.toBe(first.body.id);
  });
});
