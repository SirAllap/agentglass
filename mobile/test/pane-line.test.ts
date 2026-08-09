/*
 * Reading the typed line off a real terminal, in a real browser engine.
 *
 * The phone's field IS the pane's input line, and the half that decides whether
 * that works at all runs inside the WebView: it asks xterm's buffer what is on
 * the cursor's row and looks for the end of the prompt. Neither can be checked
 * by a type, and neither can be checked against a string — the answer depends
 * on what xterm actually laid out after parsing escape sequences, which is a
 * whole terminal emulator's worth of behaviour.
 *
 * So the document is loaded into headless Chrome, fed the bytes a pane would
 * send, and asked what it thinks is being typed. The other half — turning an
 * edit into keystrokes — is pure and is tested in mirror.test.ts.
 *
 * Skipped where there is no Chrome. It is a real browser or it is nothing:
 * a stub would be testing the stub.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalDocument, terminalTheme } from "../src/terminal/terminal-html.ts";
import { paletteFor } from "../../shared/palettes.ts";
import { C } from "../src/theme.ts";

const CHROME = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  .find((p) => Bun.file(p).size !== 0 || Bun.which(p));
const HAVE_CHROME = !!CHROME;
const CDP = 9457;
/*
 * The two sockets this file needs are asked for by number 0 — whatever is free
 * — and read back, rather than written down.
 *
 * They were 4711 and 4712, and the whole file failed in `beforeAll` with
 * EADDRINUSE because another agent's scratch server on this machine happened to
 * be on 4711. That is not a flake: this repo is worked on by several sessions at
 * once, a fixed port is a lock shared with all of them, and the failure lands
 * before a single assertion runs. The CDP port below is still fixed because
 * Chrome only reports a chosen one through a file in its profile.
 */
let PORT = 0;
/** Where the page's own socket lands — see the drag rig at the bottom. */
let WIRE = 0;
/*
 * What a drag test is allowed to take, because bun's own default is five
 * seconds and these do not fit in it: a pane has to print three hundred lines,
 * a thumb crosses twenty rows a frame at a time, and the answer comes back off
 * a real tmux. Written here rather than passed as a flag — a test that only
 * passes when somebody remembers `--timeout` is a test that fails in the suite.
 */
const SLOW = 30_000;

/**
 * The smallest CDP client that can do this: one page, one call at a time, and
 * a fresh connection when the old one dies under it.
 *
 * Both of those are measured rather than careful. This socket carries every
 * question the file asks the page, and it does not survive a long run: close
 * code 1006, no close frame, while the very same page answers a connection
 * opened a second later perfectly — reliably in the whole-suite run, rarely
 * when this file runs alone. Every call already waiting then waits for ever,
 * and the run stops with no output at all, because the test timeout is on the
 * same loop as the wait. So a close is not fatal: the waiters are released, the
 * next call opens another connection, and the one call that was in flight is
 * asked again. Nothing is lost with it — the page keeps its own state, and the
 * pane's traffic goes over its own socket, not this one.
 */
class Cdp {
  private next = 1;
  private waiting = new Map<number, (value: unknown) => void>();
  private dead = false;
  private gen = 0;
  private turn: Promise<unknown> = Promise.resolve();
  constructor(private ws: WebSocket, private again: () => Promise<WebSocket>) { this.wire(ws); }
  private wire(ws: WebSocket): void {
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
      if (frame.id && this.waiting.has(frame.id)) {
        this.waiting.get(frame.id)!(frame.result);
        this.waiting.delete(frame.id);
      }
    };
    ws.onclose = () => {
      this.dead = true;
      this.gen++;
      for (const [id, resolve] of this.waiting) { this.waiting.delete(id); resolve(undefined); }
    };
  }
  private async revive(): Promise<void> {
    if (!this.dead) return;
    this.ws = await this.again();
    this.dead = false;
    this.wire(this.ws);
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      await this.revive();
      const era = this.gen;
      const answer = await this.raw(method, params);
      // Undefined AND the connection changed underneath: that is the socket
      // dying mid-question, not the page answering nothing.
      if (answer === undefined && this.gen !== era) {
        await this.revive();
        return this.raw(method, params);
      }
      return answer;
    };
    this.turn = this.turn.then(run, run);
    return this.turn;
  }
  private raw(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.dead) return Promise.resolve(undefined);
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** Evaluate and hand back the value, which is all this file ever needs. */
  async value<T>(expression: string): Promise<T> {
    const answer = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return (answer as { result?: { value?: T } }).result?.value as T;
  }
  close(): void { try { this.ws.close(); } catch { /* already gone */ } }
}

let chrome: ReturnType<typeof Bun.spawn> | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;
let cdp: Cdp | null = null;
let profile = "";

/** How many reports the page had already sent when the last `feed` went in. */
let before = 0;

const LINES = `(window.__agx || []).filter(function (m) { return m.t === 'line'; })`;

/** Bytes as the pane would send them, base64 the way the socket delivers them. */
const feed = async (bytes: string): Promise<void> => {
  before = (await cdp!.value<number>(`${LINES}.length`)) ?? 0;
  const b64 = Buffer.from(bytes, "utf8").toString("base64");
  await cdp!.value(`window.AGX.write(${JSON.stringify(b64)}), 1`);
};

