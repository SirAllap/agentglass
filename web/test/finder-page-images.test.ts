// A report page with its screenshots beside it drew every screenshot as alt
// text: the closed frame may fetch nothing. The app now reads the pictures in
// the page's own folder and hands them over as data: URIs.
import { describe, expect, test } from "bun:test";
import { isolatedDoc, pageImages, siblingPath, withPageImages, PAGE_IMAGE_MAX, PAGE_CSP } from "../src/lib/finderPreview.ts";

const page = "/home/dev/reports/acme-orbit/INDEX.html";

describe("pictures beside a rendered page", () => {
  test("a file name beside the page resolves into the page's folder", () => {
    expect(siblingPath(page, "01-window.png")).toBe("/home/dev/reports/acme-orbit/01-window.png");
    expect(siblingPath(page, "./img/two%20cards.png?v=2#top")).toBe("/home/dev/reports/acme-orbit/img/two cards.png");
  });
  test("the network, an absolute path and a climb out of the folder are refused", () => {
    for (const src of ["https://example.com/a.png", "//example.com/a.png", "/etc/passwd", "../secret.png", "img/../../x.png", "data:image/png;base64,AA", "file:///etc/passwd", "", "%E0%A4%A"])
      expect(siblingPath(page, src)).toBeNull();
  });
  test("each distinct local picture once, in order, under the cap", () => {
    const html = `<img alt="a" src="a.png"><IMG src='b.png'><img src="a.png"><img src="https://example.com/c.png">`;
    expect(pageImages(html, page).map((i) => i.src)).toEqual(["a.png", "b.png"]);
    const many = Array.from({ length: PAGE_IMAGE_MAX + 5 }, (_, i) => `<img src="${i}.png">`).join("");
    expect(pageImages(many, page).length).toBe(PAGE_IMAGE_MAX);
  });
  test("a read picture replaces its name, an unread one is left as written, and the policy still allows only data:", () => {
    const html = `<p><img alt="a" src="a.png"><img src='b.png'></p>`;
    const out = withPageImages(html, new Map([["a.png", "data:image/png;base64,AAAA"]]));
    expect(out).toBe(`<p><img alt="a" src="data:image/png;base64,AAAA"><img src='b.png'></p>`);
    expect(isolatedDoc(out)).toContain(PAGE_CSP);
    expect(PAGE_CSP).toContain("img-src data:");
  });
});
