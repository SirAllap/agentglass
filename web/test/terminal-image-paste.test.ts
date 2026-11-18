// Ctrl+V on a picture in a worker's pane answered "no image found": the CLI
// inside the wall cannot see the clipboard. The app now saves the picture and
// types its path, for workers only.
import { describe, expect, test } from "bun:test";
import { base64Of, pastedImageType, pathPaste, takesImagePaste } from "../src/lib/terminalImagePaste.ts";

describe("a picture pasted into a worker's pane", () => {
  test("only a worker's pane takes it", () => {
    expect(takesImagePaste({ under: "/home/dev/acme-orbit" })).toBe(true);
    expect(takesImagePaste({ startedBy: { kind: "policy" } })).toBe(true);
    expect(takesImagePaste({ worker: { role: "builder", since: 1 } })).toBe(true);
    expect(takesImagePaste({ role: "orchestrator", under: "/home/dev/acme-orbit" })).toBe(false);
    expect(takesImagePaste({})).toBe(false);
    expect(takesImagePaste(undefined)).toBe(false);
  });
  test("text on the clipboard is not a picture", () => {
    expect(pastedImageType(["text/plain", "text/html"])).toBeNull();
    expect(pastedImageType(["text/html", "image/png"])).toBe("image/png");
    expect(pastedImageType(["image/svg+xml"])).toBeNull();
  });
  test("the path is one bracketed paste where the CLI asked for them", () => {
    expect(pathPaste("/tmp/agx-image-1/image.png", true)).toBe("\x1b[200~/tmp/agx-image-1/image.png\x1b[201~");
    expect(pathPaste("/tmp/agx-image-1/image.png", false)).toBe("/tmp/agx-image-1/image.png");
  });
  test("a large picture encodes without overflowing the stack", () => {
    const big = new Uint8Array(300_000).fill(65);
    expect(base64Of(big)).toBe(btoa("A".repeat(300_000)));
  });
});
