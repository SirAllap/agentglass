/*
 * Every window the server opens runs through one door for the browser
 * credential: a token in `env` is the credential the window was handed, and
 * without one it gets none of the four variables — never the machine token a
 * tmux window inherits from the server. The person's own terminals pass
 * `person` and keep their environment.
 *
 * The last test is the table: every call site in src, so a new launch path that
 * skips the door fails here instead of being found one at a time in review.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { BROWSER_CREDENTIAL_VARS, BROWSER_OFF_VAR } from "../src/browseraccess.ts";

const SOCKET = `agx-door-${process.pid}`;
const REAL_SOCKET = process.env.AGENTGLASS_TMUX_SOCKET;
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
process.env.TMUX_TMPDIR = TMUX_TEST_TMPDIR;
// The server's own environment: the credential an agent window must not inherit.
for (const v of BROWSER_CREDENTIAL_VARS) process.env[v] = "person-token-example";

const { engineWindowOutcome, tmux, tmuxCapability } = await import("../src/tmuxpane.ts");

const have = tmuxCapability().available;
let dir = "";

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agx-door-")); });
afterAll(async () => {
  if (have) await tmux(["kill-server"]);
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (REAL_SOCKET === undefined) delete process.env.AGENTGLASS_TMUX_SOCKET; else process.env.AGENTGLASS_TMUX_SOCKET = REAL_SOCKET;
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  for (const v of BROWSER_CREDENTIAL_VARS) delete process.env[v];
});

/** A window that writes the names in its environment, so what it holds is measured rather than assumed. */
async function envNames(name: string, env?: Record<string, string>, person = false): Promise<string[]> {
  const out = join(dir, `${name}.names`);
  const w = await engineWindowOutcome(dir, name, ["sh", "-c", `printenv | sed 's/=.*//' > '${out}'`], dir, env, undefined, false, false, person);
  expect(w.ok).toBe(true);
  for (let i = 0; i < 50 && !readFileSyncSafe(out); i++) await Bun.sleep(100);
  return (readFileSyncSafe(out) ?? "").split("\n").filter(Boolean);
}
const readFileSyncSafe = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };

describe.skipIf(!have)("the one door for an agent window", () => {
  test("an agent window with no credential of its own inherits none of the four, even though the server holds them", async () => {
    const seen = await envNames("agent-none");
    for (const v of BROWSER_CREDENTIAL_VARS) expect(seen).not.toContain(v);
    // And says so, which is what makes the supplied CLI refuse instead of reading the person's file.
    expect(seen).toContain(BROWSER_OFF_VAR);
  }, 20_000);

  test("an agent window handed a credential keeps exactly that one", async () => {
    const seen = await envNames("agent-minted", { AGENTGLASS_TOKEN: "wk_example", AGENTGLASS_PROFILE: "orbit-builder", AGENTGLASS_BROWSER_AS: "orbit-builder" });
    for (const v of ["AGENTGLASS_TOKEN", "AGENTGLASS_PROFILE", "AGENTGLASS_BROWSER_AS"]) expect(seen).toContain(v);
    expect(seen).not.toContain("AGENTGLASS_WORKER_TOKEN");
    expect(seen).not.toContain(BROWSER_OFF_VAR);
  }, 20_000);

  test("the person's own terminal is untouched: it still holds the server's environment", async () => {
    const seen = await envNames("person-tab", undefined, true);
    for (const v of BROWSER_CREDENTIAL_VARS) expect(seen).toContain(v);
  }, 20_000);

  test("an agent window with nothing to run is refused, not opened as a bare env", async () => {
    const w = await engineWindowOutcome(dir, "agent-empty", [], dir, undefined, undefined, false, false, false);
    expect(w).toMatchObject({ ok: false });
    if (!w.ok) expect(w.reason).toContain("no command to run");
  }, 20_000);
});

interface Site { file: string; what: string; person: boolean }
/* One row per call to the window door in src, in source order per file. */
const SITES: Site[] = [
  { file: "server/src/index.ts", what: "flight-plan Launch (Go)", person: false },
  { file: "server/src/index.ts", what: "open-shell (a person's tab)", person: true },
  { file: "server/src/agentops.ts", what: "named agent start / seat / schedule", person: false },
  { file: "server/src/terminal.ts", what: "terminal's agent tab", person: true },
  { file: "server/src/terminal.ts", what: "review button", person: true },
  { file: "server/src/terminal.ts", what: "issue/agent button", person: true },
  { file: "server/src/terminal.ts", what: "issue/agent button (shell fallback)", person: true },
  { file: "server/src/terminal.ts", what: "resume: split", person: true },
  { file: "server/src/terminal.ts", what: "resume: window", person: true },
];

/** The argument list of every engineWindowOutcome/engineWindowRunning call, with
 *  its own closing paren (arguments contain calls too). */
export function callsOf(src: string): string[][] {
  const out: string[][] = [];
  const re = /engineWindow(?:Outcome|Running)\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1, i = re.lastIndex;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    out.push(src.slice(re.lastIndex, i - 1).split(/,(?![^()]*\))/).map((a) => a.trim()));
  }
  return out;
}

test("every window the server opens is in the table, classified agent or person", async () => {
  const rows: { site: Site; args: string[] }[] = [];
  for (const file of ["server/src/index.ts", "server/src/agentops.ts", "server/src/terminal.ts"]) {
    const src = await Bun.file(new URL(`../../${file}`, import.meta.url).pathname).text();
    const calls = callsOf(src);
    const mine = SITES.filter((s) => s.file === file);
    expect({ file, calls: calls.length }).toEqual({ file, calls: mine.length });
    for (let i = 0; i < calls.length; i++) rows.push({ site: mine[i]!, args: calls[i]! });
  }
  for (const { site, args } of rows) {
    const last = args.at(-1);
    if (site.person) expect({ what: site.what, last }).toEqual({ what: site.what, last: "true" });
    else expect({ what: site.what, last }).not.toEqual({ what: site.what, last: "true" });
  }
  // The Launch path is the one Go opens, and it mints through the same door for
  // the engine the window ACTUALLY runs (claude), not the role's default provider,
  // and hands the role over so the supplied CLI cannot take the machine identity.
  const index = await Bun.file(new URL("../../server/src/index.ts", import.meta.url).pathname).text();
  const launch = index.slice(index.indexOf("async function launchFlightPlan("), index.indexOf("\n}\n", index.indexOf("async function launchFlightPlan(")));
  expect(launch).toContain('const engine = "claude" as const;');
  expect(launch).toContain('issueArgv({ kind: engine,');
  expect(launch).toContain("mintBrowserCredential(env, name, engine, \"builder\")");
  expect(launch).toContain("withBrowserLine(FlightPlan.launchPrompt(plan, coordinator), engine, \"builder\")");
  expect(launch).toContain('AGENTGLASS_ROLE: "builder"');

  // The two other creation doors are the same class: no agent pane inherits the server's environment.
  const restore = await Bun.file(new URL("../../server/src/tmuxrestore.ts", import.meta.url).pathname).text();
  expect(restore).toContain("agentWindowGuard()");
  expect(restore).toContain("replayArgs(");
  const pane = await Bun.file(new URL("../../server/src/tmuxpane.ts", import.meta.url).pathname).text();
  const split = pane.slice(pane.indexOf("export async function engineSplitRunning("));
  expect(split.slice(0, split.indexOf("\n}\n"))).toContain("agentWindowDrops(given)");
});
