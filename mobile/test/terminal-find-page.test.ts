/*
 * The two things the page does for search and copy, in a real browser engine.
 *
 * The decisions are tested as data (terminal-find.test.ts, terminal-select
 * .test.ts), and they are half of the feature. The other half is the half the
 * plan says a pure test proves nothing about: what the page hands up when it is
 * asked for its buffer, whether a marked line becomes a box over the grid, and
 * whether a tap in select mode names a line instead of opening the keyboard.
 *
 * So the document is loaded into headless Chrome, fed the bytes a pane would
 * send, and asked. Skipped where there is no Chrome: a stub would be testing
 * the stub.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { announce, built } from "./generated-artifacts.ts";
import { C } from "../src/theme.ts";

announce("terminal-find-page.test.ts");

const { terminalDocument } = built
  ? await import("../src/terminal/terminal-html.ts")
  : {
      terminalDocument: (() => "") as unknown as typeof import("../src/terminal/terminal-html.ts")["terminalDocument"],
    };

const CHROME = [
  process.env.CHROME,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/pw-browsers/chromium/chrome-linux/chrome",
].filter((p): p is string => !!p)
  .find((p) => Bun.file(p).size !== 0 || Bun.which(p));
const HAVE_CHROME = !!CHROME && built;

/** One page, one call at a time, with the same revival as pane-line.test.ts:
 *  this CDP socket does not survive a long run and a close is not a failure. */
class Cdp {
  private next = 1;
  private waiting = new Map<number, (value: unknown) => void>();
  private dead = false;
  private turn: Promise<unknown> = Promise.resolve();
  constructor(private ws: WebSocket) { this.wire(ws); }
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
      for (const [id, resolve] of this.waiting) { this.waiting.delete(id); resolve(undefined); }
    };
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      if (this.dead) return undefined;
      const id = this.next++;
      return new Promise((resolve) => {
        this.waiting.set(id, resolve);
        this.ws.send(JSON.stringify({ id, method, params }));
      });
    };
    this.turn = this.turn.then(run, run);
    return this.turn;
  }
  async value<T>(expression: string): Promise<T> {
    const answer = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return (answer as { result?: { value?: T } }).result?.value as T;
  }
  close(): void { try { this.ws.close(); } catch { /* already gone */ } }
}

let CDP = 0;
let PORT = 0;
let chrome: ReturnType<typeof Bun.spawn> | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;
let cdp: Cdp | null = null;
let profile = "";

/** Bytes as the pane would send them, base64 the way the socket delivers them. */
const feed = async (bytes: string): Promise<void> => {
  const b64 = Buffer.from(bytes, "utf8").toString("base64");
  await cdp!.value(`window.AGX.write(${JSON.stringify(b64)}), 1`);
};

/** The last frame of a given type the page posted, or undefined. */
const lastOf = async <T>(type: string): Promise<T | undefined> => cdp!.value<T | undefined>(
  `(function () {
    var seen = (window.__agx || []).filter(function (m) { return m.t === ${JSON.stringify(type)}; });
    return seen.length ? seen[seen.length - 1] : undefined;
  })()`);

/** How many boxes the page painted over the grid, and how many are strong. */
const painted = async (): Promise<{ boxes: number; strong: number }> => cdp!.value(
  `(function () {
    var layer = document.getElementById('agx-paint');
    if (!layer) return { boxes: 0, strong: 0 };
    var all = layer.querySelectorAll('div');
    var strong = 0;
    for (var i = 0; i < all.length; i++) {
      if ((all[i].getAttribute('style') || '').indexOf('box-shadow') >= 0) strong++;
    }
    return { boxes: all.length, strong: strong };
  })()`);

/** The grid's row height, so a tap can be aimed at a row. */
const cellHeight = async (): Promise<number> =>
  (await cdp!.value<{ cell: number }>(`window.AGX.metrics()`)).cell;

