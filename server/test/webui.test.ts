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

  /**
   * One mark, and no second one about who is asking.
   *
   * `__AGENTGLASS_REMOTE__` was planted for a non-loopback request, and the
   * bundle read it to mount the phone companion instead of the cockpit. The
   * companion is deleted and `main.tsx` no longer forks, so the flag had no
   * reader — and a planted global with no reader is the kind of thing that gets
   * a new one, quietly restoring a fork nobody decided to restore.
   */
  test("nothing is said about where the request came from", () => {
    expect(injectSameOrigin("<html><head></head><body></body></html>")).not.toContain("REMOTE");
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

  /**
   * AGENTGLASS_WEB_DIR, set or unset for the length of one case.
   *
   * `resolveDist`'s first parameter *defaults* to that variable, and in
   * JavaScript passing `undefined` explicitly is precisely what triggers a
   * default parameter — so a case that means "unset" has to actually unset it.
   * It was not doing so, and the variable is exported into every shell on a
   * machine with the desktop app installed: the assertion passed in CI, where
   * nothing sets it, and failed on the one kind of box that ships the thing it
   * is about.
   */
  function withWebDirEnv<T>(value: string | null, fn: () => T): T {
    const saved = process.env.AGENTGLASS_WEB_DIR;
    if (value === null) delete process.env.AGENTGLASS_WEB_DIR;
    else process.env.AGENTGLASS_WEB_DIR = value;
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env.AGENTGLASS_WEB_DIR;
      else process.env.AGENTGLASS_WEB_DIR = saved;
    }
  }

  test("blank and unset fall through to the fallback", () => {
    withWebDirEnv(null, () => {
      expect(resolveDist(undefined, dist)).toBe(dist);
      // A blank string never reached the default anyway — only `undefined`
      // does — but it is the other way the override arrives empty.
      expect(resolveDist("   ", dist)).toBe(dist);
    });
  });

  test("omitted, it reads AGENTGLASS_WEB_DIR — which is what the default is for", () => {
    // The contract the default parameter exists to provide, and which nothing
    // covered: the packaged sidecar passes no argument and is found by the
    // variable the desktop shell exported for it.
    withWebDirEnv(dist, () => {
      expect(resolveDist(undefined, "/nonexistent/fallback")).toBe(dist);
    });
  });

  test("null when neither the override nor the fallback holds a build", () => {
    expect(resolveDist("/nonexistent/override", "/nonexistent/fallback")).toBe(null);
  });
});
