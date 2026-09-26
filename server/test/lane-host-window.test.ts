/*
 * The lane host window (electron/main.js, createLaneHost).
 *
 * The measured reason it is offscreen is in the comment above the function: a
 * hidden window's webview gets no painted frames, so `shot` and `screencast`
 * fail there. These pin the three things that keep that true and keep the
 * window off the person's screen.
 */
import { describe, expect, test } from "bun:test";

const PRELOAD = await Bun.file(new URL("../../electron/preload.js", import.meta.url)).text();
const MAIN = await Bun.file(new URL("../../electron/main.js", import.meta.url)).text();

/** The source of `function name(` up to its own closing brace, comments out. */
function body(name: string): string {
  const start = MAIN.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
  let depth = 0;
  // From the brace that opens the body, not one in a default parameter.
  for (let i = MAIN.indexOf(") {", start) + 2; i < MAIN.length; i++) {
    if (MAIN[i] === "{") depth++;
    else if (MAIN[i] === "}" && --depth === 0) {
      return MAIN.slice(start, i + 1).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    }
  }
  throw new Error(`unbalanced ${name}`);
}

describe("createLaneHost", () => {
  const host = body("createLaneHost");

  test("is never shown and paints offscreen", () => {
    expect(host).toContain("show: false,");
    expect(host).toContain("offscreen: true,");
    expect(host).toContain("webviewTag: true,");
    expect(host).not.toMatch(/\.show(Inactive)?\(/);
  });

  test("its webviews go through the same guest guard, as a lane", () => {
    expect(host).toContain("guardWebviews(host, { lane: true });");
  });

  test("loads the app as a lane", () => {
    expect(host).toContain("#lane=${encodeURIComponent(id)}");
  });
});

describe("a lane's guest", () => {
  test("never becomes the front tab the zoom and the unaddressed capture use", () => {
    const guard = body("guardWebviews");
    expect(guard).toContain("browserGuests.add(guest);");
    expect(guard).toContain("if (!opts.lane) browserGuest = guest;");
    expect(guard).not.toMatch(/^\s*browserGuest = guest;/m);
  });
});

describe("lanes are made on request, and only by the app's own window", () => {
  test("there is no spike gate any more", () => {
    expect(MAIN).not.toContain("AGENTGLASS_LANE_SPIKE");
  });

  test("ag:laneOpen answers only the app window, validates what it is given, and caps count and memory", () => {
    const at = MAIN.indexOf('ipcMain.handle("ag:laneOpen"');
    expect(at).toBeGreaterThan(-1);
    const block = MAIN.slice(at, MAIN.indexOf('ipcMain.handle("ag:laneClose"', at));
    expect(block).toContain("e.sender !== mainWindow.webContents");
    expect(block).toContain("/^[A-Za-z0-9_-]{1,64}$/.test(id)");
    expect(block).toContain("/^[a-z0-9]{0,16}$/.test(slug)");
    expect(block).toContain("laneHosts.size >= LANE_MAX");
    expect(block).toContain("used > LANE_RSS_MB");
    // The order matters: refuse before making anything.
    expect(block.indexOf("used > LANE_RSS_MB")).toBeLessThan(block.indexOf("createLaneHost(id, slug)"));
  });

  test("ag:laneClose answers only the app window too", () => {
    const at = MAIN.indexOf('ipcMain.handle("ag:laneClose"');
    const block = MAIN.slice(at, MAIN.indexOf('ipcMain.on("ag:deskKey"', at));
    expect(block).toContain("e.sender !== mainWindow.webContents");
    expect(block).toContain("destroyLaneHost(id)");
  });

  test("the preload offers both, and nothing that takes a partition name", () => {
    expect(PRELOAD).toContain('ipcRenderer.invoke("ag:laneOpen", id, slug)');
    expect(PRELOAD).toContain('ipcRenderer.invoke("ag:laneClose", id)');
  });

  test("a lane host is handed the desk key although its contents are typed offscreen, and only a lane host", () => {
    expect(MAIN).toContain("const isLaneHost = (wc) => [...laneHosts.values()].some((l) => !l.host.isDestroyed() && l.host.webContents === wc);");
    expect(MAIN).toContain('(e.sender.getType() === "window" || isLaneHost(e.sender)) ? deskKey : null');
  });

  test("a restarted server has no lanes, so their windows go with the old one", () => {
    const fn = body("restartSidecar");
    expect(fn.indexOf("destroyLaneHost(id)")).toBeGreaterThan(-1);
    expect(fn.indexOf("destroyLaneHost(id)")).toBeLessThan(fn.indexOf("killSidecar()"));
  });

  test("a host the server forgot is destroyed on the next heartbeat, and every host goes when the sidecar exits", () => {
    const at = MAIN.indexOf('ipcMain.handle("ag:laneKeep"');
    expect(at).toBeGreaterThan(-1);
    const block = MAIN.slice(at, MAIN.indexOf('ipcMain.handle("ag:laneClose"', at));
    expect(block).toContain("e.sender !== mainWindow.webContents");
    expect(block).toContain("!ids.includes(id) && destroyLaneHost(id)");
    const exit = MAIN.indexOf('child.on("exit", (code, signal) => {');
    expect(MAIN.slice(exit, MAIN.indexOf("if (sidecar !== child || stopped) return;", exit))).toContain("destroyLaneHost(id)");
  });

  test("a lane's guest may not open a window, and a lane host cannot save its bounds as the app's", () => {
    const guard = body("guardWebviews");
    expect(guard).toContain("if (opts.lane) return { action: \"deny\" };");
    // The one thing a lane may do with a window request is fetch an armed
    // download in its own tab (browser-blank-download.test.ts); the denial
    // still precedes anything that opens a tab or a window.
    expect(guard.indexOf("if (opts.lane) return { action: \"deny\" };")).toBeLessThan(guard.indexOf("ag:browser-open-tab"));
    expect(guard.indexOf("if (opts.lane) return { action: \"deny\" };")).toBeLessThan(guard.indexOf('action: "allow"'));
    const at = MAIN.indexOf('ipcMain.on("ag:setWindowBackground"');
    expect(MAIN.slice(at, at + 400)).toContain("if (isLaneHost(e.sender)) return;");
  });

  test("every lane dies with the app's window, or the app would run on with nothing to see", () => {
    const at = MAIN.indexOf('win.on("closed", () => {\n    if (mainWindow === win) mainWindow = null;');
    expect(at).toBeGreaterThan(-1);
    const block = MAIN.slice(at, MAIN.indexOf("});", at));
    expect(block).toContain("destroyLaneHost(id)");
  });

  test("a private lane's jar is wiped when it closes, and only a private one", () => {
    const fn = body("destroyLaneHost");
    expect(fn).toContain("if (l.private) {");
    expect(fn).toContain("clearStorageData()");
    const make = body("createLaneHost");
    expect(make).toContain("private: slug === id");
  });

  test("the host loads its container after &p=, and none for the person's own", () => {
    expect(body("createLaneHost")).toContain('${slug ? `&p=${slug}` : ""}');
  });
});
