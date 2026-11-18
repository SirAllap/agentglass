/*
 * The pull request's folded Details block, held as source text: every row is
 * one height (HIT, 26) and no status is upper-cased on the way to the screen.
 */
import { describe, expect, it } from "bun:test";

const read = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();
const css = await read("index.css");
const panel = await read("components/PrPanel.tsx");
const prio = await read("lib/priority.tsx");

describe("PR details rows", () => {
  it("draws every Jira row with the same SidebarSection row as People: no second row style", () => {
    const jira = panel.slice(panel.indexOf("export function JiraCardFacts"), panel.indexOf("function CardFacts("));
    for (const t of ["Card", "Status", "Assignee", "Move to"]) expect(jira).toContain(`<SidebarSection title="${t}">`);
    expect(jira).not.toMatch(/data-side-sub|data-side-pass|data-rows|data-side-steps/);
    expect(css).not.toMatch(/\[data-side-sub\]/);
  });
  it("draws the edit pencil at the control height, in the last column", () => {
    expect(panel).toMatch(/data-side-edit[\s\S]{0,200}width: HIT, height: HIT/);
  });
  it("draws Jira's status as the chip at the shared height", () => {
    expect(panel).toMatch(/<TrackerStatusPick tracker=\{TRACKERS\.jira\}[^>]*chip=\{CTRL_H\.hit\}/);
  });
  it("shows every tracker status through the one shared statusText, upper case", async () => {
    const pill = await read("components/StatusPill.tsx");
    const dock = await read("components/jira/DockParts.tsx");
    const board = await read("components/jira/list/JiraBoard.tsx");
    expect(pill).toContain("export const statusText = (status: string): string => status.toUpperCase();");
    expect(pill).toContain("{statusText(status)}");
    expect(dock).toContain("{statusText(status)}");
    expect(board).toContain("{statusText(col.status)}");
    expect(dock).not.toMatch(/<span className="truncate">\{status\}<\/span>/);
    expect(board).not.toMatch(/agx-jb-colname[^>]*>\{col\.status\}/);
  });
  it("leaves the header chip's case alone", () => {
    expect(prio).toContain('"uppercase tracking-wide text-[9px] font-medium truncate"');
  });
});
