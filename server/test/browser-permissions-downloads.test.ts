/*
 * What a page in the built-in browser may ask the machine for, and where a
 * download may land.
 *
 * Measured before the fix: no permission handler existed on any browsing
 * session, so Electron's default applied and a page's request for the camera,
 * the microphone, the clipboard and notifications was granted with no prompt.
 * Downloads had a second hole: the directory an agent armed for one download
 * stayed armed for the whole profile, so a later download from any page landed
 * there under the page's chosen name, over whatever was already in the file.
 *
 * The decisions live in electron/guest-guard.js, which requires nothing, so
 * they are asserted there. What main.js does with them is a rule about source.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const guard = require("../../electron/guest-guard.js") as {
  permissionAllowed: (permission: unknown) => boolean;
  uniqueSavePath: (dir: string, name: string, exists: (p: string) => boolean) => string;
  permissionVerdict: (
    permission: unknown,
    ctx: { frontTab?: boolean; lane?: boolean; person?: boolean; mediaTypes?: unknown },
  ) => { verdict: "allow" | "deny" | "ask" | "hold"; what?: string; needs?: string[] };
  permissionPrompt: (what: string, origin: string) => string;
  holderAfter: (current: "person" | "agent" | undefined, event: object) => "person" | "agent" | undefined;
  createPermissionDesk: (opts?: {
    timeoutMs?: number; now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void;
  }) => Desk;
  pendingPermissionNote: (p: { what: string; origin: string; deniedInMs: number }) => string;
};
type Desk = {
  hold: (guest: number, store: object, origin: string, needs: string[], done: (ok: boolean) => void) => void;
  allowed: (store: object, origin: string, needs: string[]) => boolean;
  answer: (guest: number, store: object, what: string[], allow: boolean, origin?: string) =>
    { error: string } | { answered: string[]; origins: string[]; settled: number };
  list: (guest: number, store: object) => {
    pending: { what: string; origin: string; deniedInMs: number }[];
    answered: { origin: string; what: string; allow: boolean }[];
  };
  drop: (guest: number) => void;
  handOver: (guest: number) => { origin: string; needs: string[]; done: (ok: boolean) => void }[];
};
const mainSrc = await Bun.file(resolve(import.meta.dir, "../../electron/main.js")).text();
const panelSrc = await Bun.file(resolve(import.meta.dir, "../../web/src/components/BrowserPanel.tsx")).text();
const dropComments = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

/** The body of `name`, cut at its own closing brace and stripped of comment lines. */
function bodyOf(src: string, head: string): string {
  const at = src.indexOf(head);
  expect(at, head).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = src.indexOf("{", at); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return dropComments(src.slice(at, i + 1));
  }
  throw new Error(`no closing brace for ${head}`);
}

describe("permissionAllowed", () => {
  test.each([
    "media", "audioCapture", "videoCapture", "mediaKeySystem", "clipboard-read", "geolocation", "midi",
    "midiSysex", "notifications", "hid", "serial", "usb", "display-capture", "openExternal", "unknown-thing",
  ])("%s is refused", (p) => {
    expect(guard.permissionAllowed(p)).toBe(false);
  });

  test("a value that is not a string is refused", () => {
    expect(guard.permissionAllowed(undefined)).toBe(false);
    expect(guard.permissionAllowed(null)).toBe(false);
    expect(guard.permissionAllowed({ toString: () => "fullscreen" })).toBe(false);
  });

  test("the few things a page needs to behave are allowed", () => {
    for (const p of ["fullscreen", "clipboard-sanitized-write", "pointerLock"]) {
      expect(guard.permissionAllowed(p), p).toBe(true);
    }
  });
});

