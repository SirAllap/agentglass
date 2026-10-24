/*
 * Rules about the usage popover's source, held as text because there is no
 * renderer: its layer is a name, it draws no timer of its own, and the only way
 * to the switch route is a press the person makes.
 */
import { describe, expect, it } from "bun:test";
import { LAYER } from "../src/lib/layers.ts";

const read = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();
const topBar = await read("components/TopBar.tsx");
const chips = await read("components/AccountChips.tsx");
const store = await read("lib/accountStore.ts");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");

/** From `function name(` to the closing brace at column 0. */
function body(src: string, head: string): string {
  const at = src.indexOf(head);
  expect(at).toBeGreaterThanOrEqual(0);
  const end = src.indexOf("\n}\n", at);
  return src.slice(at, end + 2);
}

describe("the popover's layer", () => {
  const panel = code(body(topBar, "function PlanPanel("));

  it("is named, not a literal", () => {
    expect(panel).not.toMatch(/\b10050\b/);
    expect(panel).toContain("<Portal z={LAYER.usage}>");
  });

  it("sits above the picture and under the waiting-on-you panel, where the literal was", () => {
    expect(LAYER.usage).toBe(10050);
    expect(LAYER.usage).toBeGreaterThan(LAYER.paletteImage);
    expect(LAYER.usage).toBeLessThan(LAYER.needs);
  });
});

