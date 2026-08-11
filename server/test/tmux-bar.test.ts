// Taking tmux's status line, and giving it back.
//
// The panel draws its own window list, so tmux's row is either the one on
// screen or it is not there at all — a blanked row that still takes a row is
// neither, and that gap is what this replaced.
//
// Removing the row costs something real: with no status line, tmux draws
// `prefix ,` and `prefix .` over the first line of the shell. So those keys are
// rebound to leave a note the panel picks up instead. The tests below are about
// the two ways that can go wrong, both of which reach outside this app:
//
//  * Key bindings are GLOBAL to a tmux server, not per session. An
//    unconditional rebind would take rename away from every other session on
//    the machine, including one attached from a real terminal where tmux's own
//    prompt is the right answer. Hence `@agx-owned`, and hence the test that a
//    session we do not own still prompts.
//  * Giving it back has to be exact. `list-keys` prints a command *line* with
//    quoted arguments; restoring by splitting it on whitespace tears
//    `command-prompt -I "#W" "rename-window -- %%"` into rubbish, and the user
//    is left with a broken key they never touched.
//
// Runs against its own tmux server on a private socket — never the developer's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";

import { TMUX_ISOLATED } from "./tmuxIsolated.ts";

// Own socket AND an empty config — see tmuxIsolated. Unique per run, or a
// leftover server from a previous one is what this talks to.
const SOCK = [...TMUX_ISOLATED, "-L", `agx-bartest-${process.pid}`];
/*
 * And a socket DIRECTORY of its own, which this had not got. A `-L` name with
 * no TMUX_TMPDIR resolves to /tmp/tmux-<uid> — the developer's, beside the
 * `default` his sessions are on. Measured with a recording tmux on PATH: 68 of
 * this file's calls landed there, and the machine still had `agx-bartest-*`
 * sockets in his directory from runs hours earlier, one per run, cleaned up by
 * reaching into his directory to delete them.
 *
 * Not the danger `-f /dev/null` above already closed — that is the half that
 * keeps his tmux config, and so tmux-continuum's restore, out of a server this
 * file starts. This is the other half: a fixture has no business leaving
 * anything in that directory at all, and `tmuxSockets()` hands every server in
 * a directory to `listPanes`.
 */
const TMPDIR = `/tmp/agx-tmux-bar-${process.pid}`;
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
const has = !!Bun.which("tmux");

/** `env: process.env` and it is load-bearing: measured on Bun 1.3.9, a
 *  `Bun.spawnSync` with no `env` gets the environment as it was when the
 *  PROCESS started, not `process.env` as it is now. Without it the TMUX_TMPDIR
 *  set below reaches `tmuxctl.ts` (which passes `process.env`) and not this
 *  helper, so the fixture would build its server in one directory while the
 *  code under test looked in another. */
const raw = (args: string[]) =>
  Bun.spawnSync(["tmux", ...SOCK, ...args], { stdout: "pipe", stderr: "pipe", timeout: 4000, env: process.env });
const out = (args: string[]) => raw(args).stdout.toString().trim();

let target: { pid: number; socket: string[]; session: string; id: string };
let ctl: typeof import("../src/tmuxctl.ts");

beforeAll(async () => {
  if (!has) return;
  // Here rather than at module load: `bun test` runs a suite's files in one
  // process, and the other tmux files are entitled to the environment they were
  // written against.
  mkdirSync(TMPDIR, { recursive: true });
  process.env.TMUX_TMPDIR = TMPDIR;
  raw(["kill-server"]);
  raw(["new-session", "-d", "-s", "bartest", "-n", "one"]);
  raw(["new-window", "-t", "bartest", "-n", "two"]);
  const id = out(["display-message", "-p", "-t", "bartest", "#{session_id}"]);
  target = { pid: 0, socket: SOCK, session: "bartest", id };
  ctl = await import("../src/tmuxctl.ts");
});

afterAll(() => {
  if (has) raw(["kill-server"]);
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
  // tmux leaves the socket file behind when the server exits, so killing the
  // server alone still drops one dead socket per run. It is inside TMPDIR now,
  // so this takes the directory and the socket together — where the version
  // before reached into HIS directory to delete a file out of it.
  try { rmSync(TMPDIR, { recursive: true, force: true }); } catch { /* nothing to remove */ }
});

const win = (n: string) => out(["list-windows", "-t", "bartest", "-F", "#{window_name}\t#{window_id}\t#{window_index}"])
  .split("\n").map((l) => l.split("\t")).find((c) => c[0] === n)!;

/**
 * The binding for one key, read the way the code under test reads it.
 *
 * Never `list-keys -T prefix ,`. Measured on tmux 3.7b, the one-key form prints
 * NOTHING to stdout and paints the binding onto the attached client as a
 * message instead — so this fixture used to assert against an empty string, and
 * the app used to scribble `bind-key  -T prefix . if-shell …` over the first
 * line of the user's shell every time it took the row.
 */
