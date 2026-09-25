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
import { describe, expect, test } from "bun:test";
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
    ctx: { frontTab?: boolean; lane?: boolean; mediaTypes?: unknown },
  ) => { verdict: "allow" | "deny" | "ask"; what?: string };
  permissionPrompt: (what: string, origin: string) => string;
};
const mainSrc = await Bun.file(resolve(import.meta.dir, "../../electron/main.js")).text();
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
  const human = { frontTab: true, lane: false };
  const v = (p: unknown, ctx: object = human) => guard.permissionVerdict(p, ctx);

  test("the tab a person is looking at is asked about the microphone, the camera and notifications", () => {
    expect(v("media", { ...human, mediaTypes: ["audio"] })).toEqual({ verdict: "ask", what: "microphone" });
    expect(v("media", { ...human, mediaTypes: ["video"] })).toEqual({ verdict: "ask", what: "camera" });
    expect(v("media", { ...human, mediaTypes: ["audio", "video"] })).toEqual({ verdict: "ask", what: "microphone and camera" });
    expect(v("notifications")).toEqual({ verdict: "ask", what: "notifications" });
  });

  test("a lane, or a tab that is not in front, is never asked: it is refused", () => {
    for (const ctx of [{ frontTab: true, lane: true }, { frontTab: false, lane: false }, {}]) {
      expect(v("media", { ...ctx, mediaTypes: ["audio"] }).verdict).toBe("deny");
      expect(v("notifications", ctx).verdict).toBe("deny");
    }
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

describe("uniqueSavePath", () => {
  const dir = mkdtempSync(join(tmpdir(), "agx-f2-dl-"));
  const exists = (p: string) => existsSync(p);

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
    rmSync(dir, { recursive: true });
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
    expect(asks.includes("browserGuest")).toBe(true);
    expect(asks.includes("laneGuests.has(")).toBe(true);
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
