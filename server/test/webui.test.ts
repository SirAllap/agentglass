// The static UI resolver shares a threat model with git.ts's safeAbs: a
// request path is attacker-supplied, and a miss here serves files from outside
// web/dist. Plus the marker injection api.ts keys same-origin resolution off.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveAsset, injectSameOrigin } from "../src/webui.ts";

let dist: string;

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), "agentglass-webui-"));
  writeFileSync(join(dist, "index.html"), "<html><head></head><body></body></html>");
  writeFileSync(join(dist, "favicon.svg"), "<svg/>");
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "assets", "index-CAFE1234.js"), "//js");
  // A file that lives NEXT TO dist — what a traversal would reach.
  writeFileSync(join(dist, "..", "agentglass-webui-outside.txt"), "secret");
});

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
  rmSync(join(dist, "..", "agentglass-webui-outside.txt"), { force: true });
});

describe("resolveAsset", () => {
  test("maps / and real files under dist", () => {
    expect(resolveAsset("/", dist)).toBe(resolve(dist, "index.html"));
    expect(resolveAsset("/index.html", dist)).toBe(resolve(dist, "index.html"));
    expect(resolveAsset("/favicon.svg", dist)).toBe(resolve(dist, "favicon.svg"));
    expect(resolveAsset("/assets/index-CAFE1234.js", dist)).toBe(resolve(dist, "assets", "index-CAFE1234.js"));
  });

  test("misses (API routes, unknown files, directories) are null", () => {
    expect(resolveAsset("/stats", dist)).toBe(null);
    expect(resolveAsset("/git/status", dist)).toBe(null);
    expect(resolveAsset("/assets", dist)).toBe(null); // a directory, not a file
    expect(resolveAsset("/nope.js", dist)).toBe(null);
  });

  test("traversal cannot escape dist, encoded or not", () => {
    for (const p of [
      "/../agentglass-webui-outside.txt",
      "/assets/../../agentglass-webui-outside.txt",
      "/%2e%2e/agentglass-webui-outside.txt",
      "/..%2fagentglass-webui-outside.txt",
      "/assets/%2e%2e%2f%2e%2e%2fagentglass-webui-outside.txt",
    ]) {
      expect(resolveAsset(p, dist)).toBe(null);
    }
  });

  test("malformed escapes and NUL bytes are refused, not thrown", () => {
    expect(resolveAsset("/%zz", dist)).toBe(null);
    expect(resolveAsset("/index.html%00.js", dist)).toBe(null);
  });

  test("a null dist (no build) resolves nothing", () => {
    expect(resolveAsset("/index.html", null)).toBe(null);
  });
});

describe("injectSameOrigin", () => {
  test("plants the marker inside <head>", () => {
    const out = injectSameOrigin("<html><head><title>x</title></head><body></body></html>");
    expect(out).toContain("window.__AGENTGLASS_SAME_ORIGIN__=true");
    expect(out.indexOf("__AGENTGLASS_SAME_ORIGIN__")).toBeLessThan(out.indexOf("</head>") + "</head>".length);
    // Everything else survives untouched.
    expect(out).toContain("<title>x</title>");
    expect(out).toContain("<body></body>");
  });

  test("headless html still gets the marker (prepended)", () => {
    expect(injectSameOrigin("<div/>").startsWith("<script>")).toBe(true);
  });
});
