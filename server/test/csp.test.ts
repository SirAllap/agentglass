// The lock on the Content-Security-Policy, and on the two copies of it.
//
// The policy is enforcing now, which turns two previously harmless edits into
// a blank window: changing the inline splash in web/index.html without
// rehashing it, and changing one origin's directives without the other's. The
// first is a whole-app outage that no other test can see (the hash lives in a
// string, the script lives in HTML, and nothing links them at build time); the
// second is the quieter one — the desktop shell keeps a verbatim copy of the
// list because electron/package.json's `files` allowlist means it cannot import
// shared/csp.ts, so the copy has to be checked rather than trusted.
//
// So this file recomputes every hash from the real bytes and reparses the
// desktop copy out of electron/main.js. It never hard-codes a hash of its own:
// a test that repeats the constant only proves the constant was copied twice.
import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  CSP, CSP_DIRECTIVES, BOOT_SCRIPT_SHA256, SAME_ORIGIN_MARKER_SHA256,
  SECURITY_HEADERS, DOCUMENT_SECURITY_HEADERS,
} from "../../shared/csp.ts";
import { injectSameOrigin } from "../src/webui.ts";

const REPO = resolve(import.meta.dir, "../..");

/** A CSP hash source is the exact bytes BETWEEN the tags — not the tag, not the
 *  file, and not a trimmed version of either. */
const cspHash = (script: string): string =>
  `'sha256-${createHash("sha256").update(script, "utf8").digest("base64")}'`;

/** Every inline <script> in a document, in order. `src=` ones are fetched, not
 *  inlined, and a hash never applies to them. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

/** The directive by name, without its name. */
const directive = (name: string): string =>
  CSP_DIRECTIVES.find((d) => d.startsWith(name + " "))?.slice(name.length + 1) ?? "";

describe("the hashes name the scripts that are actually inline", () => {
  test("web/index.html's splash is the one inline script, and it is hashed", () => {
    const scripts = inlineScripts(readFileSync(join(REPO, "web/index.html"), "utf8"));
    // More than one would mean somebody added an inline the policy has never
    // heard of — which is the same blank window by a different route.
    expect(scripts).toHaveLength(1);
    expect(cspHash(scripts[0])).toBe(BOOT_SCRIPT_SHA256);
  });

  test("the built copy of it hashes the same", () => {
    // vite copies the tag through untouched, and this is the assertion that
    // says so out loud: if a future build step ever minifies inline HTML
    // scripts, source and build stop agreeing and only the build matters.
    const built = join(REPO, "web/dist/index.html");
    if (!existsSync(built)) return; // no build in this checkout; the source case above still holds
    const scripts = inlineScripts(readFileSync(built, "utf8"));
    expect(scripts).toHaveLength(1);
    expect(cspHash(scripts[0])).toBe(BOOT_SCRIPT_SHA256);
  });

  test("the single-port marker the server plants is hashed too", () => {
    // Taken from the injector rather than retyped: the marker is one string in
    // one place, and this is that place asked what it emits.
    const scripts = inlineScripts(injectSameOrigin("<html><head></head><body></body></html>"));
    expect(scripts).toHaveLength(1);
    expect(cspHash(scripts[0])).toBe(SAME_ORIGIN_MARKER_SHA256);
  });

  test("script-src names both hashes and nothing loose", () => {
    const src = directive("script-src");
    expect(src).toContain(BOOT_SCRIPT_SHA256);
    expect(src).toContain(SAME_ORIGIN_MARKER_SHA256);
    // The two escape hatches that would make every hash above decorative.
    expect(src).not.toContain("'unsafe-inline'");
    expect(src).not.toContain("'unsafe-eval'");
  });
});

describe("the desktop shell's copy of the policy", () => {
  const main = readFileSync(join(REPO, "electron/main.js"), "utf8");

  test("is byte-identical to the shared one", () => {
    const body = /const CSP = \[([\s\S]*?)\n\]\.join\("; "\);/.exec(main);
    expect(body).not.toBeNull();
    // Evaluated rather than string-matched so the comments between the entries
    // survive — they are half of why that list is readable.
    const directives = new Function(`return [${body![1]}]`)() as string[];
    expect(directives).toEqual([...CSP_DIRECTIVES]);
    expect(directives.join("; ")).toBe(CSP);
  });

  test("sends it enforcing, not Report-Only", () => {
    expect(main).toContain('"content-security-policy": CSP');
    // The COOP stripper further down legitimately mentions a -report-only
    // header, so this looks for the CSP one by name.
    expect(main).not.toContain("content-security-policy-report-only");
  });
});

