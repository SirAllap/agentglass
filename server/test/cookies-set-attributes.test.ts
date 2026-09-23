/*
 * `cookies --set` passes every attribute it was given to the window — the
 * renderer half, which turns them into Network.setCookie, is tested in
 * web/test/browser-drive.test.ts. Before this the verb sent name, value and
 * path, and nothing else: there was no way to ask for Secure or HttpOnly, and
 * so no way to set a `__Host-` cookie at all.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { startBrowserStub, runCli } from "./fixtures/browser-stub.ts";

const HAVE_PY = !!Bun.which("python3");
let stub: ReturnType<typeof startBrowserStub>;
beforeAll(() => { stub = startBrowserStub(() => ({ ok: true, value: { set: { name: "x" } } })); });
afterAll(() => stub.stop());

test.skipIf(!HAVE_PY)("every attribute reaches the window, and only the ones given", async () => {
  const r = await runCli(stub.url, [
    "--page", "tab-1", "cookies", "--set", "__Host-orbit_sid", "v4lue-not-printed",
    "--http-only", "--same-site", "Lax", "--expires", "1900000000",
  ]);
  expect(r.code, r.stderr).toBe(0);
  const set = stub.calls.find((c) => c.op === "cookies")?.body.set as Record<string, unknown>;
  expect(set).toEqual({ name: "__Host-orbit_sid", value: "v4lue-not-printed", path: "/", httpOnly: true, sameSite: "Lax", expires: 1900000000 });

  await runCli(stub.url, ["--page", "tab-1", "cookies", "--set", "theme", "dark", "--domain", ".orbit.example", "--secure", "--partition-key", "https://orbit.example"]);
  const set2 = stub.calls.filter((c) => c.op === "cookies").at(-1)?.body.set as Record<string, unknown>;
  expect(set2).toEqual({ name: "theme", value: "dark", path: "/", domain: ".orbit.example", secure: true, partitionKey: "https://orbit.example" });
});
