/*
 * The ledger lives where the rest of this app's state lives, and a machine that
 * ran the old code does not lose it.
 *
 * `AGENTGLASS_STATE_DIR` is how a probe or a second server is pointed at a
 * scratch directory. `ledgerDir()` used to append "agentglass" to it — the
 * suffix belongs to the XDG fallbacks it shared an `||` with, not to a variable
 * that already names a dedicated directory. The refutation was four hundred
 * lines down the same file: `auditLogPath()` writes
 * `$AGENTGLASS_STATE_DIR/browser-audit.log`, so with the variable set, the two
 * halves of the browser's state landed in different places and a probe found
 * one of them.
 *
 * Four other readers of the variable already treat it as the directory —
 * `auditLogPath`, `cloneClaudeHome`, and `db.ts`, which gives it a branch of
 * its own; `tasks.ts` and `tmuxbin.ts` append a name of their own rather than
 * the app's. This was the one that did not.
 *
 * Fixing the variable left the pair still apart on a machine that does not set
 * it: this read `XDG_CONFIG_HOME` while `auditLogPath` reads `XDG_STATE_HOME`.
 * The ledger is not configuration — nobody edits it, nothing reads it to decide
 * behaviour, and the app rewrites it every time a container is made. It is a
 * record of what happened. Measured before moving it: `~/.config/agentglass/`
 * holds no browser file at all on this machine, and `~/.local/state/agentglass/`
 * already holds `browser-audit.log`, `clone-claude/`, `tmux/` and `tmux.conf`.
 *
 * The migration matters more than the tidiness. This file is what stops one
 * agent dropping another's live container, and a reader that missed the old
 * path would answer "no creator on record" for every existing container —
 * which is the ALLOWED branch, so the guard would quietly switch off on exactly
 * the machines that had been using it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerRecord, resetContainerLedger } from "../src/browserdrive.ts";

let scratch = "";
let previous: string | undefined;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "agx-ledgerpath-"));
  previous = process.env.AGENTGLASS_STATE_DIR;
  process.env.AGENTGLASS_STATE_DIR = scratch;
});
afterAll(() => {
  if (previous === undefined) delete process.env.AGENTGLASS_STATE_DIR;
  else process.env.AGENTGLASS_STATE_DIR = previous;
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* fine */ }
});
afterEach(() => {
  resetContainerLedger();
  for (const p of [join(scratch, "browser-containers.json"),
    join(scratch, "agentglass", "browser-containers.json")]) {
    try { rmSync(p, { force: true }); } catch { /* never existed */ }
  }
});

const NEW = () => join(scratch, "browser-containers.json");
const OLD = () => join(scratch, "agentglass", "browser-containers.json");
/* The oldest path of the three, used only when the variable is unset. */
const OLDEST = (cfg: string) => join(cfg, "agentglass", "browser-containers.json");

const put = (file: string, creator: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({
    "some-container": { creator, lastSeenMs: 1_700_000_000_000 },
  }));
};

describe("where the ledger is read from", () => {
  test("the state dir itself, beside the audit log — not a level down", () => {
    put(NEW(), "orbit-a1b2c3");
    expect(containerRecord("some-container")?.creator).toBe("orbit-a1b2c3");
  });

  test("a ledger left at the old path is still read", () => {
    /* The regression that would turn the drop guard off silently: an unknown
       creator is the ALLOWED branch, so losing this file reads as "nobody owns
       anything" rather than as an error. */
    put(OLD(), "orbit-legacy");
    expect(containerRecord("some-container")?.creator).toBe("orbit-legacy");
  });

  test("and the new path wins when both exist", () => {
    // Read, never written back: the old file stays where it is, and the moment
    // anything writes, the new one is the answer.
    put(OLD(), "orbit-legacy");
    put(NEW(), "orbit-current");
    expect(containerRecord("some-container")?.creator).toBe("orbit-current");
  });

  test("neither present is no creator, not a throw", () => {
    expect(containerRecord("some-container")).toBeNull();
  });
});

describe("with no AGENTGLASS_STATE_DIR at all", () => {
  /* The other half of the move, and the one an ordinary machine actually takes:
     the fallback root changed from the config directory to the state one, so a
     ledger written by the old code sits somewhere the new code would not look.
     Same consequence as above — an unknown creator is the ALLOWED branch, so
     missing it turns the drop guard off rather than reporting anything. */
  let keptState: string | undefined, keptCfg: string | undefined, keptHome: string | undefined;
  let home = "";

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "agx-ledgerhome-"));
    keptState = process.env.AGENTGLASS_STATE_DIR;
    keptCfg = process.env.XDG_CONFIG_HOME;
    keptHome = process.env.XDG_STATE_HOME;
    delete process.env.AGENTGLASS_STATE_DIR;
    process.env.XDG_CONFIG_HOME = join(home, "config");
    process.env.XDG_STATE_HOME = join(home, "state");
  });
  afterAll(() => {
    for (const [k, v] of [["AGENTGLASS_STATE_DIR", keptState], ["XDG_CONFIG_HOME", keptCfg],
      ["XDG_STATE_HOME", keptHome]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { rmSync(home, { recursive: true, force: true }); } catch { /* fine */ }
    /* Put the outer suite's scratch back: the tests above share this file's
       process and read the variable on every call. */
    process.env.AGENTGLASS_STATE_DIR = scratch;
  });

  afterEach(() => {
    /* NOT `resetContainerLedger()`: that deletes the file at the CURRENT path,
       which under this describe is the one a test has just written. Removing
       both by hand keeps the cases independent. */
    for (const f of [join(home, "state", "agentglass", "browser-containers.json"),
      OLDEST(join(home, "config"))]) {
      try { rmSync(f, { force: true }); } catch { /* never existed */ }
    }
  });

  test("it is read from the STATE directory, beside the audit log", () => {
    put(join(home, "state", "agentglass", "browser-containers.json"), "orbit-state");
    expect(containerRecord("some-container")?.creator).toBe("orbit-state");
  });

  test("and one left in the CONFIG directory is still read", () => {
    put(OLDEST(join(home, "config")), "orbit-config");
    expect(containerRecord("some-container")?.creator).toBe("orbit-config");
  });

  test("with state winning when both are there", () => {
    put(OLDEST(join(home, "config")), "orbit-config");
    put(join(home, "state", "agentglass", "browser-containers.json"), "orbit-state");
    expect(containerRecord("some-container")?.creator).toBe("orbit-state");
  });
});
