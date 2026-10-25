/*
 * The tab strip's push channel: a control-mode sidecar (`tmuxwatch.ts`) that
 * tells the sweep when tmux moved, in place of a poll that asked every 500 ms
 * to 2 s.
 *
 * Real tmux on its own socket (`-f /dev/null`, inside a private TMUX_TMPDIR),
 * because every claim here is about how a tmux client behaves: that a new window
 * reaches the listener quickly, that the sidecar does not take the window's size
 * from the client that has it, that it goes away when it is released, and that
 * it is restarted after a kill with a delay and not in a loop.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchSession, HEARTBEAT_MS, QUIET_SWEEPS, SLOW_MS, type SessionWatch, type WatchEvent, type WatchOptions } from "../src/tmuxwatch.ts";
import { nestedFrom, attachedFrom } from "../src/tmuxctl.ts";
import { TEST_TERM } from "./tmuxTerm.ts";
import { startSession } from "./tmuxIsolated.ts";
import { settled } from "./paneSettled.ts";

const uid = process.getuid?.() ?? 0;
const base = mkdtempSync(join(tmpdir(), "agx-watch-"));
const sockDir = join(base, `tmux-${uid}`);
mkdirSync(sockDir, { recursive: true });
const SOCK = join(sockDir, "agx-watch");
const SOCKET = ["-S", SOCK];
const T = ["tmux", "-f", "/dev/null", ...SOCKET];
// Every sidecar in this file starts with an empty config, as the server does:
// an attach that starts a server must not load the developer's.
const BIN = ["tmux", "-f", "/dev/null"];

const { TMUX: _inside, ...OUTSIDE } = process.env;
const tmux = (...args: string[]) => {
  const r = Bun.spawnSync([...T, ...args], { env: OUTSIDE });
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim() };
};
/** The control clients on the server, by the pid of their tmux process. */
const controlPids = () =>
  tmux("list-clients", "-F", "#{client_control_mode} #{client_pid}").out.split("\n")
    .filter((l) => l.startsWith("1 ")).map((l) => Number(l.slice(2)));

