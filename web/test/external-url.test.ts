import { describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal";
import { externalUrl, openExternal } from "../src/lib/externalUrl.ts";

describe("externalUrl", () => {
  it("passes the links GitHub actually hands us", () => {
    expect(externalUrl("https://github.com/acme/shop-api/pull/482")).toBe("https://github.com/acme/shop-api/pull/482");
    expect(externalUrl("http://internal.forge/pr/3")).toBe("http://internal.forge/pr/3");
  });

  it("declines schemes that execute rather than navigate", () => {
    expect(externalUrl("javascript:alert(1)")).toBeUndefined();
    expect(externalUrl("JavaScript:alert(1)")).toBeUndefined();
    expect(externalUrl("data:text/html,<script>alert(1)</script>")).toBeUndefined();
    expect(externalUrl("vbscript:msgbox(1)")).toBeUndefined();
    expect(externalUrl("file:///etc/passwd")).toBeUndefined();
  });

  it("declines nothing-at-all rather than returning an empty href", () => {
    // href="" reloads the page, so absent has to stay absent.
    expect(externalUrl("")).toBeUndefined();
    expect(externalUrl(null)).toBeUndefined();
    expect(externalUrl(undefined)).toBeUndefined();
    expect(externalUrl("   ")).toBeUndefined();
  });

  it("declines a relative path rather than pointing it back at the app", () => {
    expect(externalUrl("/acme/shop-api/pull/482")).toBeUndefined();
    expect(externalUrl("not a url")).toBeUndefined();
  });
});

describe("openExternal", () => {
  const stubGlobal = globalStubs();
  const opened: string[][] = [];
  stubGlobal("window", { open: (...a: string[]) => { opened.push(a); } });

  it("opens an http(s) address in a tab that cannot reach back", () => {
    opened.length = 0;
    expect(openExternal("https://github.com/acme/orbit/pull/7")).toBe(true);
    expect(opened).toEqual([["https://github.com/acme/orbit/pull/7", "_blank", "noopener,noreferrer"]]);
  });

  it("never reaches window.open with a scheme that executes or hands off", () => {
    opened.length = 0;
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "intent://x#Intent;end", "", null]) {
      expect(openExternal(bad), String(bad)).toBe(false);
    }
    expect(opened).toEqual([]);
  });
});