/**
 * What the page said is being typed, AFTER the feed that preceded this call.
 *
 * This used to be `await Bun.sleep(260)` and a read — 260ms being "longer than
 * the page's own 90ms settle". A fixed sleep is not a synchronisation
 * primitive, and on a GitHub runner the first report arrived later than that:
 * `Expected: "hola como vas bien" / Received: undefined`, one test red out of
 * 398 with the engine loaded and every later test in the same file green,
 * because by then there was an older message for the read to return. The same
 * race was live in every one of these assertions; the first one is simply the
 * only one with nothing stale to fall back on.
 *
 * So it waits for a report the page had not sent yet, rather than for a period
 * of time. The count is taken in `feed`, which is the only thing that makes the
 * page speak, so the pair cannot drift.
 *
 * The ceiling is a real answer and not a failure: if the page decides a redraw
 * changed nothing it sends nothing, and the last thing it said is what it
 * thinks. `undefined` when it has never said anything at all.
 */
const reported = async (): Promise<string | null | undefined> => {
  const deadline = Date.now() + 4_000;
  for (;;) {
    const n = (await cdp!.value<number>(`${LINES}.length`)) ?? 0;
    if (n > before || Date.now() > deadline) {
      return cdp!.value<string | null | undefined>(
        `(function () { var seen = ${LINES}; return seen.length ? seen[seen.length - 1].text : undefined; })()`);
    }
    await Bun.sleep(40);
  }
};

