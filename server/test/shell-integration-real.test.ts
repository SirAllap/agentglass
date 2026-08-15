/*
 * The markers, against a real shell — #297.
 *
 * Everything in shell-markers.test.ts feeds the parser strings a test wrote.
 * That proves the parser and proves nothing about whether `trap DEBUG` and
 * `PROMPT_COMMAND` actually emit those strings out of a bash that has just
 * sourced somebody's `.bashrc`. This file is the one that can fail for the
 * right reason, and every bug listed below was found here and by nothing else:
 *
 *  - the DEBUG trap firing for the prompt hook, so `_agx_precmd` appeared in
 *    the history as something the user had run;
 *  - the trap installed before the rest of the snippet, so the first row was a
 *    line of our own setup code;
 *  - `$BASH_COMMAND` being the simple command, so `mkdir sub && cd sub` filed
 *    itself as `mkdir sub` while carrying the whole line's exit status;
 *  - chaining *after* the user's own PROMPT_COMMAND, which clobbers `$?` — so
 *    every failing command was recorded as a success;
 *  - the shim resolving `~/.bashrc` from the *server's* home rather than the
 *    shell's, which silently shims a file the shell never reads.
 *
 * Skipped rather than failed when the shell is absent: a machine without zsh is
 * a fact about the machine, and a red suite that means "not installed here"
 * teaches people to ignore it.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { familyOf, install, SNIPPETS } from "../src/shellmark.ts";

const FIXTURE = new URL("./fixtures/shell-drive.ts", import.meta.url).pathname;

type Driven = {
  family: string;
  commands: { command: string; exit: number | null; duration_ms: number; cwd: string | null }[];
  directory: string | null;
  theirPs1: boolean;
  theirPromptCommandRuns: boolean;
  raw: string;
};

function drive(shell: string): Driven {
  const home = mkdtempSync(join(tmpdir(), "agx-shellrun-"));
  try {
    const p = Bun.spawnSync(["bun", "run", FIXTURE, shell, home], {
      // Named, never `...process.env`. This spawns a login shell that sources
      // rc files: the one thing it must never inherit is the developer's HOME.
      env: { PATH: process.env.PATH ?? "", HOME: home },
      stdout: "pipe", stderr: "pipe",
    });
    const text = p.stdout.toString().trim();
    if (!text) throw new Error(`the shell driver produced nothing: ${p.stderr.toString().slice(0, 500)}`);
    return JSON.parse(text.split("\n").at(-1)!);
  } finally {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* fine */ }
  }
}

const BASH = Bun.which("bash");
/** Driven once and shared: it spawns a login shell and types into it, which is
 *  seconds, and every assertion below is about the same run.
 *
 *  The explicit timeout is not padding. Typing into a real shell and waiting for
 *  it to answer is inherently slower than the 5s default, and a suite that goes
 *  red on a loaded CI box for a reason that has nothing to do with the code is
 *  one people learn to re-run rather than read. */
let run: Driven;
beforeAll(() => { if (BASH) run = drive(BASH); }, 60_000);

describe.if(!!BASH)("a real bash, with a config of its own", () => {
  test("runs the commands and reports each one once", () => {
    expect(run.commands.map((c) => c.command)).toEqual([
      "echo hello",
      "false",
      "mkdir -p sub && cd sub",
      "pwd",
      "echo theirs=$AGX_THEIR_PROMPT_RAN",
    ]);
  });

  test("with the exit status of the line, not of whatever ran last in the prompt", () => {
    /*
     * The bug worth the whole file. Appending `_agx_precmd` to an existing
     * PROMPT_COMMAND means the user's hook runs first and `$?` is *its* status
     * by the time ours reads it — so with any git prompt installed, every
     * failing command was recorded as a success. Silent, plausible, and
     * invisible to any test that did not have a PROMPT_COMMAND of its own.
     */
    expect(run.commands.find((c) => c.command === "false")?.exit).toBe(1);
    expect(run.commands.find((c) => c.command === "echo hello")?.exit).toBe(0);
  });

  test("and the line as typed, not the first simple command in it", () => {
    // `mkdir -p sub && cd sub` carries the exit status of the whole line, so
    // filing it under `mkdir -p sub` would show a row claiming success for
    // something that is not what the user ran.
    expect(run.commands.map((c) => c.command)).toContain("mkdir -p sub && cd sub");
  });

  test("it follows the shell into a directory it cd'd to", () => {
    expect(run.directory?.endsWith("/sub")).toBe(true);
    expect(run.commands.find((c) => c.command === "pwd")?.cwd?.endsWith("/sub")).toBe(true);
  });

  test("nothing of ours is recorded as something they ran", () => {
    // PROMPT_COMMAND fires the DEBUG trap too, for our hook and for theirs.
    for (const c of run.commands) {
      expect(c.command, "our own bookkeeping is in the history").not.toContain("_agx");
      expect(c.command, "their prompt hook is in the history").not.toContain("AGX_THEIR_PROMPT_RAN=$");
      expect(c.command, "our setup code is in the history").not.toContain("PROMPT_COMMAND");
    }
  });

  test("and an empty line at the prompt is not a command", () => {
    expect(run.commands.filter((c) => !c.command.trim())).toEqual([]);
  });
});

