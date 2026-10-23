import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/*
 * Five overlays (command palette, search, legend, statistics, skills) were
 * plain divs: a screen reader announced nothing, Tab walked out into the page
 * behind the scrim, and closing left the focus nowhere. They now spread
 * useModalDialog on their panel. Source-level lock, same reasoning as
 * jira-step-dialog.test.ts: no renderer in this project, and the portal draws
 * nothing without a document.
 */
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const trap = read("../src/lib/focusTrap.ts");

const OVERLAYS: Array<[string, string, string]> = [
  ["CommandPalette", "Command palette", "initial={{ opacity: 0, scale: 0.96, y: -12 }}"],
  ["SearchModal", "Search", "initial={{ opacity: 0, scale: 0.97, y: -10 }}"],
  ["HelpLegend", "Legend and shortcuts", "initial={{ opacity: 0, scale: 0.95, y: 12 }}"],
  ["StatsModal", "Statistics", "initial={{ opacity: 0, scale: 0.985 }}"],
  ["SkillsModal", "Skills explorer", "initial={{ opacity: 0, scale: 0.95, y: 14 }}"],
];

describe("useModalDialog", () => {
  test("gives the panel the dialog role, aria-modal, a name and a focusable root", () => {
    expect(trap).toContain('role: "dialog"');
    expect(trap).toContain('"aria-modal": true');
    expect(trap).toContain('"aria-label": label');
    expect(trap).toContain("tabIndex: -1");
  });

  test("traps Tab and returns focus to the opener read before any autofocus", () => {
    expect(trap).toContain('e.key !== "Tab"');
    expect(trap).toContain("useFocusTrap(open, ref, opener)");
    // the opener is captured in render, not in an effect: an autofocused child has already taken the focus by then
    const render = trap.slice(trap.indexOf("export function useModalDialog"), trap.indexOf("useFocusTrap(open, ref, opener)"));
    expect(render).toContain("opener.current = document.activeElement");
    expect(render).not.toContain("useEffect");
  });

  test("takes the focus in only when nothing inside has it (an autofocused field keeps it)", () => {
    expect(trap).toContain("!el.contains(document.activeElement)");
  });

  test("the Jira dialogs import the trap from lib, not each other", () => {
    expect(read("../src/components/jira/JiraStepDialog.tsx")).toContain('from "../../lib/focusTrap.ts"');
    expect(read("../src/components/jira/JiraMoveForm.tsx")).toContain('from "../../lib/focusTrap.ts"');
    expect(read("../src/components/jira/JiraStepDialog.tsx")).not.toContain("export function useFocusTrap");
  });
});

describe("the five overlays use it without changing how they close", () => {
  for (const [name, label, panel] of OVERLAYS) {
    const src = read(`../src/components/${name}.tsx`);
    test(`${name}: panel carries the dialog props, labelled "${label}"`, () => {
      expect(src).toContain(`const modal = useModalDialog(open, "${label}");`);
      expect(src).toContain('from "../lib/focusTrap.ts"');
      const at = src.indexOf(panel);
      expect(at).toBeGreaterThan(-1);
      expect(src.slice(src.lastIndexOf("<motion.div", at), at)).toContain("{...modal}");
    });
    test(`${name}: scrim click still closes and the pointer-events structure is intact`, () => {
      expect(src).toMatch(/className="fixed inset-0[^"]*"[^>]*onClick=\{onClose\}/);
      if (name !== "StatsModal") expect(src).toContain("pointer-events-none");
      if (name !== "StatsModal") expect(src).toContain("pointer-events-auto");
    });
  }
});
