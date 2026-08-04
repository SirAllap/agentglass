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

const SOCK = ["-L", "agx-bartest"];
const has = !!Bun.which("tmux");

const raw = (args: string[]) =>
  Bun.spawnSync(["tmux", ...SOCK, ...args], { stdout: "pipe", stderr: "pipe", timeout: 4000 });
const out = (args: string[]) => raw(args).stdout.toString().trim();

let target: { pid: number; socket: string[]; session: string; id: string };
let ctl: typeof import("../src/tmuxctl.ts");

beforeAll(async () => {
  if (!has) return;
  raw(["kill-server"]);
  raw(["new-session", "-d", "-s", "bartest", "-n", "one"]);
  raw(["new-window", "-t", "bartest", "-n", "two"]);
  const id = out(["display-message", "-p", "-t", "bartest", "#{session_id}"]);
  target = { pid: 0, socket: SOCK, session: "bartest", id };
  ctl = await import("../src/tmuxctl.ts");
});

afterAll(() => { if (has) raw(["kill-server"]); });

const win = (n: string) => out(["list-windows", "-t", "bartest", "-F", "#{window_name}\t#{window_id}\t#{window_index}"])
  .split("\n").map((l) => l.split("\t")).find((c) => c[0] === n)!;

describe.if(has)("the status row, taken and given back", () => {
  test("the row is gone, not blanked — there is no gap to leave behind", () => {
    // The whole point. `status off`, not `status on` with an empty format:
    // a row held open for prompts that no longer arrive there is just a gap.
    expect(ctl.setStatusLine(target, false)).toBe(true);
    expect(out(["show-options", "-t", target.id, "-v", "status"])).toBe("off");
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
    const two = win("two");
    expect(ctl.runAction(target, "move", two[1]!, "7")).toBe(true);
    expect(win("two")[2]).toBe("7");
    // A target spec rather than a number is how a client would reach another
    // session; it never gets that far.
    expect(ctl.runAction(target, "move", two[1]!, "other:0")).toBe(false);
    expect(ctl.runAction(target, "move", two[1]!, "-1")).toBe(false);
    expect(ctl.runAction(target, "move", two[1]!, "")).toBe(false);
  });

  test("giving it back restores the row and the keys, quotes intact", () => {
    const before = out(["list-keys", "-T", "prefix", ","]);
    expect(before).toContain("if-shell"); // ours is installed
    expect(ctl.setStatusLine(target, true)).toBe(true);
    // The row is the user's again — unset, not forced to "on", because their
    // config is what decides.
    expect(out(["show-options", "-t", target.id, "-v", "@agx-owned"])).toBe("");
    const after = out(["list-keys", "-T", "prefix", ","]);
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
});