describe.if(!!BASH)("what it leaves of the user's own shell", () => {
  test("their prompt is still their prompt", () => {
    /*
     * The property this whole design exists to protect, and the one that would
     * be quietly broken by the obvious implementations: an integration that
     * assigns PS1, or a bash shim that reimplements the login sequence and gets
     * it slightly wrong, leaves somebody's terminal looking wrong on a machine
     * they are not sitting at.
     */
    expect(run.theirPs1, "the user's PS1 did not survive the shim").toBe(true);
  });

  test("and their PROMPT_COMMAND is still running", () => {
    // Assigning to PROMPT_COMMAND rather than chaining is how an integration
    // eats somebody's git status, their window title and their directory
    // tracking, all at once and without a word.
    expect(run.theirPromptCommandRuns, "the user's PROMPT_COMMAND was replaced").toBe(true);
  });
});

describe("shells we have no snippet for", () => {
  test("are declined rather than guessed at", () => {
    // A wrong snippet in somebody's login shell is worse than no telemetry.
    expect(familyOf("/usr/bin/nu")).toBeNull();
    expect(familyOf("/bin/tcsh")).toBeNull();
    expect(familyOf("")).toBeNull();
    expect(install("/usr/bin/nu")).toBeNull();
  });

  test("and the ones we do have are recognised however they are spelled", () => {
    expect(familyOf("/opt/homebrew/bin/zsh")).toBe("zsh");
    expect(familyOf("/usr/local/bin/fish")).toBe("fish");
    expect(familyOf("/bin/sh")).toBe("bash");
  });
});

describe("every snippet, whether or not that shell is installed here", () => {
  test("chains the prompt hook rather than assigning it", () => {
    // The rule that keeps this from eating somebody's configuration, asserted
    // over all three because only one of them can be driven on this machine.
    expect(SNIPPETS.bash).toContain("_agx_precmd;${PROMPT_COMMAND#;}");
    expect(SNIPPETS.zsh).toContain("add-zsh-hook");
    expect(SNIPPETS.fish).toContain("--on-event");
  });

  test("captures the exit status on the first line of the prompt hook", () => {
    // Anywhere later and it is whatever the hook itself last did.
    for (const [name, src] of Object.entries(SNIPPETS)) {
      const body = src.slice(src.indexOf("_agx_precmd"));
      // fish spells it `set -l _agx_status $status`, so match the name rather
      // than an `=` that only two of the three shells use.
      const status = body.indexOf("_agx_status");
      const printf = body.indexOf("printf");
      expect(status, `${name}: no status capture`).toBeGreaterThan(-1);
      expect(status, `${name}: the status is read after something else has run`).toBeLessThan(printf);
    }
  });

  test("and installs itself only once", () => {
    // A user who has our snippet in their own rc as well would otherwise get
    // two of every marker, and every duration would be measured from the wrong
    // one of them.
    for (const [name, src] of Object.entries(SNIPPETS)) {
      expect(src, `${name}: no re-entry guard`).toMatch(/AGENTGLASS_SHELL_INTEGRATION_ON/);
    }
  });
});
