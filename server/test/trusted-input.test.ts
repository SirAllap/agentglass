/*
 * What the shell sends a page for a click, a key or text
 * (electron/trusted-input.js). The events themselves are proven against a
 * page that believes only `isTrusted` by scripts/trusted-input.ts; this pins
 * the translation, which is where a zoom or a modifier goes wrong.
 */
import { describe, expect, test } from "bun:test";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { inputEvents, sendInput, isAgentInput } = require("../../electron/trusted-input.js") as {
  isAgentInput: (guest: object) => boolean;
  inputEvents: (req: Record<string, unknown>, zoom: number) => { ok: boolean; events?: Array<Record<string, unknown>>; error?: string };
  sendInput: (guest: unknown, req: Record<string, unknown>) => { ok: boolean; sent?: number; error?: string };
};
const MAIN = await Bun.file(new URL("../../electron/main.js", import.meta.url)).text();

const events = (req: Record<string, unknown>, zoom = 1) => {
  const r = inputEvents(req, zoom);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r.events!;
};

describe("pointer", () => {
  test("a point in CSS pixels is sent in DIPs: at zoom 1.5 the page would get two thirds of it", () => {
    const down = events({ op: "click", x: 100, y: 50 }, 1.5).find((e) => e.type === "mouseDown")!;
    expect([down.x, down.y]).toEqual([150, 75]);
  });

  test("a click is a move, a press and a release; a double click presses twice, counting", () => {
    expect(events({ op: "click", x: 1, y: 1 }).map((e) => e.type)).toEqual(["mouseMove", "mouseDown", "mouseUp"]);
    expect(events({ op: "dblclick", x: 1, y: 1 }).filter((e) => e.type === "mouseDown").map((e) => e.clickCount)).toEqual([1, 2]);
    expect(events({ op: "hover", x: 1, y: 1 }).map((e) => e.type)).toEqual(["mouseMove"]);
  });

  test("no point is refused, not sent to the corner", () => {
    expect(inputEvents({ op: "click" }, 1).ok).toBe(false);
  });
});

describe("keys", () => {
  test("a shortcut carries its modifiers and inserts nothing", () => {
    const ev = events({ op: "key", key: "Control+a" });
    expect(ev.map((e) => e.type)).toEqual(["keyDown", "keyUp"]);
    expect(ev[0]!.modifiers).toEqual(["control"]);
  });

  test("a printable key and Enter insert; Backspace does not", () => {
    expect(events({ op: "key", key: "a" }).map((e) => e.type)).toEqual(["keyDown", "char", "keyUp"]);
    expect(events({ op: "key", key: "Enter" }).map((e) => e.type)).toEqual(["keyDown", "char", "keyUp"]);
    expect(events({ op: "key", key: "Backspace" }).map((e) => e.type)).toEqual(["keyDown", "keyUp"]);
  });

  test("DOM key names become the shell's, and Control++ is the plus key", () => {
    expect(events({ op: "key", key: "ArrowUp" })[0]!.keyCode).toBe("Up");
    expect(events({ op: "key", key: "Control++" })[0]).toMatchObject({ keyCode: "+", modifiers: ["control"] });
  });

  test("a modifier nobody has is refused", () => {
    expect(inputEvents({ op: "key", key: "Hyper+a" }, 1).error).toContain("Hyper");
  });
});

describe("text", () => {
  test("an upper-case letter is typed with Shift, a letter outside ASCII by its char alone, a newline as Enter", () => {
    const ev = events({ op: "text", text: "Hé\n" });
    expect(ev.slice(0, 3).map((e) => [e.type, e.keyCode, e.modifiers])).toEqual([
      ["keyDown", "H", ["shift"]], ["char", "H", ["shift"]], ["keyUp", "H", ["shift"]],
    ]);
    expect(ev.slice(3, 5).map((e) => [e.type, e.keyCode])).toEqual([["char", "é"], ["keyUp", "é"]]);
    expect(ev.slice(5).map((e) => e.keyCode)).toEqual(["Enter", "Enter", "Enter"]);
  });

  test("every character ends in one keyUp, which is what the page-side counter waits for", () => {
    expect(events({ op: "text", text: "a😀b" }).filter((e) => e.type === "keyUp")).toHaveLength(3);
  });
});

describe("sending", () => {
  const guest = () => {
    const sent: unknown[] = [];
    return { sent, getZoomFactor: () => 1, sendInputEvent: (e: unknown) => { sent.push(e); } };
  };

  test("a bad request sends nothing at all", () => {
    const g = guest();
    expect(sendInput(g, { op: "text", text: "x".repeat(10_001) }).ok).toBe(false);
    expect(sendInput(g, { op: "nope" }).ok).toBe(false);
    expect(g.sent).toEqual([]);
  });

  test("a good one sends every event to the guest it was handed", () => {
    const g = guest();
    expect(sendInput(g, { op: "key", key: "Tab" })).toEqual({ ok: true, sent: 2 });
    expect(g.sent).toHaveLength(2);
  });

  test("the shell takes input only for a tab it knows, like the DevTools relay", () => {
    const a = MAIN.indexOf('ipcMain.handle("ag:browserInput"');
    expect(a).toBeGreaterThan(-1);
    const h = MAIN.slice(a, MAIN.indexOf("\n  });\n", a));
    expect(h).toContain("browserGuestById(wanted)");
    expect(h).toContain("that tab is not a browser pane in this window");
    expect(h).toContain("sendInput(guest, req)");
    expect(h).toContain("_e.sender !== win.webContents && !isLaneHost(_e.sender)");
  });

  /* The guest's key handler runs inside sendInputEvent, so the mark is what
     tells it the key is an agent's: held for every event, gone after. */
  test("the guest is marked as receiving an agent's input while, and only while, it is sent", () => {
    const seen: boolean[] = [];
    const g = { getZoomFactor: () => 1, sendInputEvent: () => { seen.push(isAgentInput(g)); } };
    sendInput(g, { op: "key", key: "Control+w" });
    expect(seen).toEqual([true, true]);
    expect(isAgentInput(g)).toBe(false);
    const boom = { getZoomFactor: () => 1, sendInputEvent: () => { throw new Error("gone"); } };
    expect(() => sendInput(boom, { op: "key", key: "a" })).toThrow("gone");
    expect(isAgentInput(boom)).toBe(false);
  });

  test("an agent's key leaves the guest's handler before any chord is forwarded to the app", () => {
    const a = MAIN.indexOf('guest.on("before-input-event", (event, input) => {');
    expect(a).toBeGreaterThan(-1);
    const h = MAIN.slice(a, MAIN.indexOf("\n    });\n", a)).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const mark = h.indexOf("if (isAgentInput(guest)) return;");
    expect(mark).toBeGreaterThan(-1);
    for (const later of ["preventDefault()", "ag:browser-key", "webContents.focus()", "applyZoom("]) {
      expect(h.indexOf(later), later).toBeGreaterThan(mark);
    }
  });
});
