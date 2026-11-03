/*
 * The three small pieces the Local and GitHub sources share: the dialog shell,
 * the menu rows and the pane grip. Read as source.
 */
import { describe, expect, it } from "bun:test";

const read = (f: string) => Bun.file(new URL(`../src/components/tasks/${f}`, import.meta.url)).text();
const dialog = await read("TaskDialog.tsx");
const menu = await read("TaskMenu.tsx");
const grip = await read("PaneGrip.tsx");

describe("TaskDialog", () => {
  it("covers the page with a scrim that is no drag region and closes on a press", () => {
    expect(dialog).toContain("NO_DRAG");
    expect(dialog).toContain('className="fixed inset-0"');
    expect(dialog).toContain("onClick={onClose}");
  });
  it("closes on Escape through useDismiss, and not at all when the question must be answered", () => {
    expect(dialog).toContain("useDismiss(true, box, onClose)");
    expect(dialog).toContain("{closable && <CloseButton");
  });
  it("is a modal dialog no wider than the window", () => {
    expect(dialog).toContain('role="dialog" aria-modal="true"');
    expect(dialog).toContain("min(${width}px, 92vw)");
  });
});

describe("TaskMenu", () => {
  it("draws 28px rows with a check for the current choice and red for a destructive one", () => {
    expect(menu).toContain("minHeight: 28");
    expect(menu).toContain("{checked &&");
    expect(menu).toContain('"var(--error-ink)"');
  });
  it("opens a chip's menu on the shared ContextMenu, under the chip", () => {
    expect(menu).toContain("<ContextMenu x={at.x} y={at.y}");
    expect(menu).toContain("r.bottom + 4");
    expect(menu).toContain('aria-haspopup="menu"');
  });
});

describe("PaneGrip", () => {
  it("remembers the width, clamps it and snaps back on a double click", () => {
    expect(grip).toContain("localStorage.setItem(key");
    expect(grip).toContain("Math.max(280");
    expect(grip).toContain("onDoubleClick={pane.reset}");
  });
  it("moves with the arrow keys as well as the pointer", () => {
    expect(grip).toContain('"ArrowLeft"');
    expect(grip).toContain('"ArrowRight"');
    expect(grip).toContain("setPointerCapture");
  });
});
