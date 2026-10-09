/*
 * How the finder's centre pane shows a file, and what the rail offers for it.
 * Opening a search result used to hand every non-markdown file to a bench tab,
 * so glancing at a `.py` cost the search; these pin that each kind has a face
 * of its own and that the bench is an offer, not the destination.
 */
import { describe, expect, test } from "bun:test";
import { outline, typeLabel, viewerActions, viewerKind } from "../src/lib/finderViewer.ts";

describe("viewerKind", () => {
  test("prose is a document however it was sniffed", () => {
    expect(viewerKind("retry-policy.md", "text")).toBe("markdown");
    expect(viewerKind("NOTES.MDX")).toBe("markdown");
  });
  test("code is shown as code, not sent to an editor", () => {
    expect(viewerKind("retry.py", "text")).toBe("code");
    expect(viewerKind("Makefile", "text")).toBe("code");
  });
  test("a page shows its source and is offered in the browser", () => {
    expect(viewerKind("mock-a.html", "text")).toBe("html");
  });
  test("what the bytes say wins over the name for media", () => {
    expect(viewerKind("shot.png", "image")).toBe("image");
    expect(viewerKind("shot.heic", "image-convert")).toBe("image");
    expect(viewerKind("spec.pdf", "pdf")).toBe("pdf");
    expect(viewerKind("blob.bin", "binary")).toBe("binary");
    expect(viewerKind("src", "dir")).toBe("dir");
    // a .md that is really a binary is not rendered as a document
    expect(viewerKind("x.md", "binary")).toBe("binary");
  });
});

describe("viewerActions", () => {
  test("the bench is for what an editor can open", () => {
    expect(["markdown", "code", "html"].map((k) => viewerActions(k as never).bench)).toEqual([true, true, true]);
    expect(["image", "pdf", "video", "binary", "dir"].some((k) => viewerActions(k as never).bench)).toBe(false);
  });
  test("the browser is for pages, pictures and PDFs only", () => {
    expect(["html", "image", "pdf"].every((k) => viewerActions(k as never).browser)).toBe(true);
    expect(["markdown", "code", "video", "binary"].some((k) => viewerActions(k as never).browser)).toBe(false);
  });
});

describe("outline", () => {
  test("markdown headings by level, skipping fenced code", () => {
    const md = "# Retry policy\ntext\n## Why retry\n```sh\n# not a heading\n```\n## Backoff\n";
    expect(outline(md, "markdown", "a.md")).toEqual([
      { label: "Retry policy", line: 1, level: 1 }, { label: "Why retry", line: 3, level: 2 }, { label: "Backoff", line: 7, level: 2 },
    ]);
  });
  test("python definitions, nested by indent", () => {
    const py = "def retry_call(a):\n    pass\nclass RetryPolicy:\n    def __init__(self):\n        pass\n    async def run(self):\n        pass\n";
    expect(outline(py, "code", "retry.py").map((o) => [o.label, o.line, o.level])).toEqual([
      ["retry_call", 1, 1], ["RetryPolicy", 3, 1], ["__init__", 4, 2], ["run", 6, 2],
    ]);
  });
  test("typescript and shell, and an unknown language has no outline", () => {
    expect(outline("export async function go() {}\nexport interface Row {}\n", "code", "a.ts").map((o) => o.label)).toEqual(["go", "Row"]);
    expect(outline("build() {\n}\n", "code", "x.sh").map((o) => o.label)).toEqual(["build"]);
    expect(outline("a: 1\n", "code", "x.yml")).toEqual([]);
  });
});

describe("typeLabel", () => {
  test("a language by extension, with the encoding for text", () => {
    expect(typeLabel("retry.py", "code")).toBe("Python \u00b7 UTF-8");
    expect(typeLabel("retry-policy.md", "markdown")).toBe("Markdown \u00b7 UTF-8");
    expect(typeLabel("Makefile", "code")).toBe("Makefile \u00b7 UTF-8");
  });
  test("media has no encoding, and an unknown file falls back to what the server sniffed", () => {
    expect(typeLabel("01-home.png", "image")).toBe("PNG image");
    expect(typeLabel("blob.xyz", "binary", "application/octet-stream")).toBe("application/octet-stream");
    expect(typeLabel("blob.xyz", "binary")).toBe("File");
  });
});
