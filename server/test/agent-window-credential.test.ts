/*
 * ONE DOOR, EVERY START PATH, AND THE INVARIANT THAT KEEPS IT THAT WAY.
 *
 * The browser is a must for agents: ON is the default for every agent tab, and
 * a tab that comes back with `AGENTGLASS_BROWSER_OFF=1` and no credential is a
 * P0 regression, not a settings state. This file holds the door (`agentWindowEnv`
 * in browseraccess.ts) to that promise:
 *
 *  - a credential is minted for the TAB, never the person's machine token;
 *  - off only when the person turned that engine or role off;
 *  - every row of `AGENT_START_PATHS` names a file that goes through the door;
 *  - a path that skipped it fails the check, which is what makes a new start
 *    path fail the build instead of being found months later as a dead tab.
 *
 * A running process cannot be handed an environment after exec, so the tabs the
 * restore rebuilds are measured in restore-keeps-the-browser.test.ts with real
 * tmux; this file is the decision and the table.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const savedCfg = process.env.XDG_CONFIG_HOME;
const configDir = mkdtempSync(join(tmpdir(), "agx-agent-window-"));
process.env.XDG_CONFIG_HOME = configDir;

import {
  AGENT_START_PATHS, agentShellEnv, agentWindowEnv, BROWSER_CREDENTIAL_VARS, browserHealthLine, browserWorkersNow, holdCredential,
  layoutCredentialName, personPaneEnv, saveBrowserWorkers, windowCredentialOf, withoutBrowserCredentials,
  type AgentStartPath, type AgentWindowAsk,
} from "../src/browseraccess.ts";
import { browserOffReason, defaultBrowserWorkers, type BrowserWorkers } from "../../shared/browserWorkers.ts";
import { seatTokenCount, workerTokenOf, revokeWorkerTokens } from "../src/auth.ts";
import { paneRoleFor, seatWindowEnv } from "../src/seatwindow.ts";
import type { CapturedPane } from "../src/tmuxrestore.ts";

const SEAT_ROOT = "/home/someone/code/orbit";
const TAB = "orbit-ORBIT-1042";

/** The person's own token as the server holds it; every assertion below says it
 *  never reaches a window. */
const PERSON_TOKEN = "mk_person_example_never_sent";

const narrowed = (set: BrowserWorkers, kind: "engines" | "roles", id: string): BrowserWorkers =>
  ({ ...set, [kind]: set[kind].filter((x) => x !== id) });

beforeEach(() => {
  expect(saveBrowserWorkers(defaultBrowserWorkers()).ok).toBe(true);
  process.env.AGENTGLASS_TOKEN = PERSON_TOKEN;
});