let prevTmpdir: string | undefined;
let prevTmux: string | undefined;
beforeAll(() => {
  prevTmpdir = process.env.TMUX_TMPDIR;
  prevTmux = process.env.TMUX;
  process.env.TMUX_TMPDIR = base;
  delete process.env.TMUX;
});
afterAll(() => {
  tmux("kill-server");
  if (prevTmpdir === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = prevTmpdir;
  if (prevTmux === undefined) delete process.env.TMUX; else process.env.TMUX = prevTmux;
});

const watches: SessionWatch[] = [];
beforeEach(() => {
  tmux("kill-server");
  startSession([...T, "new-session", "-d", "-s", "main", "-x", "120", "-y", "40", "sleep 300"], process.env);
});
afterEach(() => {
  for (const w of watches.splice(0)) w.release();
  tmux("kill-server");
});

/** A watch that records what it hears, and a way to wait for the next of a kind. */
function listen(opts: WatchOptions = { bin: BIN }, socket = SOCKET, session = "main") {
  const events: { ev: WatchEvent; at: number }[] = [];
  const w = watchSession(socket, session, (ev) => events.push({ ev, at: performance.now() }), opts);
  expect(w).not.toBeNull();
  watches.push(w!);
  const count = (ev: WatchEvent) => events.filter((e) => e.ev === ev).length;
  return { w: w!, events, count };
}

describe("the sidecar pushes a change", () => {
  it("hears a new window in under 300 ms, with nothing polling", async () => {
    const { w, count } = listen();
    await settled(() => w.alive(), Boolean);
    expect(w.alive()).toBe(true);
    const before = count("change");
    const t0 = performance.now();
    tmux("new-window", "-d", "-n", "second", "sleep 300");
    const heard = await settled(() => count("change") > before, Boolean, 1000);
    const took = performance.now() - t0;
    expect(heard).toBe(true);
    expect(took).toBeLessThan(1000);
  });

  it("hears a rename and a kill too", async () => {
    const { w, count } = listen();
    await settled(() => w.alive(), Boolean);
    tmux("new-window", "-d", "-n", "second", "sleep 300");
    await settled(() => tmux("list-windows", "-F", "#{window_name}").out.includes("second"), Boolean);
    let n = count("change");
    tmux("rename-window", "-t", "main:second", "renamed");
    expect(await settled(() => count("change") > n, Boolean, 1000)).toBe(true);
    n = count("change");
    tmux("kill-window", "-t", "main:renamed");
    expect(await settled(() => count("change") > n, Boolean, 1000)).toBe(true);
  });
});

describe("the sidecar leaves the client alone", () => {
  it("is attached with no-output and ignore-size, and the window keeps the real client's size", async () => {
    // A real client at 100x30 (29 rows of window under tmux's status line): the
    // size a control client would otherwise drag the window to (80x24 by
    // default, under `window-size latest`).
    Bun.spawn(["script", "-qfc", `stty rows 30 cols 100; ${T.join(" ")} attach -t main`, "/dev/null"],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore", env: { ...process.env, TERM: TEST_TERM } });
    const size = () => tmux("display", "-p", "-t", "main", "#{window_width}x#{window_height}").out;
    expect(await settled(size, (v) => v === "100x29", 4000)).toBe("100x29");
    const { w } = listen();
    await settled(() => w.alive(), Boolean);
    const flags = tmux("list-clients", "-F", "#{client_control_mode} #{client_flags}").out.split("\n").find((l) => l.startsWith("1 ")) ?? "";
    expect(flags).toContain("no-output");
    expect(flags).toContain("ignore-size");
    // Activity from the sidecar's side must not matter either: a new window is
    // born at the real client's size.
    tmux("new-window", "-d", "-n", "second", "sleep 300");
    const sizes = () => tmux("list-windows", "-F", "#{window_width}x#{window_height}").out.split("\n");
    expect(await settled(sizes, (v) => v.length === 2)).toEqual(["100x29", "100x29"]);
  });

  it("is a control client the nested-popup read does not count", () => {
    // A control client has no tty and reports a tmux TERM; without the mark the
    // only outer client of a session would be outvoted by it.
    expect(nestedFrom("main\ttmux-256color\t1\n").size).toBe(0);
    expect(nestedFrom("main\ttmux-256color\t0\n").has("main")).toBe(true);
    expect(nestedFrom("main\ttmux-256color\t1\nmain\txterm-256color\t0\n").size).toBe(0);
  });

  it("is gone when released, so the session does not read as attached", async () => {
    const { w } = listen();
    await settled(() => w.alive(), Boolean);
    expect(controlPids().length).toBe(1);
    w.release();
    expect(await settled(() => controlPids().length, (n) => n === 0)).toBe(0);
  });

  it("is shared: two listeners on one session are one client, and the last release closes it", async () => {
    const a = listen();
    const b = listen();
    await settled(() => a.w.alive() && b.w.alive(), Boolean);
    expect(controlPids().length).toBe(1);
    a.w.release();
    // Still one client: the other listener is on it. Wait for it to be gone
    // for as long as a close would take, and expect it not to be.
    expect(await settled(() => controlPids().length, (n) => n === 0, 500)).toBe(1);
    b.w.release();
    expect(await settled(() => controlPids().length, (n) => n === 0)).toBe(0);
  });
});

describe("the sidecar sees the whole server", () => {
  it("hears an @agx-ask set on a window of ANOTHER session", async () => {
    // The sweep reads every session (`list-windows -a`) and "an agent needs
    // you" is set on windows of sessions the sidecar is not attached to.
    tmux("new-session", "-d", "-s", "other", "sleep 300");
    const { w, count } = listen();
    await settled(() => w.alive(), Boolean);
    const n = count("change");
    tmux("set-option", "-w", "-t", "=other:", "@agx-ask", "needs you");
    expect(await settled(() => count("change") > n, Boolean, 3000)).toBe(true);
  });
});

describe("the sidecar is not a reason for a session to read as attached", () => {
  it("is taken off the counts, alone and in a group", () => {
    const control = (name: string) => `\t${name}\t1\n`;
    // Only the sidecar on it: nobody is looking.
    expect([...attachedFrom(`main\t1\t\t\n${control("main")}`)]).toEqual([]);
    // A person too: still live.
    expect([...attachedFrom(`main\t2\t\t\n${control("main")}`)]).toEqual(["main"]);
    // Grouped: the sidecar on one member does not make the other read as live.
    expect([...attachedFrom(`a\t1\t1\tg\nb\t0\t1\tg\n${control("a")}`)]).toEqual([]);
    expect([...attachedFrom(`a\t1\t2\tg\nb\t0\t2\tg\n${control("a")}`)].sort()).toEqual(["a", "b"]);
    // A client that is not a control one is not subtracted.
    expect([...attachedFrom("main\t1\t\t\n\tmain\t0\n")]).toEqual(["main"]);
  });
});

describe("the sidecar dying", () => {
  it("is reported down at once, and restarted after a delay, not in a loop", async () => {
    const { w, events, count } = listen();
    await settled(() => w.alive(), Boolean);
    const [pid] = controlPids();
    const t0 = performance.now();
    process.kill(pid, "SIGKILL");
    expect(await settled(() => count("down"), (n) => n === 1, 1000)).toBe(1);
    expect(w.alive()).toBe(false);
    // Back up — but after the first backoff step, not immediately.
    expect(await settled(() => count("up"), (n) => n === 2, 4000)).toBe(2);
    const back = events.filter((e) => e.ev === "up")[1].at - t0;
    expect(back).toBeGreaterThanOrEqual(900);
    expect(w.alive()).toBe(true);
  });

  it("is not restarted once nobody is listening", async () => {
    const { w, count } = listen();
    await settled(() => w.alive(), Boolean);
    const [pid] = controlPids();
    process.kill(pid, "SIGKILL");
    await settled(() => count("down"), (n) => n === 1, 1000);
    w.release();
    // The restart delay is a second: look for a client for longer than that.
    expect(await settled(() => controlPids().length, (n) => n > 0, 1500)).toBe(0);
  });
});

/** A `tmux` that logs its argv and answers as the test says, for the answers a
 *  real tmux of this version will not give: an old tmux, a lost %end. */
function stub(name: string, body: string): { bin: string[]; log: () => string[] } {
  const file = join(base, name);
  const logFile = join(base, `${name}.log`);
  writeFileSync(logFile, "");
  writeFileSync(file, `#!/bin/sh\necho "$*" >> '${logFile}'\n${body}\n`);
  chmodSync(file, 0o755);
  return { bin: [file], log: () => readFileSync(logFile, "utf8").split("\n").filter(Boolean) };
}
const REAL = `exec tmux -f /dev/null "$@"`;

describe("the sidecar never starts a server", () => {
  it("asks has-session first and does not attach to a socket nobody is serving", async () => {
    // After a power cut the socket is dead; `attach-session` would boot an
    // empty server, loading a config, before the restore gets there.
    const dead = ["-S", join(sockDir, "agx-dead")];
    const t = stub("tmux-real", REAL);
    const { count } = listen({ bin: t.bin, backoffMs: 20 }, dead);
    await settled(() => t.log().filter((l) => l.includes("has-session")).length, (n) => n >= 3, 3000);
    expect(t.log().some((l) => l.includes(" -C "))).toBe(false);
    expect(count("up")).toBe(0);
    expect(existsSync(dead[1])).toBe(false);
  });

  it("stops asking after five starts that never came up", async () => {
    const dead = ["-S", join(sockDir, "agx-dead2")];
    const t = stub("tmux-real2", REAL);
    listen({ bin: t.bin, backoffMs: 20 }, dead);
    const asks = () => t.log().filter((l) => l.includes("has-session")).length;
    expect(await settled(asks, (n) => n >= 5, 3000)).toBe(5);
    expect(await settled(asks, (n) => n > 5, 600)).toBe(5);
  });
});

describe("the sidecar and a tmux that cannot do it", () => {
  it("stands down for good on a tmux older than 3.2, without attaching", async () => {
    const t = stub("tmux-old", `case "$*" in *-V*) echo "tmux 3.1";; *) exit 0;; esac`);
    const { w } = listen({ bin: t.bin, backoffMs: 20 });
    await settled(() => t.log().length, (n) => n >= 1);
    expect(await settled(() => t.log().some((l) => l.includes(" -C ")), Boolean, 500)).toBe(false);
    expect(w.alive()).toBe(false);
  });

  it("stands down for good when tmux answers 'unknown flag -B', and asks once", async () => {
    const t = stub("tmux-noB", `case "$*" in *-V*) echo "tmux 3.8";; *has-session*) exit 0;; *" -C "*) printf '%%begin 1 1 1\\ncommand refresh-client: unknown flag -B\\n%%error 1 1 1\\n'; exec sleep 5;; esac`);
    listen({ bin: t.bin, backoffMs: 20 });
    const attaches = () => t.log().filter((l) => l.includes(" -C ")).length;
    expect(await settled(attaches, (n) => n >= 1)).toBe(1);
    expect(await settled(attaches, (n) => n > 1, 600)).toBe(1);
  });

  it("treats any other error as a failure to retry, not as 'too old'", async () => {
    const t = stub("tmux-err", `case "$*" in *-V*) echo "tmux 3.8";; *has-session*) exit 0;; *" -C "*) printf '%%begin 1 1 1\\nsomething else went wrong\\n%%error 1 1 1\\n'; exec sleep 5;; esac`);
    listen({ bin: t.bin, backoffMs: 20 });
    const attaches = () => t.log().filter((l) => l.includes(" -C ")).length;
    expect(await settled(attaches, (n) => n >= 2, 3000)).toBeGreaterThanOrEqual(2);
  });

  it("closes a reply whose %end never came instead of swallowing the stream", async () => {
    const t = stub("tmux-lost", `case "$*" in *-V*) echo "tmux 3.8";; *has-session*) exit 0;; *" -C "*) printf '%%begin 1 1 1\\n%%subscription-changed tabs $0 - - - : x\\n'; exec sleep 5;; esac`);
    const { w } = listen({ bin: t.bin, backoffMs: 20 });
    const attaches = () => t.log().filter((l) => l.includes(" -C ")).length;
    // Killed and tried again, and never reported as up.
    expect(await settled(attaches, (n) => n >= 2, 3000)).toBeGreaterThanOrEqual(2);
    expect(w.alive()).toBe(false);
  });
});

// terminal.ts is a closure around a pty; the rule is asserted against source.
const src = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();
const from = src.indexOf("const arm = () => {");
const arm = src.slice(from, src.indexOf("\n  arm();", from)).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

describe("the poll is the fallback", () => {
  it("waits the heartbeat only while the sidecar is alive, and the old rhythm otherwise", () => {
    expect(arm).toMatch(/session\.tmuxWatch\?\.alive\(\) \? HEARTBEAT_MS : quiet >= QUIET_SWEEPS/);
    expect(arm).toContain("? SLOW_MS : 500");
    expect(HEARTBEAT_MS).toBeGreaterThan(SLOW_MS);
    expect(QUIET_SWEEPS).toBe(10);
  });

  it("goes back to the poll the moment the sidecar goes down", () => {
    const at = src.indexOf("const onWatch = (");
    const onWatch = src.slice(at, src.indexOf("\n  };", at));
    expect(onWatch).toMatch(/ev === "down"[\s\S]*quiet = 0;[\s\S]*arm\(\);/);
  });

  it("opens the sidecar on the app's own tmux only", () => {
    const at = src.indexOf("function syncWatch(");
    expect(src.slice(at, src.indexOf("\n  }", at))).toContain("if (!session.onEngine");
  });

  it("lets the sidecar go when the client is gone, and with the session", () => {
    expect(src).toContain("if (!frame) syncWatch(null);");
    const at = src.indexOf("function cleanup(");
    expect(src.slice(at, at + 900)).toContain("s.tmuxWatch.release()");
  });
});
