/*
 * The brief's second row: s, e, ?, Space, Alt+arrow. `s` (a per-row status menu via the keyboard) is not built —
 * see .agx-tmp/report.md. The other four: `e` opens the description's edit box the same way `r` opens reader
 * mode (jiraReaderMode.ts); `?` opens a legend of every key (boardModel.ts + JiraKeyBar.tsx); Space marks a
 * focused sub-task done and Alt+Up/Down moves one (already built; Space is new, read from source like the dock's
 * own modes are).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { opensDescriptionEdit, opensReader } from "../src/lib/jiraReaderMode.ts";
import { boardKey, type BoardKey } from "../src/components/jira/list/boardModel.ts";
import { BOARD_KEYS, CARD_KEYS, LIST_KEYS } from "../src/components/jira/list/JiraKeyBar.tsx";

const at = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const field = (tag: string) => ({ tagName: tag, isContentEditable: false }) as unknown as EventTarget;
const key = (k: string, o: Record<string, boolean> = {}) => ({ key: k, ctrlKey: false, shiftKey: false, metaKey: false, altKey: false, ...o });

describe("opensDescriptionEdit", () => {
  test("a bare e opens it, the same way r opens reader mode", () => {
    expect(opensDescriptionEdit(key("e"), null)).toBe(true);
    expect(opensReader(key("r"), null)).toBe(true);
  });
  test("a modifier or typing swallows it", () => {
    expect(opensDescriptionEdit(key("e", { ctrlKey: true }), null)).toBe(false);
    expect(opensDescriptionEdit(key("e"), field("TEXTAREA"))).toBe(false);
    expect(opensDescriptionEdit(key("E"), null)).toBe(false);
  });
});

describe("the ? legend key", () => {
  test("boardKey maps a bare ? to \"legend\"", () => {
    expect(boardKey(key("?"), false)).toBe<BoardKey>("legend");
    expect(boardKey(key("?"), true)).toBeNull();
    expect(boardKey(key("?", { altKey: true }), false)).toBeNull();
  });

  test("the legend lists the board/list bar's own keys plus the open card's", () => {
    for (const g of [BOARD_KEYS, LIST_KEYS, CARD_KEYS]) expect(g.length).toBeGreaterThan(0);
    expect(CARD_KEYS.some((k) => k.keys.includes("r"))).toBe(true);
    expect(CARD_KEYS.some((k) => k.keys.includes("e"))).toBe(true);
    expect(CARD_KEYS.some((k) => k.keys.includes("Space"))).toBe(true);
    expect(CARD_KEYS.some((k) => k.keys.includes("Alt"))).toBe(true);
    expect(BOARD_KEYS.some((k) => k.keys.includes("?"))).toBe(true);
    expect(LIST_KEYS.some((k) => k.keys.includes("?"))).toBe(true);
  });

  test("JiraListView toggles it on ? and closes it first on Escape", () => {
    const c = at("../src/components/jira/list/JiraListView.tsx").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(c).toContain('const [legend, setLegend] = useState(false);');
    expect(c).toContain('if (e.key === "Escape" && legend) { e.preventDefault(); setLegend(false); return; }');
    expect(c).toContain('else if (k === "legend") setLegend((v) => !v);');
    expect(c).toContain('{legend && <KeyLegend mode={mode} onClose={() => setLegend(false)} />}');
  });
});

describe("the open card's Space and Alt+arrow, read from source", () => {
  const src = () => at("../src/components/jira/detail/SubtaskTree.tsx").replace(/\/\*[\s\S]*?\*\//g, "");

  test("Alt+Up/Down moves the focused row (already built)", () => {
    const c = src();
    expect(c).toContain('e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")');
    expect(c).toContain("void move(i, e.key === \"ArrowUp\" ? -1 : 1);");
  });

  test("Space marks the focused row done, only with writes on and not already done", () => {
    const c = src();
    expect(c).toContain('e.key === " " && !e.altKey && !e.ctrlKey && !e.metaKey && writes && rows[i]!.statusKind !== "done"');
    expect(c).toContain("void markDone(rows[i]!);");
  });

  test("both keys act on the row under the event target, not a stale index", () => {
    const c = src();
    const from = c.indexOf("const onKeyDown = ");
    const block = c.slice(from, c.indexOf("};", from));
    expect(block).toContain("els.findIndex((el) => el.contains(e.target as Node))");
    expect(block).toContain("if (i < 0) return;");
  });
});
