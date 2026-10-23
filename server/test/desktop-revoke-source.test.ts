/*
 * "Revoke this link" in the desktop shell has to reach the paired devices, not
 * only the machine token: a device holds a credential of its own, so a rotation
 * alone left every phone paired. The shell is not run here; the order of its
 * handler is asserted against its source.
 */
import { describe, expect, test } from "bun:test";

const main = await Bun.file(new URL("../../electron/main.js", import.meta.url).pathname).text();
const start = main.indexOf('ipcMain.handle("ag:revokeRemote"');
const handler = main.slice(start, main.indexOf("\n  });", start));

describe("ag:revokeRemote", () => {
  test("asks the server to forget every device before it rotates the token", () => {
    expect(start).toBeGreaterThan(0);
    const forget = handler.indexOf("forgetAllDevices(");
    const rotate = handler.indexOf("rotateToken()");
    expect(forget).toBeGreaterThan(-1);
    expect(rotate).toBeGreaterThan(forget);
  });

  test("rotates nothing when the server did not confirm", () => {
    expect(handler).toMatch(/if \(!\(await forgetAllDevices\([^\n]*throw /);
  });

  test("calls the machine-only route with the old token", () => {
    const fn = main.slice(main.indexOf("function forgetAllDevices("));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toContain('path: "/pair/forget-all"');
  });
});
