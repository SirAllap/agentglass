/*
 * THE SESSION'S FIRST WINDOW NEVER TAKES `-e` FOR A CREDENTIAL.
 *
 * `new-session -e K=V` writes the SESSION's environment, not just the new
 * window's: any window that session gets afterwards can read it back by
 * name with `tmux show-environment` (no `-g`, which resolves to the current
 * session). This was true of the person's own attach (`withPersonEnv`) and
 * of an agent's first window (`ensurePanelWindow`, `engineWindowOutcome`)
 * alike — see REVIEW.md Must 1 and Should 4. Both now hand the value to the
 * window's own command instead, through a file it sources once and deletes
 * (`sessionCredentialFile`/`sessionCredentialArgv` in browseraccess.ts).
 *
 * Real tmux, on a private socket and config, with `env -u TMUX` so a client
 * started from inside a tmux session (this one, possibly) never resolves
 * onto it. Invented values only; nothing here is a real credential.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settled } from "./paneSettled.ts";

const have = !!Bun.which("tmux");
const SOCKET = `agx-cred-handoff-${process.pid}`;
const DIR = join(tmpdir(), `agx-cred-handoff-${process.pid}`);
const TOKEN = "mk_an_invented_person_token";
const WORKER_TOKEN = "wk_an_invented_worker_token";

const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const REAL_STATE = process.env.AGENTGLASS_STATE_DIR;
const REAL_SOCKET = process.env.AGENTGLASS_TMUX_SOCKET;
const REAL_TOKEN = process.env.AGENTGLASS_TOKEN;
const REAL_TMUX = process.env.TMUX;

let pane: typeof import("../src/tmuxpane.ts");

beforeAll(async () => {
  if (!have) return;
  mkdirSync(DIR, { recursive: true });
  process.env.TMUX_TMPDIR = DIR;
  process.env.AGENTGLASS_STATE_DIR = join(DIR, "state");
  process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
  process.env.AGENTGLASS_TOKEN = TOKEN;
  delete process.env.TMUX;
  pane = await import("../src/tmuxpane.ts");
  await pane.tmux(["kill-server"]);
});

afterAll(async () => {
  if (have) await pane.tmux(["kill-server"]);
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  if (REAL_STATE === undefined) delete process.env.AGENTGLASS_STATE_DIR; else process.env.AGENTGLASS_STATE_DIR = REAL_STATE;
  if (REAL_SOCKET === undefined) delete process.env.AGENTGLASS_TMUX_SOCKET; else process.env.AGENTGLASS_TMUX_SOCKET = REAL_SOCKET;
  if (REAL_TOKEN === undefined) delete process.env.AGENTGLASS_TOKEN; else process.env.AGENTGLASS_TOKEN = REAL_TOKEN;
  if (REAL_TMUX === undefined) delete process.env.TMUX; else process.env.TMUX = REAL_TMUX;
  rmSync(DIR, { recursive: true, force: true });
});

const panePidOf = async (session: string, windowId: string): Promise<string> => {
  const r = await pane.tmux(["list-panes", "-t", `=${session}:${windowId}`, "-F", "#{pane_pid}"]);
  return r.stdout.trim().split("\n")[0] ?? "";
};

const environOf = async (pid: string): Promise<string[]> => {
  const read = () => {
    try { return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean); } catch { return []; }
  };
  return settled(read, (v) => v.length > 0);
};

const cmdlineOf = (pid: string): string => {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" "); } catch { return ""; }
};

describe("a person's tab, attached through withPersonEnv", () => {
  test.skipIf(!have)("never writes the credential into the session's own environment", async () => {
    const root = join(DIR, "orbit-person");
    mkdirSync(root, { recursive: true });
    const session = pane.engineSessionName(root);
    const base = pane.engineAttachArgv(root, session);
    expect(base).not.toBeNull();
    const argv = pane.withPersonEnv(base!);
    // Detached, so the test gets its own process back rather than attaching.
    const detached = argv.map((a) => (a === "new-session" ? "new-session" : a));
    const at = detached.indexOf("new-session");
    detached.splice(at + 1, 0, "-d");
    const r = Bun.spawnSync(detached, { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode, new TextDecoder().decode(r.stderr)).toBe(0);

    const env = await pane.tmux(["show-environment", "-t", `=${session}`]);
    expect(env.stdout).not.toContain("AGENTGLASS_TOKEN");
    expect(env.stdout).not.toContain(TOKEN);

    const pid = await settled(
      async () => (await pane.tmux(["list-panes", "-t", `=${session}:`, "-F", "#{pane_pid}"])).stdout.trim().split("\n")[0] ?? "",
      (v) => !!v,
    );
    const pidEnv = await settled(() => environOf(pid), (e) => e.some((x) => x === `AGENTGLASS_TOKEN=${TOKEN}`), 5000);
    expect(pidEnv.some((e) => e === `AGENTGLASS_TOKEN=${TOKEN}`), "the pane's own process still has it").toBe(true);
    expect(cmdlineOf(pid)).not.toContain(TOKEN);
  }, 20_000);
});

describe("an agent's first window, through engineWindowOutcome", () => {
  test.skipIf(!have)("creates the session with no credential in its environment, and a second window cannot read it", async () => {
    const root = join(DIR, "orbit-agent");
    mkdirSync(root, { recursive: true });
    const session = pane.engineSessionName(root);

    const a = await pane.engineWindowOutcome(root, "worker-a", ["sh", "-c", "while :; do sleep 1; done"], root,
      { AGENTGLASS_TOKEN: WORKER_TOKEN, AGENTGLASS_WORKER_TOKEN: WORKER_TOKEN, AGENTGLASS_PROFILE: "worker-a" });
    expect(a.ok, (a as { reason?: string }).reason).toBe(true);
    if (!a.ok) return;

    const sessionEnv = await pane.tmux(["show-environment", "-t", `=${session}`]);
    expect(sessionEnv.stdout).not.toContain("AGENTGLASS_TOKEN");
    expect(sessionEnv.stdout).not.toContain(WORKER_TOKEN);

    const aPid = await panePidOf(session, a.windowId);
    /* The pane's first process is the wrapper shell; /proc/<pid>/environ only
       shows the credential once that shell has sourced the file and exec'd the
       real command, so wait for the exec instead of reading once. */
    const aEnv = await settled(() => environOf(aPid), (e) => e.some((x) => x === `AGENTGLASS_TOKEN=${WORKER_TOKEN}`), 5000);
    expect(aEnv.some((e) => e === `AGENTGLASS_TOKEN=${WORKER_TOKEN}`), "worker A's own process has its token").toBe(true);
    expect(cmdlineOf(aPid)).not.toContain(WORKER_TOKEN);

    // A SECOND window in the SAME session: the reuse branch (`new-window -e`),
    // already safe on its own, but it must not find worker A's token sitting
    // in the session table either.
    const b = await pane.engineWindowOutcome(root, "worker-b", ["sh", "-c", "while :; do sleep 1; done"], root);
    expect(b.ok, (b as { reason?: string }).reason).toBe(true);
    if (!b.ok) return;
    const bPid = await panePidOf(session, b.windowId);
    /* The pane's command is `env -u ... sh -c …`, run inside the window's
       default shell: on a real machine that shell is zsh, which sources
       `.zshenv` for every invocation, `-c` included — before `env` has even
       forked. A read right after window creation can land in that gap, while
       the wrapping shell still carries whatever `.zshenv` exported, and see a
       token the window was never handed. `env -u` strips it at the FINAL
       exec, the same one `AGENTGLASS_BROWSER_OFF=1` only appears after, so
       wait for that marker rather than reading once. */
    const bEnv = await settled(() => environOf(bPid), (e) => e.includes("AGENTGLASS_BROWSER_OFF=1"), 5000);
    expect(bEnv.some((e) => e.startsWith("AGENTGLASS_TOKEN")), "worker B inherited nothing from the session").toBe(false);
    expect(bEnv.some((e) => e === "AGENTGLASS_BROWSER_OFF=1")).toBe(true);
  }, 20_000);
});