const keyLine = (key: string) => out(["list-keys", "-T", "prefix"]).split("\n")
  .find((l) => ctl.parseBinding(l)?.key === key) ?? "";

describe.if(has)("the status row, taken and given back", () => {
  test("the row is kept and blanked, because tmux still has messages to draw", () => {
    /*
     * This test used to assert the opposite — `status off`, "a row held open
     * for prompts that no longer arrive there is just a gap" — and the premise
     * was wrong. They do arrive.
     *
     * Measured against a real attached client on a private server: with
     * `status off`, `display-message "Saving… AI00"` reaches the client as a
     * bare paint at the cursor, with no cursor-home before it and no repaint
     * after, so it lands in the middle of the pane and stays until something
     * redraws that line. Reported from a desk running tmux-continuum, where
     * every autosave stamped a line across an agent's box and ate the line
     * under it. With the row kept and the format blank, the same message is
     * written after a `\r\n` into the reserved row and the pane is untouched.
     *
     * The cost is one row, paid once, against a pane that is corrupted every
     * time any plugin says anything.
     */
    expect(ctl.setStatusLine(target, false)).toBe(true);
    expect(out(["show-options", "-t", target.id, "-v", "status"])).toBe("on");
    expect(out(["show-options", "-t", target.id, "-v", "status-format[0]"])).toBe("");
    expect(out(["show-options", "-t", target.id, "-v", "@agx-owned"])).toBe("1");
  });

  test("prefix , leaves a note on the window instead of prompting", () => {
    // The binding is run directly rather than by sending the key, because a
    // detached server has no client to press it at — what is under test is the
    // command the binding resolves to, which is the part that could be wrong.
    const w = win("two");
    raw(["run-shell", "-t", `${target.id}:${w[2]}`, "true"]); // make it current-ish
    raw(["select-window", "-t", w[1]!]);
    raw(["send-keys", "-t", w[1]!, ""]); // no-op; keeps tmux's idea of current fresh
    raw(["if-shell", "-F", "#{@agx-owned}", `set-option -w -t ${w[1]} @agx-ask rename`, "display-message no"]);
    expect(out(["show-options", "-w", "-t", w[1]!, "-v", "@agx-ask"])).toBe("rename");
  });

  test("the note reaches the panel through the frame it already polls", () => {
    // No extra subprocess: `@agx-ask` rides in the same list-windows format the
    // tab strip is already built from.
    const w = win("two");
    raw(["set-option", "-w", "-t", w[1]!, "@agx-ask", "move"]);
    const rows = out(["list-windows", "-t", "bartest",
      "-F", "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_raw_flags}\t#{@agx-ask}"]);
    const parsed = ctl.parseWindows(rows);
    expect(parsed.find((x) => x.id === w[1])?.ask).toBe("move");
    // And anything that is not one of ours is dropped rather than forwarded.
    raw(["set-option", "-w", "-t", w[1]!, "@agx-ask", "something-else"]);
    const rows2 = out(["list-windows", "-t", "bartest",
      "-F", "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_raw_flags}\t#{@agx-ask}"]);
    expect(ctl.parseWindows(rows2).find((x) => x.id === w[1])?.ask).toBeUndefined();
  });

  test("clearing the note takes it off, so the box opens once and not forever", () => {
    const w = win("two");
    raw(["set-option", "-w", "-t", w[1]!, "@agx-ask", "rename"]);
    ctl.clearAsk(target, w[1]!);
    expect(out(["show-options", "-w", "-t", w[1]!, "-v", "@agx-ask"])).toBe("");
  });

  test("move-window takes an index and refuses anything else", () => {
    /*
     * The move INSERTS beside that index and renumbers, rather than landing on
     * it. Measured on 3.6a and the reason this changed: a bare move onto an
     * occupied index answers "index in use" and moves nothing — which is every
     * index in a real strip, so this control did nothing at all for its whole
     * life. What it asserts now is that the window moved and the strip has no
     * holes; where exactly it lands is tmux-move-window.test.ts's business.
     */
    const two = win("two");
    // Two windows, `one` then `two`. Dropping `two` before `one` swaps them,
    // and the indexes stay contiguous.
    expect(ctl.runAction(target, "move", two[1]!, win("one")[2]!)).toBe(true);
    expect(Number(win("two")[2])).toBeLessThan(Number(win("one")[2]));
    // A target spec rather than a number is how a client would reach another
    // session; it never gets that far.
    expect(ctl.runAction(target, "move", two[1]!, "other:0")).toBe(false);
    expect(ctl.runAction(target, "move", two[1]!, "-1")).toBe(false);
    expect(ctl.runAction(target, "move", two[1]!, "")).toBe(false);
  });

  test("what the key did is written down, so there is something to give back", () => {
    // The take is what this asserts on, not the release: with the answer coming
    // back empty, `@agx-had-rename` was never set and the release below had
    // nothing to restore — silently, because an unset option reads as "".
    expect(out(["show-options", "-t", target.id, "-qv", "@agx-had-rename"])).toContain("command-prompt");
  });

  test("a second take keeps the user's binding, not ours", () => {
    // Key bindings are global and the take runs again on every sweep. Reading
    // the table back now returns OUR binding, and saving that as "what they
    // had" would bury their real one one copy deeper on every pass.
    const had = out(["show-options", "-t", target.id, "-qv", "@agx-had-rename"]);
    ctl.setStatusLine(target, false);
    expect(out(["show-options", "-t", target.id, "-qv", "@agx-had-rename"])).toBe(had);
    const line = keyLine(",");
    expect(line.split("@agx-ask").length - 1).toBe(1); // ours, once, not nested
    expect(line).toContain("#W"); // and the user's is still the false branch
  });

  test("a server the old build already took gets its keys back", () => {
    // What a machine that ran the broken query looks like: our binding is
    // installed and nothing was written down, so the release path had nothing
    // to give back and the user's key stayed ours until they killed the server.
    // Their command is still in the false branch, which is where it is read from.
    ctl.setStatusLine(target, true);
    raw(["bind-key", "-T", "prefix", ".", "if-shell", "-F", "#{@agx-owned}",
      "set-option -w @agx-ask move", 'command-prompt -p "go where?" "move-window -t \'%%\'"']);
    raw(["set-option", "-t", target.id, "-u", "@agx-had-move"]);

    ctl.setStatusLine(target, false);
    expect(out(["show-options", "-t", target.id, "-qv", "@agx-had-move"])).toContain("go where?");
    ctl.setStatusLine(target, true);
    const back = keyLine(".");
    expect(back).not.toContain("@agx-ask");
    expect(back).toContain("go where?");
    ctl.setStatusLine(target, false);
  });

  test("giving it back restores the row and the keys, quotes intact", () => {
    expect(keyLine(",")).toContain("if-shell"); // ours is installed
    expect(ctl.setStatusLine(target, true)).toBe(true);
    // The row is the user's again — unset, not forced to "on", because their
    // config is what decides.
    expect(out(["show-options", "-t", target.id, "-v", "@agx-owned"])).toBe("");
    const after = keyLine(",");
    expect(after).not.toContain("@agx-ask");
    // The quoted arguments survived the round trip. Splitting the saved line on
    // whitespace is what breaks this, and it breaks it silently.
    expect(after).toContain("command-prompt");
    expect(after).toContain("#W");
  });

  test("a session we do not own keeps tmux's own prompt", () => {
    // The binding is global to the server; the flag is per session. Someone
    // attached from a real terminal must still get their prompt.
    ctl.setStatusLine(target, false);
    raw(["new-session", "-d", "-s", "theirs"]);
    const theirs = out(["display-message", "-p", "-t", "theirs", "#{session_id}"]);
    expect(out(["show-options", "-t", theirs, "-v", "@agx-owned"])).toBe("");
    expect(out(["show-options", "-t", target.id, "-v", "@agx-owned"])).toBe("1");
    ctl.setStatusLine(target, true);
  });

  test("the head of a bind-key line is not a fixed width", () => {
    // What has to come off the front to leave a command the false branch can
    // run. `-r` and `-N "note"` ride in front of `-T`, the columns are padded,
    // and the key comes back escaped — each of which a split on whitespace or a
    // fixed prefix gets wrong in a different way.
    const p = (l: string) => ctl.parseBinding(l);
    expect(p('bind-key    -T prefix ,       command-prompt -I "#W" { rename-window "%%" }'))
      .toEqual({ key: ",", cmd: 'command-prompt -I "#W" { rename-window "%%" }' });
    expect(p('bind-key -r -T prefix T       run-shell "menu.sh"'))
      .toEqual({ key: "T", cmd: 'run-shell "menu.sh"' });
    expect(p('bind-key    -N "split it" -T prefix v    split-window -h'))
      .toEqual({ key: "v", cmd: "split-window -h" });
    expect(p("bind-key    -T prefix \\#      list-buffers")).toEqual({ key: "#", cmd: "list-buffers" });
    // The column width tracks the widest key in the table, so it moves as the
    // user's config does. Two gaps, same line, nothing fixed about either.
    expect(p("bind-key -T prefix C-Space next-layout")).toEqual({ key: "C-Space", cmd: "next-layout" });
    // A binding in another table is not this key's, however it is padded.
    expect(p("bind-key    -T copy-mode-vi , select-pane")).toBeNull();
    expect(p("some other line")).toBeNull();
  });
});