describe("the chips", () => {
  it("add no interval of their own", () => {
    for (const s of [chips, store]) expect(code(s)).not.toContain("setInterval");
  });

  it("reach the switch route only through pressAccount, from a press", () => {
    expect(code(chips)).not.toMatch(/api\.|fetch\(|from "\.\.\/lib\/api/);
    // pressAccount is called in doSwitch and doManage; those are reached from a click, a key, or confirmOffer.
    const calls = code(chips).match(/pressAccount\(/g) ?? [];
    expect(calls.length).toBe(2);
  });

  it("clear the proposal only after the person's own press has been answered", () => {
    const confirm = code(chips.slice(chips.indexOf("const confirmOffer"), chips.indexOf("const act =")));
    expect(confirm.indexOf("await doSwitch")).toBeGreaterThan(-1);
    expect(confirm.indexOf("dismiss()")).toBeGreaterThan(confirm.indexOf("await doSwitch"));
    expect(code(chips)).toMatch(/const dismiss = \(\) => \{ clearStage\(\);/);
  });

  it("show the active chip as text, not by colour alone", () => {
    expect(chips).toMatch(/\{a\.active && <span[^>]*>active<\/span>\}/);
  });

  it("use the house sizes, not new numbers", () => {
    expect(chips).toContain("HIT");
    expect(chips).toContain("MIN_BOX");
    expect(chips).not.toMatch(/\bz-?index\b|zIndex/i);
  });
});

describe("an agent's proposal", () => {
  const panel = code(chips.slice(chips.indexOf("export function useAccountPanel"), chips.indexOf("export type AccountPanel")));

  it("moves no focus: only a popover the person opened takes it", () => {
    const mount = panel.slice(panel.indexOf("useEffect(() => {"), panel.indexOf("const usable"));
    expect(mount).toContain("focusIn");
    expect(mount).toMatch(/if \(focusIn\)/);
    const bar = code(body(topBar, "function PlanPanel("));
    expect(bar).toContain("useAccountPanel(strip, onClose, onEscape, !at.staged)");
  });

  it("is marked as staged when it opens the popover", () => {
    const sub = code(topBar.slice(topBar.indexOf("const seenProposal"), topBar.indexOf("const ctx = providerInContext")));
    expect(sub).toMatch(/staged: true/);
  });

  it("selects no chip: the candidate stays where the person left it", () => {
    const eff = panel.slice(panel.indexOf("const pn = proposal?.n;"), panel.indexOf("const offerList"));
    expect(eff).toContain("setProvider");
    expect(eff).not.toContain("setCandId");
  });
});

describe("every consumer of the provider rows", () => {
  // The rows of a provider's other logins are the popover's. A screen that lists
  // or headlines the rows takes the core ones; these read by label or go through
  // usageOf/busiestOf, which already do.
  const reads = new Set(["components/AccountChips.tsx", "components/TopBar.tsx", "lib/usageStore.ts", "lib/accountStore.ts"]);

  it("filter to the login in use, or are named here as reading them on purpose", async () => {
    const offenders: string[] = [];
    for await (const f of new Bun.Glob("**/*.{ts,tsx}").scan(new URL("../src/", import.meta.url).pathname)) {
      if (reads.has(f)) continue;
      const src = code(await read(f));
      const takesRows = /import\s*\{[^}]*\bproviderUsage\b[^}]*\}\s*from\s*"[^"]*usageStore/.test(src);
      if (takesRows && !/\b(isCoreRow|coreRows|longWindowUsed)\b/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("list one row per provider, from the core rows", async () => {
    for (const f of ["components/UsageBox.tsx", "components/StatsModal.tsx"]) {
      const src = code(await read(f));
      expect(src, f).toMatch(/coreRows\(useSyncExternalStore\(subscribeProviderUsage, providerUsage/);
    }
  });
});

describe("the popover for a keyboard and a screen reader", () => {
  const hook = code(chips.slice(chips.indexOf("export function useAccountPanel"), chips.indexOf("export type AccountPanel")));
  const view = code(chips.slice(chips.indexOf("export function AccountChips")));
  const panel = code(body(topBar, "function PlanPanel("));

  it("is a modal dialog once the person is in it, and keeps Tab inside", () => {
    expect(hook).toContain('"aria-modal"');
    expect(hook).toContain("tabTarget(");
    expect(hook).toMatch(/document\.addEventListener\("keydown"/);
    expect(hook).toMatch(/document\.removeEventListener\("keydown"/);
  });

  it("does not take Tab from someone typing elsewhere while a proposal sits unopened", () => {
    expect(hook).toContain("engaged.current");
  });

  it("draws the chips as a radiogroup with one tab stop, and moves focus with the arrows", () => {
    expect(view).toContain('role="radiogroup"');
    expect(view).toContain('role="radio"');
    expect(view).toContain("aria-checked={sel}");
    expect(view).toContain("tabIndex={sel ? 0 : -1}");
    expect(view).not.toContain("aria-pressed");
    expect(hook).toMatch(/chipEls\.current\.get\([^)]*\)\?\.focus\(/);
  });

  it("puts focus back on the strip when the scrim closes it, like Escape", () => {
    expect(panel).toMatch(/className="fixed inset-0" onClick=\{onEscape\}/);
  });

  it("brings focus back into the popover when a press disables the button that had it", () => {
    expect(hook).toContain("keepFocusIn()");
  });
});

describe("the chips do not move and the status line is not cut", () => {
  const view = code(chips.slice(chips.indexOf("export function AccountChips")));

  it("the proposal card comes after the chips and their line, so it cannot push them", () => {
    expect(view.indexOf('aria-label="Accounts"')).toBeGreaterThan(-1);
    expect(view.indexOf('aria-label="Proposed switch"')).toBeGreaterThan(view.indexOf("aria-live"));
  });

  it("the status line wraps and reserves two lines, so a long answer is read whole and nothing moves when it arrives", () => {
    const line = view.slice(view.indexOf("aria-live"), view.indexOf("</div>", view.indexOf("aria-live")));
    expect(line).not.toContain("truncate");
    expect(line).toContain("NOTE_LINES");
    expect(chips).toMatch(/const NOTE_LINES = 2;/);
  });
});

describe("a proposal that arrives with no row to anchor it", () => {
  it("goes through onProposal, so it is not kept for when a reading lands", () => {
    const sub = code(topBar.slice(topBar.indexOf("const seenProposal"), topBar.indexOf("const ctx = providerInContext")));
    expect(sub).toContain("onProposal(seenProposal.current, r.n, hasRow.current)");
  });
});