describe("permissionVerdict", () => {
  const human = { frontTab: true, lane: false, person: true };
  const v = (p: unknown, ctx: object = human) => guard.permissionVerdict(p, ctx);

  test("the tab a person is looking at is asked about the microphone, the camera and notifications", () => {
    expect(v("media", { ...human, mediaTypes: ["audio"] })).toEqual({ verdict: "ask", what: "microphone" });
    expect(v("media", { ...human, mediaTypes: ["video"] })).toEqual({ verdict: "ask", what: "camera" });
    expect(v("media", { ...human, mediaTypes: ["audio", "video"] })).toEqual({ verdict: "ask", what: "microphone and camera" });
    expect(v("notifications")).toEqual({ verdict: "ask", what: "notifications" });
  });

  test("the person's own tab in the background is refused: they are not there to answer", () => {
    expect(v("media", { person: true, frontTab: false, mediaTypes: ["audio"] }).verdict).toBe("deny");
    expect(v("notifications", { person: true }).verdict).toBe("deny");
  });

  test("a tab that is not the person's is held, never asked — an agent's, a lane, or nobody's yet, in front or not", () => {
    for (const ctx of [{ frontTab: true, lane: true }, { frontTab: true }, { frontTab: false }, { lane: true }, { frontTab: true, person: true, lane: true }, {}]) {
      expect(v("media", { ...ctx, mediaTypes: ["audio"] })).toEqual({ verdict: "hold", what: "microphone", needs: ["microphone"] });
      expect(v("notifications", ctx)).toEqual({ verdict: "hold", what: "notifications", needs: ["notifications"] });
      expect(v("media", { ...ctx, mediaTypes: ["audio", "video"] }).needs).toEqual(["microphone", "camera"]);
    }
  });

  test("holding is not a way to widen the policy: the rest stays refused on an agent's tab", () => {
    for (const p of ["clipboard-read", "geolocation", "hid", "display-capture", "midi"]) {
      expect(v(p, { frontTab: true }).verdict, p).toBe("deny");
    }
    expect(v("media", { frontTab: true, mediaTypes: [] }).verdict).toBe("deny");
  });

  test("the rest stays refused everywhere, front tab or not", () => {
    for (const p of ["clipboard-read", "hid", "serial", "usb", "display-capture", "geolocation", "midi", "openExternal", "unknown-thing", undefined]) {
      expect(v(p).verdict, String(p)).toBe("deny");
    }
  });

  test("a media request that names nothing we know is refused, not asked", () => {
    expect(v("media", { ...human, mediaTypes: [] }).verdict).toBe("deny");
    expect(v("media", { ...human, mediaTypes: ["unknown"] }).verdict).toBe("deny");
    expect(v("media", human).verdict).toBe("deny");
  });

  test("what the always-allowed permissions still are, in any tab", () => {
    expect(v("fullscreen", { frontTab: false, lane: true }).verdict).toBe("allow");
  });

  test("the question names the site and the thing, and nothing the page wrote", () => {
    expect(guard.permissionPrompt("microphone", "https://meet.example")).toBe("meet.example wants to use your microphone");
    expect(guard.permissionPrompt("notifications", "https://news.example:8443")).toBe("news.example:8443 wants to show notifications");
  });
});

describe("holderAfter", () => {
  const h = guard.holderAfter;

  test("whoever opened the tab owns it from its first moment", () => {
    expect(h(undefined, { kind: "opened", by: "person" })).toBe("person");
    expect(h(undefined, { kind: "opened", by: "agent" })).toBe("agent");
    expect(h(undefined, { kind: "opened", by: "somebody" })).toBeUndefined();
  });

  test("a popup is its opener's, and nobody's when the opener is nobody's", () => {
    expect(h(undefined, { kind: "popup", opener: "agent" })).toBe("agent");
    expect(h(undefined, { kind: "popup", opener: "person" })).toBe("person");
    expect(h(undefined, { kind: "popup", opener: undefined })).toBeUndefined();
  });

  test("any agent ask takes the person's tab; only typing an address gives it back", () => {
    expect(h("person", { kind: "driven" })).toBe("agent");
    expect(h("agent", { kind: "typed" })).toBe("person");
    expect(h("agent", { kind: "opened", by: "x" })).toBe("agent");
    expect(h("agent", { kind: "looked-at" })).toBe("agent");
  });
});

describe("the panel says who opened each tab", () => {
  const panel = dropComments(panelSrc);

  test("an agent's mint is the agent's, the window's own opens are the person's, a popup is its opener's", () => {
    expect(panel.includes('openedBy.set(made.tab.id, "agent")')).toBe(true);
    expect(panel.match(/openedBy\.set\(r\.tab\.id, "person"\)/g)?.length).toBe(2);
    expect(panel.includes("openedBy.set(id, opener)")).toBe(true);
  });

  test("main is told when the guest attaches, before its page can ask", () => {
    expect(panel.includes('w.addEventListener("did-attach", sayOpener)')).toBe(true);
    const say = bodyOf(panelSrc, "const sayOpener = () => {");
    expect(say.includes("setGuestOpener(")).toBe(true);
    // The front tab is said to be in front at attach, not 60 ms later.
    expect(say.includes("setActiveBrowserGuest(gid)")).toBe(true);
  });
});

