/*
 * The shell hands the first run two numbers and no sentence.
 *
 * What went wrong before: the port fallback existed only as a line on stderr,
 * so a window that had moved off the port the hooks expected said nothing on
 * screen. The fix is a strip in the wizard. The words must be built once, in
 * the renderer's own lib, or the shell and the page drift apart; this test
 * reads both files as source because the browser-side rule is what is checked,
 * and neither process is started.
 */
import { describe, expect, it } from "bun:test";

const main = await Bun.file(new URL("../../electron/main.js", import.meta.url)).text();
const preload = await Bun.file(new URL("../../electron/preload.js", import.meta.url)).text();
const notices = await Bun.file(new URL("../../web/src/lib/setupNotices.ts", import.meta.url)).text();

describe("what the shell sends", () => {
  const sends = [...main.matchAll(/send\("ag:server-changed", \{([^}]*)\}/g)].map((m) => m[1]);
  const send = sends.find((body) => body.includes("origin")) ?? null;

  it("carries the two numbers, preferred and bound", () => {
    expect(send).not.toBeNull();
    expect(send!).toContain("origin");
    expect(send!).toContain("preferredPort: PREFERRED_PORT");
  });

  it("carries no sentence: every field is an expression, never a string literal", () => {
    expect(send).not.toBeNull();
    expect(send!).not.toMatch(/"[^"]*"/);
  });

  it("answers both numbers to a window that opens later", () => {
    expect(main).toContain('ipcMain.on("ag:preferredPort"');
    expect(main).toContain('ipcMain.on("ag:serverPort"');
    expect(preload).toContain("preferredPort:");
    expect(preload).toContain("serverPort:");
  });

  it("says which display it drew through, from the switch that decides it", () => {
    expect(main).toContain("const DISPLAY_SERVER =");
    expect(main).toContain('ipcMain.on("ag:displayServer"');
    expect(preload).toContain("displayServer:");
  });
});

describe("where the words live", () => {
  it("the renderer's lib builds the strip's copy", () => {
    expect(notices).toContain("This window is on port");
    expect(notices).toContain("Hooks and CLIs read the port the server wrote");
  });

  it("the shell and the preload never carry that copy", () => {
    for (const src of [main, preload]) {
      expect(src).not.toContain("This window is on port");
      expect(src.toLowerCase()).not.toContain("another agentglass");
    }
  });
});
