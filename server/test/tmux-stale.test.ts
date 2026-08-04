// Giving the status line back after a crash, which is the only case that was
// not covered.
//
// The panel borrows tmux's status row and rebinds two prefix keys while it owns
// them, and it gives both back when it closes. That release is keyed off state
// held in memory, so it runs on close and on shell exit — and not at all when
// the process is killed, OOMed, or goes down with the lid. What was left behind
// is somebody's tmux session with no status line and `prefix ,` writing notes
// nobody reads, healing only if they happened to reopen the panel on that exact
// session and then close it properly.
//
// Every test here runs against its own tmux server on a private socket.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const SOCK = ["-L", "agx-stale-test"];
const has = !!Bun.which("tmux");

const raw = (args: string[]) =>
  Bun.spawnSync(["tmux", ...SOCK, ...args], { stdout: "pipe", stderr: "pipe", timeout: 5000 });
const out = (args: string[]) => raw(args).stdout.toString().trim();

let ctl: typeof import("../src/tmuxctl.ts");
let mine = "";
let theirs = "";

beforeAll(async () => {
  if (!has) return;
  raw(["kill-server"]);
  raw(["new-session", "-d", "-s", "mine"]);
  raw(["new-session", "-d", "-s", "theirs"]);
  mine = out(["display-message", "-p", "-t", "mine", "#{session_id}"]);
  theirs = out(["display-message", "-p", "-t", "theirs", "#{session_id}"]);
  ctl = await import("../src/tmuxctl.ts");
});

afterAll(() => { if (has) raw(["kill-server"]); });

const target = () => ({ pid: 0, socket: SOCK, session: "mine", id: mine });
const opt = (sess: string, name: string) => out(["show-options", "-qv", "-t", sess, name]);
const client = () => ({ pid: 0, socket: SOCK, tty: "/dev/null" });

describe.if(has)("a run that was killed does not leave tmux broken", () => {
  test("the takeover is what a crash would leave behind", () => {
    const before = out(["list-keys", "-T", "prefix", ","]);
    expect(ctl.setStatusLine(target(), false)).toBe(true);
    // This is the state a SIGKILL freezes: no status row, the claim still set,
    // and the way back written on the session rather than in a variable.
    expect(out(["show-options", "-t", mine, "-v", "status"])).toBe("off");
    expect(opt(mine, "@agx-owned")).toBe("1");
    expect(opt(mine, "@agx-had-rename")).toContain("bind-key");
    expect(before).toContain("command-prompt");
  });

  test("the next run gives it back, without having been told what it took", () => {
    // No in-memory state is handed over — releaseStale is given only a client,
    // exactly as a fresh process would have it.
    ctl.releaseStale(client());
    expect(out(["show-options", "-t", mine, "-v", "status"])).toBe("");
    expect(opt(mine, "@agx-owned")).toBe("");
    const back = out(["list-keys", "-T", "prefix", ","]);
    expect(back).not.toContain("@agx-ask");
    // Restored verbatim, quoting intact — the saved line is re-run through
    // tmux's own parser rather than rebuilt from an argv.
    expect(back).toContain('command-prompt -I "#W"');
  });

  test("it sweeps once per server, so it cannot fight a live panel", () => {
    // Second call on the same socket must be a no-op: by then this process may
    // legitimately own a session, and a sweep that ran again would release a
    // status line out from under a panel that is still using it.
    ctl.setStatusLine(target(), false);
    expect(opt(mine, "@agx-owned")).toBe("1");
    ctl.releaseStale(client());
    expect(opt(mine, "@agx-owned")).toBe("1");
    ctl.setStatusLine(target(), true);
  });

  test("a session the panel never touched is not touched by the sweep either", () => {
    expect(opt(theirs, "@agx-owned")).toBe("");
    // `status` unset means "whatever your config says" — the sweep must not
    // turn it on, because forcing a value is its own kind of override.
    expect(out(["show-options", "-t", theirs, "-v", "status"])).toBe("");
  });
});
