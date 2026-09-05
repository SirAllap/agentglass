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

const WEB = join(import.meta.dir, "..", "src");
const COMPONENTS = join(WEB, "components");
const read = (f: string) => readFileSync(join(COMPONENTS, f), "utf8");

/** The files that draw a workspace view's own chrome. */
const VIEWS = [
  "PrPanel.tsx", "TasksPanel.tsx", "GitPanel.tsx", "DockerPanel.tsx",
  "TerminalPanel.tsx", "FilesPanel.tsx", "ChatPanel.tsx", "BrowserPanel.tsx",
  "diff/DiffPage.tsx", "understudy/UnderstudyPanel.tsx",
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
/* The terminal is not in this list any more, and that is the point of the list
   rather than an exception to it: it no longer HAS a header. Its row was
   deleted — it described one pane while four were on screen — and what it kept
   rides the tabs row instead. A view with no header cannot drift into a fourth
   header shape. */
const HEADED = ["PrPanel.tsx", "TasksPanel.tsx", "diff/DiffPage.tsx", "CheckoutPicker.tsx"];

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
  /*
   * THE TAG ENDS AT ITS OWN `>`, found by counting braces.
   *
   * `<button\b([^>]*?)>` stops at the FIRST `>` — which is the one in `=>`
   * whenever the handler is inline, and it usually is. So every
   * `<button onClick={() => …}` in this app was skipped before its className
   * was ever read: measured, this scan saw 80 of 294 chip-shaped buttons, and
   * the 214 it could not see included twenty-one drawn `rounded-full` in six
   * files. A lint nobody had touched in months, quietly looking at a quarter of
   * the code.
   *
   * Found because a refactor moved one button's handler out of its tag and the
   * lint went red on a file it had always passed.
   */
  for (const m of src.matchAll(/<button\b/g)) {
    let i = (m.index ?? 0) + "<button".length, depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    const tag = src.slice((m.index ?? 0) + "<button".length, i);
    const cls = /className="([^"]*)"/.exec(tag)?.[1];
    // Every rounded shape, not only `rounded-lg`: the divergence that prompted
    // this was a `rounded-full` pill and a `rounded-md` chip, and a scan that
    // only knew one radius called both of them fine.
    if (!cls || !cls.includes("px-") || !/rounded-(lg|md|full)/.test(cls)) continue;
    // The exemption is matched against the whole opening tag AND the few lines
    // after it, because what identifies a submit button is often its label.
    const around = src.slice(m.index, i + 220);
    if (exempt.some((e) => around.includes(e))) continue;
    out.push({ line: src.slice(0, m.index).split("\n").length, cls });
  }
  return out;
}

/*
 * WHAT WAS ALREADY THERE the day this scan got its sight back.
 *
 * `chipButtons` matched `<button\b([^>]*?)>`, which stops at the first `>` —
 * the one inside `=>` whenever the handler is inline, and it nearly always is.
 * So the lint below read 80 of this app's 294 chip-shaped buttons and passed
 * for months on a quarter of the code. Counting braces fixed it and 20 existing
 * divergences appeared at once, in six files nobody was editing.
 *
 * They are frozen here rather than fixed in the same commit that found them:
 * repainting six panels the owner has not seen is a bigger change than the one
 * that uncovered this, and a silent `.filter()` over them would put the lint
 * straight back to sleep. A NEW one still fails — this list does not grow by
 * itself.
 *
 * Entries are `File.tsx` plus the class fragment, not line numbers: a line
 * number goes stale on the next edit above it and the list starts lying.
 *
 * Only the VIEWS, because that is all this lint reads. Three more of the twenty
 * live in `SessionModal`, `TopBar` and `PrFilterBar` — chrome by any reasonable
 * reading, and outside the list above. Left named here rather than silently
 * omitted: the next person to widen `VIEWS` should know what widening it costs.
 */
const KNOWN: { file: string; cls: string; what: string }[] = [
  { file: "ChatPanel.tsx", cls: "mt-1.5 text-[10px] px-2 py-0.5 rounded-full", what: "the fold's cost" },
  { file: "ChatPanel.tsx", cls: "text-[11.5px]", what: "a chip a size off the ladder" },
  { file: "PrPanel.tsx", cls: "text-[10px] px-2 py-px rounded-full", what: "Pin #n" },
  { file: "PrPanel.tsx", cls: "agx-btn text-[10px] px-1.5 py-0.5 rounded-full", what: "the reaction chips" },
  { file: "PrPanel.tsx", cls: "agx-btn text-[10.5px] px-2 py-0.5 rounded-full", what: "reviewer and base pickers" },
  { file: "TasksPanel.tsx", cls: "rounded-full", what: "ten chips across its two bars" },
  { file: "TasksPanel.tsx", cls: "text-[11.5px]", what: "a chip a size off the ladder" },
  { file: "DockerPanel.tsx", cls: "text-[13px]", what: "a chip a size off the ladder" },
];

