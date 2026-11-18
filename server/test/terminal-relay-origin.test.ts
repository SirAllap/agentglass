// With the relay on, the desktop window was refused on every connect: the
// door's list named `app://`, and the window is served from `agentglass://app`.
import { expect, test } from "bun:test";
import { relayOriginOk } from "../src/relay/wire.ts";

const shell = await Bun.file(new URL("../../electron/main.js", import.meta.url)).text();

test("the desktop window's own origin opens the relay's door, another site's does not", () => {
  // The origin the shell really serves the window from, read out of the shell.
  const scheme = /const APP_SCHEME = "([a-z]+)";/.exec(shell)?.[1];
  expect(scheme).not.toBeUndefined();
  expect(shell).toContain("const APP_ORIGIN = `${APP_SCHEME}://app`;");
  expect(relayOriginOk(`${scheme}://app`)).toBe(true);
  expect(relayOriginOk("http://127.0.0.1:4000")).toBe(true);
  expect(relayOriginOk(null)).toBe(true);
  for (const o of ["https://example.com", "app://anything", `${scheme}://evil`, "http://127.0.0.1.example.com"]) expect(relayOriginOk(o)).toBe(false);
});
