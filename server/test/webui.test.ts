// The static UI resolver shares a threat model with git.ts's safeAbs: a
// request path is attacker-supplied, and a miss here serves files from outside
// web/dist. Plus the marker injection api.ts keys same-origin resolution off.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { resolveAsset, injectSameOrigin, resolveDist } from "../src/webui.ts";

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

  // The off-box mark. It decides which application the device gets, so the one
  // thing that must never happen is planting it by default: that would put the
  // phone companion on the desk.
  test("the remote mark is planted only when asked for", () => {
    const local = injectSameOrigin("<html><head></head><body></body></html>");
    expect(local).not.toContain("__AGENTGLASS_REMOTE__");

    const remote = injectSameOrigin("<html><head></head><body></body></html>", true);
    expect(remote).toContain("window.__AGENTGLASS_REMOTE__=true");
    expect(remote.indexOf("__AGENTGLASS_REMOTE__")).toBeLessThan(remote.indexOf("</head>"));
    // Both marks, and the same-origin one still first.
    expect(remote.indexOf("__AGENTGLASS_SAME_ORIGIN__")).toBeLessThan(remote.indexOf("__AGENTGLASS_REMOTE__"));
  });

  test("headless html carries the remote mark too", () => {
    expect(injectSameOrigin("<div/>", true)).toContain("__AGENTGLASS_REMOTE__");
  });
});

// AGENTGLASS_WEB_DIR: the override that lets the packaged desktop sidecar find
// the dashboard at all. Without it a compiled binary looks for web/dist beside
// its own source file, which inside `bun build --compile` is a virtual path
// that has never existed — so the app could expose a port to a phone and serve
// it nothing but JSON.
describe("resolveDist", () => {
  test("prefers the override when it holds a real build", () => {
    expect(resolveDist(dist, "/nonexistent/fallback")).toBe(dist);
  });

  test("resolves a relative override to an absolute path", () => {
    expect(resolveDist(relative(process.cwd(), dist), "/nonexistent/fallback")).toBe(dist);
  });

  test("an override with no index.html is ignored rather than fatal", () => {
    // A wrong path should cost the UI, not the server behind it.
    const empty = mkdtempSync(join(tmpdir(), "agentglass-webui-empty-"));
    try {
      expect(resolveDist(empty, dist)).toBe(dist);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("blank and unset fall through to the fallback", () => {
    expect(resolveDist(undefined, dist)).toBe(dist);
    expect(resolveDist("   ", dist)).toBe(dist);
  });

  test("null when neither the override nor the fallback holds a build", () => {
    expect(resolveDist("/nonexistent/override", "/nonexistent/fallback")).toBe(null);
  });
});
