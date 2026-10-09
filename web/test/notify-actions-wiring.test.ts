import { describe, expect, it } from "bun:test";
import { askedState, askedTimeline } from "../src/lib/askedAudit.ts";
import { watchPayload, type AskedAlert } from "../../shared/notifyPayload.ts";

/*
 * Where a notification press lands, as rules about source: there is no
 * renderer, so the click handlers are asserted against the text of the files
 * that hold them, sliced to each function's own closing brace.
 */
const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
const notify = await read("../src/lib/sysNotify.ts");
const app = await read("../src/App.tsx");
const live = await read("../src/lib/useLive.ts");
const toasts = await read("../src/components/NoteToasts.tsx");
const lane = await read("../src/components/TopBarNotes.tsx");
const main = await read("../../electron/main.js");
const preload = await read("../../electron/preload.js");
const strip = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

function body(text: string, header: string): string {
  const i = text.indexOf(header);
  expect(i).toBeGreaterThan(-1);
  let depth = 0;
  for (let j = text.indexOf(") {\n", i) + 2; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}" && --depth === 0) return text.slice(i, j + 1);
  }
  throw new Error("unbalanced");
}

describe("pressing the OS notification", () => {
  const p = strip(body(notify, "function popup("));
  it("raises the window through the shell, then routes in the app, then closes", () => {
    const click = p.slice(p.indexOf("n.onclick"));
    expect(click.indexOf("raiseWindow()")).toBeGreaterThan(-1);
    expect(click.indexOf("raiseWindow()")).toBeLessThan(click.indexOf("goto?.(dest)"));
    expect(click.indexOf("goto?.(dest)")).toBeLessThan(click.indexOf("n.close()"));
  });
  it("never opens the external browser from a notification", () => {
    expect(p).not.toContain("window.open");
    expect(p).not.toContain("openExternal");
  });
  it("says why it could not be shown instead of returning silently", () => {
    expect(p).toContain("a.onFail?.(");
    expect(p.match(/onFail\?\./g)!.length).toBeGreaterThanOrEqual(3); // no API, no permission, a throw
    expect(strip(body(notify, "export function fireWatchAlert("))).toContain("api.askedOsFailed(");
  });
  it("a popup that fails reports against the server's alert; the banner is the server's frame, not this popup's", () => {
    const f = strip(body(notify, "export function fireWatchAlert("));
    expect(f).toContain("f.alertId");
    expect(f).not.toContain("showAsked");
  });
});

describe("the shell", () => {
  it("raiseWindow is wired preload to main, answered only for the app's own window", () => {
    expect(preload).toContain('raiseWindow: () => ipcRenderer.invoke("ag:raiseWindow")');
    const h = main.slice(main.indexOf('ipcMain.handle("ag:raiseWindow"'));
    const handler = h.slice(0, h.indexOf("});") + 3);
    expect(handler).toContain("e.sender !== win.webContents");
    expect(handler).toMatch(/restore\(\)[\s\S]*show\(\)[\s\S]*focus\(\)/);
  });
});

describe("the router", () => {
  it("takes a file to Files, scoped to its checkout and the folder it is in", () => {
    const g = body(app, "const goFromNote = useCallback(async (g");
    expect(g).toContain('g.kind === "file"');
    expect(g).toContain("requestFilesReveal(g.root,");
    expect(g).toContain('goView("files")');
  });
  it("the bell, the toast and the popup share one resolver", () => {
    expect(app).toContain("setAlertGoto(goFromNote)");
    expect(app).toContain("<NoteToasts onGoto={goFromNote} />");
  });
});

describe("the toast card", () => {
  it("has a real button for its destination, and acting takes the card down", () => {
    expect(toasts).toContain("GO_LABEL[n.goto.kind]");
    const go = toasts.slice(toasts.indexOf("const go ="), toasts.indexOf("const go =") + 120);
    expect(go).toContain("onGone(); onGoto(n.goto!)");
  });
});

describe("the bar's caption lane", () => {
  it("no longer carries what the person asked for: that is a banner that waits", () => {
    expect(strip(lane)).not.toContain("subscribeAskedFires");
  });
});

describe("what arrives while the window is open or closed", () => {
  it("both frames and the restore on every (re)connect are handled", () => {
    expect(live).toContain('frame.type === "askedalert"');
    expect(live).toContain('frame.type === "askedclosed"');
    expect(body(live, 'if (frame.type === "initial") {')).toContain("restoreAsked()");
  });
});

describe("the audit", () => {
  const base: AskedAlert = {
    id: "a", key: "k", ok: true, payload: watchPayload({ repo: "acme/orbit", number: 1, title: "t", summary: "CI passed", detail: "" }),
    firedAt: 1_000_000, seenAt: null, actedAt: null, closedAt: null, osError: null,
  };
  it("waiting, opened and closed are told apart", () => {
    expect(askedState(base)).toBe("waiting");
    expect(askedState({ ...base, closedAt: 2, actedAt: 2 })).toBe("opened");
    expect(askedState({ ...base, closedAt: 2 })).toBe("closed");
  });
  it("the timeline names only the steps that happened", () => {
    expect(askedTimeline(base)).toMatch(/^fired [^·]+$/);
    expect(askedTimeline({ ...base, seenAt: 1_000_500, actedAt: 1_060_000, closedAt: 1_060_000 })).toMatch(/fired .* · seen .* · opened /);
  });
});