/** Is this one of the divergences that predates the scan being fixed? */
const known = (file: string, cls: string): boolean =>
  KNOWN.some((k) => file.endsWith(k.file) && cls.includes(k.cls));

describe("the chip a view puts in its chrome", () => {
  it("is one size, in every view", () => {
    const bad: string[] = [];
    for (const v of VIEWS) {
      const exempt = EXEMPT.filter((e) => v.endsWith(e.file)).map((e) => e.match);
      for (const b of chipButtons(read(v), exempt)) {
        for (const size of b.cls.match(/text-\[[0-9.]+px\]/g) ?? []) {
          if (!SIZES.has(size) && !known(v, b.cls)) bad.push(`${v}:${b.line} ${size}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("has one place that says what the shape is", () => {
    const chrome = read("workspace/Chrome.tsx");
    expect(chrome).toContain('export const CHIP = "agx-chip text-[11px] px-2.5 min-h-[28px]');
    // And the icon-only sibling takes the app's own target size rather than a
    // fourth opinion about how big a square control is.
    expect(chrome).toContain("width: HIT, height: HIT");
  });

  it("is tall enough to hit", () => {
    /* `py-1` made this 24.5px — 11px type at line-height 1.5 is a 16.5px line
       box, plus 4px of padding on each side — which clears WCAG 2.2's 24×24
       floor by half a pixel. Reported from using it, in those words: the
       buttons are easy to miss with the mouse. Measured in the running app at
       1999×1124, every chip in the understudy view came back at exactly 24.5,
       and the Teach checkbox at 20×20.

       So the height is declared rather than derived from the line box, and it
       is declared here so no view has to know it. */
    const chrome = read("workspace/Chrome.tsx");
    const min = chrome.match(/export const CHIP = "[^"]*min-h-\[(\d+)px\]/);
    expect(min, "CHIP must declare its own height").not.toBeNull();
    expect(Number(min![1])).toBeGreaterThanOrEqual(28);
    // A tab is navigation and gets the larger target of the two.
    const at = chrome.indexOf("export function Tabs");
    expect(at, "the app has a real tab bar").toBeGreaterThan(-1);
    const tab = chrome.slice(at).match(/min-h-\[(\d+)px\]/);
    expect(Number(tab![1])).toBeGreaterThanOrEqual(32);
  });

  it("answers the pointer", () => {
    /* `chipTone()` writes `background` as an INLINE style, and an inline
       declaration outranks every class Tailwind can emit — so `hover:bg-*` on a
       chip did nothing at all, and the app shipped a control kit with no hover
       state. Measured: 0 `hover:` rules in the whole understudy view against 41
       in TasksPanel.

       The fix cannot live in a Tailwind class, so it is an unlayered rule in
       index.css keyed off the class CHIP carries. This pins both halves — the
       hook and the rule — because either one alone is silently useless. */
    expect(read("workspace/Chrome.tsx")).toContain("agx-chip");
    const css = readFileSync(join(WEB, "index.css"), "utf8");
    expect(css).toContain(".agx-chip:hover:not(:disabled)");
    expect(css).toMatch(/\.agx-chip:hover:not\(:disabled\)\s*\{[^}]*!important/);
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
    const body = chrome.slice(at, at + 900);
    // gap-1.5 and not gap-1: 4px between two 28px targets is inside the
    // distance a pointer slips, and this set is the primary navigation of a
    // view. The rule being pinned is that the GROUP has no box of its own.
    expect(body).toContain('className="flex items-center gap-1.5 shrink-0"');
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
        if (b.cls.includes("rounded-full") && !known(v, b.cls)) pills.push(`${v}:${b.line}`);
      }
    }
    expect(pills).toEqual([]);
  });
});

describe("the frozen list", () => {
  it("still names things that are actually there", () => {
    /* A ratchet that keeps entries for divergences somebody has since fixed is
       a ratchet that would not notice them coming back. */
    const stale = KNOWN.filter((k) => {
      const v = VIEWS.find((f) => f.endsWith(k.file));
      return !v || !chipButtons(read(v)).some((b) => b.cls.includes(k.cls));
    });
    expect(stale.map((k) => `${k.file} — ${k.what}`),
      "fixed: delete the entry so it cannot come back unnoticed").toEqual([]);
  });

  it("and the scan it guards can still see", () => {
    // The guard on the guard. A regex that stopped matching would make every
    // assertion above pass over nothing — which is exactly what it did.
    const seen = VIEWS.reduce((n, v) => n + chipButtons(read(v)).length, 0);
    // 123 at the time of writing, against the 80 the broken scan could see
    // across the whole component tree.
    expect(seen, "chip-shaped buttons found across the views").toBeGreaterThan(100);
  });
});
