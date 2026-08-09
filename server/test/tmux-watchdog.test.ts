/*
 * The bar the panel repaints, kept off — against a real tmux server with a
 * real attached client.
 *
 * The panel draws its own window list and hides tmux's own status line on the
 * grouped mirror it attaches through (`agx-phone-…`). The hiding is a session
 * option, and session options can be flipped back by the user's own keyboard:
 * `prefix :` and a bare `set status on`, a plugin's `set status …` without
 * `-g`, a config line without `-g` re-sourced by `prefix r` or tpm's `I`/`U`.
 * The sweep re-asserts the choice once per tick, off the two fields the frame
 * already reads (`#{status}` and `#{@agx-owned}`), and a client moved onto a
 * session that never had `status off` is answered by remounting a fresh mirror
 * rather than hiding the user's own session — hiding THERE would take the
 * desk's bar away, because `status` is a session option and the desk is on
 * that same session.
 *
 * What is under test is the three pieces the sweep is built from: the frame
 * reporting the flip, `setStatusLine` healing it, and `remountPhoneClient`
 * putting the client back on a mirror that costs nobody else anything.
 *
 * The tests are stateful and ordered on purpose: the flip, the heal, the
 * reload, and the session-switch are one story about the same mirror.
 *
 * Runs against its own tmux server on a private socket, with `-f /dev/null`
 * so no `~/.tmux.conf` and no restore plugin can reach in.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFrame, setStatusLine, remountPhoneClient, isPhoneSession } from "../src/tmuxctl.ts";
import type { TmuxClient, TmuxTarget } from "../src/tmuxctl.ts";
import { TEST_TERM } from "./tmuxTerm.ts";

// Own socket AND an empty config — see tmux-attach.test.ts for what each half
// is for. Unique per run, or a leftover server from a previous one is what
// this talks to.
const SOCK = ["-L", `agx-watchdog-${process.pid}`];
const TMPDIR = `/tmp/agx-tmux-watchdog-${process.pid}`;
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const has = !!Bun.which("tmux") && !!Bun.which("python3") && process.platform === "linux";

/** `env: process.env` is load-bearing — measured on Bun 1.3.9, a
 *  `Bun.spawnSync` with no `env` gets the environment as it was when the
 *  PROCESS started, not `process.env` as it is now. See tmux-bar.test.ts. */
const raw = (args: string[]) =>
  Bun.spawnSync(["tmux", "-f", "/dev/null", ...SOCK, ...args], { stdout: "pipe", stderr: "pipe", timeout: 4000, env: process.env });
const out = (args: string[]) => raw(args).stdout.toString().trim();

/** A real attached client on a pty, the way a terminal emulator makes one.
 *  Held open by a sleep; killed in afterAll. */
function clientOn(target: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(
    ["python3", "-c",
      "import os,pty,sys,time\n" +
      "pid,fd=pty.fork()\n" +
      "if pid==0: os.execvp('tmux',['tmux','-f','/dev/null','-L',sys.argv[1],'attach','-t',sys.argv[2]])\n" +
      "time.sleep(600)\n",
      SOCK[1]!, target],
    // `TERM` is declared, not inherited: tmux refuses `TERM=dumb`, which is
    // what a CI job step has, so this attach would do nothing there — the same
    // rule every other pty-building test in this directory follows (see
    // tmuxTerm.ts, and the lint that keeps us honest).
    { stdout: "ignore", stderr: "ignore", env: { ...process.env, TERM: TEST_TERM } },
  );
}

let pty: ReturnType<typeof Bun.spawn> | null = null;
let realId = "";
let currentMirror = "";
let currentMirrorId = "";
let tty = "";

beforeAll(async () => {
  if (!has) return;
  // Set here and put back in afterAll rather than at module load: `bun test`
  // runs a suite's files in one process, and the other tmux files are entitled
  // to the environment they were written against.
  mkdirSync(TMPDIR, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  raw(["kill-server"]);
  raw(["new-session", "-d", "-s", "real", "-n", "one"]);
  raw(["new-window", "-d", "-t", "real", "-n", "two"]);
  realId = out(["display-message", "-p", "-t", "real", "#{session_id}"]);
  // The mirror a phone attach would leave, in the state the attach leaves it:
  // grouped on `real`, its own `status off`, and — once the client is on it —
  // `destroy-unattached` so it dies with the client. `destroy-unattached`
  // comes LAST on purpose: measured, tmux kills a detached session carrying it
  // the moment it has no client.
  raw(["new-session", "-d", "-t", "real", "-s", "agx-phone-1-abc"]);
  raw(["set-option", "-t", "agx-phone-1-abc", "window-size", "largest"]);
  raw(["set-option", "-t", "agx-phone-1-abc", "status", "off"]);
  currentMirror = "agx-phone-1-abc";
  currentMirrorId = out(["display-message", "-p", "-t", currentMirror, "#{session_id}"]);
  pty = clientOn(currentMirror);
  await Bun.sleep(1200);
  tty = out(["list-clients", "-F", "#{client_tty}"]).split("\n")[0] ?? "";
  raw(["set-option", "-t", currentMirror, "destroy-unattached", "on"]);
});

afterAll(() => {
  pty?.kill();
  raw(["kill-server"]);
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* already gone */ }
});

