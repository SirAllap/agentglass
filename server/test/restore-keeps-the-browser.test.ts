/*
 * A RESTORED AGENT KEEPS ITS BROWSER; A PERSON'S TAB IS THEIRS.
 *
 * After a reinstall, a reboot or an OOM every project seat and every agent tab
 * came back with `AGENTGLASS_BROWSER_OFF=1` and no credential: the restore put
 * the old guard in front of every agent pane it rebuilt, and the supplied CLI
 * then refused every verb. ON is the default for an agent tab, so a restore
 * hands each one a credential of its own through the same door a fresh start
 * uses (`agentWindowEnv`): the chair's `st_` for a seat, a `wk_` named after
 * the tab for a worker.
 *
 * The photograph is what tells them apart: a window agentglass opened for an
 * agent carries `AGX_OWNER` in its process environment, and a tab the person
 * opened has none (`person: true`). A photograph too old to say is treated as
 * an agent's — a credential somebody can read beats the server's machine token.
 *
 * The capture half runs real tmux on its own socket, with a stand-in for an
 * agent CLI: a script whose basename is `opencode`, which is what the process
 * walk sees. The credential is read back from the process and asserted by
 * PREFIX only; no value is ever printed.
 */
import { expect, beforeAll, afterAll, describe, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { story } from "./story.ts";
import { settled } from "./paneSettled.ts";

const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const REAL_STATE = process.env.AGENTGLASS_STATE_DIR;
const REAL_SOCKET = process.env.AGENTGLASS_TMUX_SOCKET;
const SOCKET = `agx-seat-browser-${process.pid}`;
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
const DIR = join(tmpdir(), `agx-seat-browser-${process.pid}`);
process.env.AGENTGLASS_STATE_DIR = join(DIR, "state");
process.env.AGENTGLASS_RESTORE_SETTLE_MS = "400";

const S = `agxseat${process.pid}`;
const ROOT = join(DIR, "orbit");
/** An absolute program whose basename is an agent CLI's, so the walk sees an
 *  agent and the restore runs it without a PATH lookup. */
const STUB = join(DIR, "bin", "opencode");
/** The chair's window name carries a hash of the path (`seatName`). */
let SEAT_WIN = "";
const WORK_WIN = "orbit-ORBIT-1042";
const MINE_WIN = "my-notes";

/** The agentglass session this test may itself be running in names an owner in
 *  the environment; a tmux server started from it would give every window one.
 *  Saved and removed before the server exists, so a hand-opened tab is really
 *  a person's. */
const STRIP = ["AGX_OWNER", "AGX_OWNER_TMP", "AGENTGLASS_TOKEN", "AGENTGLASS_WORKER_TOKEN", "AGENTGLASS_PROFILE", "AGENTGLASS_BROWSER_AS", "AGENTGLASS_BROWSER_OFF"];
const saved = new Map<string, string | undefined>(STRIP.map((k) => [k, process.env[k]]));

let restore: typeof import("../src/tmuxrestore.ts");
let pane: typeof import("../src/tmuxpane.ts");
let Seat: typeof import("../src/seat.ts");
let db: typeof import("../src/db.ts");

const step = story();

beforeAll(async () => {
  mkdirSync(join(DIR, "bin"), { recursive: true });
  mkdirSync(ROOT, { recursive: true });
  /* The CLI, as a process: the loop keeps the pane alive for the whole step. */
  writeFileSync(STUB, "#!/bin/sh\nwhile :; do sleep 1; done\n", { mode: 0o755 });
  for (const k of STRIP) delete process.env[k];
  process.env.TMUX_TMPDIR = DIR;
  const conf = await import("../src/tmuxconf.ts");
  restore = await import("../src/tmuxrestore.ts");
  pane = await import("../src/tmuxpane.ts");
  Seat = await import("../src/seat.ts");
  db = await import("../src/db.ts");
  SEAT_WIN = Seat.seatName(ROOT);
  /* Written by hand: `ensureConf` remembers the content it last wrote, and
     every test file shares one process. */
  mkdirSync(dirname(conf.confPath()), { recursive: true });
  writeFileSync(conf.confPath(), conf.confContent());
  /* The chair this app seated, open: the restore recognises a seat by its row. */
  db.db.run(`INSERT INTO seat (root, name, kind, model, powers, started_at, ended_at)
    VALUES (?, ?, 'claude', '', 'nudge', ?, NULL)
    ON CONFLICT(root) DO UPDATE SET name = excluded.name, ended_at = NULL, powers = excluded.powers`,
    [ROOT, Seat.seatName(ROOT), Date.now()]);
});

afterAll(async () => {
  try { await pane.tmux(["kill-server"]); } catch { /* already gone */ }
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  if (REAL_STATE === undefined) delete process.env.AGENTGLASS_STATE_DIR;
  else process.env.AGENTGLASS_STATE_DIR = REAL_STATE;
  if (REAL_SOCKET === undefined) delete process.env.AGENTGLASS_TMUX_SOCKET;
  else process.env.AGENTGLASS_TMUX_SOCKET = REAL_SOCKET;
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* never made */ }
});

