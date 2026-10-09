/*
 * Controls a per-view screenshot pass found off the family.
 *
 * Each one was a single call site doing its own thing next to a house control
 * that already existed:
 *
 *   - the pull request's own section strip was five plain buttons, the only
 *     body-swapping strip in the app that a screen reader heard as unrelated
 *     actions rather than one tab list;
 *   - the Machine dialog's Ports / Resources / Locks were the same, in a box;
 *   - the Machine dialog was missing from the app's Escape handler, so Escape
 *     closed everything except it;
 *   - the triage card's one button was 24px tall from `py-0.5`, off the
 *     22 / 28 / 32 ladder.
 *
 * Read from source, because mounting any of these wants a repository, a
 * websocket and GitHub. Every slice is cut at its own closing brace or tag.
 */
import { describe, expect, test } from "bun:test";

const read = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();
const pr = await read("components/PrPanel.tsx");
const machine = await read("components/MachinePanel.tsx");
const app = await read("App.tsx");
const triage = await read("components/TriageBoard.tsx");

/** From `start` to the brace that closes the block opened on or after it. */
function block(src: string, start: string): string {
  const from = src.indexOf(start);
  if (from < 0) return "";
  const open = src.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(from, i + 1);
  }
  return "";
}

/** One JSX element's opening tag, from `<tag` before `marker` to its `>`. */
function openingTag(src: string, tag: string, marker: string): string {
  const at = src.indexOf(marker);
  if (at < 0) return "";
  const from = src.lastIndexOf(`<${tag}`, at);
  // The tag ends at the first `>` that is not inside a `{ … }` expression.
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    else if (src[i] === ">" && depth === 0 && src[i - 1] !== "=") {
      // Comments go: a note explaining what `py-0.5` used to do is not `py-0.5`.
      return src.slice(from, i + 1).replace(/\/\*[\s\S]*?\*\//g, "");
    }
  }
  return "";
}

describe("body-swapping strips are tab lists", () => {
  test("the pull request's section strip is the shared Tabs, over a tabpanel", () => {
    expect(pr).toMatch(/<Tabs value=\{tab\}[^>]*panelId="pr-tab-body"/);
    expect(pr).toMatch(/ref=\{tabBodyRef\} id="pr-tab-body" role="tabpanel"/);
    // And the hand-rolled strip is gone rather than kept beside it.
    expect(pr).not.toMatch(/TABS\.map\(\(t\) => \(\s*<button/);
  });

  test("the Machine dialog's three sections are the shared Tabs, over a tabpanel", () => {
    expect(machine).toMatch(/<Tabs value=\{tab\} onChange=\{onTab\}[^>]*panelId="machine-tab-body"/);
    expect(machine).toContain('id="machine-tab-body" role="tabpanel"');
    expect(machine).not.toContain("onClick={() => onTab(t)}");
  });
});

describe("Escape closes the Machine dialog", () => {
  test("the app's Escape branch puts it away, and alone", () => {
    const esc = block(app, 'if (e.key === "Escape") {');
    expect(esc).not.toBe("");
    expect(esc).toMatch(/if \(machineOpenRef\.current\) \{ setMachine\(null\); return; \}/);
    expect(app).toContain("machineOpenRef.current = machine != null;");
  });
});

describe("one-off control heights join the ladder", () => {
  test("the triage card's button is a compact control", () => {
    const tag = openingTag(triage, "button", 'onAct(p, "open")');
    expect(tag).not.toBe("");
    expect(tag).toContain("CTRL_H.compact");
    expect(tag).not.toMatch(/\bpy-0\.5\b/);
    expect(tag).toContain("rounded-lg");
  });
});
