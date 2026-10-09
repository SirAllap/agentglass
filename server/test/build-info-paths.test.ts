import { test, expect } from "bun:test";
import { buildInfoPaths } from "../src/selfupdate.ts";

/*
 * /health answered build:"" on an installed app: the stamp was read relative to
 * the module, a path that exists in a checkout and not in the compiled binary,
 * where build-info.json sits beside the executable.
 */
test("an installed app looks beside its binary first", () => {
  const p = buildInfoPaths("/opt/orbit/resources/agentglass-server", "/work/orbit");
  expect(p[0]).toBe("/opt/orbit/resources/build-info.json");
  expect(p[1]).toBe("/work/orbit/electron/staging/build-info.json");
});

test("/health reads the stamp from that same list", async () => {
  const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
  const at = src.indexOf("function buildStamp(");
  const body = src.slice(at, src.indexOf("\n}\n", at));
  expect(body).toContain("buildInfoPaths()");
});