beforeAll(async () => {
  if (!HAVE_CHROME) return;
  const html = terminalDocument({ palette: C, columns: 80 });
  server = Bun.serve({
    port: 0,
    fetch: () => new Response(html, { headers: { "content-type": "text/html" } }),
  });
  PORT = server.port!; // undefined only for a unix socket, and this one is TCP
  // A profile of this run's own. The fixed one it used to have is a singleton
  // lock shared with whatever a killed run left behind, and a second Chrome that
  // finds it occupied exits — partway through, which reads here as the debugger
  // connection dying for no reason.
  profile = mkdtempSync(join(tmpdir(), "agx-chrome-"));
  chrome = Bun.spawn([
    CHROME!, "--headless=new", "--disable-gpu", "--no-first-run", "--no-sandbox",
    `--user-data-dir=${profile}`, "--window-size=412,915",
    `--remote-debugging-port=${CDP}`, "about:blank",
  ], { stdout: "ignore", stderr: "ignore" });

  /*
   * 240 quarter-seconds — a full minute — and it is not generosity.
   *
   * This loop asked for 15s while the hook it lives in had bun's 5s default,
   * so the ceiling always fired first and the patience written here was never
   * actually available. With the hook budgeted (see the bottom of this
   * function) the number finally means something, and 15s is not enough for a
   * cold Chrome on a 2-core runner: measured on ubuntu-latest, the same commit
   * that came up inside 15s twice failed to expose a page at all on the third
   * run.
   */
  let target = "";
  for (let i = 0; i < 240 && !target; i++) {
    await Bun.sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json() as
        { type: string; webSocketDebuggerUrl?: string }[];
      target = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "";
    } catch { /* not up yet */ }
  }
  /*
   * Loud, because the quiet version cost an afternoon of reading the wrong
   * thing. This was `if (!target) return;`, which left `cdp` null and handed
   * all 29 tests below a `TypeError: null is not an object (evaluating
   * 'cdp.value')` — twenty-nine failures, none of them mentioning Chrome, for
   * one browser that had not finished starting. A hook that cannot build its
   * fixture has to say so itself.
   */
  if (!target) {
    throw new Error(
      `Chrome never exposed a debuggable page on 127.0.0.1:${CDP} within 60s (binary: ${CHROME}). ` +
      `Its output is discarded here; re-run with stdout/stderr inherited on the spawn above to see why.`,
    );
  }

  /** Open a connection to the page — the first one, and any replacement. */
  const connect = async (): Promise<WebSocket> => {
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json() as
      { type: string; webSocketDebuggerUrl?: string }[];
    const at = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? target;
    const socket = new WebSocket(at);
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("no cdp")); });
    return socket;
  };
  cdp = new Cdp(await connect(), connect);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  // The bridge the page posts through, defined before its own script runs —
  // the page reports while that script is still executing.
  // `__out` is the same keystrokes again, as a queue somebody drains: the drag
  // tests below have to put them on a real pane WHILE the finger is still down,
  // because the page holds its first notch until it sees what that notch did.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__agx = []; window.__out = [];
      window.ReactNativeWebView = { postMessage: function (m) {
        var msg = JSON.parse(m);
        window.__agx.push(msg);
        if (msg.t === 'in') window.__out.push(msg.d);
      } };`,
  });
  // Touch, or dispatchTouchEvent is refused and the drag test measures nothing.
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  // The engine is a megabyte of bundled JavaScript; it is not instant.
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(250);
    if (await cdp.value<boolean>(`!!(window.AGX && (window.__agx || []).some(function (m) { return m.t === 'ready'; }))`)) break;
  }
  /*
   * A budget for the hook, because this one cannot fit in bun's 5s default and
   * never could: it launches Chrome, serves the document, opens a CDP socket
   * and then waits on the loop above, which is allowed 40 × 250ms = 10 seconds
   * on its own. It fit on a dev box by finishing long before either ceiling.
   *
   * Measured on ubuntu-latest: `(fail) (unnamed) [5000.30ms] — a
   * beforeEach/afterEach hook timed out for this test`, the whole file's worth
   * of assertions lost to a hook that was still starting a browser. It ran
   * green there twice before and went red on a commit that changed two version
   * fields and a lockfile, which is what a test sitting exactly on a timeout
   * looks like from the outside.
   *
   * The budget goes HERE and not on `bun test --timeout` for the whole job:
   * the other 31 suites in this directory are pure-module tests that finish in
   * milliseconds, and a tight default is what turns a genuine hang in one of
   * them into a fast red instead of a five-minute one. The server job raises
   * its ceiling globally for the opposite reason — there, most suites do real
   * git and spawn work.
   */
}, 120_000);

afterAll(() => {
  cdp?.close();
  chrome?.kill();
  server?.stop(true);
  if (profile) rmSync(profile, { recursive: true, force: true });
});

describe.if(HAVE_CHROME)("what the page thinks is being typed", () => {
  test("the engine loaded and said it was ready", async () => {
    expect(await cdp!.value<boolean>("!!window.AGX")).toBe(true);
    expect(await cdp!.value<number>("(window.__agx || []).length")).toBeGreaterThan(0);
  });

  test("an agent's prompt with a half-written line in it", async () => {
    // Clear, home, then exactly what `capture-pane` showed on a real pane.
    await feed("[2J[H❯ hola como vas bien");
    expect(await reported()).toBe("hola como vas bien");
  });

  test("typing more of it is reported as the whole line, not the tail", async () => {
    // The field is the line, so a partial answer would truncate what is in it.
    await feed(" y tu");
    expect(await reported()).toBe("hola como vas bien y tu");
  });

  test("erasing on the pane shrinks it here too", async () => {
    // What an erase looks like arriving from the other side: back up, blank,
    // back up. This is the direction that keeps the phone in step with the desk.
    //
    // The blank is the point. It PAINTS A SPACE, so those cells were written
    // and xterm's own trim keeps them — this first ran green-adjacent, reading
    // "hola como vas bien y   ", which the field would have carried and then
    // sent back on the next edit. See the trim in `lineNow`.
    await feed("\b \b\b \b\b \b");
    expect(await reported()).toBe("hola como vas bien y");
  });

  test("an empty prompt is empty, which is not the same as unreadable", async () => {
    await feed("[2J[H❯ ");
    expect(await reported()).toBe("");
  });

  test("and it refuses a line that is not a prompt", async () => {
    // The half that matters most. `null` is the page saying it cannot tell, and
    // the screen treats that as "leave the field alone" — because offering a
    // line of build output as something to press Enter on is worse than
    // offering nothing at all.
    await feed("[2J[HRan 3 shell commands");
    expect(await reported()).toBeNull();
  });

  test("a split row stops at the pane border, not at the neighbour's prompt", async () => {
    /*
     * A tmux pane is a rectangle inside one terminal, so two panes side by side
     * share every buffer row: the row under a cursor in the RIGHT pane reads
     * "their output │ what I am typing". Measured on a real two-pane window,
     * tmux draws that divider as U+2502 — 38 of them in one repaint, with no ACS
     * charset switch.
     *
     * Taking the LAST marker before the cursor was meant to cover this and does
     * not. When the typed line has wrapped inside its own narrow pane, tmux
     * redraws the wrap by moving the cursor, so the cursor's row carries no
     * marker of ours at all — and the last marker before it is the NEIGHBOUR'S.
     * The field then held their prompt and everything between it and here, and
     * every edit made in it was computed against their characters.
     */
    await feed("\x1b[2J\x1b[H$ ls -la    │mundo");
    expect(await reported()).toBeNull();
  });

  test("but a prompt of our own on the far side of the border is read", async () => {
    // The same row with the right-hand pane at its own prompt. Cutting at the
    // border must not cost the case the cut is there to protect.
    await feed("\x1b[2J\x1b[H$ ls -la    │❯ hola");
    expect(await reported()).toBe("hola");
  });

  /*
   * The five that were losing data, each one a marker the USER typed.
   *
   * The reader took the LAST marker on the row, and the marker class — > $ # %
   * and the arrows — is ordinary shell syntax. So the prompt it found was
   * usually somewhere inside the command: measured here, in this engine, the
   * field believed "echo $HOME" was the line "HOME".
   *
   * They are here as five separate tests rather than one loop because each is a
   * different character doing it, and a loop that breaks tells you five things
   * are broken when one is. The stakes are in lineNow's comment: the field
   * sends the DIFFERENCE between what it believes and what it holds, so a wrong
   * belief is DELs typed into somebody's real command line.
   */
  // Written "\x1b" rather than as the byte itself, which is what the tests above
  // carry: a literal ESC is invisible in an editor and does not survive being
  // copied, and a feed that lost it prints "[2J[H" as five characters at the
  // start of the row — which reads back as a line with no prompt on it, so the
  // test fails with null and blames the reader. Cost me a run.
  const readsWhole = (line: string) => async () => {
    await feed(`\x1b[2J\x1b[H❯ ${line}`);
    expect(await reported()).toBe(line);
  };

  test("a variable is not a prompt: echo $HOME", readsWhole("echo $HOME"));
  test("a redirect is not a prompt: cat a > b", readsWhole("cat a > b"));
  test("a format string is not a prompt: git log --format=%h", readsWhole("git log --format=%h"));
  test("a hash in a message is not a prompt: git commit -m fix#12", readsWhole("git commit -m fix#12"));
  test("and neither is a merged stderr: make 2>&1", readsWhole("make 2>&1"));

  test("the case the data loss was reported from, end to end", async () => {
    /*
     * The pane holds "make build > log.txt" and the field believed "log.txt".
     * Clearing the field then sent seven DELs — leaving the pane on
     * "make build > " — and the next thing typed was run as its target. What is
     * asserted is only the belief, because the belief is what the erase count is
     * computed from (see editFor in mirror.ts).
     */
    await feed("\x1b[2J\x1b[H❯ make build > log.txt");
    expect(await reported()).toBe("make build > log.txt");
  });

  test("a line longer than the terminal is read whole", async () => {
    // 80 columns, so this wraps. Only the cursor's row is on screen at the end;
    // a reader that stopped there would hand back the tail of the command and
    // the field would silently lose its first eighty characters.
    const long = "x".repeat(100);
    await feed(`[2J[H❯ ${long}`);
    expect(await reported()).toBe(long);
  });
});


describe.if(HAVE_CHROME)("dragging the pane with a finger", () => {
  /** Everything the page has sent up as keystrokes since it was last cleared. */
  const sent = async (): Promise<string[]> => cdp!.value<string[]>(`(function () {
    return (window.__agx || []).filter(function (m) { return m.t === 'in'; }).map(function (m) { return m.d; });
  })()`);
  const clear = async (): Promise<void> => {
    /*
     * A finger on the glass first, because a flick COASTS after the finger
     * leaves — deliberately, see the page — and a coast that outlives the 400ms
     * at the end of a drag puts its wheels in the next test's bucket. Caught
     * once as nineteen wheels up arriving ahead of the thirteen down this test
     * asked for, in a run where the page happened to be a little busier.
     * Touching a moving screen stops it, which is what a reader does too.
     */
    await cdp!.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 120, y: 300 }] });
    await cdp!.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await cdp!.value(`(window.__agx = []), 1`);
  };

  const drag = async (from: number, to: number): Promise<void> => {
    await cdp!.send("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ x: 120, y: from }],
    });
    // In steps, the way a thumb actually moves — one jump can be dismissed as
    // an artefact of the test, and the page accumulates between moves.
    const step = from > to ? -20 : 20;
    for (let y = from + step; from > to ? y >= to : y <= to; y += step) {
      await cdp!.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 120, y }] });
    }
    await cdp!.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    // Longer than the page's probe holds its first notch waiting to see what
    // that notch did — nothing here ever answers it, so it always waits it out.
    await Bun.sleep(400);
  };

  test("a drag sends the pane a wheel, because that is all a program understands", async () => {
    /*
     * Mouse tracking on, exactly as tmux turns it on with `mouse on`: 1000 is
     * "report buttons", 1006 is the SGR encoding. Without this xterm has
     * nothing to forward to and scrolls its own buffer instead, which on an
     * attached pane is empty — which is the bug being fixed, not the fix.
     */
    await feed("\x1b[?1000h\x1b[?1006h");
    await clear();
    // Finger UP the screen. The content follows the finger, which is a wheel
    // DOWN — SGR button 65. The opposite of what the arithmetic first suggests.
    await drag(400, 240);
    const down = (await sent()).join("");
    expect(down).toContain("\x1b[<65;");
    expect(down).not.toContain("\x1b[<64;");
  });

  test("and the other way is the other button", async () => {
    await clear();
    await drag(240, 400);
    const up = (await sent()).join("");
    expect(up).toContain("\x1b[<64;");
    expect(up).not.toContain("\x1b[<65;");
  });

  test("a tap is not a drag", async () => {
    // Somebody putting a finger down to look at something must not scroll it.
    await clear();
    await cdp!.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 120, y: 300 }] });
    await cdp!.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await Bun.sleep(400);
    expect((await sent()).join("")).not.toContain("\x1b[<6");
  });

  /*
   * ── and the case with nothing listening for a mouse ──────────────────────
   *
   * This is the one that shipped as a blocker, and it is the reason every test
   * above is not enough: they all turn mouse tracking ON first, which is the
   * branch xterm handles safely. A tmux with `mouse off` — the default, and
   * what the machine this was reported from has — leaves xterm answering the
   * wheel itself, and on the alternate screen with no scrollback its answer is
   * a CURSOR KEY. Measured through this document against a real pane running
   * `cat -v`: one 760px drag delivered 53 of them, a mix of ESC[B and ESC O B,
   * while tmux's pane_in_mode stayed 0 and the screen moved a single line.
   *
   * Those arrows are not cosmetic. At a shell they walk history onto the
   * prompt and one stray Enter runs it; in an agent's TUI they move the
   * selection, including on an Allow/Deny gate — which is the thing this app
   * exists to answer from a phone.
   *
   * `?1049h` is the alternate screen, which is the state a tmux attach puts
   * this page in (measured on a real one: alternate_on=1, history_size=0). No
   * mouse mode is turned on, because that is the point.
   */
  const scrolls = async (): Promise<number[]> => cdp!.value<number[]>(`(function () {
    return (window.__agx || []).filter(function (m) { return m.t === 'scroll'; }).map(function (m) { return m.lines; });
  })()`);

  /**
   * A drag, and long enough afterwards for the page to have finished asking.
   *
   * The tmux route paces itself against the pane: one request goes out and the
   * rest of the finger's travel waits until the pane has answered or 220ms have
   * passed, because a request is a `tmux` call plus a whole repaint coming back
   * and a fixed rate is either slower or faster than the link. Nothing answers
   * in this rig, so every request waits the hold out — and `drag`'s own 400ms
   * only covers the first one. Waiting less does not measure a page that is
   * slow, it measures a test that asked too early.
   */
  const dragBack = async (from: number, to: number): Promise<void> => {
    await drag(from, to);
    await Bun.sleep(700);
  };

  /** The state a tmux attach puts this page in, asserted rather than inherited:
   *  the alternate screen, and NO mouse mode — the tests above turn tracking on
   *  and leave it on, and inheriting that would quietly test the other branch. */
  const asTmuxWithMouseOff = async (): Promise<void> => {
    await feed("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049h\x1b[2J\x1b[H");
  };

  test("with no mouse and no scrollback, a drag delivers not one keystroke", async () => {
    await asTmuxWithMouseOff();
    await clear();
    await dragBack(400, 240);
    // The whole assertion, and deliberately about ALL input rather than about
    // arrows: nothing a program can act on may come out of a scroll.
    expect(await sent()).toEqual([]);
  });

  test("it asks for the scrollback to move instead, in lines", async () => {
    await asTmuxWithMouseOff();
    await clear();
    // Finger DOWN the screen is a reach back into history, which is negative.
    await dragBack(240, 400);
    const back = await scrolls();
    expect(back.length).toBeGreaterThan(0);
    expect(back.every((n) => n < 0)).toBe(true);
    expect(await sent()).toEqual([]);
  });

  test("and the other way is forward, toward the present", async () => {
    await asTmuxWithMouseOff();
    await clear();
    await dragBack(400, 240);
    const forward = await scrolls();
    expect(forward.length).toBeGreaterThan(0);
    expect(forward.every((n) => n > 0)).toBe(true);
    expect(await sent()).toEqual([]);
  });

  test("a tap still scrolls nothing at all", async () => {
    await asTmuxWithMouseOff();
    await clear();
    await cdp!.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 120, y: 300 }] });
    await cdp!.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await Bun.sleep(700);
    expect(await scrolls()).toEqual([]);
    expect(await sent()).toEqual([]);
  });

  test("a program that DOES take the mouse keeps the wheel, and asks for nothing", async () => {
    /*
     * The other half of the decision, and the half that must not regress: when
     * something is listening, the encoding stays xterm's and the far end
     * decides what a notch means. tmux with `mouse on` forwards to a program
     * that asked for the mouse and otherwise enters its own copy mode — that
     * policy is its to make, and a page that grabbed the gesture here would be
     * taking it away.
     */
    await feed("\x1b[?1000h\x1b[?1006h");
    await clear();
    await dragBack(240, 400);
    expect(await scrolls()).toEqual([]);
    expect((await sent()).join("")).toContain("\x1b[<64;");
    await feed("\x1b[?1000l\x1b[?1006l");
  });

  test("a pane with its own scrollback is scrolled where it is, and nothing leaves", async () => {
    // Back to the normal buffer, where xterm holds the history itself. Neither
    // route applies: the wheel moves the viewport in the page and the machine
    // is not asked anything.
    await feed("\x1b[?1000l\x1b[?1006l\x1b[?1049l");
    await feed("line\r\n".repeat(200));
    await clear();
    await dragBack(240, 400);
    expect(await scrolls()).toEqual([]);
    expect(await sent()).toEqual([]);
  });
});

/*
 * How far the SCREEN moves for a drag of a known distance.
 *
 * This is the test the feature needed and did not have. The one it had counted
 * the notches that went out and passed while the pane crawled: a thumb dragged
 * most of the way down the phone moved eight lines of a session, because a
 * notch is a request and the PROGRAM decides what it is worth — five lines in
 * tmux's copy mode, one in anything with its own mouse handling.
 *
 * So nothing here asserts an event. A real tmux runs on a private socket with
 * three hundred numbered lines in it, a real client is attached to it on a real
 * pty, and the page is wired to that client both ways: the keystrokes it posts
 * are written into the pty as they happen, and everything the pty says comes
 * back through AGX.write. Then a finger is dragged a measured number of rows
 * and the numbered lines ON THE PAGE are read before and after. The numbering
 * is what makes it exact.
 *
 * The tmux server is its own: TMUX_TMPDIR of its own, a socket inside it, and
 * `-f /dev/null`. Not tidiness — this machine's tmux config loads continuum,
 * which restores the user's real sessions into any server that starts without
 * one, and a test that resizes somebody's working window is not a test.
 */
const HAVE_TMUX = !!Bun.which("tmux");
const HAVE_PY = !!Bun.which("python3");

/** A tmux client on a pty, with its input and its output on this process's
 *  pipes — the two halves the phone's WebSocket carries in the real thing. */
const CLIENT_PY = `
import os, pty, sys, struct, fcntl, termios, threading
sock, rows, cols = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.environ.pop("TMUX", None)
    os.execvp("tmux", ["tmux", "-f", "/dev/null", "-S", sock, "attach", "-t", "probe"])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
def up():
    while True:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
threading.Thread(target=up, daemon=True).start()
while True:
    data = os.read(0, 4096)
    if not data:
        break
    os.write(fd, data)
`;

/*
 * A program with its own mouse handling that scrolls ONE line a notch.
 *
 * That is what an agent's TUI does and it is the case the three-row constant
 * made useless, so it is the case worth pinning. Written out rather than borrowed
 * from less, whose wheel step is a version and a flag away from being something
 * else — the number has to be a fact of the test, not of the machine.
 */
const VIEWER_PY = `
import sys, termios, tty
rows = int(sys.argv[1])
top, total = 0, 300
tty.setraw(sys.stdin.fileno())
sys.stdout.write("\\x1b[?1000h\\x1b[?1006h")
def draw():
    out = ["\\x1b[H\\x1b[2J"]
    for i in range(rows - 1):
        out.append("LINE-%d\\r\\n" % (top + i + 1))
    sys.stdout.write("".join(out))
    sys.stdout.flush()
draw()
buf = ""
while True:
    ch = sys.stdin.read(1)
    if not ch or ch == "q":
        # Handing the mouse back on the way out, which less does and this forgot:
        # tmux keeps forwarding wheels to a pane whose program asked for them, so
        # without this the shell after it swallowed every notch and the pane sat
        # still — which read exactly like the bug this file is about.
        sys.stdout.write("\\x1b[?1006l\\x1b[?1000l")
        sys.stdout.flush()
        break
    buf += ch
    if ch == "M" and "<" in buf:
        try:
            button = int(buf.split("<")[1].split(";")[0])
        except ValueError:
            button = -1
        if button == 64:
            top = max(0, top - 1)
            draw()
        elif button == 65:
            top = min(total - rows, top + 1)
            draw()
        buf = ""
    elif ch in "Mm":
        buf = ""
`;

describe.if(HAVE_CHROME && HAVE_TMUX && HAVE_PY)("how far the pane actually moves", () => {
  let dir = "";
  let sock = "";
  let client: ReturnType<typeof Bun.spawn> | null = null;
  let pumping = true;
  let wire: ReturnType<typeof Bun.serve> | null = null;
  let pane: { send: (data: string) => unknown } | null = null;
  let grid = { cols: 80, rows: 24, cell: 10 };

  /*
   * Never spawnSync, and this one cost an hour.
   *
   * The client's output comes back through a pipe that the pump below drains on
   * the event loop. `Bun.spawnSync` blocks that loop, so the pipe stops being
   * read; a few kilobytes later tmux blocks writing to its client, and a tmux
   * server that is blocked cannot answer the very command being waited on. The
   * run stopped dead with no output and no test timeout — the timeout is on the
   * loop too. Only the unfiltered run hit it, because it takes an earlier test's
   * worth of repaints in the pipe to fill it.
   */
  const tmux = async (...args: string[]): Promise<void> => {
    const env = { ...process.env, TMUX_TMPDIR: dir } as Record<string, string>;
    delete env.TMUX; // tmux refuses to talk to another server from inside one
    const run = Bun.spawn(["tmux", "-f", "/dev/null", "-S", sock, ...args], { env, stdout: "pipe", stderr: "pipe" });
    await run.exited;
  };

  /** The rows as the page is DRAWING them: the DOM renderer writes one div per
   *  row, so this is the screen and not a model of it. */
  const shown = async (): Promise<string[]> => cdp!.value<string[]>(`(function () {
    return Array.prototype.map.call(document.querySelectorAll('.xterm-rows > div'), function (row) {
      return (row.textContent || '').trim();
    });
  })()`);

  /** The first numbered line on screen. The whole measurement is this number
   *  before and after. */
  const firstLine = async (): Promise<number> => {
    for (const row of await shown()) {
      const hit = /LINE-(\d+)/.exec(row);
      if (hit) return Number(hit[1]);
    }
    return -1;
  };

  /**
   * A thumb, at a speed nobody would call a flick, across `rows` rows of the
   * terminal — so the answer is directly comparable to the question.
   *
   * `back` is the finger going DOWN the screen, which drags the content down
   * with it and is therefore a walk backwards through what came before.
   */
  const dragRows = async (rows: number, back: boolean): Promise<void> => {
    const distance = rows * grid.cell;
    const from = back ? 140 : 140 + distance;
    await cdp!.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 120, y: from }] });
    for (let moved = 12; moved <= distance; moved += 12) {
      // 12px every 55ms is 0.22 CSS px/ms, a third of what the page calls a
      // flick — a coast after the finger would be measuring two things.
      await Bun.sleep(55);
      const y = back ? from + moved : from - moved;
      await cdp!.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 120, y }] });
    }
    await cdp!.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await Bun.sleep(600); // the last notches, their round trip, and the repaint
  };

  /** The same distance thrown rather than dragged: the finger leaves the glass
   *  still moving, which is what tells a coast from a stop. */
  const flickRows = async (rows: number): Promise<void> => {
    const distance = rows * grid.cell;
    const from = 140 + distance;
    /*
     * Timestamped, not merely dispatched quickly.
     *
     * The gesture is 24 CSS px every 16ms — 1.5 px/ms, a real flick on a real
     * phone — and it is stamped that way rather than left to whenever these
     * calls happen to arrive, which under a browser and an emulator on the same
     * machine reads as a careful drag and coasts nowhere. The page times the
     * finger by the event's own clock for exactly that reason.
     */
    let at = Date.now() / 1000;
    const step = (type: string, y: number | null) => {
      at += 0.016;
      return cdp!.send("Input.dispatchTouchEvent", {
        type, timestamp: at, touchPoints: y === null ? [] : [{ x: 120, y }],
      });
    };
    await step("touchStart", from);
    for (let moved = 24; moved <= distance; moved += 24) await step("touchMove", from - moved);
    await step("touchEnd", null);
    await Bun.sleep(1600); // the coast is over well inside this
  };

  /** The three hundred, printed again, so the screen sits at the end of them
   *  with the rest in the history behind. */
  const printLines = async (): Promise<void> => {
    await tmux("send-keys", "-t", "probe", "clear; for i in $(seq 1 300); do echo LINE-$i; done", "Enter");
    await Bun.sleep(2500);
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "agx-scroll-"));
    sock = join(dir, "server");
    grid = await cdp!.value<typeof grid>(`(function () {
      var rows = document.querySelectorAll('.xterm-rows > div');
      var box = rows[0] ? rows[0].getBoundingClientRect() : null;
      return { cols: 80, rows: rows.length, cell: box ? box.height : 10 };
    })()`);
    // The session is the page's own geometry, so a wheel reported at row 40 of
    // the page is row 40 of a window that has one — tmux drops a mouse event
    // outside its window and the drag would measure nothing.
    await tmux("new-session", "-d", "-s", "probe", "-x", String(grid.cols), "-y", String(grid.rows), "bash", "--norc", "--noprofile");
    await tmux("set", "-g", "mouse", "on");
    await tmux("set", "-g", "status", "off");
    await tmux("set", "-g", "history-limit", "2000");
    await Bun.write(join(dir, "viewer.py"), VIEWER_PY);
    client = Bun.spawn(["python3", "-c", CLIENT_PY, sock, String(grid.rows), String(grid.cols)], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
    });
    /*
     * The pane and the page, wired both ways over a socket of their own.
     *
     * Not over CDP, and that is measured rather than tidy. Carrying this traffic
     * as Runtime.evaluate calls — one per repaint fragment, plus a poll for the
     * keystrokes — killed the CDP connection partway through the run every time:
     * close 1006 with no close frame, after which every call waits for ever
     * while the same page answers a fresh connection perfectly. Serialising them
     * did not save it either.
     *
     * A socket is also what the real thing has. React Native owns the phone's
     * WebSocket and injects what arrives; here the page opens one to this test
     * and does the same, so the round trip a probe waits on is a socket round
     * trip and not a debugger's.
     */
    wire = Bun.serve({
      port: 0,
      fetch: (req, srv) => (srv.upgrade(req, { data: undefined }) ? undefined : new Response("no", { status: 400 })),
      websocket: {
        open: (ws) => { pane = ws; },
        message: (_ws, msg) => {
          const sink = client!.stdin as { write?: (s: string) => void; flush?: () => void };
          sink.write?.(String(msg));
          sink.flush?.();
        },
      },
    });
    WIRE = wire.port!; // likewise TCP
    await cdp!.value(`(function () {
      var wire = new WebSocket('ws://127.0.0.1:${WIRE}/');
      window.__wire = wire;
      wire.onmessage = function (e) { window.AGX.write(e.data); };
      var rn = window.ReactNativeWebView, real = rn.postMessage.bind(rn);
      rn.postMessage = function (m) {
        var msg = JSON.parse(m);
        if (msg.t === 'in' && wire.readyState === 1) wire.send(msg.d);
        return real(m);
      };
      return 1;
    })()`);
    (async () => {
      const reader = (client!.stdout as ReadableStream<Uint8Array>).getReader();
      while (pumping) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) pane?.send(Buffer.from(value).toString("base64"));
      }
    })();
    await Bun.sleep(1500);
    // Same reason as the outer hook: a tmux server, a websocket and a 1.5s
    // settle share the 5s default with whatever the runner is doing at the
    // time. It is not asserting anything about the clock, so the ceiling only
    // decides whether a slow machine gets to run the tests at all.
  }, 120_000);

  afterAll(async () => {
    pumping = false;
    try { client?.kill(); } catch { /* already gone */ }
    await tmux("kill-server");
    wire?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the pane is on the page, three hundred lines of it", async () => {
    await tmux("send-keys", "-t", "probe", "PS1='$ '", "Enter");
    await printLines();
    // The bottom of the run is on screen, which is where a shell leaves you.
    expect((await shown()).join("\n")).toContain("LINE-300");
  }, SLOW);

  test("a program that scrolls a line a notch still follows the finger", async () => {
    /*
     * The complaint, reproduced and then measured. Before this, a drag of
     * twenty rows against a program like this moved SEVEN lines: one notch per
     * three rows of finger, one line per notch. The band is deliberately wide
     * on both sides — a notch is quantised and the first one of a gesture is
     * spent asking — and it excludes both the old ratio and the naive fix.
     */
    await tmux("send-keys", "-t", "probe", `python3 ${join(dir, "viewer.py")} ${grid.rows}`, "Enter");
    await Bun.sleep(2500);
    const before = await firstLine();
    expect(before).toBe(1);
    await dragRows(20, false);
    const after = await firstLine();
    expect(after - before).toBeGreaterThanOrEqual(14);
    expect(after - before).toBeLessThanOrEqual(30);
  }, SLOW);

  test("a flick carries on after the finger, a drag stops with it", async () => {
    /*
     * The same twenty rows, thrown instead of dragged, and the pane goes
     * further than the finger did. Measured on the phone against less: 800px in
     * 1200ms moved 29 lines for 29 rows of finger, the same 800px in 150ms
     * moved 48 — the coast is the difference, and it is bounded at two screens
     * so a hard throw cannot run away down a wire.
     */
    const before = await firstLine();
    await flickRows(20);
    const after = await firstLine();
    expect(after - before).toBeGreaterThan(28);
    expect(after - before).toBeLessThan(110); // the cap, plus the drag itself
  }, SLOW);

  test("and tmux's own copy mode, which moves five lines a notch, does too", async () => {
    /*
     * The other half of why a constant cannot work. Same page, same finger,
     * same distance — and five times the answer per notch, because here it is
     * tmux scrolling its history and not a program reading a button. A page
     * that emitted one notch per row would fly a hundred lines up this pane.
     *
     * The first notch is spent entering copy mode and moves nothing, which is
     * why the page probes again when a probe measures nothing at all.
     */
    await cdp!.value(`window.AGX.send('q'), 1`); // out of the viewer, back to the shell
    await Bun.sleep(1500);
    await printLines();
    const before = await firstLine();
    expect(before).toBeGreaterThan(200); // the tail of the three hundred
    await dragRows(20, true);
    const after = await firstLine();
    expect(before - after).toBeGreaterThanOrEqual(12);
    expect(before - after).toBeLessThanOrEqual(32);
  }, SLOW);
});

/*
 * Which of the two colour sets the page ends up wearing, and why it is measured
 * rather than chosen.
 *
 * The phone's mode paints the pane — that is the whole point of a Light phone
 * having a light terminal — but the pane is not always painted on the phone's
 * background. agentglass syncs the desk's theme into the user's tmux and that
 * conf carries `window-style "bg=<the desk's background>"`; measured against a
 * real tmux with a real client on a pty, every cell then arrives carrying
 * ESC[48;2;30;30;30m, for xterm-256color, tmux-256color and xterm-direct alike.
 * A phone in Light against that painted #1f2328 text on #1e1e1e and the words at
 * the top of a session disappeared, which is why the pane was pinned to dark and
 * stopped following the phone at all.
 *
 * So the page reads the background out of its own buffer and wears the set that
 * is legible on it. Nothing here asks the page what it thinks: the foreground is
 * read back off the DOM with getComputedStyle, because what a row is painted
 * with is the only thing a reader actually gets.
 *
 * This block is last in the file on purpose — it paints the whole screen and
 * changes the theme, and the rigs above want a pane they put there themselves.
 */
describe.if(HAVE_CHROME)("which colours the pane ends up wearing", () => {
  const DARK_FG = "rgb(230, 237, 243)"; // the dark base's #e6edf3
  const LIGHT_FG = "rgb(31, 35, 40)";   // the light base's #1f2328
  const DESK_BG = "rgb(30, 30, 30)";    // what this machine's synced tmux paints

  /** What a row is actually painted with, and what the frame around the grid
   *  is. Both come off the document rather than out of the page's own state. */
  const worn = async (): Promise<{ fg: string; frame: string }> => {
    await Bun.sleep(700); // longer than the page's 400ms settle after bytes
    return cdp!.value<{ fg: string; frame: string }>(`(function () {
      var row = document.querySelector('.xterm-rows > div');
      return { fg: row ? getComputedStyle(row).color : '', frame: document.body.style.background };
    })()`);
  };

  /*
   * `rows` rows of text, every cell carrying an explicit background — which is
   * exactly what a tmux with window-style set sends.
   *
   * The SGR reset in front is load-bearing and cost a red test: an erase paints
   * with the CURRENT background, so clearing while the previous case's
   * ESC[48;2;30;30;30m is still in effect fills the whole screen with the
   * previous case's colour, and the thirty rows written after it lose the vote
   * to the thirty-four rows of leftover the clear just laid down.
   */
  const paintedPane = (rows: number, bg: string): string =>
    `\x1b[0m\x1b[2J\x1b[H\x1b[48;2;${bg}m${Array.from({ length: rows }, (_, i) => `line ${i} of a pane painting its own background`.padEnd(80)).join("")}`;

  test("the phone's mode reaches a pane that paints nothing", async () => {
    // A plain pty, or a tmux with no theme synced into it: the background is
    // ours to choose, and Light means light. This is the report — "I asked for
    // a light terminal and it is still dark" — as an assertion.
    await feed("\x1b[0m\x1b[2J\x1b[Hnothing here paints a background\r\n");
    await cdp!.value(`window.AGX.theme(${JSON.stringify(terminalTheme(paletteFor("light", "blue")))}), 1`);
    const light = await worn();
    expect(light.fg).toBe(LIGHT_FG);
    expect(light.frame).toBe("rgb(255, 255, 255)");

    await cdp!.value(`window.AGX.theme(${JSON.stringify(terminalTheme(paletteFor("dark", "blue")))}), 1`);
    const dark = await worn();
    expect(dark.fg).toBe(DARK_FG);
  });

  test("a pane that paints a dark background gets the dark set, in Light", async () => {
    /*
     * The refusal that pinned the pane, undone. The phone stays in Light — its
     * chrome, its keys and its composer are light — and the terminal wears the
     * colours that read on what the machine is painting, down to taking the
     * machine's own #1e1e1e for the frame so the edges match the cells.
     */
    await cdp!.value(`window.AGX.theme(${JSON.stringify(terminalTheme(paletteFor("light", "blue")))}), 1`);
    await feed(paintedPane(30, "30;30;30"));
    const out = await worn();
    expect(out.fg).toBe(DARK_FG);
    expect(out.frame).toBe(DESK_BG);
  });

  test("and a pane shorter than the phone's grid still decides it", async () => {
    /*
     * The vote's real test. A phone grid is taller than the desk's window
     * whenever the desk's terminal is shorter — measured here at 64 rows of
     * page against 24 of pane — and counting the empty rows below the pane as
     * "no background" loses the vote 37% to 63% and keeps the wrong set. Empty
     * cells abstain for exactly this.
     */
    const rows = await cdp!.value<number>(`document.querySelectorAll('.xterm-rows > div').length`);
    expect(rows).toBeGreaterThan(30);
    await cdp!.value(`window.AGX.theme(${JSON.stringify(terminalTheme(paletteFor("light", "blue")))}), 1`);
    await feed(paintedPane(12, "30;30;30"));
    expect((await worn()).fg).toBe(DARK_FG);
  });

  test("a light desk under a dark phone is the same rule the other way", async () => {
    // Nothing here is about dark being safe: it is about matching what arrives.
    await cdp!.value(`window.AGX.theme(${JSON.stringify(terminalTheme(paletteFor("dark", "blue")))}), 1`);
    await feed(paintedPane(30, "255;255;255"));
    const out = await worn();
    expect(out.fg).toBe(LIGHT_FG);
    expect(out.frame).toBe("rgb(255, 255, 255)");
  });
});