describe("createPermissionDesk", () => {
  const origin = "http://localhost:8002";
  /** A desk on a hand-wound clock: timers run only when `fire()` is called. */
  function desk() {
    let t = 1000;
    const timers = new Set<() => void>();
    const d = guard.createPermissionDesk({
      timeoutMs: 30_000,
      now: () => t,
      setTimer: (fn) => { timers.add(fn); return fn; },
      clearTimer: (fn) => { timers.delete(fn as () => void); },
    });
    return { d, tick: (ms: number) => { t += ms; }, fire: () => { for (const fn of [...timers]) { timers.delete(fn); fn(); } } };
  }
  const answers = () => { const got: boolean[] = []; return { got, done: (ok: boolean) => got.push(ok) }; };

  test("a held request is pending for its tab, with the sentence the agent reads", () => {
    const { d, tick } = desk();
    const jar = {};
    const a = answers();
    d.hold(7, jar, origin, ["microphone"], a.done);
    tick(5_000);
    expect(a.got).toEqual([]);
    const { pending } = d.list(7, jar);
    expect(pending).toEqual([{ what: "microphone", origin, deniedInMs: 25_000 }]);
    expect(guard.pendingPermissionNote(pending[0])).toBe(
      "pending permission: microphone for http://localhost:8002 — answer with `permission grant|deny microphone` within 25s, or it is denied");
    expect(d.list(8, jar).pending).toEqual([]);
  });

  test("the agent's grant answers it, and is remembered for that container and origin only", () => {
    const { d } = desk();
    const jar = {}, other = {};
    const a = answers();
    d.hold(7, jar, origin, ["microphone"], a.done);
    expect(d.answer(7, jar, ["microphone"], true)).toEqual({ answered: ["microphone"], origins: [origin], settled: 1 });
    expect(a.got).toEqual([true]);
    expect(d.allowed(jar, origin, ["microphone"])).toBe(true);
    expect(d.allowed(jar, "http://localhost:9000", ["microphone"])).toBe(false);
    expect(d.allowed(other, origin, ["microphone"])).toBe(false);
    expect(d.allowed(jar, origin, ["microphone", "camera"])).toBe(false);
    const b = answers();
    d.hold(9, jar, origin, ["microphone"], b.done);
    expect(b.got).toEqual([true]);
  });

  test("unanswered is denied when the time runs out, and the denial is not remembered", () => {
    const { d, fire } = desk();
    const jar = {};
    const a = answers();
    d.hold(7, jar, origin, ["notifications"], a.done);
    fire();
    expect(a.got).toEqual([false]);
    expect(d.list(7, jar)).toEqual({ pending: [], answered: [] });
    expect(d.answer(7, jar, ["notifications"], true, origin)).toMatchObject({ settled: 0 });
    expect(d.allowed(jar, origin, ["notifications"])).toBe(true);
  });

  test("a deny answers at once; microphone and camera together need both", () => {
    const { d } = desk();
    const jar = {};
    const a = answers();
    d.hold(7, jar, origin, ["microphone", "camera"], a.done);
    d.answer(7, jar, ["microphone"], true);
    expect(a.got).toEqual([]);
    d.answer(7, jar, ["camera"], false);
    expect(a.got).toEqual([false]);
  });

  test("a grant ahead of the ask needs the site named, and answers the request when it comes", () => {
    const { d } = desk();
    const jar = {};
    expect(d.answer(7, jar, ["camera"], true)).toHaveProperty("error");
    expect(d.answer(7, jar, ["camera"], true, origin)).toMatchObject({ origins: [origin], settled: 0 });
    const a = answers();
    d.hold(7, jar, origin, ["camera"], a.done);
    expect(a.got).toEqual([true]);
    expect(d.list(7, jar).answered).toEqual([{ origin, what: "camera", allow: true }]);
  });

  test("only what is held for an agent can be answered — never the clipboard or location", () => {
    const { d } = desk();
    for (const w of [["geolocation"], ["clipboard-read"], ["microphone", "midi"], []]) {
      expect(d.answer(7, {}, w, true, origin), w.join()).toHaveProperty("error");
    }
  });

  test("a request made before the tab turned out to be the person's is handed over unanswered, its timer gone", () => {
    const { d, fire } = desk();
    const jar = {};
    const a = answers();
    d.hold(7, jar, origin, ["microphone"], a.done);
    const taken = d.handOver(7);
    expect(taken.map((h) => [h.origin, h.needs])).toEqual([[origin, ["microphone"]]]);
    fire();
    expect(a.got).toEqual([]);
    expect(d.list(7, jar).pending).toEqual([]);
    taken[0].done(true);
    expect(a.got).toEqual([true]);
  });

  test("another tab's answer does not settle this tab's request; a closed tab's request is refused", () => {
    const { d } = desk();
    const jar = {};
    const a = answers();
    d.hold(7, jar, origin, ["microphone"], a.done);
    expect(d.answer(8, jar, ["microphone"], true)).toHaveProperty("error");
    expect(a.got).toEqual([]);
    d.drop(7);
    expect(a.got).toEqual([false]);
  });
});