/** An argv for the stand-in CLI: `sh` calling itself an agent, kept alive.
 *  `owner` rides in the environment the way the launch path puts it there. */
const agentArgv = (owner?: string): string[] => [
  ...(owner ? ["env", `AGX_OWNER=${owner}`] : []),
  "bash", "-c", `exec -a ${STUB} /bin/sh -c 'while :; do sleep 1; done' stub`,
];

const photographed = async (win: string) => {
  await Bun.sleep(250);
  return (await restore.captureLayout())?.sessions.find((s) => s.name === S)?.windows.find((w) => w.name === win)?.panes[0];
};

/** After a beat: a pane forked a moment ago has not exec'd yet, and reads as
 *  the tmux server — whose own environment must never be mistaken for a
 *  window's. */
const capturedPane = async (win: string) => settled(() => photographed(win), (p) => !!p?.startArgv);

/** The environment and argv of the process holding a window, once it is the
 *  stand-in and not the server that forked it. */
const processIn = async (win: string) => {
  const read = async () => {
    const pid = (await pane.tmux(["display-message", "-p", "-t", `=${S}:${win}`, "#{pane_pid}"])).stdout.trim();
    try {
      return {
        env: readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean),
        argv: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean),
      };
    } catch { return { env: [] as string[], argv: [] as string[] }; }
  };
  return settled(read, (v) => v.argv[0] === STUB || v.argv.includes(STUB));
};

let once: Promise<{ ok: boolean; restored: number; error?: string }> | null = null;
const restored = () => (once ??= restore.restoreLayout("all"));

describe("the photograph says whose window it was", () => {
  step("a seat and a worker carry the owner they were launched as, and a hand-opened tab says it is the person's", async () => {
    const mk = await pane.tmux(["new-session", "-d", "-s", S, "-n", SEAT_WIN, "-c", ROOT, ...agentArgv(SEAT_WIN)]);
    expect(mk.ok, mk.stderr).toBe(true);
    await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", WORK_WIN, "-c", ROOT, ...agentArgv(WORK_WIN)]);
    await pane.tmux(["new-window", "-d", "-t", `=${S}:`, "-n", MINE_WIN, "-c", ROOT, ...agentArgv()]);

    const seat = await capturedPane(SEAT_WIN);
    expect(seat, "the seat's pane is in the picture").toBeDefined();
    expect(seat!.owner, "the name the window was launched as").toBe(SEAT_WIN);
    expect(seat!.person).toBeUndefined();

    const work = await capturedPane(WORK_WIN);
    expect(work!.owner).toBe(WORK_WIN);

    const mine = await capturedPane(MINE_WIN);
    expect(mine!.person, "no owner, and the photograph recorded that").toBe(true);
    expect(mine!.owner).toBeUndefined();
  }, 20_000);
});

describe("the restore", () => {
  step("a captured seat comes back with the chair's credential and no off marker", async () => {
    await pane.tmux(["kill-session", "-t", `=${S}`]);
    const r = await restored();
    expect(r.ok, r.error).toBe(true);

    const got = await processIn(SEAT_WIN);
    expect(got.env.some((e) => e.startsWith("AGENTGLASS_TOKEN=st_")), "the chair's own credential").toBe(true);
    expect(got.env).toContain(`AGENTGLASS_SEAT=${ROOT}`);
    expect(got.env).toContain(`AGENTGLASS_PROFILE=${SEAT_WIN}`);
    expect(got.env.some((e) => e.startsWith("AGENTGLASS_BROWSER_OFF")), "the off marker is not on a seat").toBe(false);
  }, 20_000);

  step("a captured worker comes back ON, with a credential of its own named after the tab", async () => {
    const got = await processIn(WORK_WIN);
    expect(got.env.some((e) => e.startsWith("AGENTGLASS_TOKEN=wk_")), "a worker's own credential").toBe(true);
    expect(got.env).toContain(`AGENTGLASS_PROFILE=${WORK_WIN}`);
    expect(got.env.some((e) => e.startsWith("AGENTGLASS_BROWSER_OFF"))).toBe(false);
    /* The credential is in tmux's `-e`, never on the command line the capture
       photographs and writes to a file. */
    expect(got.argv.join(" ")).not.toContain("AGENTGLASS_TOKEN");
  }, 20_000);

  step("a tab the person opened comes back as the person's, with no agent marker and no credential", async () => {
    const got = await processIn(MINE_WIN);
    expect(got.argv.length, "the window is back").toBeGreaterThan(0);
    expect(got.env.some((e) => e.startsWith("AGENTGLASS_BROWSER_OFF"))).toBe(false);
    expect(got.env.some((e) => e.startsWith("AGENTGLASS_TOKEN"))).toBe(false);
  }, 20_000);
});

