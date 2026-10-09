/*
 * The finder as a browser, not only as a search box.
 *
 * Two of these are about drawing a path as pieces you can jump to, and one is
 * the fix for the report that started this: opening a `.png` from the finder
 * sent it to the floating nvim modal — a modal nobody asked for, showing a
 * binary nobody can read.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { humanBytes, FilePalette } from "../src/components/FilePalette.tsx";
import { Preview } from "../src/components/finder/Preview.tsx";

describe("sizes in a listing", () => {
  test("scanned, not audited", () => {
    expect(humanBytes(284_000)).toBe("284 KB");
    expect(humanBytes(1_900_000_000)).toBe("1.9 GB");
    expect(humanBytes(512)).toBe("512 B");
  });
});

describe("the pane that shows what a row is", () => {
  test("nothing selected says so instead of drawing an empty box", () => {
    const html = renderToStaticMarkup(React.createElement(Preview, { path: null }));
    expect(html).toContain("Nothing selected");
  });

  test("a path with no facts yet is a spinner, not a blank", () => {
    // First paint, before the engine has answered. There is no DOM here so the
    // effect never runs, which is exactly the state this asserts.
    const html = renderToStaticMarkup(React.createElement(Preview, { path: "/home/dev/Documents/a.png" }));
    expect(html).toContain("agx-spin");
  });
});

describe("the palette still draws", () => {
  test("closed, and open with nothing fetched", () => {
    // The finder grew a browse mode, a preview pane and a query parser in one
    // pass; this is the assertion that the component still renders at all.
    expect(() => renderToStaticMarkup(React.createElement(FilePalette, {
      open: false, onClose: () => {}, onOpenFile: () => {}, onRevealDir: () => {},
    }))).not.toThrow();
    expect(() => renderToStaticMarkup(React.createElement(FilePalette, {
      open: true, onClose: () => {}, onOpenFile: () => {}, onRevealDir: () => {},
    }))).not.toThrow();
  });
});

describe("what must never reach a text editor", () => {
  /* The report: "this floating modal opens when trying to open it… I never
     asked for that". The list of formats lives in the component; this pins that the
     ones somebody actually has on disk are on it, because the failure is
     invisible until you press Enter on a screenshot. */
  const source = require("node:fs").readFileSync(new URL("../src/components/FilePalette.tsx", import.meta.url).pathname, "utf8");
  const IMAGEY = /const IMAGEY = (\/.+\/i);/.exec(source)?.[1];

  test("the pattern is still there to be tested", () => {
    expect(IMAGEY).toBeTruthy();
  });

  test("every picture, video, sound and pdf", () => {
    const re = eval(IMAGEY!) as RegExp;   // eslint-disable-line no-eval
    for (const name of [
      "01-task.png", "shot.JPG", "photo.jpeg", "anim.gif", "icon.svg", "pic.webp", "new.avif",
      "old.bmp", "fav.ico", "scan.tiff", "phone.heic", "art.psd", "camera.cr2", "doc.pdf",
      "clip.mp4", "clip.webm", "song.mp3", "voice.opus",
    ]) {
      expect(re.test(name)).toBe(true);
    }
  });

  test("and nothing that is actually text", () => {
    const re = eval(IMAGEY!) as RegExp;   // eslint-disable-line no-eval
    for (const name of ["notes.md", "main.ts", "Makefile", "data.json", "styles.css", "README"]) {
      expect(re.test(name)).toBe(false);
    }
  });
});
