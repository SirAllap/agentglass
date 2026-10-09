/*
 * Dotted entries in the machine tab.
 *
 * Typing `~/.con` listed nothing and said "36 hidden items left out": the
 * server dropped every dotted name before the typed filter ever saw one. The
 * server now lists them when asked; these pin that the palette asks — for a
 * typed leading dot, and for the persisted toggle — and that a locked row is
 * never opened.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/FilePalette.tsx", import.meta.url)).text();
const api = await Bun.file(new URL("../src/lib/api.ts", import.meta.url)).text();
const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");

describe("the palette asks for hidden entries", () => {
  test("a typed leading dot asks for them without the toggle", () => {
    expect(code).toContain('typedPath?.tail.startsWith(".")');
    expect(code).toContain("api.browse(at, wantHidden)");
  });

  test("the request carries the flag", () => {
    expect(api).toContain('${hidden ? "&hidden=1" : ""}');
  });

  test("the toggle is remembered per user and off by default", () => {
    expect(code).toContain('localStorage.getItem(HIDDEN_KEY) === "1"');
    expect(code).toContain('localStorage.setItem(HIDDEN_KEY, on ? "1" : "0")');
    expect(code).toContain("useState(readHidden)");
  });

  test("the count is the switch", () => {
    expect(code).toContain("aria-pressed={showHidden}");
    expect(code).toContain("left out · show");
  });

  test("a locked row is not opened", () => {
    expect(code).toContain('row.kind !== "recent" && row.locked)) return;');
  });
});
