import { beforeAll, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";

// A notification that points at a bare link opens it in a browser tab. The
// address arrives from outside, so only http and https may open: a scheme that
// runs or hands off to another program reaches window.open never.

const stubGlobal = globalStubs();
const opened: string[] = [];
let sysNotify: typeof import("../src/lib/sysNotify.ts");

beforeAll(async () => {
  stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000" });
  stubGlobal("window", { open: (u: string) => { opened.push(u); } });
  sysNotify = await import("../src/lib/sysNotify.ts");
});

describe("openTarget with a link", () => {
  test("opens a web address", () => {
    opened.length = 0;
    sysNotify.openTarget({ kind: "url", url: "https://github.com/acme/orbit/pull/7" });
    expect(opened).toEqual(["https://github.com/acme/orbit/pull/7"]);
  });
  test("opens nothing for a scheme that is not http(s)", () => {
    opened.length = 0;
    for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "intent://scan/#Intent;end", "/relative"]) {
      sysNotify.openTarget({ kind: "url", url });
    }
    expect(opened).toEqual([]);
  });
});