afterAll(() => {
  delete process.env.AGENTGLASS_TOKEN;
  if (savedCfg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedCfg;
  rmSync(configDir, { recursive: true, force: true });
});

describe("the one door", () => {
  test("a card's tab gets a credential of its own, named after the tab", () => {
    const r = agentWindowEnv({ name: TAB, engine: "claude" });
    expect(r.token).toMatch(/^wk_/);
    expect(r.env.AGENTGLASS_TOKEN).toBe(r.token!);
    expect(r.env.AGENTGLASS_WORKER_TOKEN).toBe(r.token!);
    expect(r.env.AGENTGLASS_PROFILE).toBe(TAB);
    expect(r.env.AGENTGLASS_BROWSER_AS).toBe(TAB);
    expect(r.env.AGENTGLASS_BROWSER_OFF).toBeUndefined();
    expect(r.off).toBeNull();
    expect(windowCredentialOf(TAB)).toMatchObject({ state: "issued", reason: null });
  });

  test("the person's machine token never rides along, even when the caller's env has it", () => {
    const r = agentWindowEnv({ name: TAB, engine: "claude", base: { AGENTGLASS_TOKEN: PERSON_TOKEN, TMPDIR: "/tmp/example" } });
    expect(r.token).not.toBe(PERSON_TOKEN);
    for (const v of Object.values(r.env)) expect(v).not.toBe(PERSON_TOKEN);
    expect(r.env.TMPDIR).toBe("/tmp/example");
  });

  test("a tmux client is handed no credential of the server's", () => {
    /* tmux gives its server the client's environment, so the four variables
       must not be in the client at all: otherwise a pane can ask the server for
       one by name, whatever was removed from the pane. */
    const env = withoutBrowserCredentials({
      AGENTGLASS_TOKEN: PERSON_TOKEN, AGENTGLASS_WORKER_TOKEN: PERSON_TOKEN,
      AGENTGLASS_PROFILE: "the-person", AGENTGLASS_BROWSER_AS: "the-person", AGENTGLASS_PORT: "4567",
    });
    for (const v of BROWSER_CREDENTIAL_VARS) expect(env[v]).toBeUndefined();
    expect(env.AGENTGLASS_PORT).toBe("4567");
  });

  test("a person's own pane is handed the credential explicitly", () => {
    /* The person's shell still works after tmux stops inheriting it: the
       credential travels on the window itself, never on the server. */
    const env = personPaneEnv({ AGENTGLASS_TOKEN: PERSON_TOKEN, AGENTGLASS_PROFILE: "the-person", PATH: "/bin" });
    expect(env.AGENTGLASS_TOKEN).toBe(PERSON_TOKEN);
    expect(env.AGENTGLASS_PROFILE).toBe("the-person");
    expect(env.AGENTGLASS_WORKER_TOKEN).toBeUndefined();
    expect(env.PATH).toBeUndefined();
  });

  test("a shell opened with an agent's credential is stripped and marked off", () => {
    const env = agentShellEnv({ AGENTGLASS_TOKEN: PERSON_TOKEN, AGENTGLASS_PROFILE: "the-person", TERM: "xterm" });
    for (const v of BROWSER_CREDENTIAL_VARS) expect(env[v]).toBeUndefined();
    expect(env.AGENTGLASS_BROWSER_OFF).toBe("1");
    expect(env.AGENTGLASS_BROWSER_OFF_REASON).toContain("agent's credential");
    expect(env.TERM).toBe("xterm");
  });

  test("the layout route names a credential from the server's session, window id and engine identity", () => {
    expect(layoutCredentialName("orbit", "@7", "123.456")).toBe("layout:orbit:@7:123.456");
  });

  test("a seat gets the chair's token, its project, and its own name", () => {
    const r = agentWindowEnv({ name: "orchestrator-orbit", engine: "claude", seat: { root: SEAT_ROOT, powers: "nudge" } });
    expect(r.token).toMatch(/^st_/);
    expect(r.env.AGENTGLASS_SEAT).toBe(SEAT_ROOT);
    expect(r.env.AGENTGLASS_PROFILE).toBe("orchestrator-orbit");
    expect(r.env.AGENTGLASS_BROWSER_OFF).toBeUndefined();
  });

  test("a seat's window builder is the same door, so a fresh seating and a restore cannot drift", () => {
    const r = seatWindowEnv({ root: SEAT_ROOT, powers: "assign", kind: "claude", name: "orchestrator-orbit" });
    expect(r.token).toMatch(/^st_/);
    expect(r.env.AGENTGLASS_SEAT).toBe(SEAT_ROOT);
    expect(r.off).toBeNull();
  });
});

describe("off means the person turned it off, and says why", () => {
  test("an engine off in Settings ▸ Browser gets no credential and the marker", () => {
    expect(saveBrowserWorkers(narrowed(browserWorkersNow(), "engines", "claude")).ok).toBe(true);
    const r = agentWindowEnv({ name: TAB, engine: "claude" });
    expect(r.token).toBeNull();
    expect(r.env.AGENTGLASS_TOKEN).toBeUndefined();
    expect(r.env.AGENTGLASS_BROWSER_OFF).toBe("1");
    expect(r.env.AGENTGLASS_BROWSER_OFF_REASON).toContain("Settings ▸ Browser");
    expect(windowCredentialOf(TAB)).toMatchObject({ state: "off" });
    expect(r.off).toContain("Claude Code workers are off");
  });

  test("a role off in Settings ▸ Browser gets no credential", () => {
    expect(saveBrowserWorkers(narrowed(browserWorkersNow(), "roles", "reviewer")).ok).toBe(true);
    const r = agentWindowEnv({ name: "orbit-review", engine: "claude", role: "reviewer" });
    expect(r.token).toBeNull();
    expect(r.env.AGENTGLASS_BROWSER_OFF).toBe("1");
    expect(r.off).toContain("Reviewer role is off");
  });

  test("a tab with no role is decided by its engine alone, so a restore's worker is on", () => {
    const r = agentWindowEnv({ name: TAB, engine: "claude" });
    expect(r.token).toMatch(/^wk_/);
    expect(r.env.AGENTGLASS_BROWSER_OFF).toBeUndefined();
  });

  test("the health line says ok, or exactly why not", () => {
    expect(browserHealthLine("claude", "builder")).toBe("browser: ok");
    expect(saveBrowserWorkers(narrowed(browserWorkersNow(), "roles", "builder")).ok).toBe(true);
    expect(browserHealthLine("claude", "builder")).toContain("browser: the Builder role is off in Settings ▸ Browser");
  });
});

/*
 * livecred2: a card tab worker AND the project's own seat were both refused a
 * credential with every engine and role on, because neither had a row of its
 * own — the door fell back to "no role, so only the engine decides". `seat`
 * and `cardTabs` give each one, on by default (parity with before the row
 * existed), and `agentWindowEnv` derives the right `ctx` on its own.
 */
describe("the seat and card-tab rows this door derives on its own", () => {
  test("a seat gets a credential with engines and roles fully on (the measured bug)", () => {
    expect(browserWorkersNow().engines.length).toBeGreaterThan(0);
    const r = agentWindowEnv({ name: "orchestrator-orbit", engine: "claude", seat: { root: SEAT_ROOT, powers: "nudge" } });
    expect(r.token).toMatch(/^st_/);
    expect(r.env.AGENTGLASS_BROWSER_OFF).toBeUndefined();
  });

  test("turning the seat row off refuses a seat even though every engine and role is on", () => {
    // The seat still keeps a token to speak to the server with (it answers its
    // board either way), but it is marked off and told exactly why: the chair
    // itself is not revoked, only its browser credential.
    const now = browserWorkersNow();
    expect(saveBrowserWorkers({ ...now, seat: false }).ok).toBe(true);
    const r = agentWindowEnv({ name: "orchestrator-orbit", engine: "claude", seat: { root: SEAT_ROOT, powers: "nudge" } });
    expect(r.env.AGENTGLASS_BROWSER_OFF).toBe("1");
    expect(r.off).toContain("This project's seat");
    expect(r.off).toContain("Settings ▸ Browser");
  });

  test("a card tab (no role, no seat) gets a credential with engines and roles fully on", () => {
    const r = agentWindowEnv({ name: TAB, engine: "claude" });
    expect(r.token).toMatch(/^wk_/);
    expect(r.env.AGENTGLASS_BROWSER_OFF).toBeUndefined();
  });

  test("turning the card-tabs row off refuses a card tab even though every engine and role is on", () => {
    const now = browserWorkersNow();
    expect(saveBrowserWorkers({ ...now, cardTabs: false }).ok).toBe(true);
    const r = agentWindowEnv({ name: TAB, engine: "claude" });
    expect(r.token).toBeNull();
    expect(r.env.AGENTGLASS_BROWSER_OFF).toBe("1");
    expect(r.off).toContain("Card tabs");
    expect(r.off).toContain("Settings ▸ Browser");
  });

  test("a built-in role is unaffected by either new row: the old engine/role pair alone decides it", () => {
    const now = browserWorkersNow();
    expect(saveBrowserWorkers({ ...now, seat: false, cardTabs: false }).ok).toBe(true);
    const r = agentWindowEnv({ name: "orbit-builder", engine: "claude", role: "builder" });
    expect(r.token).toMatch(/^wk_/);
    expect(r.env.AGENTGLASS_BROWSER_OFF).toBeUndefined();
  });
});

describe("a restored window's credential, decided before anything is resumed", () => {
  /* `lazy` (the default at boot) leaves the pane's command empty — nothing to
     resume yet — and that used to be read as nothing to decide either: every
     restored window, agent or seat, came back with none of the four
     variables and no OFF marker, holding whatever the session already had.
     The decision must run the same whether or not there is a command. */
  const agentPane = (extra: Partial<CapturedPane> = {}): CapturedPane =>
    ({ id: "%1", index: 0, active: true, command: "claude", path: "/tmp",
       startCommand: "claude", startArgv: ["claude"], ...extra }) as CapturedPane;

  test("a person's tab gets their own credential, even with no command to resume", async () => {
    const { replayArgs } = await import("../src/tmuxrestore.ts");
    const rep = replayArgs("lazy", agentPane({ person: true }));
    expect(rep.argv).toEqual([]);
    const set = Object.fromEntries(rep.set);
    expect(set.AGENTGLASS_TOKEN).toBe(PERSON_TOKEN);
    expect(set.AGENTGLASS_BROWSER_OFF).toBeUndefined();
  });

  test("an agent tab whose engine is on gets its own credential, with no command to resume", async () => {
    const { replayArgs } = await import("../src/tmuxrestore.ts");
    const rep = replayArgs("lazy", agentPane({ owner: TAB }), TAB);
    expect(rep.argv).toEqual([]);
    const set = Object.fromEntries(rep.set);
    expect(set.AGENTGLASS_TOKEN).toMatch(/^wk_/);
    expect(set.AGENTGLASS_PROFILE).toBe(TAB);
    expect(set.AGENTGLASS_BROWSER_OFF).toBeUndefined();
  });

  test("an agent tab whose engine is off in Settings ▸ Browser keeps the OFF marker and no token", async () => {
    expect(saveBrowserWorkers(narrowed(browserWorkersNow(), "engines", "claude")).ok).toBe(true);
    const { replayArgs } = await import("../src/tmuxrestore.ts");
    const rep = replayArgs("lazy", agentPane({ owner: TAB }), TAB);
    expect(rep.argv).toEqual([]);
    const set = Object.fromEntries(rep.set);
    expect(set.AGENTGLASS_TOKEN).toBeUndefined();
    expect(set.AGENTGLASS_BROWSER_OFF).toBe("1");
  });

  test("a window with no agent and no command stays undecided", async () => {
    const { replayArgs } = await import("../src/tmuxrestore.ts");
    const rep = replayArgs("lazy", { id: "%1", index: 0, active: true, command: "bash", path: "/tmp", startCommand: "" } as CapturedPane);
    expect(rep.argv).toEqual([]);
    expect(rep.set).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- *
 * THE INVARIANT: one table, every start path, and a bypass that fails.
 * ------------------------------------------------------------------------- */

/** One representative ask per path, so the table is not only a list of files. */
const ASK: Record<string, AgentWindowAsk> = {
  "seat": { name: "orchestrator-orbit", engine: "claude", seat: { root: SEAT_ROOT, powers: "speak" } },
  "seat-adopt": { name: "orchestrator-orbit", engine: "claude", seat: { root: SEAT_ROOT, powers: "speak" } },
  "worker-start": { name: TAB, engine: "claude", role: "builder" },
  "worker-turn": { name: TAB, engine: "claude", role: "builder" },
  "worker-fallback": { name: TAB, engine: "claude", role: "builder" },
  "named-agent": { name: TAB, engine: "claude" },
  "flight-plan": { name: TAB, engine: "claude", role: "builder" },
  "layout-window": { name: TAB, engine: "claude" },
  "restore": { name: TAB, engine: "claude" },
  "resume": { name: TAB, engine: "claude" },
  "panel-window": { name: "bench-1", engine: "claude", role: "builder" },
  "terminal-open-engine": { name: "orbit", engine: "claude" },
  "terminal-review": { name: "pr-1042", engine: "claude" },
  "terminal-issue": { name: TAB, engine: "claude" },
  "terminal-resume": { name: "orbit", engine: "claude" },
  "start-door": { name: TAB, engine: "claude" },
};

const source = (file: string) => Bun.file(new URL(`../../${file}`, import.meta.url).pathname).text();

/**
 * The body of one start path: from the row's own marker to the end of the
 * block or function it belongs to, never past it.
 *
 * Per FILE was not enough. `tmuxrestore.ts` reaches the door once, in
 * `replayArgs`, and both the restore row and the Resume row were checked
 * against the whole file — so Resume could stop going through `replayArgs` and
 * the row stayed green while it respawned the pane with the server's
 * environment. The same held for the two calls in `index.ts`.
 *
 * Per NEXT ROW was not enough either. `index.ts` holds three rows now, and a
 * row that comes last in its file (or before another row that lives earlier in
 * the file) was checked against the rest of the file: deleting the
 * `agentWindowEnv(` from the start route and minting anywhere below it kept
 * the table green. A body ends where its own block does.
 */
async function bodies(rows: readonly AgentStartPath[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const byFile = new Map<string, AgentStartPath[]>();
  for (const r of rows) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
  for (const [file, mine] of byFile) {
    const text = await source(file);
    const at = mine.map((r) => ({ row: r, i: r.within ? text.indexOf(r.within) : -1 }));
    for (const a of at) {
      if (a.i < 0) continue;
      const next = at.map((b) => b.i).filter((i) => i > a.i).sort((x, y) => x - y)[0] ?? text.length;
      out.set(a.row.id, text.slice(a.i, Math.min(next, ownEnd(text, a.i))));
    }
  }
  return out;
}

/** The close of a brace block that opens at `open`. */
function closeOf(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i + 1;
  }
  return text.length;
}

/** The end of a declaration that starts at `at`: the first closing brace at the
 *  left margin. A return type can hold braces of its own
 *  (`Promise<{ ok: true } | { ok: false }>`), so the body is not found by
 *  counting from the declaration's first `{`. */
function endOfDecl(text: string, at: number): number {
  const close = text.indexOf("\n}\n", at);
  return close < 0 ? text.length : close + 3;
}

/** Where the block a marker opens — or the function it is written in — ends. */
function ownEnd(text: string, at: number): number {
  const lineEnd = text.indexOf("\n", at);
  const head = text.slice(at, lineEnd < 0 ? text.length : lineEnd);
  if (/^\s*(export\s+)?(async\s+)?function\b/.test(head)) return endOfDecl(text, at);
  /* A command's `if (...) {`: its own block, so a call in the next branch is no
     cover for this one. */
  const brace = head.lastIndexOf("{");
  if (brace >= 0) return closeOf(text, at + brace);
  /* A statement: the function it is written in, found by its declaration. */
  const above = Math.max(text.lastIndexOf("\nfunction ", at), text.lastIndexOf("\nexport function ", at), text.lastIndexOf("\nasync function ", at), text.lastIndexOf("\nexport async function ", at));
  return above < 0 ? text.length : endOfDecl(text, above + 1);
}

/** Whether a table row's own body really carries the call it claims. A row with
 *  `inherits` is allowed to have no call: it reaches `startAgent`'s door. */
async function holds(rows: readonly AgentStartPath[]): Promise<string[]> {
  const bad: string[] = [];
  const body = await bodies(rows);
  for (const r of rows) {
    if (r.inherits) continue;
    if (!r.within) { bad.push(`${r.id} names no marker to be checked in`); continue; }
    const text = body.get(r.id) ?? "";
    if (!text) bad.push(`${r.id}: ${r.file} has no ${JSON.stringify(r.within)}`);
    else if (!r.calls || !text.includes(r.calls)) bad.push(`${r.id}: ${r.file} has no ${r.calls} in ${r.within}`);
  }
  return bad;
}

test("every start path is in the table and reaches the door", async () => {
  expect(await holds(AGENT_START_PATHS)).toEqual([]);
  expect(new Set(AGENT_START_PATHS.map((p) => p.id)).size).toBe(AGENT_START_PATHS.length);
  for (const p of AGENT_START_PATHS) expect(p.what.length).toBeGreaterThan(0);
  /* One marker each, so a body is one path's own and not a neighbour's. */
  const marks = AGENT_START_PATHS.filter((p) => p.within).map((p) => `${p.file}\u0000${p.within}`);
  expect(new Set(marks).size).toBe(marks.length);
});

test("every start path, run, ends with a valid scoped credential and no OFF marker", () => {
  for (const p of AGENT_START_PATHS) {
    const ask = ASK[p.id];
    expect(ask, `a representative ask for ${p.id}`).toBeDefined();
    const r = agentWindowEnv(ask!);
    expect({ id: p.id, hasToken: !!r.token }).toEqual({ id: p.id, hasToken: true });
    expect(r.token!).toMatch(/^(wk|st)_/);
    expect(r.env.AGENTGLASS_BROWSER_OFF, p.id).toBeUndefined();
    expect(r.env.AGENTGLASS_BROWSER_OFF_REASON, p.id).toBeUndefined();
    expect(r.env.AGENTGLASS_PROFILE, p.id).toBe(ask!.name);
    expect(r.env.AGENTGLASS_BROWSER_AS, p.id).toBe(ask!.name);
  }
});

test("a path that skips the door fails this check — the fake row is rejected, then removed", async () => {
  /* The build fails for a path that skipped the shared function. Proven the way
     the delivery asked: add a row that bypasses it, watch `holds` reject it. */
  const fake: AgentStartPath[] = [{ id: "fake", what: "a path that mints its own", file: "server/src/tmuxrestore.ts", within: "export function replayArgs(", calls: "mintBrowserCredential(" }];
  expect(await holds(fake)).not.toEqual([]);
  expect(await holds(AGENT_START_PATHS)).toEqual([]);
});

test("a row is checked in its own body, so a neighbour's call cannot cover it", async () => {
  /* `replayArgs` has the door call; `resumeRestored` reaches it. Asking the
     Resume row for the call itself must fail, which is what makes "Resume uses
     runArgs directly" a red build instead of a green one. */
  const resume = AGENT_START_PATHS.find((p) => p.id === "resume")!;
  expect(await holds([{ ...resume, calls: "agentWindowEnv(" }])).not.toEqual([]);
  expect(await holds([resume])).toEqual([]);
});

test("the lowest door mints when a start path hands no credential", async () => {
  const ops = await source("server/src/agentops.ts");
  expect(ops).toContain("agentWindowEnv({ name: p.name, engine: kind.id, base: given, root: p.root })");
  /* And it does not mint over one a caller already handed it. */
  expect(ops).toContain("given?.AGENTGLASS_TOKEN || given?.[BROWSER_OFF_VAR]");
});

/* ------------------------------------------------------------------------- *
 * THE CHAIR, AND WHAT THE CHECKS AND THE BRIEF SAY ABOUT IT.
 * ------------------------------------------------------------------------- */

test("a chair on an engine Settings cannot name is told ok, because the door hands it a credential", async () => {
  /* `gemini` is not a row of Settings ▸ Browser's engine list (it cannot run a
     worker turn), and the door's answer for it is "allowed" — a chair sat on it
     keeps its credential. The seat's brief read the list itself and told that
     chair it had none. */
  for (const engine of ["claude", "gemini"]) {
    const off = browserOffReason(browserWorkersNow(), engine, "");
    expect({ engine, ok: browserHealthLine(engine, "") === "browser: ok" }).toEqual({ engine, ok: off === null });
  }
  const seat = await source("server/src/seat.ts");
  expect({ seatBriefUsesTheDoor: seat.includes('const line = browserHealthLine(kind, "");') }).toEqual({ seatBriefUsesTheDoor: true });
});

test("a seat's window is minted once per project, however many times a restore builds it", () => {
  /* Every `seatWindowEnv` call minted an `st_` and nothing but `openSeat`
     revoked any: a restore that replayed a seat pane twice left two live
     credentials for one chair, and the off branch minted its own as well. */
  const root = "/home/someone/code/orbit-minted-once";
  const before = seatTokenCount();
  const a = seatWindowEnv({ root, powers: "nudge", kind: "claude", name: "orchestrator-orbit-minted-once" });
  const b = seatWindowEnv({ root, powers: "nudge", kind: "claude", name: "orchestrator-orbit-minted-once" });
  expect(a.token).toMatch(/^st_/);
  expect(b.token).toMatch(/^st_/);
  expect(seatTokenCount() - before, "one live credential for one chair").toBe(1);
});

test("a renamed chair is still the chair", async () => {
  /* A rename is supported, and matching a seat by window name alone made it
     come back as a worker: a `wk_` under the seat's name, no AGENTGLASS_SEAT
     and none of its seat-only verbs. The owner the launcher pinned is what the
     rename does not touch. */
  const { db } = await import("../src/db.ts");
  const root = "/home/someone/code/orbit-renamed";
  const name = "orchestrator-orbit-renamed";
  db.run(`INSERT INTO seat (root, name, kind, model, powers, started_at, ended_at)
    VALUES (?, ?, 'claude', '', 'nudge', ?, NULL)
    ON CONFLICT(root) DO UPDATE SET name = excluded.name, ended_at = NULL`,
    [root, name, Date.now()]);
  expect(paneRoleFor({ name: "my chair", owner: name }, root)).toMatchObject({ kind: "seat", root });
  /* A window nobody pinned to that chair is still not one. */
  expect(paneRoleFor({ name: "my chair" }, root).kind).toBe("person");
});

/* ------------------------------------------------------------------------- *
 * THE RE-ISSUE, AND THE CREDENTIAL THE RUNNING PROCESS STILL HOLDS.
 * ------------------------------------------------------------------------- */

test("a re-issue keeps the credential the tab is running with, and waits for the next start", () => {
  /* It used to mint with replace, deleting the token the running process holds,
     and the self-check then read the held one as live and drew a green dot for
     a tab that had just been cut off. */
  const first = agentWindowEnv({ name: TAB, engine: "claude" }).token!;
  const held = holdCredential(TAB);
  expect(held).not.toBe(first);
  expect(workerTokenOf(TAB), "the running tab's credential survives").toBe(first);
  expect(windowCredentialOf(TAB)).toMatchObject({ state: "pending" });
  /* And the next start consumes the held one. */
  expect(agentWindowEnv({ name: TAB, engine: "claude" }).token).toBe(held);
});

test("a held credential the server has revoked is not handed to the next start", () => {
  /* The turn that held it ended, so the server revoked it. Handing it over
     started a tab with a token this server refuses, with no marker and no
     reason in its brief. */
  const held = holdCredential(TAB);
  revokeWorkerTokens(TAB);
  const next = agentWindowEnv({ name: TAB, engine: "claude" }).token!;
  expect(next).not.toBe(held);
  expect(workerTokenOf(TAB)).toBe(next);
});
