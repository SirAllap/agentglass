/*
 * "Take me to that agent" must land on the desk, never on the phone.
 *
 * `focusPaneAnywhere` is what the bar's "needs you" chip runs: given a pane id,
 * find the tmux server holding it and switch the client onto it. A grouped
 * phone-mirror session (`agx-phone-<digits>-<suffix>`) shares the desk's window,
 * so `list-panes -a` reports the SAME pane twice — once under the real session
 * and once under the mirror. Two behaviours in that one function keep the desk
 * off the phone-sized doubled view, and both are load-bearing:
 *
 *   (a) the mirror row is filtered out — `!PHONE_SESSION.test(r.session)` — so a
 *       pane that appears under both sessions is matched on the REAL one, and
 *   (b) the switch uses the matched row's OWN session/window ids, not the ids
 *       the click carried (which, coming from the same duplicated list, may be
 *       the mirror's).
 *
 * A regression that reverts either silently `switch-client`s the desk onto the
 * phone-sized mirror it cannot close without reloading tmux. Neither had a test.
 *
 * Everything here runs against a real tmux server on its own socket with
 * `-f /dev/null`, because this is a question about how `focusPaneAnywhere`
 * drives tmux through a grouped session and a mock of tmux could only confirm
 * what was already believed. The socket lives inside a private
 * `$TMUX_TMPDIR/tmux-<uid>` directory rather than /tmp/tmux-<uid>, so discovery
 * (`tmuxSockets` reads TMUX_TMPDIR) finds THIS server and never the developer's
 * — the same isolation the `-f /dev/null`, own-socket rule buys the window-size
 * suite. `$TMUX` is cleared for the run so a bare-socket resolution cannot fall
 * back to the server this process is itself sitting inside.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { focusPaneAnywhere } from "../src/tmuxctl.ts";

// A private socket directory, shaped exactly as tmux's own — `<TMUX_TMPDIR>/
// tmux-<uid>/<name>` — so `tmuxSockets`, which lists that directory, discovers
// this server and only this server. Built at module scope; the env that points
// discovery at it is set in beforeAll, never here, so importing this file does
// not mutate the process for its neighbours.
const uid = process.getuid?.() ?? 0;
const base = mkdtempSync(join(tmpdir(), "agx-focuspane-"));
const sockDir = join(base, `tmux-${uid}`);
mkdirSync(sockDir, { recursive: true });
const SOCK = join(sockDir, "agx-focus");
const T = ["tmux", "-f", "/dev/null", "-S", SOCK];

// The three sessions that reproduce the phone-mirror shape.
const REAL = "real";
const MIRROR = "agx-phone-0-abc123"; // grouped onto REAL — matches PHONE_SESSION
const PHONE_ONLY = "agx-phone-1-def456"; // a standalone phone session

const tmux = (...args: string[]) => {
  const r = Bun.spawnSync([...T, ...args]);
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim() };
};

/** A client of a given size attached to `session`, kept alive by `script`'s pty
 *  until the server dies — the same trick the window-size suite uses to give
 *  tmux something to size itself to (and to make `list-panes` see the server,
 *  which `listPanes` skips when nothing is attached). */
const attach = (session: string, cols: number, rows: number) => {
  Bun.spawn(["script", "-qfc", `stty rows ${rows} cols ${cols}; ${T.join(" ")} attach -t ${session}`, "/dev/null"],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
};

/** Which session the (single) attached client is on right now. */
const clientSession = () => tmux("list-clients", "-F", "#{client_session}").out;

const settle = () => Bun.sleepSync(1000);

let prevTmpdir: string | undefined;
let prevTmux: string | undefined;
beforeAll(() => {
  prevTmpdir = process.env.TMUX_TMPDIR;
  prevTmux = process.env.TMUX;
  // Discovery reads TMUX_TMPDIR; a usable one is also what lifts the test-mode
  // ban on going looking for a server (`blindTmuxBanned`). `$TMUX` is cleared so
  // a bare-socket resolution names nothing rather than the server this agent is
  // itself running inside.
  process.env.TMUX_TMPDIR = base;
  delete process.env.TMUX;
});
afterAll(() => {
  if (prevTmpdir === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = prevTmpdir;
  if (prevTmux === undefined) delete process.env.TMUX; else process.env.TMUX = prevTmux;
  tmux("kill-server");
});

beforeEach(() => {
  tmux("kill-server");
  // The desk's own session, and a client attached to the MIRROR of it — the
  // exact state the regression corrupts: a phone is looking at the desk, and
  // "take me to that agent" must move the client onto REAL, not leave it (or
  // drag it) onto the phone-sized mirror.
  tmux("new-session", "-d", "-s", REAL, "-x", "200", "-y", "50", "sleep 300");
  // Grouped onto REAL: same window, same pane, its own name — so `list-panes -a`
  // reports REAL's pane under BOTH sessions, and the mirror's name sorts first.
  tmux("new-session", "-d", "-t", REAL, "-s", MIRROR);
  // A standalone phone session whose pane belongs to no real session at all.
  tmux("new-session", "-d", "-s", PHONE_ONLY, "sleep 300");
  attach(MIRROR, 100, 40);
  settle();
});

afterEach(() => { tmux("kill-server"); });

describe("focusPaneAnywhere aims at the desk, not the phone mirror sharing its window", () => {
  it("switches the client to the REAL session that owns the shared pane", () => {
    // REAL's pane, the one `list-panes -a` reports under both REAL and MIRROR.
    const pane = tmux("display", "-p", "-t", REAL, "#{pane_id}").out;
    expect(pane).toMatch(/^%\d+$/);

    // The client is on the mirror, the shape a phone leaves behind.
    expect(clientSession()).toBe(MIRROR);

    // The click carries well-formed but BOGUS session/window ids ($99/@99 exist
    // on no server here). If the function used those — instead of the matched
    // row's own ids — `switch-client` would fail and the client would never move
    // to REAL. That it lands on REAL proves both that the mirror row was
    // filtered out AND that the real row's own ids were used.
    const ok = focusPaneAnywhere(["-S", SOCK], "$99", "@99", pane);
    expect(ok).toBe(true);
    settle();

    // The desk, not the phone-sized doubled mirror it was showing.
    expect(clientSession()).toBe(REAL);
  });

  it("focuses nothing when the only row for a pane is a phone mirror", () => {
    // A pane that appears ONLY under a phone session: there is no real session
    // to switch the desk onto, so the honest answer is to do nothing.
    const pane = tmux("display", "-p", "-t", PHONE_ONLY, "#{pane_id}").out;
    expect(pane).toMatch(/^%\d+$/);

    const ok = focusPaneAnywhere(["-S", SOCK], "$99", "@99", pane);
    expect(ok).toBe(false);
    // And it did not drag the desk anywhere: still where it was.
    expect(clientSession()).toBe(MIRROR);
  });
});