describe("what the HTTP origin actually puts on the wire", () => {
  // The dist the sidecar serves is chosen once, at import time, from
  // AGENTGLASS_WEB_DIR — so proving the headers reach a real Response means
  // importing webui.ts in a process where that variable is already set. A child
  // process is the only honest way to do that from inside a suite that has
  // already imported it.
  function headersFrom(expr: string): Record<string, string> {
    const dist = mkdtempSync(join(tmpdir(), "agentglass-csp-"));
    writeFileSync(join(dist, "index.html"), "<html><head></head><body></body></html>");
    writeFileSync(join(dist, "app.js"), "// js");
    try {
      const r = Bun.spawnSync({
        cmd: ["bun", "-e", `
          const m = await import("${resolve(REPO, "server/src/webui.ts")}");
          const res = ${expr};
          console.log(JSON.stringify(Object.fromEntries(res.headers)));
        `],
        env: { ...process.env, AGENTGLASS_WEB_DIR: dist },
        cwd: resolve(REPO, "server"),
      });
      const out = r.stdout.toString().trim();
      if (r.exitCode !== 0 || !out) throw new Error(`probe failed (${r.exitCode}): ${r.stderr.toString()}`);
      return JSON.parse(out.split("\n").pop()!);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  }

  test("the document carries the policy and the companion headers", () => {
    const h = headersFrom("m.serveIndex({})");
    expect(h["content-security-policy"]).toBe(CSP);
    for (const [name, value] of Object.entries(DOCUMENT_SECURITY_HEADERS)) {
      expect(h[name.toLowerCase()]).toBe(value);
    }
  });

  test("assets carry the companion headers (the policy binds to the document)", () => {
    const h = headersFrom('m.serveWeb("/app.js", {})');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(h[name.toLowerCase()]).toBe(value);
    }
  });

  test("a CORS header cannot displace the policy", () => {
    // Security headers are merged last on purpose; this is that ordering, held.
    const h = headersFrom('m.serveIndex({ "Content-Security-Policy": "default-src *" })');
    expect(h["content-security-policy"]).toBe(CSP);
  });
});

/*
 * The pictures come from the sidecar, not from GitHub.
 *
 * Reported as "we don't have the avatar images… I don't know whether we touched
 * something ourselves and broke it". We had: this policy went from Report-Only to
 * enforcing, and `img-src` named the two GitHub hosts but not the loopback the
 * API lives on. The desktop renderer is served from `agentglass://app`, so
 * `'self'` is that scheme — and every avatar is
 * `http://127.0.0.1:<port>/prs/asset?url=…`, the allowlisted proxy that fetches
 * GitHub on the page's behalf. The page never reaches github at all.
 *
 * Measured A/B in headless Chromium against the real proxy (200, image/jpeg,
 * 1146 bytes): without the loopback the <img> ends at naturalWidth 0 with an
 * error event; with it, 48.
 */
describe("the proxied pictures", () => {
  test("the sidecar is an image source, on both copies of the policy", () => {
    // The shared copy, and the one electron/main.js carries for the packaged
    // app — the test above this one already fails on any drift between them,
    // so this asserts the directive rather than the file it lives in.
    expect(directive("img-src")).toContain("http://127.0.0.1:*");
    expect(directive("img-src")).toContain("http://localhost:*");
    const desktop = readFileSync(join(REPO, "electron/main.js"), "utf8");
    expect(desktop).toContain("img-src 'self' data: blob: http://127.0.0.1:* http://localhost:*");
  });

  test("and it is images only — the token still cannot leave the machine", () => {
    /* connect-src is the load-bearing one: an injected script may reach this
       app and its own sidecar and nothing else. Widening img-src does not
       widen that, and this test is here so a future edit cannot quietly do it
       by copying the line. */
    const connect = directive("connect-src");
    expect(connect).not.toContain("https://");
    expect(CSP).toContain("object-src 'none'");
  });
});
