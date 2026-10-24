import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";

/*
 * Action buttons on a macOS notification, the half that lives in the shell.
 * UNTESTED ON A REAL MAC: nothing here draws a button, it drives the module
 * with a stand-in for Electron's Notification and reads the shell's source.
 */
const req = createRequire(import.meta.url);
const mac = req("../../electron/notify-mac.js") as {
  sanitize: (r: unknown) => null | { title: string; body: string; urgent: boolean; tag: string; labels: string[]; closeAfterMs: number };
  indexOf: (count: number, ev: unknown) => number | null;
  raise: (N: unknown, r: unknown, onPress: (i: number) => void) => unknown;
};
const MAIN = await Bun.file(new URL("../../electron/main.js", import.meta.url)).text();
const PRELOAD = await Bun.file(new URL("../../electron/preload.js", import.meta.url)).text();

/** The three things the real class does that matter here: remembers its options, emits, closes. */
class FakeNotification {
  static last: FakeNotification | null = null;
  handlers = new Map<string, (...a: unknown[]) => void>();
  shown = false; closed = false;
  constructor(public opts: Record<string, unknown>) { FakeNotification.last = this; }
  on(ev: string, fn: (...a: unknown[]) => void) { this.handlers.set(ev, fn); return this; }
  show() { this.shown = true; }
  close() { this.closed = true; this.handlers.get("close")?.(); }
  emit(ev: string, ...a: unknown[]) { this.handlers.get(ev)?.({}, ...a); }
}

const ask = { title: "CI failed · acme/orbit #1042", body: "build", urgent: true, tag: "pr-watch-7", labels: ["Open checks", "Open PR"], closeAfterMs: 60_000 };

describe("sanitize", () => {
  it("keeps a well-formed request", () => {
    expect(mac.sanitize(ask)).toEqual(ask);
  });
  it("shows nothing without a title or without a button", () => {
    expect(mac.sanitize({ ...ask, title: "" })).toBeNull();
    expect(mac.sanitize({ ...ask, labels: [] })).toBeNull();
    expect(mac.sanitize({ ...ask, labels: [7, "", null] })).toBeNull();
    expect(mac.sanitize(null)).toBeNull();
    expect(mac.sanitize("x")).toBeNull();
  });
  it("two buttons at most, text bounded, close timer bounded", () => {
    const r = mac.sanitize({ ...ask, labels: ["a", "b", "c"], title: "t".repeat(500), closeAfterMs: 1e12 })!;
    expect(r.labels).toEqual(["a", "b"]);
    expect(r.title.length).toBe(200);
    expect(r.closeAfterMs).toBe(120_000);
    expect(mac.sanitize({ ...ask, closeAfterMs: -5 })!.closeAfterMs).toBe(0);
  });
  it("urgent only when exactly true", () => {
    expect(mac.sanitize({ ...ask, urgent: "yes" })!.urgent).toBe(false);
  });
});

describe("indexOf", () => {
  it("the body is the primary, a button is its own index", () => {
    expect(mac.indexOf(2, { kind: "click" })).toBe(0);
    expect(mac.indexOf(2, { kind: "action", index: 1 })).toBe(1);
  });
  it("anything out of range or malformed is no press", () => {
    for (const ev of [{ kind: "action", index: 2 }, { kind: "action", index: -1 }, { kind: "action", index: 0.5 },
      { kind: "action", index: "0" }, { kind: "action" }, { kind: "other" }, null, 3]) {
      expect(mac.indexOf(2, ev)).toBeNull();
    }
  });
});

describe("raise", () => {
  it("builds the buttons from the labels and shows it", () => {
    mac.raise(FakeNotification, ask, () => {});
    const n = FakeNotification.last!;
    expect(n.shown).toBe(true);
    expect(n.opts.actions).toEqual([{ type: "button", text: "Open checks" }, { type: "button", text: "Open PR" }]);
    expect(n.opts.urgency).toBe("critical");
  });
  it("a click presses 0, a button presses its index, and only once", () => {
    const got: number[] = [];
    mac.raise(FakeNotification, ask, (i) => got.push(i));
    FakeNotification.last!.emit("action", 1);
    FakeNotification.last!.emit("click");
    expect(got).toEqual([1]);
    const again: number[] = [];
    mac.raise(FakeNotification, ask, (i) => again.push(i));
    FakeNotification.last!.emit("click");
    expect(again).toEqual([0]);
  });
  it("a button index that was never offered presses nothing", () => {
    const got: number[] = [];
    mac.raise(FakeNotification, ask, (i) => got.push(i));
    FakeNotification.last!.emit("action", 5);
    expect(got).toEqual([]);
  });
  it("an empty request raises nothing", () => {
    FakeNotification.last = null;
    expect(mac.raise(FakeNotification, { title: "" }, () => {})).toBeNull();
    expect(FakeNotification.last).toBeNull();
  });
});

describe("the shell wiring", () => {
  const handler = (() => {
    const start = MAIN.indexOf('ipcMain.handle("ag:notify"');
    return MAIN.slice(start, MAIN.indexOf("\n  });\n", start));
  })();
  it("answers only the app's own window", () => {
    expect(handler).toContain("e.sender !== win.webContents");
  });
  it("refuses everywhere but macOS, so Linux and Windows keep the renderer's popup", () => {
    expect(handler).toMatch(/process\.platform !== "darwin"[^\n]*return \{ ok: false \}/);
  });
  it("lifts the window before it tells the renderer which entry was pressed", () => {
    expect(handler.indexOf("win.show()")).toBeGreaterThan(-1);
    expect(handler.indexOf("win.show()")).toBeLessThan(handler.indexOf('"ag:notifyPress"'));
  });
  it("raises no other notification from the main process", () => {
    expect(MAIN.match(/new Notification\(/g)).toBeNull();
    expect(MAIN.match(/notifyMac\.raise\(/g)?.length).toBe(1);
  });
  it("the preload exposes the pair the renderer checks for", () => {
    expect(PRELOAD).toContain('ipcRenderer.invoke("ag:notify"');
    expect(PRELOAD).toContain('ipcRenderer.on("ag:notifyPress"');
  });
});
