/*
 * A catalogue entry and a manifest are a stranger's strings. Three rules, each
 * aimed at a hostile fixture: an entry installs only at a full 40-hex commit;
 * a link opens only as https:; a picture loads only as https: or a raster
 * data: image (never svg, never script).
 */
import { describe, expect, test } from "bun:test";
import { validateCatalogue } from "../src/plugin-catalogue.ts";
import { httpsLink, pinnedRefError, previewSrc } from "../../shared/pluginSafe.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const entry = (over: Record<string, unknown> = {}) => ({
  id: "orbit-clock", description: "Puts the time in a panel.", categories: [],
  source: { kind: "git", url: "https://github.com/acme/orbit-clock", ref: SHA }, ...over,
});
const listed = (e: unknown) => {
  const c = validateCatalogue({ name: "orbit", owner: "acme", plugins: [e] });
  return typeof c === "string" ? c : c.plugins;
};

describe("rule 1: an entry pins a full commit", () => {
  test.each([null, undefined, "main", "v1.0.0", "HEAD", "0123456", SHA.toUpperCase(), SHA + "0", `-${SHA.slice(1)}`, `${SHA}\n`, 7])(
    "ref %p is refused", (ref) => {
      expect(pinnedRefError(ref)).not.toBeNull();
      expect(listed(entry({ source: { kind: "git", url: "https://github.com/acme/orbit-clock", ref } }))).toEqual([]);
    });
  test("a 40-hex ref is listed as written", () => {
    expect(pinnedRefError(SHA)).toBeNull();
    const p = listed(entry());
    expect(Array.isArray(p) && p[0]!.source.ref).toBe(SHA);
  });
});

describe("rule 2: links are https only", () => {
  test.each(["javascript:alert(1)", "data:text/html,<script>1</script>", "http://acme.test/x", "file:///etc/passwd", "//acme.test/x", "https://u:p@acme.test/x", " ", "", null, 5])(
    "%p is not a link", (raw) => expect(httpsLink(raw)).toBeUndefined());
  test("https passes", () => expect(httpsLink("https://github.com/acme/orbit-clock")).toBe("https://github.com/acme/orbit-clock"));
});

describe("rule 3: a picture is https or a raster data: image", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  test.each([
    "javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "data:image/svg+xml,<svg onload=alert(1)>",
    "data:text/html;base64,PHNjcmlwdD4=", "data:image/png,not-base64", "data:image/png;base64,AA\"onerror=\"x", "http://acme.test/p.png", "https://a b/p.png", null,
  ])("%p is refused", (raw) => {
    expect(previewSrc(raw)).toBeUndefined();
    expect(listed(entry({ preview: raw }))).toEqual([expect.not.objectContaining({ preview: expect.anything() })]);
  });
  test("an https .svg path is refused, case and query aside", () => {
    for (const bad of ["https://acme.test/p.svg", "https://acme.test/p.SVG", "https://acme.test/p.svg?x=1", "https://acme.test/p.svg#a"]) expect(previewSrc(bad)).toBeUndefined();
    expect(previewSrc("https://acme.test/p.png?name=a.svg")).toBe("https://acme.test/p.png?name=a.svg");
  });
  test("https, png, jpeg and webp pass", () => {
    for (const ok of ["https://raw.githubusercontent.com/acme/orbit-clock/" + SHA + "/preview.png", png, "data:image/jpeg;base64,/9j/4AAQ", "data:image/webp;base64,UklGRg=="]) expect(previewSrc(ok)).toBe(ok);
  });
});
