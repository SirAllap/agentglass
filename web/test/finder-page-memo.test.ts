/*
 * A page preview with its pictures is built once, lighter, and stops when left.
 *
 * What went wrong: a page beside 22 screenshots of 0.6 MB became about 18 MB of
 * base64 in the frame's srcdoc, every picture at full size (the widest 4774 by
 * 1072), rebuilt from 22 reads each time the page was selected; a selection
 * that had moved on did not stop the reads.
 */
import { describe, expect, test } from "bun:test";
import {
  PAGE_CSP, PAGE_IMAGE_SHRINK_MIN_BYTES, PAGE_MEMO_MS,
  makePageMemo, pageDocKey, pageImageShrink,
} from "../src/lib/finderPreview.ts";

const body = await Bun.file(new URL("../src/components/finder/machine/PreviewBody.tsx", import.meta.url)).text();
const apiSrc = await Bun.file(new URL("../src/lib/api.ts", import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => { const t = l.trim(); return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); }).join("\n");
/** A function's own text, from its name to its closing brace at the start of a line. */
const fn = (src: string, head: string) => { const at = src.indexOf(head); expect(at).toBeGreaterThan(-1); return src.slice(at, src.indexOf("\n}\n", at) + 2); };

describe("which pictures are drawn down before they go into the page", () => {
  test("a large screenshot or photo, in its own format", () => {
    expect(pageImageShrink("image/png", 600_000)).toEqual({ type: "image/png" });
    expect(pageImageShrink("image/jpeg", 600_000)).toEqual({ type: "image/jpeg", quality: 0.85 });
    expect(pageImageShrink("image/webp", 600_000)).toEqual({ type: "image/webp", quality: 0.9 });
  });
  test("not a small one, and never an animation or a drawing", () => {
    expect(pageImageShrink("image/png", PAGE_IMAGE_SHRINK_MIN_BYTES - 1)).toBeNull();
    expect(pageImageShrink("image/gif", 600_000)).toBeNull();
    expect(pageImageShrink("image/svg+xml", 600_000)).toBeNull();
  });
});

describe("the built page is kept", () => {
  const key = pageDocKey("/home/acme/orbit/report.html", 1000, 4096);
  test("the key changes when the page file does", () => {
    expect(pageDocKey("/home/acme/orbit/report.html", 1000, 4096)).toBe(key);
    expect(pageDocKey("/home/acme/orbit/report.html", 1001, 4096)).not.toBe(key);
    expect(pageDocKey("/home/acme/orbit/report.html", 1000, 4097)).not.toBe(key);
    expect(pageDocKey("/home/acme/orbit/other.html", 1000, 4096)).not.toBe(key);
  });
  test("the same page again is answered without a read", () => {
    const m = makePageMemo();
    expect(m.get(key, 0)).toBeUndefined();
    m.set(key, "<p>built</p>", 0);
    expect(m.get(key, 5_000)).toBe("<p>built</p>");
  });
  test("only the last page, so the megabytes held are one page's", () => {
    const m = makePageMemo();
    m.set(key, "one", 0);
    m.set("other", "two", 0);
    expect(m.get(key, 1)).toBeUndefined();
    expect(m.get("other", 1)).toBe("two");
  });
  test("and only while fresh: a picture replaced beside the page shows after that", () => {
    const m = makePageMemo();
    m.set(key, "old", 0);
    expect(m.get(key, PAGE_MEMO_MS)).toBe("old");
    expect(m.get(key, PAGE_MEMO_MS + 1)).toBeUndefined();
  });
});

describe("the frame's wiring", () => {
  const frame = code(fn(body, "function HtmlFrame("));
  const reads = code(fn(body, "async function readPageImages("));
  test("a kept page skips the read", () => {
    expect(frame).toContain("if (!ok || kept !== undefined) return;");
  });
  test("leaving the page aborts the text request and the picture reads", () => {
    expect(frame).toContain("api.previewText(path, HTML_RENDER_MAX_BYTES, leave.signal)");
    expect(frame).toContain("readPageImages(r.text, path, leave.signal)");
    expect(frame).toContain("return () => leave.abort();");
    expect(reads).toContain("fetch(api.previewUrl(path), { signal })");
    expect(code(apiSrc)).toMatch(/previewText: async \(path: string, cap: number, signal\?: AbortSignal\)[^\n]*\n[^\n]*\n[^\n]*headers: authHeaders\(\), signal \}/);
  });
  test("the text is on screen before the pictures are asked for", () => {
    const text = frame.indexOf("setDoc(plain);");
    const wait = frame.indexOf("setTimeout(go, PAGE_IMAGES_AFTER_MS)");
    const read = frame.indexOf("readPageImages(");
    expect(text).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(text);
    expect(read).toBeGreaterThan(wait);
  });
  test("the pictures are read a few at a time, and a drawn-down one is used only when lighter", () => {
    expect(reads).toContain("makeGate(PAGE_IMAGE_PARALLEL)");
    expect(reads).toContain("small && small.size < read.size ? small : read");
  });
  test("the frame's policy is not widened to do it", () => {
    expect(PAGE_CSP).toContain("img-src data:;");
    expect(PAGE_CSP).not.toContain("blob:");
    expect(frame).toContain('sandbox=""');
  });
});