describe("a credential file whose new-session call fails", () => {
  test.skipIf(!have)("is deleted, not left in agx-cred for the window that never ran", async () => {
    const root = join(DIR, "orbit-badcwd");
    // No such directory: the session's first window never comes up, so the
    // file sessionCredentialFile wrote is never sourced by anything.
    const badCwd = join(DIR, "no-such-dir-at-all");
    const credDir = join(tmpdir(), "agx-cred");
    const before = new Set(existsSync(credDir) ? readdirSync(credDir) : []);

    const out = await pane.engineWindowOutcome(root, "worker-badcwd", ["sh", "-c", "echo hi"], badCwd,
      { AGENTGLASS_TOKEN: WORKER_TOKEN, AGENTGLASS_WORKER_TOKEN: WORKER_TOKEN, AGENTGLASS_PROFILE: "worker-badcwd" });
    expect(out.ok).toBe(false);

    const after = existsSync(credDir) ? readdirSync(credDir) : [];
    expect(after.filter((f) => !before.has(f))).toEqual([]);
  }, 20_000);
});

describe("the engine's own identity", () => {
  test.skipIf(!have)("differs after the server dies and comes back, even with the same window id", async () => {
    const root = join(DIR, "orbit-identity");
    mkdirSync(root, { recursive: true });
    const session = pane.engineSessionName(root);
    await pane.ensurePanelWindow(root, "console", { person: true });
    const first = await pane.engineIdentity(session);
    expect(first).toMatch(/^\d+\.\d+$/);

    await pane.tmux(["kill-server"]);
    await pane.ensurePanelWindow(root, "console", { person: true });
    const second = await pane.engineIdentity(session);
    expect(second).toMatch(/^\d+\.\d+$/);
    expect(second, "a reborn server is not the one the first id named").not.toBe(first);
  }, 20_000);
});