describe("uniqueSavePath", () => {
  const dir = mkdtempSync(join(tmpdir(), "agx-f2-dl-"));
  const exists = (p: string) => existsSync(p);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a free name is used as it is", () => {
    expect(guard.uniqueSavePath(dir, "a.txt", exists)).toBe(join(dir, "a.txt"));
  });

  test("a taken name gets a suffix and the file already there is untouched", () => {
    writeFileSync(join(dir, "Makefile"), "original");
    writeFileSync(join(dir, "Makefile (1)"), "second");
    const at = guard.uniqueSavePath(dir, "Makefile", exists);
    expect(at).toBe(join(dir, "Makefile (2)"));
    expect(readFileSync(join(dir, "Makefile"), "utf8")).toBe("original");
  });

  test("the extension stays last", () => {
    writeFileSync(join(dir, "report.pdf"), "x");
    expect(guard.uniqueSavePath(dir, "report.pdf", exists)).toBe(join(dir, "report (1).pdf"));
  });

  test("a name that tries to leave the directory stays inside it", () => {
    for (const evil of ["../escape.txt", "/etc/cron.d/x", "a/../../b", ".."]) {
      const at = guard.uniqueSavePath(dir, evil, () => false);
      expect(at.startsWith(dir + "/"), evil).toBe(true);
      expect(at.slice(dir.length + 1).includes("/"), evil).toBe(false);
    }
  });
});

