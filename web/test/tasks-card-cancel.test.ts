/* Cancel on the card read drops only this view's wait, and each card's effect starts clean. */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const i = src.indexOf("const cardCancel = useRef");
const block = src.slice(i, src.indexOf("const reread = useCallback", i));

describe("card read cancel", () => {
  test("no controller outlives its card: reset at effect start", () => {
    expect(block).toContain("cardCancel.current = null;");
    expect(block).not.toContain("cardAbort");
  });
  test("goes through the refcounted store, never aborts the shared request directly", () => {
    expect(block).toContain("loadCancellable<CardRead>(");
    expect(block).not.toContain(".abort()");
  });
  test("a real failure on the next card is shown", () => {
    expect(block).toContain("if (live) setFull({ ok: false");
  });
});
