import { describe, expect, test } from "bun:test";
import { fileChooserNote } from "../../web/src/lib/fileChooserNote.ts";

describe("an agent click that opens a file chooser", () => {
  test("becomes a note that names upload and the same id", () => {
    const n = fileChooserNote([
      { method: "Debugger.resumed" },
      { method: "Page.fileChooserOpened", params: { mode: "selectMultiple", backendNodeId: 42 } },
    ], "e17");
    expect(n).not.toBeNull();
    expect(n!.mode).toBe("selectMultiple");
    expect(n!.backendNodeId).toBe(42);
    expect(n!.note).toContain("upload e17");
  });
  test("single mode is the default for an odd mode", () => {
    expect(fileChooserNote([{ method: "Page.fileChooserOpened", params: { mode: "x" } }], "e1")!.mode).toBe("selectSingle");
  });
  test("no chooser event is no note", () => {
    expect(fileChooserNote([{ method: "Page.loadEventFired" }], "e1")).toBeNull();
    expect(fileChooserNote([], "e1")).toBeNull();
  });
});