/* `new-session -e` puts the variables in the SESSION's environment, so every
   window made into it afterwards — including one the person opens — would
   inherit the chair's `st_`. The restore unsets them straight after the first
   window, and a `set-environment -u` that fails leaves a credential where the
   next window finds it: the result is reported, not dropped. */
test("a session that will not part with a credential variable says so", async () => {
  const r = await import("../src/tmuxrestore.ts");
  const asked: string[][] = [];
  const kept = await r.unsetSessionVars("agx-example", ["AGENTGLASS_TOKEN", "AGENTGLASS_PROFILE"], async (args) => {
    asked.push(args);
    return { ok: !args.includes("AGENTGLASS_TOKEN"), stderr: "no such variable" };
  });
  expect(asked).toHaveLength(2);
  expect(kept).toEqual(["AGENTGLASS_TOKEN"]);
});

/*
 * THE FIRST WINDOW AT BOOT, BEFORE THE SERVER EXISTS TO BE PURGED.
 *
 * `stripGlobalBrowserCredentials` runs at the top of every `tmux()` call, but
 * it is a no-op until a server answers — and the very first `new-session` of a
 * `lazy` restore is the call that BORN that server, in the same breath. A
 * brand-new tmux server's global environment starts as a copy of whatever the
 * client that spawned it was carrying, so this app's own process environment
 * — the "machine" token, here played by a value this test plants itself —
 * would otherwise ride straight into the first pane, invisible to every later
 * purge because the pane already exec'd by the time one runs.
 */
describe("the first window of a brand-new session, at boot", () => {
  const BOOT_S = `agxboot${process.pid}`;
  const BOOT_WIN = "orbit-ORBIT-9999";
  const MACHINE_TOKEN = "mk_machine_never_inherited";

  const envOf = async (session: string, win: string) => {
    const read = async () => {
      const pid = (await pane.tmux(["display-message", "-p", "-t", `=${session}:${win}`, "#{pane_pid}"])).stdout.trim();
      try { return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean); } catch { return [] as string[]; }
    };
    /* The pane's first process is the start script, which still carries what
       tmux handed it until it unsets the stale variables and execs the agent.
       /proc/<pid>/environ is fixed at exec, so a read before that exec sees
       the script's environment, not the agent's: wait for the worker
       credential the exec'd agent carries, then assert on that. */
    return settled(read, (v) => v.some((e) => e.startsWith("AGENTGLASS_TOKEN=wk_")), 5000);
  };

  test("a lazy restore's first pane does not inherit the server's own token", async () => {
    await pane.tmux(["kill-server"]).catch(() => undefined);
    await Bun.sleep(100);
    const mk = await pane.tmux(["new-session", "-d", "-s", BOOT_S, "-n", BOOT_WIN, "-c", ROOT, ...agentArgv(BOOT_WIN)]);
    expect(mk.ok, mk.stderr).toBe(true);
    await settled(async () => (await restore.captureLayout())?.sessions.find((s) => s.name === BOOT_S)?.windows.find((w) => w.name === BOOT_WIN)?.panes[0],
      /* The stub, not just any argv: a pane caught between fork and exec reads
         as the wrapper's own line, and restoring from that has no agent. */
      (p) => !!p?.startArgv?.includes(STUB), 5000);

    await pane.tmux(["kill-server"]);
    await Bun.sleep(100);

    process.env.AGENTGLASS_TOKEN = MACHINE_TOKEN;
    try {
      const r = await restore.restoreLayout("lazy");
      expect(r.ok, r.error).toBe(true);
    } finally {
      delete process.env.AGENTGLASS_TOKEN;
    }

    const env = await envOf(BOOT_S, BOOT_WIN);
    expect(env.some((e) => e === `AGENTGLASS_TOKEN=${MACHINE_TOKEN}`), "the server's own token never rode into the first pane").toBe(false);
    expect(env.some((e) => e.startsWith("AGENTGLASS_TOKEN=wk_")), "the window still gets its own worker credential").toBe(true);
  }, 20_000);
});
