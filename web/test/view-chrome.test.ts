/*
 * One vocabulary for the controls a view puts in its own chrome.
 *
 * `ViewHeader` fixed the bar's HEIGHT, after five headers written at five
 * different times had drifted enough that switching views made the frame twitch.
 * What it did not fix is what goes IN the bar, so the drift moved one level
 * down: a chip at 11.5px in one panel, 10px in the next, and a segmented control
 * with its own border and inner padding in a third — visibly taller than the
 * chips doing the same job beside it.
 *
 * Reported, in the author's words: "las vistas tienen que tener las secciones
 * homogéneas, que no parezca que estoy en otra app".
 *
 * The canon is not a preference stated here. It is what the panels already
 * agree on, counted across the view files when this was written:
 *
 *     rounded-lg  94   ·   px-2  63   ·   py-1  54   ·   text-[11px]  51
 *
 * So this holds new work to it, and `workspace/Chrome.tsx` is where the shape
 * lives so a view does not have to remember the numbers.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const COMPONENTS = join(import.meta.dir, "..", "src", "components");
const read = (f: string) => readFileSync(join(COMPONENTS, f), "utf8");

/** The files that draw a workspace view's own chrome. */
const VIEWS = [
  "PrPanel.tsx", "TasksPanel.tsx", "GitPanel.tsx", "DockerPanel.tsx",
  "TerminalPanel.tsx", "FilesPanel.tsx", "ChatPanel.tsx", "BrowserPanel.tsx",
  "diff/DiffPage.tsx",
];

/**
 * Sizes a text control in a view's chrome may be set at.
 *
 * Three rather than one because a chip, a secondary chip and a count are not the
 * same object — but 11.5px and 12px and 13px on a button are not a fourth
 * decision, they are three slips, and each one reads as a different app.
 */
const SIZES = new Set(["text-[10px]", "text-[10.5px]", "text-[11px]"]);

/**
 * Buttons that are a form's primary action rather than view chrome.
 *
 * Exempt BY NAME with a reason, the way `spacing-scale.test.ts` handles its own
 * exceptions — which is what turns "off the canon" from something that happens
 * into something somebody decided. A Send button under a message box is not a
 * chip in a toolbar: it is the end of a sentence the user is writing, and it is
 * sized against the field it sits beside.
 */
const EXEMPT: { file: string; match: string; why: string }[] = [
  { file: "TasksPanel.tsx", match: "onClick={onAdd}", why: "the submit of the comment box, sized against the box" },
  { file: "ChatPanel.tsx", match: 'active?.sending ? "Queue ↵"', why: "the submit of the chat composer, sized against the composer" },
];

/** Every `<button>` whose class list looks like a chip: rounded, with padding. */
function chipButtons(src: string, exempt: string[] = []): { line: number; cls: string }[] {
  const out: { line: number; cls: string }[] = [];
  for (const m of src.matchAll(/<button\b((?:[^>]|\n)*?)>/g)) {
    const tag = m[1] ?? "";
    const cls = /className="([^"]*)"/.exec(tag)?.[1];
    if (!cls || !cls.includes("rounded-lg") || !cls.includes("px-")) continue;
    // The exemption is matched against the whole opening tag AND the few lines
    // after it, because what identifies a submit button is often its label.
    const around = src.slice(m.index, (m.index ?? 0) + tag.length + 220);
    if (exempt.some((e) => around.includes(e))) continue;
    out.push({ line: src.slice(0, m.index).split("\n").length, cls });
  }
  return out;
}

describe("the chip a view puts in its chrome", () => {
  it("is one size, in every view", () => {
    const bad: string[] = [];
    for (const v of VIEWS) {
      const exempt = EXEMPT.filter((e) => v.endsWith(e.file)).map((e) => e.match);
      for (const b of chipButtons(read(v), exempt)) {
        for (const size of b.cls.match(/text-\[[0-9.]+px\]/g) ?? []) {
          if (!SIZES.has(size)) bad.push(`${v}:${b.line} ${size}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("has one place that says what the shape is", () => {
    const chrome = read("workspace/Chrome.tsx");
    expect(chrome).toContain('export const CHIP = "text-[11px] px-2 py-1 rounded-lg');
    // And the icon-only sibling takes the app's own target size rather than a
    // fourth opinion about how big a square control is.
    expect(chrome).toContain("width: HIT, height: HIT");
  });

  it("is what the newest view uses, rather than its own copy", () => {
    /* The Diff view is the one that prompted this: it arrived with a local
       `HEAD_BTN`, a local tone helper and a 24px icon button. A view that
       declares its own is a view that will drift again. */
    const s = read("diff/DiffPage.tsx");
    expect(s).toContain('from "../workspace/Chrome.tsx"');
    expect(s).not.toContain("const HEAD_BTN");
  });

  it("does not wrap a set of modes in a box of its own", () => {
    /* The pill around "Uncommitted / Last commit" is what made the control
       taller than the identical set of chips in the pull-request view. The tint
       says which one is on; a border around the group says nothing more, and
       costs 2px of padding plus 2px of border on every edge. */
    const chrome = read("workspace/Chrome.tsx");
    const at = chrome.indexOf("export function Segmented");
    const body = chrome.slice(at, at + 700);
    expect(body).toContain('className="flex items-center gap-1 shrink-0"');
    expect(body).not.toContain("border:");
  });
});
