/*
 * The sweep asks tmux for the prefix on the call it was already making.
 *
 * It used to cost two more subprocesses — `show-options -gv prefix` and the
 * same again for `prefix2` — every half second, for every attached shell. On an
 * idle cockpit that was two thirds of the server's whole spawn rate, to read a
 * pair of values that almost never change but cannot be cached (the settings
 * panel applies a new prefix to a running server, and the strip has to say so).
 *
 * The risk this file covers is the wire format, so it runs a real tmux: the
 * answer to one command list has to split cleanly into "the prefix" and "the
 * frame", and it has to keep splitting when the second prefix is unset and when
 * a window is named after the marker that separates the two halves.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { FRAME_ARGV, parsePrefix, parseFrame } from "../src/tmuxctl.ts";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOCK = "agx-frame-prefix";
const TMPDIR = mkdtempSync(join(tmpdir(), "agx-fp-"));
const env = { ...process.env, TMUX_TMPDIR: TMPDIR };

function run(...args: string[]): string {
  const p = Bun.spawnSync(["tmux", ...TMUX_ISOLATED, "-L", SOCK, ...args], { env });
  return new TextDecoder().decode(p.stdout);
}

/** The marker `readFrame` puts between the two halves, spelled here so the test
 *  fails if the module ever changes it silently. */
const MARKER = "agx-prefix-end";

/* The window runs `sleep`, not a shell: on a runner with no usable login
 *  shell the default command exits at once, the only window closes, and the
 *  server goes with it — between the module loading and the test running.
 *  `ensure()` is also called from the test itself, so a server that went
 *  away for any other reason is rebuilt rather than read as an empty answer. */
const ensure = () => {
  if (run("list-sessions", "-F", "#{session_name}").includes("frame")) return true;
  run("new-session", "-d", "-s", "frame", "-x", "80", "-y", "24", "sleep 600");
  return run("list-sessions", "-F", "#{session_name}").includes("frame");
};
const ready = (() => {
  if (Bun.spawnSync(["tmux", "-V"], { env }).exitCode !== 0) return false;
  return ensure();
})();

afterAll(() => { if (ready) run("kill-server"); });

describe("the frame carries the prefix", () => {
  test("the argv says the marker the parser looks for", () => {
    expect(MARKER).not.toBe("");
    // One invocation: every command after the first is introduced by a `;`.
    expect(FRAME_ARGV.filter((a) => a === ";").length).toBe(5);
  });

  test("one command list answers both, and the halves do not bleed", () => {
    if (!ready) return;
    expect(ensure(), "the frame session is up").toBe(true);
    run("set-option", "-g", "prefix", "C-a");
    run("set-option", "-g", "prefix2", "C-q");
    const out = run(...FRAME_ARGV);

    expect(parsePrefix(out)).toEqual(["C-a", "C-q"]);
    // …and the frame in the same answer is still there. No client is attached
    // here, so there is no `c` line to match; what matters is that the prefix
    // block did not swallow or become part of the window rows.
    expect(out.split("\n").some((l) => l.startsWith("w\t"))).toBe(true);
  });

  test("an unset second prefix is dropped, not reported as None", () => {
    if (!ready) return;
    expect(ensure(), "the frame session is up").toBe(true);
    run("set-option", "-g", "prefix", "C-b");
    run("set-option", "-gu", "prefix2");
    expect(parsePrefix(run(...FRAME_ARGV))).toEqual(["C-b"]);
  });

  test("a window named like the marker is still a window", () => {
    if (!ready) return;
    expect(ensure(), "the frame session is up").toBe(true);
    // The reason the prefix is asked for FIRST and ends at a marker: anything
    // tmux prints after that line belongs to the frame, however it is spelled.
    run("rename-window", "-t", "frame:0", MARKER);
    const out = run(...FRAME_ARGV);
    expect(parsePrefix(out)).toEqual(["C-b"]);
    expect(out.split("\n").filter((l) => l.startsWith("w\t")).length).toBeGreaterThan(0);
    run("rename-window", "-t", "frame:0", "frame");
  });

  test("every client's session is collected, not just ours", () => {
    // What replaced a `list-sessions` of its own: a session is attached if and
    // only if a client is on it, and this answer lists every client there is.
    const tty = "/dev/pts/999";
    const out = [
      "C-a",
      MARKER,
      `c\t/dev/pts/7\tagx-phone-abc\t$3\t40\t80\ton\t`,
      `c\t${tty}\tframe\t$0\t80\t24\toff\t1`,
      "w\t$0\t@0\t0\tframe\t1\t\t\t80\t24",
    ].join("\n");
    const f = parseFrame(out, tty);
    expect([...(f?.attached ?? [])].sort()).toEqual(["agx-phone-abc", "frame"]);
    // …and the row that is OURS is still picked by tty, not by being first.
    expect(f?.session).toBe("frame");
    expect(f?.client).toEqual({ cols: 80, rows: 24 });
  });

  test("parseFrame ignores the prefix block", () => {
    const tty = "/dev/pts/999";
    const out = [
      "C-a",
      MARKER,
      `c\t${tty}\tframe\t$0\t80\t24\toff\t1`,
      "w\t$0\t@0\t0\tframe\t1\t\t\t80\t24",
      "p\t$0\t@0\t1\t%0\t0\t0\t79\t23\t1\t0",
    ].join("\n");
    const f = parseFrame(out, tty);
    expect(f?.session).toBe("frame");
    expect(f?.windows.length).toBe(1);
  });
});
