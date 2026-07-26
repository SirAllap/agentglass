import { describe, expect, it } from "bun:test";
import { externalUrl } from "../src/lib/externalUrl.ts";

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