describe("main.js wiring", () => {
  const arm = bodyOf(mainSrc, "function armEgress(");

  test("the permission and display-capture handlers are set on the session", () => {
    for (const call of ["setPermissionRequestHandler(", "setPermissionCheckHandler(", "setDisplayMediaRequestHandler(", "setDevicePermissionHandler("]) {
      expect(arm.includes(call), call).toBe(true);
    }
    expect(arm.includes("permissionAsk("), "asks the pure policy").toBe(true);
  });

  test("the front tab is asked, lanes are told apart, and the answer is remembered", () => {
    const ask = bodyOf(mainSrc, "function askPermission(");
    const asks = bodyOf(mainSrc, "function permissionAsk(");
    expect(arm.includes("askPermission(")).toBe(true);
    // The check handler answers synchronously: it may repeat a yes he gave and
    // grant nothing else, so an "ask" verdict is granted only from the record.
    expect(arm.includes('if (ask.verdict !== "ask") return ask.verdict === "allow";')).toBe(true);
    expect(arm.includes("permissionAnswers.get(permissionKey(ask.what")).toBe(true);
    expect(arm.includes("=== true;")).toBe(true);
    expect(ask.includes("dialog.showMessageBox(")).toBe(true);
    expect(ask.includes("permissionAnswers.set(")).toBe(true);
    // The person's front tab is the one the renderer said is on screen, never
    // the last guest to attach; a tab an agent named itself on is the agent's.
    expect(asks.includes("shownGuest")).toBe(true);
    expect(asks.includes("browserGuest")).toBe(false);
    expect(asks.includes('guestHolder.get(wc.id) === "person"')).toBe(true);
    // Who opened a guest is told on its own channel, and a named ask moves it.
    expect(mainSrc.includes('ipcMain.on("ag:browserGuestOpener"')).toBe(true);
    expect(bodyOf(mainSrc, "function moveHolder(").includes("holderAfter(")).toBe(true);
    // Every agent ask drives the tab, a --shared one (no name) included.
    const owner = mainSrc.slice(mainSrc.indexOf('ipcMain.on("ag:browserGuestOwner"'), mainSrc.indexOf('ipcMain.on("ag:browserGuestOpener"'));
    expect(owner.includes('if (!(req && req.person === true)) moveHolder(guestId, { kind: "driven" })')).toBe(true);
    // Held before the person's tab was known to be theirs: handed to their dialog.
    const opener = mainSrc.slice(mainSrc.indexOf('ipcMain.on("ag:browserGuestOpener"'), mainSrc.indexOf('ipcMain.handle("ag:browserPermission"'));
    expect(opener.includes("permissionDesk.handOver(guestId)")).toBe(true);
    expect(opener.includes('if (req.by === "typed" || guestHolder.get(guestId) !== "person") return;')).toBe(true);
    expect(dropComments(mainSrc).includes('win.webContents.send("ag:browser-guest-attached", guest.id)')).toBe(true);
    expect(asks.includes("laneGuests.has(")).toBe(true);
    expect(arm.includes("permissionDesk.hold(")).toBe(true);
    expect(arm.includes("permissionDesk.allowed(")).toBe(true);
    const active = mainSrc.slice(mainSrc.indexOf('ipcMain.handle("ag:browserActive"'), mainSrc.indexOf('ipcMain.handle("ag:browserPlaces"'));
    expect(active.includes("shownGuest = g")).toBe(true);
    expect(dropComments(mainSrc).match(/shownGuest = (?!null)/g)?.length).toBe(1);
    expect(dropComments(mainSrc).includes("if (opts.lane) laneGuests.add(guest)")).toBe(true);
  });

  test("the policy is set before the egress guard can return early", () => {
    expect(arm.indexOf("setPermissionRequestHandler(")).toBeLessThan(arm.indexOf("if (!egress) return"));
  });

  test("every guest attach goes through armEgress", () => {
    const attaches = dropComments(mainSrc).match(/on\("will-attach-webview"/g) ?? [];
    const armed = mainSrc.match(/armEgress\(webPreferences\.partition\)/g) ?? [];
    expect(attaches.length).toBeGreaterThan(0);
    expect(armed.length).toBe(attaches.length);
  });

  const dl = bodyOf(mainSrc, "const wireDownloads = ");

  test("a download is keyed by its own webContents, never by the guest that wired the session", () => {
    expect(dl.includes("?? guestDownloadDir.get(guest)")).toBe(false);
    expect(dl.includes("|| guestCdpEvents.get(guest)")).toBe(false);
  });

  test("the directory is disarmed once a download has taken it", () => {
    expect(/guestDownloadDir\.delete\(wc\)/.test(dl)).toBe(true);
  });

  test("a name is held until its download is done", () => {
    expect(dl.includes("reservedSavePaths.add(")).toBe(true);
    expect(dl.includes("reservedSavePaths.delete(")).toBe(true);
  });

  test("the save path is a name that does not exist yet", () => {
    expect(dl.includes("uniqueSavePath(")).toBe(true);
    expect(dl.includes("path.join(dir, name)")).toBe(false);
  });
});

describe("downloadFile passes the caller's tab through", () => {
  test("both asks it makes carry the page", async () => {
    const src = await Bun.file(resolve(import.meta.dir, "../src/browserdrive.ts")).text();
    // The signature holds braces of its own (the parameter type), so this one is
    // cut at the next top-level export rather than at the first closing brace.
    const from = src.indexOf("export async function downloadFile(");
    expect(from).toBeGreaterThan(-1);
    const body = dropComments(src.slice(from, src.indexOf("\nexport ", from + 10)));
    expect(body.includes("via?: Record<string, unknown>")).toBe(true);
    // setDownloadBehavior, the click, the event drain and the disarm each go through `at(`.
    expect((body.match(/\bat\(\{/g) ?? []).length).toBe(4);
    expect(body.includes("...p.via")).toBe(true);
    // and the tab is let go again however the verb ends
    expect(/finally\s*\{[\s\S]*behavior: "default"/.test(body)).toBe(true);
  });
});
