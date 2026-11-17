/*
 * What a pane TMUXCTL opens on someone's behalf is handed.
 *
 * A tmux window inherits the SESSION's environment, and a person's own window
 * puts their credential there with `-e` (the client is spawned without it, see
 * terminal.ts). So a window an AGENT opens from its own pty must be handed the
 * OFF marker and have the person's credential removed from the pane, or a
 * supplied CLI in it silently drives as the person. And a restored pane that
 * was the person's own must keep what a person's terminal has.
 *
 * Measured on a private tmux server with `/proc/<pid>/environ`, by NAME only;
 * the value used here is invented and never read back.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";

import { TMUX_ISOLATED } from "./tmuxIsolated.ts";
import { agxTestBase } from "./tmuxTmp.ts";

const SOCK = [...TMUX_ISOLATED, "-L", `agx-browser-env-${process.pid}`];
const TMPDIR = agxTestBase("agx-browser-env");
const have = !!Bun.which("tmux");
const INVENTED = "mk_an_invented_person_token";
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const REAL_TOKEN = process.env.AGENTGLASS_TOKEN;

const raw = (args: string[]) =>
  Bun.spawnSync(["tmux", ...SOCK, ...args], { stdout: "pipe", stderr: "pipe", timeout: 4000, env: process.env });
const out = (args: string[]) => raw(args).stdout.toString().trim();

let ctl: typeof import("../src/tmuxctl.ts");
let target: { pid: number; socket: string[]; session: string; id: string };

beforeAll(async () => {
  if (!have) return;
  mkdirSync(TMPDIR, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  /* The person's credential lives in the SERVER's environment, and their own
     windows are handed it from there. */
  process.env.AGENTGLASS_TOKEN = INVENTED;
  raw(["kill-server"]);
  raw(["new-session", "-d", "-s", "orbit", "-n", "one", "-c", "/tmp"]);
  /* The session holds it, which is how a person's own window leaves it for the
     windows made into that session afterwards. */
  raw(["set-environment", "-t", "orbit", "AGENTGLASS_TOKEN", INVENTED]);
  target = { pid: 0, socket: SOCK, session: "orbit", id: out(["display-message", "-p", "-t", "orbit", "#{session_id}"]) };
  ctl = await import("../src/tmuxctl.ts");
});

afterAll(() => {
  if (have) raw(["kill-server"]);
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  if (REAL_TOKEN === undefined) delete process.env.AGENTGLASS_TOKEN;
  else process.env.AGENTGLASS_TOKEN = REAL_TOKEN;
  rmSync(TMPDIR, { recursive: true, force: true });
});

/** The names a pane's shell really has: ask it to write them out. Names only,
 *  never a value. */
async function shellEnvNames(pane: string, out: string): Promise<string[]> {
  rmSync(out, { force: true });
  raw(["send-keys", "-t", pane, `env | sed 's/=.*//' > '${out}'`, "Enter"]);
  const end = Date.now() + 8000;
  for (;;) {
    try { const t = readFileSync(out, "utf8"); if (t.trim()) return t.split("\n").filter(Boolean); } catch { /* not yet */ }
    if (Date.now() > end) return [];
    await Bun.sleep(50);
  }
}

/** The window the action just made: the highest id in the session, which is
 *  tmux's own counter and not a name two tests can share. */
const newWindow = (): string => {
  const ids = out(["list-windows", "-t", "orbit", "-F", "#{window_id}"])
    .split("\n").map((l) => l.trim()).filter((l) => /^@\d+$/.test(l));
  return ids.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).pop() ?? "";
};

const paneOf = (windowId: string): string =>
  out(["list-panes", "-t", windowId, "-F", "#{pane_id}"]).split("\n")[0] ?? "";

describe("a window an agent opens from its pty", () => {
  test.skipIf(!have)("carries the OFF marker and none of the person's credential", async () => {
    expect(await ctl.runAction(target, "new", undefined, "orbit", 80, 24, false, "/tmp", null, false)).toBe(true);
    const pane = paneOf(newWindow());
    expect(pane).toMatch(/^%\d+$/);
    const seen = await shellEnvNames(pane, "/tmp/agx-browser-env-agent.names");
    for (const v of ["AGENTGLASS_TOKEN", "AGENTGLASS_WORKER_TOKEN", "AGENTGLASS_PROFILE", "AGENTGLASS_BROWSER_AS"]) {
      expect(seen, v).not.toContain(v);
    }
    expect(seen).toContain("AGENTGLASS_BROWSER_OFF");
  }, 20_000);

  test.skipIf(!have)("the person's own window keeps the credential it always had", async () => {
    expect(await ctl.runAction(target, "new", undefined, "orbit", 80, 24, false, "/tmp", null, true)).toBe(true);
    const pane = paneOf(newWindow());
    const seen = await shellEnvNames(pane, "/tmp/agx-browser-env-person.names");
    expect(seen).toContain("AGENTGLASS_TOKEN");
    expect(seen).not.toContain("AGENTGLASS_BROWSER_OFF");
  }, 20_000);
});

describe("a restored pane that was the person's own", () => {
  test.skipIf(!have)("is handed their credential explicitly, and never an empty one", async () => {
    const { replayArgs } = await import("../src/tmuxrestore.ts");
    const pane = { id: "%1", index: 0, active: true, command: "claude", path: "/tmp",
      startCommand: "claude", startArgv: ["claude"], person: true as const };
    const rep = replayArgs("all", pane);
    const set = Object.fromEntries(rep.set);
    expect(Object.keys(set)).toContain("AGENTGLASS_TOKEN");
    expect(Object.keys(set)).not.toContain("AGENTGLASS_BROWSER_OFF");
    /* The value is a credential: it travels in tmux's `-e`, never in the line
       the pane is born with, which a restore photographs into a file. */
    expect(rep.argv.join(" ")).not.toContain(INVENTED);
  });
});
