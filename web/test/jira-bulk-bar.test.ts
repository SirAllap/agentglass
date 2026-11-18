/*
 * The bulk bar and the row checkbox and key (x) that fill it: asserted against source, as the rest of this pane's
 * slots are (jira-assignee-picker.test.ts) - there is no renderer.
 */
import { describe, expect, test } from "bun:test";

const read = async (p: string) => Bun.file(new URL(p, import.meta.url)).text();
const bar = await read("../src/components/jira/list/BulkBar.tsx");
const row = await read("../src/components/jira/list/JiraRow.tsx");
const view = await read("../src/components/jira/list/JiraListView.tsx");
const lanes = await read("../src/components/jira/list/JiraLanes.tsx");
const keyBar = await read("../src/components/jira/list/JiraKeyBar.tsx");

describe("the bulk bar", () => {
  test("renders nothing with nothing picked", () => {
    expect(bar).toContain("if (count <= 0) return null;");
  });
  test("offers Copy keys and Clear always, Open in Jira only when the picked cards have an address", () => {
    expect(bar).toContain("Copy keys");
    expect(bar).toContain("{onOpenJql && (");
    expect(bar).toContain("Clear <Kbd>Esc</Kbd>");
  });
});

describe("the row's own checkbox", () => {
  test("only when the row is given onPick (the board has none)", () => {
    expect(row).toContain("{onPick && (");
    expect(row).toContain('role="checkbox"');
    expect(row).toContain("aria-checked={!!picked}");
  });
  test("a click picks the row without opening it", () => {
    expect(row).toContain("onClick={(e) => { e.stopPropagation(); onPick(); }}");
  });
});

describe("x toggles the focused (or open) card, list mode only", () => {
  test("reads the focused row's id, falls back to the open card", () => {
    expect(view).toContain('document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-jl-row]")');
    expect(view).toContain("row?.dataset.jlRow ?? selectedId");
  });
  test("gated to list mode and no modifier, same as the rest of this pane's keys", () => {
    expect(view).toContain('mode === "list" && !e.ctrlKey && !e.metaKey && !e.altKey');
  });
  test("Escape clears a non-empty pick", () => {
    expect(view).toContain('e.key === "Escape" && picked.size > 0');
  });
  test("picking is forgotten when the view changes", () => {
    expect(view).toContain("useEffect(() => { setPicked(EMPTY_SELECTION); }, [filterKey]);");
  });
});

describe("wiring", () => {
  test("JiraLanes threads picked/onPick to every row, parent, sub-task and opened child alike", () => {
    expect(lanes).toContain("picked={onPick ? !!picked?.has(t.id) : undefined} onPick={onPick ? () => onPick(t.id) : undefined}");
  });
  test("the key hint bar lists x only for list mode", () => {
    expect(keyBar).toContain('{ keys: ["x"], does: "select" }');
  });
});