beforeAll(async () => {
  if (!HAVE_CHROME) return;
  const html = terminalDocument({ palette: C, columns: 80 });
  server = Bun.serve({
    port: 0,
    fetch: () => new Response(html, { headers: { "content-type": "text/html" } }),
  });
  PORT = server.port!;
  profile = mkdtempSync(join(tmpdir(), "agx-find-"));
  chrome = Bun.spawn([
    CHROME!, "--headless=new", "--disable-gpu", "--no-first-run", "--no-sandbox",
    `--user-data-dir=${profile}`, "--window-size=412,915",
    "--remote-debugging-port=0", "about:blank",
  ], { stdout: "ignore", stderr: "ignore" });

  let target = "";
  for (let i = 0; i < 240 && !target; i++) {
    await Bun.sleep(250);
    if (chrome.exitCode !== null) break;
    try {
      CDP = CDP || Number((await Bun.file(join(profile, "DevToolsActivePort")).text()).split("\n")[0]);
      if (!CDP) continue;
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json() as
        { type: string; webSocketDebuggerUrl?: string }[];
      target = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "";
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error(`Chrome never exposed a debuggable page (port: ${CDP || "never reported"})`);

  const socket = new WebSocket(target);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("no cdp"));
  });
  cdp = new Cdp(socket);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__agx = [];
      window.ReactNativeWebView = { postMessage: function (m) { window.__agx.push(JSON.parse(m)); } };`,
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });

  let ready = false;
  for (let i = 0; i < 240 && !ready; i++) {
    await Bun.sleep(250);
    ready = await cdp.value<boolean>(`!!(window.AGX && (window.__agx || []).some(function (m) { return m.t === 'ready'; }))`);
  }
  if (!ready) throw new Error("the terminal page never said it was ready within 60s");
}, 120_000);

afterAll(async () => {
  cdp?.close();
  chrome?.kill();
  await chrome?.exited;
  server?.stop(true);
  if (profile) rmSync(profile, { recursive: true, force: true });
});

describe.if(HAVE_CHROME)("the scrollback, as the page hands it up", () => {
  test("every line it holds, oldest first, in one message", async () => {
    await feed("\u001b[2J\u001b[H$ bun test\r\n✓ rail.test.ts 14 passed\r\n$ ");
    await cdp!.value("window.AGX.scrollback(), 1");
    const back = await lastOf<{ lines: string[] }>("back");
    expect(back).toBeDefined();
    const lines = back!.lines;
    // The prompt, the two lines, and the empty cursor row: the buffer is the
    // screen plus whatever history it keeps, and the COUNT is what the sheet
    // reports.
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[0]).toContain("bun test");
    expect(lines[1]).toContain("rail.test.ts 14 passed");
    // Trailing padding is trimmed by the page, so a search does not have to
    // know about the pane's width.
    expect(lines[1]).toBe("✓ rail.test.ts 14 passed");
  });

  test("a pane that has printed nothing answers with blank lines, not with silence", async () => {
    // `2J` clears the screen and `3J` the saved lines behind it — what a program
    // does when it takes the screen over. The buffer still has rows; they are
    // empty, which is an answer and not a refusal.
    await feed("\u001b[2J\u001b[3J\u001b[H");
    await cdp!.value("window.AGX.scrollback(), 1");
    const back = await lastOf<{ lines: string[] }>("back");
    expect(back).toBeDefined();
    expect(back!.lines.every((l) => l === "")).toBe(true);
  });
});

describe.if(HAVE_CHROME)("painting the lines a search found", () => {
  test("marks become boxes over the grid, and the one it stands on is strong", async () => {
    await feed("\u001b[2J\u001b[H$ one\r\n$ two\r\n$ three\r\n$ ");
    await cdp!.value("window.AGX.marks([0, 2], 0), 1");
    const box = await painted();
    // Two marks on screen; the current one carries the accent bar.
    expect(box.boxes).toBeGreaterThanOrEqual(2);
    expect(box.strong).toBe(1);
  });

  test("an empty list takes them all away again", async () => {
    await cdp!.value("window.AGX.marks([], -1), 1");
    expect((await painted()).boxes).toBe(0);
  });

  test("goto moves the viewport without painting anything", async () => {
    // Two hundred lines, so line 0 is history rather than the first row on
    // screen. `AGX.screen()` is what the page is actually drawing.
    const many = Array.from({ length: 200 }, (_, i) => `L${i}\r\n`).join("");
    await feed(`\u001b[2J\u001b[H${many}$ `);
    await cdp!.value("window.AGX.goto(0), 1");
    const top = await cdp!.value<string[]>(`window.AGX.screen().map(function (r) { return r.trim(); })`);
    expect(top[0]).toBe("L0");
    expect((await painted()).boxes).toBe(0);
  });
});

describe.if(HAVE_CHROME)("select mode, and what a tap means in it", () => {
  test("a tap on a row names that line instead of the keyboard", async () => {
    await feed("\u001b[2J\u001b[H$ one\r\n$ two\r\n$ ");
    await cdp!.value("window.AGX.select(true), 1");
    // The third row of the grid, measured rather than guessed: one cell is
    // whatever the page's font came out at.
    const cell = await cellHeight();
    const before = ((await cdp!.value<unknown[]>(`(window.__agx = []), []`)) ?? []).length;
    expect(before).toBe(0);
    const y = Math.round(cell * 2 + cell / 2);
    await cdp!.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 120, y }] });
    await cdp!.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await Bun.sleep(200);
    const pick = await lastOf<{ line: number }>("pick");
    expect(pick).toBeDefined();
    expect(pick!.line).toBeGreaterThanOrEqual(0);
    // And no `tap`, which is what opens the keyboard.
    expect(await lastOf("tap")).toBeUndefined();
  });

  test("the picked line is painted, and let go again", async () => {
    const pick = await lastOf<{ line: number }>("pick");
    const line = pick!.line;
    await cdp!.value(`window.AGX.picks([${line}]), 1`);
    const on = await painted();
    expect(on.boxes).toBe(1);
    expect(on.strong).toBe(1);
    await cdp!.value("window.AGX.picks([]), 1");
    expect((await painted()).boxes).toBe(0);
  });

  test("out of select mode, the same tap is a keyboard tap again", async () => {
    await cdp!.value("window.AGX.select(false), 1");
    await cdp!.value("(window.__agx = []), 1");
    const cell = await cellHeight();
    const y = Math.round(cell * 2 + cell / 2);
    await cdp!.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 120, y }] });
    await cdp!.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await Bun.sleep(200);
    expect(await lastOf("tap")).toBeDefined();
    expect(await lastOf("pick")).toBeUndefined();
  });
});
