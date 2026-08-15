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
  // The git view's own pieces, which are chrome by any other name: they draw
  // the buttons on every row of four sections.
  "git/ui.tsx", "GitPalette.tsx", "GitRowMenu.tsx", "CheckoutPicker.tsx",
];

/**
 * The views whose FIRST control — the one in the top-left corner — has to be
 * the same object in each.
 *
 * Reported with five screenshots side by side: "son todos diferentes". They
 * were: a rounded-lg at 11px with an 8.5px badge, a rounded-md at 10px, a
 * rounded-full at 11px with px-3, a rounded-lg at 11px with px-2.5, and the
 * segmented chips. Four shapes, three heights and three radii for one job —
 * which view you are in should not be legible from the geometry of its buttons.
 */
const HEADED = ["PrPanel.tsx", "TasksPanel.tsx", "TerminalPanel.tsx", "diff/DiffPage.tsx", "CheckoutPicker.tsx"];

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
  { file: "PrPanel.tsx", match: "onClick={copyNumber}", why: "the PR number inside a 14px title line — it is sized against the heading it sits in, not against a toolbar" },
  { file: "ChatPanel.tsx", match: "pointer-events-auto mb-2", why: "a floating badge over the transcript, not a control in the chrome — a full radius is what tells it apart from the toolbar" },
];

/** Every `<button>` whose class list looks like a chip: rounded, with padding. */
function chipButtons(src: string, exempt: string[] = []): { line: number; cls: string }[] {
  const out: { line: number; cls: string }[] = [];
  // `[^>]` already matches a newline, so spelling the alternation out gave the
  // engine two ways to consume one — which is the shape that backtracks
  // exponentially on a tag that never closes.
  for (const m of src.matchAll(/<button\b([^>]*?)>/g)) {
    const tag = m[1] ?? "";
    const cls = /className="([^"]*)"/.exec(tag)?.[1];
    // Every rounded shape, not only `rounded-lg`: the divergence that prompted
    // this was a `rounded-full` pill and a `rounded-md` chip, and a scan that
    // only knew one radius called both of them fine.
    if (!cls || !cls.includes("px-") || !/rounded-(lg|md|full)/.test(cls)) continue;
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

describe("the control a view opens with", () => {
  it("is the app's, in every view that has one", () => {
    /* Not "looks similar" — the same component. Five headers drifted into four
       shapes precisely because each one drew its own, and each was reasonable
       beside the thing next to it. */
    const missing = HEADED.filter((v) => !read(v).includes('from "./workspace/Chrome.tsx"') && !read(v).includes('from "../workspace/Chrome.tsx"'));
    expect(missing).toEqual([]);
  });

  it("is not a pill in one view and a chip in the next", () => {
    // `rounded-full` on a control is the shape that made the Git panel's picker
    // read as a different kind of object from the Terminal's. Chips are
    // rounded-lg; a full radius is for a count badge, which is not a button.
    const pills: string[] = [];
    for (const v of VIEWS) {
      for (const b of chipButtons(read(v), EXEMPT.filter((e) => v.endsWith(e.file)).map((e) => e.match))) {
        if (b.cls.includes("rounded-full")) pills.push(`${v}:${b.line}`);
      }
    }
    expect(pills).toEqual([]);
  });
});
