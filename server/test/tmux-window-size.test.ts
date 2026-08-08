/*
 * Why an editor in a tmux pane had no status line.
 *
 * Reported from a real pane: nvim open, the buffer drawn at the top, blank
 * below it, and no status bar anywhere. It reads as an nvim problem and is not
 * one — the status line is on the LAST row of the pane, and the pane was taller
 * than the panel showing it.
 *
 * `window-size largest` is why, and it is there on purpose: it stops a phone
 * attaching and shrinking the desk. What nobody had measured is the other
 * direction. With something BIGGER attached — another agentglass window, a
 * `tmux attach` in a real terminal — tmux sizes the window to that one, and a
 * smaller client is shown the top-left corner of it.
 *
 * Everything here runs against a real tmux server on its own socket with
 * `-f /dev/null`, because this is a question about tmux's behaviour and a mock
 * of tmux would only be able to confirm what I already believed.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runAction } from "../src/tmuxctl.ts";

const SOCK = `/tmp/agx-wsize-${process.pid}.sock`;
const T = ["tmux", "-f", "/dev/null", "-S", SOCK];

const tmux = (...args: string[]) => {
  const r = Bun.spawnSync([...T, ...args]);
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout).trim() };
};

/** A client of a given size, attached until the server dies. `script` is what
 *  gives it a pty; without one tmux has nothing to size itself to. */
const attach = (cols: number, rows: number) => {
  Bun.spawn(["script", "-qfc", `stty rows ${rows} cols ${cols}; ${T.join(" ")} attach -t probe`, "/dev/null"],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
};

const geom = () => {
  const out = tmux("display", "-p", "-t", "probe", "#{window_width}x#{window_height}:#{pane_height}").out;
  const [size, pane] = out.split(":");
  return { window: size ?? "", paneRows: Number(pane ?? 0) };
};

const settle = () => Bun.sleepSync(1200);

beforeEach(() => {
  tmux("kill-server");
  tmux("new-session", "-d", "-s", "probe", "-x", "200", "-y", "50", "sleep 300");
  tmux("set-option", "-w", "-t", "probe", "window-size", "largest");
});

afterEach(() => { tmux("kill-server"); });

describe("who decides how big the window is", () => {
  it("fits the only client attached", () => {
    attach(80, 24);
    settle();
    // 23 rather than 24: tmux keeps a row for its own status line.
    expect(geom().paneRows).toBe(23);
  });

  it("hands the window to a bigger client, leaving the small one looking at a corner", () => {
    attach(80, 24);
    settle();
    const alone = geom().paneRows;

    attach(240, 60);
    settle();
    const shared = geom().paneRows;

    // This is the defect, in one line: the pane grew and the panel did not.
    expect(shared).toBeGreaterThan(alone);
    // And what it costs is precisely the bottom of the pane — where an editor
    // draws its status line.
    expect(shared - alone).toBeGreaterThan(20);
  });

  it("gives it back when this client asks to be fitted", () => {
    attach(80, 24);
    settle();
    attach(240, 60);
    settle();
    expect(geom().paneRows).toBeGreaterThan(30);

    /*
     * What the Fit button runs: an explicit size, the panel's own.
     *
     * NOT `-A`. That is "the largest client viewing it", which is the very
     * client that took the window away — measured here first, and it left the
     * pane at 59 rows. `-a` is the smallest, which would hand the window to a
     * phone instead. Neither of them means "the one I am looking at", and that
     * is the only thing the button says.
     */
    tmux("resize-window", "-t", "probe", "-x", "80", "-y", "24");
    settle();

    // Back to something a small client can see all of.
    expect(geom().paneRows).toBeLessThan(30);
    // And it stuck, rather than reverting to the largest client.
    expect(tmux("show-options", "-wv", "-t", "probe", "window-size").out).toBe("manual");
  });
});

/*
 * The same fit, through the code that ships it — `runAction`'s `fit` action.
 *
 * The test above runs the bare `resize-window` a person might type. This one
 * drives the server function the panel actually calls, and it does so with a
 * GROUPED session sharing the window — a phone attached, or a second agentglass
 * window. That is the state a bare `-t @id` target fails silently in on some
 * tmux (measured, and why `fitWindow` is session-qualified): the fit would be a
 * no-op and the window would sit at `window-size largest`, taller than the panel
 * that asked, until the NEXT resize — the one a view-switch triggers — went
 * through the size-qualified `fitWindow` and landed. The action now qualifies
 * its target the same way, so the initial fit takes where it used to be skipped.
 */
describe("the fit action sizes the window to the client, not taller", () => {
  it("lands on a window a grouped session shares, and it sticks", () => {
    // A grouped session sharing probe's window — the phone-attached shape, the
    // one an unqualified window id misses.
    tmux("new-session", "-d", "-t", "probe", "-s", "grp");
    // A bigger client makes the window taller than the 59 rows we will ask for,
    // exactly as a real terminal or a second window does under `largest`.
    attach(267, 65);
    settle();
    const before = geom();
    expect(before.window.split("x")[0]).toBe("267");
    expect(Number(before.window.split("x")[1])).toBeGreaterThan(59);

    const sid = tmux("display", "-p", "-t", "probe", "#{session_id}").out;
    const win = tmux("display", "-p", "-t", "probe", "#{window_id}").out;
    expect(win).toMatch(/^@\d+$/);

    // The panel saying "size this window to what I am looking at": 200x59 —
    // narrower AND shorter than the 267x65 client still attached, so both
    // dimensions are proven independently. A width that matched the client would
    // land whether or not the fit set it; 200 can only be there if it did.
    const ok = runAction({ pid: 0, socket: ["-S", SOCK], session: "probe", id: sid }, "fit", win, undefined, 200, 59);
    expect(ok).toBe(true);
    settle();

    // Sized to the panel, not left at the bigger client's grid — and it holds
    // against that client, which is still attached.
    expect(geom().window).toBe("200x59");
    expect(tmux("show-options", "-wv", "-t", "probe", "window-size").out).toBe("manual");
  });
});
