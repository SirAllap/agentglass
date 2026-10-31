import { describe, expect, test } from "bun:test";

const read = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();
const hook = await read("lib/focusTrap.ts");
const panel = await read("components/PrPanel.tsx");
const people = await read("components/PeoplePick.tsx");
const peek = await read("components/PeekFile.tsx");

// A menu portalled to the end of the body is reachable by Tab only after the whole page, so each
// one owes a keyboard the same four things: focus in, arrows, Esc, focus back.
describe("usePopoverKeys", () => {
  const body = hook.slice(hook.indexOf("export function usePopoverKeys("));
  test("focuses in, walks with the arrows, closes on Esc and gives focus back", () => {
    expect(body).toContain("?.focus()");
    expect(body).toContain('"ArrowRight"');
    expect(body).toContain('"Escape"');
    expect(body).toContain("opener.focus()");
  });
  test("leaves Esc and the arrows to a text field", () => {
    expect(body).toContain("if (field) return;");
    expect(body).toContain('e.key === "Escape" && !field');
  });
});

describe("the portalled menus use it", () => {
  test("files filter, reaction picker, people picker and the viewer's reading mode", () => {
    expect(panel.match(/usePopoverKeys\(menuRef, \(\) => setOpen\(false\), open\)/g)?.length).toBe(2);
    expect(panel).toContain('<div ref={menuRef} role="menu"');
    expect(people).toContain("usePopoverKeys(box, p.onClose)");
    expect(peek).toContain("usePopoverKeys(dialogRef, onClose, reading)");
  });
});

describe("two keys that were taken from the control that had focus", () => {
  test("Enter in the Files frame folds a file only when no button or link holds the focus", () => {
    expect(panel).toContain('e.key === "Enter" && !(e.target as HTMLElement).closest?.("button, a, summary, [role=\'menuitem\']")');
  });
  test("the prompt options button is a menu item, so the arrows reach it inside its menu", async () => {
    expect(await read("components/PromptOptions.tsx")).toContain('<button ref={box} type="button" role="menuitem"');
  });
});

describe("the name box of a saved view", () => {
  test("opens under its button, left aligned, and its text is selected when the popover takes focus", async () => {
    const bar = await read("components/PrViewsBar.tsx");
    expect(bar).toMatch(/<Pop anchor=\{panel\.anchor\} onClose=\{\(\) => setPanel\(null\)\} width=\{260\} label=\{panel\.kind === "new"/);
    expect(hook).toContain("first instanceof HTMLInputElement) first.select()");
  });
});

describe("the Files frame and the tab strip", () => {
  test("the frame takes focus on mount except from the tab strip, so ArrowRight onto Files can go on to Checks", () => {
    expect(panel).toContain(`if (!document.activeElement?.closest("[role='tablist']")) frameRef.current?.focus();`);
  });
});

describe("full screen and back", () => {
  test("hand the focus to the selected card when the swap left it on <body>", () => {
    expect(panel).toContain("if (document.activeElement !== document.body) return;");
    expect(panel).toContain("`[data-pr='${n}']`");
    expect(panel).toContain("button[aria-label='Restore the side dock']");
  });
});