const client = (): TmuxClient => ({ pid: 0, socket: SOCK, tty });
const real = (): TmuxTarget => ({ pid: 0, socket: SOCK, session: "real", id: realId });
const mirror = (): TmuxTarget => ({ pid: 0, socket: SOCK, session: currentMirror, id: currentMirrorId });

describe("the bar the panel repaints, kept off", () => {
  // The repo's tmux-test guard, per-file: `describe.if`/`test.if` print bogus
  // results on a machine with no tmux (see tmux-bar.test.ts), so the body
  // itself is what closes. `beforeAll` closes the same way.
  if (!has) return;

  test("the frame reports the client's own session's status and claim", () => {
    // The two fields the sweep re-asserts from, answered per client: the
    // mirror's own `status off` comes back as such, and the claim is absent —
    // the attach leaves `status off`, not the claim; the sweep's first
    // re-assert is what sets it.
    const f = readFrame(client())!;
    expect(f.target.session).toBe(currentMirror);
    expect(f.status).toBe("off");
    expect(f.owned).toBe(false);
  });

  test("`prefix :` flipping the option is visible to the same frame", () => {
    // The mechanism the user's keybinding uses: a bare `set status on` on the
    // session the client is on. The mirror is ours, so nothing else is on it
    // with us — the bar that comes back is tmux's own. The flip knows nothing
    // about the claim, and there is none yet, so both halves of the state the
    // sweep reads are in front of it.
    raw(["set-option", "-t", currentMirror, "status", "on"]);
    const f = readFrame(client())!;
    expect(f.status).toBe("on");
    expect(f.owned).toBe(false);
  });

  test("and re-asserting heals it within the sweep's own call", () => {
    /*
     * Exactly what the sweep does when it finds a mirror it does not own:
     * `setStatusLine` takes it again.
     *
     * What "taken" LOOKS like changed, and the change is the point. The row is
     * now kept and blanked rather than switched off, because with no row at all
     * tmux draws its messages on the pane — measured, a `display-message`
     * lands as a bare paint at the cursor with no repaint after it, which is
     * how continuum's autosave stamped a line across an agent's box. So the
     * assertion is: the row exists (`status on`), it carries our claim, and it
     * is blank — not that it is gone.
     */
    expect(setStatusLine(mirror(), false)).toBe(true);
    const f = readFrame(client())!;
    expect(f.status).toBe("on");
    expect(f.owned).toBe(true);
    expect(out(["show-options", "-qv", "-t", currentMirror, "status-format[0]"])).toBe("");
  });

  test("a config reload with `set -g status on` does not bring the bar back", () => {
    // `prefix r` / tpm's `I` and `U` re-source the config, which re-applies
    // `set -g status on`. The mirror carries the panel's own session-local
    // options, which shadow the global — measured against a real client — so a
    // reload changes nothing the sweep has to answer.
    //
    // The row is `on` here because the previous test took it: kept and blanked
    // rather than switched off, so tmux has somewhere to draw a message that is
    // not the pane. What the reload must not do is put the user's FORMAT back,
    // and that is what the second assertion pins.
    const dir = mkdtempSync(join(tmpdir(), "agx-watchdog-reload-"));
    const file = join(dir, "reload.conf");
    writeFileSync(file, "set -g status on\n");
    raw(["source-file", file]);
    expect(readFrame(client())!.status).toBe("on");
    expect(out(["show-options", "-qv", "-t", currentMirror, "status-format[0]"])).toBe("");
    expect(readFrame(client())!.owned).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a client moved to the user's own session reports ITS bar, not ours", () => {
    // `prefix s`, an `attach-session` typed into the pane, a continuum
    // restore — all of them switch the client onto a session that never had
    // `status off`. The mirror dies with the client (`destroy-unattached`),
    // which is why nothing here restores it. What is left is a frame that
    // says the bar is on and unclaimed — the remount below is the answer.
    raw(["switch-client", "-c", tty, "-t", "real"]);
    awaitTty();
    const f = readFrame(client())!;
    expect(f.target.session).toBe("real");
    expect(f.status).toBe("on");
    expect(f.owned).toBe(false);
    expect(out(["list-sessions", "-F", "#{session_name}"]).split("\n")).not.toContain("agx-phone-1-abc");
  });

  test("remounting puts the client back on a mirror, and never touches the desk's bar", () => {
    // The moved-to session is the user's: hiding its bar would hide the
    // desk's too. The remount makes a fresh mirror of it and switches our
    // client back — the user session's options are read, not written.
    expect(remountPhoneClient(client(), real())).toBe(true);
    const f = readFrame(client())!;
    expect(isPhoneSession(f.target.session)).toBe(true);
    expect(f.target.session).not.toBe("agx-phone-1-abc");
    // A fresh mirror is created with the row already off — it has nothing to
    // catch yet and nobody attached. The sweep's first re-assert is what turns
    // it into the kept-and-blank row the test above pins.
    expect(f.status).toBe("off");
    currentMirror = f.target.session;
    currentMirrorId = out(["display-message", "-p", "-t", currentMirror, "#{session_id}"]);
    // The desk's session was not touched: it carries no `status` of its own,
    // which is the same "no local option" it had before the phone arrived.
    expect(out(["show-options", "-t", "real", "-v", "status"])).toBe("");
    // And the new mirror dies with the client when it leaves, like the old
    // one did — `destroy-unattached` is set the same way.
    expect(out(["show-options", "-t", currentMirror, "-v", "destroy-unattached"])).toBe("on");
  });

  test("remounting refuses a session that is already a mirror", () => {
    const before = out(["list-sessions", "-F", "#{session_name}"]);
    expect(remountPhoneClient(client(), mirror())).toBe(false);
    expect(out(["list-sessions", "-F", "#{session_name}"])).toBe(before);
  });

  test("taking the bar twice does not overwrite the way back", () => {
    // The sweep re-asserts, and re-asserting must not clobber the recorded
    // original binding: release puts back what the user had, not our own
    // `if-shell` line. A second take on the same target is a no-op for the
    // key, so `@agx-had-rename` still holds the original.
    raw(["bind-key", "-T", "prefix", ",", 'command-prompt -p "(rename-window)" "rename-window -- %%"']);
    raw(["new-session", "-d", "-s", "twice"]);
    const id = out(["display-message", "-p", "-t", "twice", "#{session_id}"]);
    const t: TmuxTarget = { pid: 0, socket: SOCK, session: "twice", id };
    expect(setStatusLine(t, false)).toBe(true);
    const first = out(["show-options", "-qv", "-t", "twice", "@agx-had-rename"]);
    expect(first).toContain("command-prompt");
    expect(first).not.toContain("@agx-ask");
    expect(setStatusLine(t, false)).toBe(true);
    expect(out(["show-options", "-qv", "-t", "twice", "@agx-had-rename"])).toBe(first);
    expect(setStatusLine(t, true)).toBe(true);
    // The whole prefix table, because `list-keys -T prefix <key>` answers on
    // the client's screen instead of stdout on tmux ≥ 3.7 (see
    // tmux-list-keys-one-key-form in project memory).
    const back = out(["list-keys", "-T", "prefix"]);
    // tmux re-lists the key canonically, without the quotes around the
    // prompt text, so the assertion matches the unquoted form. The check is
    // scoped to the `,` row: `.` is ours from the first take and stays ours
    // by design (release restores only what it recorded), so the whole table
    // still shows `@agx-ask` on it.
    const comma = back.split("\n").find((l) => l.includes("prefix ,"));
    expect(comma).toContain('command-prompt -p (rename-window)');
    expect(comma).not.toContain("@agx-ask");
  });

  test("a config that runs without a bar still gets the claim and the prompt keys", () => {
    // `status off` in the user's global config: there is no row to reclaim,
    // but the claim and the prompt takeover still go on — `prefix ,` and
    // `prefix .` draw over the top line with or without a bar, and the
    // re-assertion the sweep runs off `@agx-owned` depends on it being there.
    raw(["set-option", "-g", "status", "off"]);
    raw(["new-session", "-d", "-s", "barless"]);
    const id = out(["display-message", "-p", "-t", "barless", "#{session_id}"]);
    const t: TmuxTarget = { pid: 0, socket: SOCK, session: "barless", id };
    expect(setStatusLine(t, false)).toBe(true);
    expect(out(["show-options", "-t", "barless", "-v", "@agx-owned"])).toBe("1");
    expect(out(["list-keys", "-T", "prefix"])).toContain("@agx-ask");
    expect(setStatusLine(t, true)).toBe(true);
    raw(["set-option", "-g", "status", "on"]);
  });
});

/** Wait until the client has settled on the named session — the frame read
 *  races the client landing, and a stale answer would blame the wrong one. */
function awaitTty(): void {
  for (let i = 0; i < 20; i++) {
    const sess = out(["list-clients", "-F", "#{session_name}"]).split("\n")[0] ?? "";
    if (sess === "real") return;
    Bun.sleepSync(50);
  }
}
