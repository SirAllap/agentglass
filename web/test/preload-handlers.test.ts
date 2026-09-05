/*
 * Every bridge the preload offers has somebody in the main process to answer it.
 *
 * Written because of what happened without it: a rewrite of one IPC handler
 * replaced everything between it and the next one, and main lost the inspector,
 * the profile import and the image save — 254 lines — while the preload went on
 * offering all three. Nothing failed at build time, no test moved, and the app
 * shipped with an inspector that opened for a frame and closed. `invoke` on a
 * name nobody handles is a rejected promise inside a click handler, which is
 * the quietest way an app can lose a feature.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const here = new URL(".", import.meta.url).pathname;
const preload = readFileSync(`${here}../../electron/preload.js`, "utf8");
const main = readFileSync(`${here}../../electron/main.js`, "utf8");

/** `ipcRenderer.invoke("ag:x"` and `ipcRenderer.send("ag:x"`, with what each needs. */
function asked(src: string, verb: "invoke" | "send" | "sendSync"): string[] {
  const re = new RegExp(`ipcRenderer\\.${verb}\\(\\s*"([^"]+)"`, "g");
  return [...new Set([...src.matchAll(re)].map((m) => m[1]!))];
}
function answered(src: string, verb: "handle" | "on"): Set<string> {
  const re = new RegExp(`ipcMain\\.${verb}\\(\\s*"([^"]+)"`, "g");
  return new Set([...src.matchAll(re)].map((m) => m[1]!));
}

describe("the preload's bridges", () => {
  test("every invoke has a handler in main", () => {
    const has = answered(main, "handle");
    const missing = asked(preload, "invoke").filter((n) => !has.has(n));
    expect(missing).toEqual([]);
  });

  /* `send` is answered by `ipcMain.on`, and a `sendSync` by an `on` that sets
     `returnValue` — same list either way. */
  test("every send has a listener in main", () => {
    const has = answered(main, "on");
    const missing = [...asked(preload, "send"), ...asked(preload, "sendSync")]
      .filter((n) => !has.has(n));
    expect(missing).toEqual([]);
  });

  /* The three the clobber took, by name: a generic rule passes on an empty
     list, and an empty list is exactly what a second clobber would leave. */
  test("the inspector, the profile import and the image save are all still wired", () => {
    for (const name of ["ag:browserDevtools", "ag:browserDevtoolsClose", "ag:browserDevtoolsZoom", "ag:browserShelfRead", "ag:saveImage", "ag:captureBrowser", "ag:captureFullPage"]) {
      expect(main).toContain(`ipcMain.handle("${name}"`);
    }
    expect(main).toContain('ipcMain.on("ag:browserDevtoolsRect"');
  });
});
