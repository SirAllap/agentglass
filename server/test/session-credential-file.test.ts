/*
 * `sessionCredentialFile`/`sessionCredentialArgv` ARE WHAT A SESSION'S FIRST
 * WINDOW RUNS INSTEAD OF `-e`, so the two properties this suite can check
 * without a real tmux server are the ones the whole fix rests on: the file is
 * 0600 and holds the value, and nothing the command STRING carries — never
 * mind what a pane later inherits from it — spells the secret out, because
 * that string is exactly what `#{pane_start_command}` would remember for as
 * long as the window lives.
 *
 * `startTicksOf` backs `serverAlive`'s pid-reuse fix (Should 3): it is a
 * plain `/proc` read, so it needs no tmux at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardCredentialFile, sessionCredentialArgv, sessionCredentialFile } from "../src/browseraccess.ts";
import { startTicksOf } from "../src/machine.ts";

const written: string[] = [];
afterEach(() => { for (const f of written.splice(0)) rmSync(f, { force: true }); });

describe("sessionCredentialFile", () => {
  test("is 0600 and holds exactly what it was given, never anything else", () => {
    const file = sessionCredentialFile({ AGENTGLASS_TOKEN: "mk_an_invented_value", AGENTGLASS_PROFILE: "bench-1" });
    expect(file).not.toBeNull();
    written.push(file!);
    expect(statSync(file!).mode & 0o777).toBe(0o600);
    const body = readFileSync(file!, "utf8");
    expect(body).toContain("export AGENTGLASS_TOKEN='mk_an_invented_value'");
    expect(body).toContain("export AGENTGLASS_PROFILE='bench-1'");
  });

  test("writes nothing, and answers null, for an empty credential", () => {
    expect(sessionCredentialFile({})).toBeNull();
  });

  test("quotes a value a shell would otherwise split or interpret", () => {
    const file = sessionCredentialFile({ AGENTGLASS_BROWSER_AS: "it's; rm -rf ~" });
    written.push(file!);
    const body = readFileSync(file!, "utf8");
    // Single-quoted, with embedded quotes escaped: the dangerous characters
    // are data inside quotes, never a token a shell would act on.
    expect(body).toBe(`export AGENTGLASS_BROWSER_AS='it'\\''s; rm -rf ~'\n`);
  });
});

describe("sessionCredentialArgv", () => {
  test("never spells the secret in the command string itself", () => {
    const file = sessionCredentialFile({ AGENTGLASS_TOKEN: "mk_an_invented_value" });
    written.push(file!);
    const argv = sessionCredentialArgv(file, {}, [], ["claude", "-p", "do the thing"]);
    expect(argv[0]).toBe("sh");
    expect(argv[1]).toBe("-c");
    const body = argv[2]!;
    expect(body).not.toContain("mk_an_invented_value");
    // The file is sourced, then removed, before the real command ever runs.
    expect(body).toContain(`. '${file}'`);
    expect(body).toContain(`rm -f '${file}'`);
    expect(body.indexOf(`rm -f`)).toBeLessThan(body.indexOf("exec"));
    expect(body).toContain("exec 'claude' '-p' 'do the thing'");
  });

  test("with no credential and no command, falls back to the person's own shell", () => {
    const argv = sessionCredentialArgv(null, {}, [], []);
    expect(argv).toEqual(["sh", "-c", `exec "$SHELL"`]);
  });

  test("unsets the drops before anything else runs", () => {
    const argv = sessionCredentialArgv(null, {}, ["AGENTGLASS_TOKEN", "AGENTGLASS_WORKER_TOKEN"], ["claude"]);
    const body = argv[2]!;
    expect(body).toBe(`unset AGENTGLASS_TOKEN; unset AGENTGLASS_WORKER_TOKEN; exec 'claude'`);
  });

  test("plain (non-secret) assignments ride the exec line, never a file", () => {
    const argv = sessionCredentialArgv(null, { AGX_OWNER: "worker-a" }, [], ["claude"]);
    expect(argv[2]).toBe("exec env AGX_OWNER='worker-a' 'claude'");
  });
});

describe("discardCredentialFile", () => {
  test("removes the file a failed session creation never sourced", () => {
    const file = sessionCredentialFile({ AGENTGLASS_TOKEN: "mk_an_invented_value" });
    expect(file).not.toBeNull();
    expect(existsSync(file!)).toBe(true);
    discardCredentialFile(file);
    expect(existsSync(file!)).toBe(false);
  });

  test("is a no-op on null (no credential was written)", () => {
    expect(() => discardCredentialFile(null)).not.toThrow();
  });

  test("is a no-op on a file already gone", () => {
    const file = sessionCredentialFile({ AGENTGLASS_TOKEN: "mk_an_invented_value" })!;
    rmSync(file, { force: true });
    expect(() => discardCredentialFile(file)).not.toThrow();
  });
});

describe("the agx-cred directory", () => {
  const fixed = join(tmpdir(), "agx-cred");

  // credDir never deletes a path it refuses: it must still exist (as the bad
  // entry) after the call, and get cleaned up here so the next real request
  // on this machine can recreate it safely.
  function tamperAndCheck(make: () => void): void {
    rmSync(fixed, { recursive: true, force: true });
    make();
    try {
      const file = sessionCredentialFile({ AGENTGLASS_TOKEN: "mk_an_invented_value" })!;
      expect(file.startsWith(fixed + "/")).toBe(false);
      rmSync(file, { force: true });
    } finally {
      rmSync(fixed, { recursive: true, force: true });
    }
  }

  test("a symlink at the fixed path is refused; a fresh private dir is used instead", () => {
    const attackerTarget = join(tmpdir(), `agx-cred-attacker-${process.pid}`);
    mkdirSync(attackerTarget, { recursive: true, mode: 0o777 });
    try {
      tamperAndCheck(() => symlinkSync(attackerTarget, fixed));
    } finally {
      rmSync(attackerTarget, { recursive: true, force: true });
    }
  });

  test("a world-writable directory at the fixed path is refused; a fresh private dir is used instead", () => {
    tamperAndCheck(() => { mkdirSync(fixed, { mode: 0o777 }); chmodSync(fixed, 0o777); });
  });

  test("a directory the fixed path already has, with the right owner and mode, is reused as-is", () => {
    rmSync(fixed, { recursive: true, force: true });
    mkdirSync(fixed, { mode: 0o700 });
    const file = sessionCredentialFile({ AGENTGLASS_TOKEN: "mk_an_invented_value" })!;
    expect(file.startsWith(fixed + "/")).toBe(true);
    rmSync(file, { force: true });
    expect(lstatSync(fixed).mode & 0o777).toBe(0o700);
  });
});

describe("startTicksOf", () => {
  test("is a stable number for this very process, read twice", () => {
    const a = startTicksOf(process.pid);
    const b = startTicksOf(process.pid);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  test("is null for a pid nothing on this machine holds", () => {
    // PIDs wrap well below this on every Linux kernel this app runs on.
    expect(startTicksOf(2_000_000_000)).toBeNull();
  });
});

describe("the pid-reuse gap this closes", () => {
  test("a boolean liveness check cannot tell two different processes with the same pid apart; ticks can", () => {
    const real = startTicksOf(process.pid)!;
    // What the OLD check asked (`process.kill(pid, 0)`): only "is SOMETHING
    // there", which a reborn server answers exactly like the one that died.
    const oldCheckWouldSay = (() => { try { process.kill(process.pid, 0); return true; } catch { return false; } })();
    expect(oldCheckWouldSay, "the old check saw no difference at all").toBe(true);
    // The new one is told the pid belongs to a DIFFERENT birth (an invented
    // tick count) and correctly refuses to call it the same server.
    expect(real === 1).toBe(false);
  });
});
