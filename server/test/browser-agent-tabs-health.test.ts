/*
 * THE SELF-CHECK DELIVERY 22b READS: which agent tabs hold no browser
 * credential, why, and the re-issue route's answer.
 *
 * The app hands every agent tab a credential through one door, so a healthy
 * app reports none missing. This holds the three states the UI draws a yellow
 * dot for — issued, off by the person's setting, and unknown (this server no
 * longer holds what it handed) — plus the refusal a re-issue gets when the
 * engine is off. One real tmux pane stands in for the tab; no CLI is started.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const REAL_STATE = process.env.AGENTGLASS_STATE_DIR;
const REAL_SOCKET = process.env.AGENTGLASS_TMUX_SOCKET;
const DIR = join(tmpdir(), `agx-health-${process.pid}`);
const SOCKET = `agx-health-${process.pid}`;
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
process.env.AGENTGLASS_STATE_DIR = join(DIR, "state");

const { defaultBrowserWorkers } = await import("../../shared/browserWorkers.ts");

const TAB = "orbit-ORBIT-1042";
const ROOT = join(DIR, "orbit");

let pane: typeof import("../src/tmuxpane.ts");
let db: typeof import("../src/db.ts");
let access: typeof import("../src/browseraccess.ts");
let health: typeof import("../src/browserhealth.ts");
let auth: typeof import("../src/auth.ts");
let paneId = "";
let windowId = "";

beforeAll(async () => {
  mkdirSync(ROOT, { recursive: true });
  mkdirSync(DIR, { recursive: true });
  process.env.TMUX_TMPDIR = DIR;
  pane = await import("../src/tmuxpane.ts");
  db = await import("../src/db.ts");
  access = await import("../src/browseraccess.ts");
  health = await import("../src/browserhealth.ts");
  auth = await import("../src/auth.ts");
  const mk = await pane.tmux(["new-session", "-d", "-s", "agxhealth", "-P", "-F", "#{pane_id}\t#{window_id}", "-c", ROOT, "sleep", "300"]);
  const [p = "", w = ""] = mk.stdout.trim().split("\t");
  paneId = p;
  windowId = w;
});

afterAll(async () => {
  try { await pane.tmux(["kill-server"]); } catch { /* already gone */ }
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  if (REAL_STATE === undefined) delete process.env.AGENTGLASS_STATE_DIR;
  else process.env.AGENTGLASS_STATE_DIR = REAL_STATE;
  if (REAL_SOCKET === undefined) delete process.env.AGENTGLASS_TMUX_SOCKET;
  else process.env.AGENTGLASS_TMUX_SOCKET = REAL_SOCKET;
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* never made */ }
});

beforeEach(() => {
  expect(access.saveBrowserWorkers(defaultBrowserWorkers()).ok).toBe(true);
  db.db.run(`INSERT INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at)
    VALUES (?, 'claude', ?, ?, ?, ?, NULL)
    ON CONFLICT(name) DO UPDATE SET pane_id = excluded.pane_id, window_id = excluded.window_id, ended_at = NULL`,
    [TAB, ROOT, paneId, windowId, Date.now()]);
});

const row = async () => (await health.agentTabHealth()).find((t) => t.name === TAB);

describe("the self-check", () => {
  test("a tab handed a credential reads ok", async () => {
    const cred = access.agentWindowEnv({ name: TAB, engine: "claude" });
    expect(cred.token).toMatch(/^wk_/);
    const t = await row();
    expect(t, "the live tab is listed").toBeDefined();
    expect(t!.state).toBe("ok");
    expect(t!.reason).toBe("");
  }, 20_000);

  test("a credential this server no longer holds reads unknown, with the reason", async () => {
    access.agentWindowEnv({ name: TAB, engine: "claude" });
    auth.revokeWorkerTokens(TAB);
    const t = await row();
    expect(t!.state).toBe("unknown");
    expect(t!.reason).toContain("revoked or expired");
    expect(t!.reason).toContain("re-issue");
  }, 20_000);

  test("an engine turned off reads off, and the re-issue refuses with that reason", async () => {
    const all = access.browserWorkersNow();
    expect(access.saveBrowserWorkers({ ...all, engines: all.engines.filter((e) => e !== "claude") }).ok).toBe(true);
    access.agentWindowEnv({ name: TAB, engine: "claude" });
    const t = await row();
    expect(t!.state).toBe("off");
    expect(t!.reason).toContain("Settings ▸ Browser");
    const r = health.reissueAgentCredential(TAB);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("Settings ▸ Browser");
  }, 20_000);

  test("a re-issue for a live tab holds a credential for its next start, and never returns the token", async () => {
    access.agentWindowEnv({ name: TAB, engine: "claude" });
    const r = health.reissueAgentCredential(TAB);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.applies).toBe("next-start");
      expect(JSON.stringify(r)).not.toContain("wk_");
    }
    /* And the next start consumes it rather than leaving it unused. */
    const next = access.agentWindowEnv({ name: TAB, engine: "claude" });
    expect(next.token).toMatch(/^wk_/);
    expect(next.env.AGENTGLASS_BROWSER_OFF).toBeUndefined();
  }, 20_000);

  test("a re-issue does not cut the credential the tab is running with, and the dot says it is waiting", async () => {
    /* The re-issue minted with replace, which deleted the token the running
       process holds; the self-check then read the held one as live and said
       ok for a tab that had just been cut off. */
    const running = access.agentWindowEnv({ name: TAB, engine: "claude" }).token!;
    expect(health.reissueAgentCredential(TAB).ok).toBe(true);
    expect(auth.workerTokenOf(TAB), "the running tab's credential survives").toBe(running);
    const t = await row();
    expect(t!.state).toBe("pending");
    expect(t!.reason).toContain("next start");
  }, 20_000);

  test("a seat's re-issue says to re-seat rather than reporting one it did not issue", () => {
    /* Seating revokes the project's credentials before minting, so a re-issue
       cannot hand this chair anything: the answer says what will, and does not
       wear the same `issued` a worker's held credential wears. */
    const root = join(DIR, "orbit-chair");
    const name = "orchestrator-orbit-chair";
    db.db.run(`INSERT INTO seat (root, name, kind, powers, started_at, ended_at, adopted_pane)
      VALUES (?, ?, 'claude', 'speak', ?, NULL, ?)
      ON CONFLICT(root) DO UPDATE SET name = excluded.name, adopted_pane = excluded.adopted_pane, ended_at = NULL`,
      [root, name, Date.now(), paneId]);
    const r = health.reissueAgentCredential(name);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state).not.toBe("issued");
      expect(r.note).toContain("Re-seat");
    }
    db.db.run("DELETE FROM seat WHERE root = ?", [root]);
  });

  test("a re-issue for a name that is not a live tab is refused", () => {
    const r = health.reissueAgentCredential("orbit-NOPE-9999");
    expect(r.ok).toBe(false);
  });

  test("the two routes the UI calls are in the server, under /browser/agent-tabs", async () => {
    const src = await Bun.file(new URL("../../server/src/index.ts", import.meta.url).pathname).text();
    expect(src).toContain('pathname === "/browser/agent-tabs" && req.method === "GET"');
    expect(src).toContain('pathname === "/browser/agent-tabs/reissue" && req.method === "POST"');
    /* The re-issue POST must not be swallowed by the browser relay. */
    expect(src).toContain('|| pathname === "/browser/agent-tabs/reissue"');
  });
});
