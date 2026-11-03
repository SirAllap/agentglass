/*
 * The Jira tab's centre column is a slot (BoardSource.Main), and ClickUp does not have one.
 *
 * Four rules, all about source because the body is a component and there is no renderer here:
 *  - the body draws its own top bar, table, footer and card pane only when the source has no Main, so ClickUp is
 *    drawn by the lines it always was;
 *  - Main is mounted once, for the source that has one, and only Jira has one;
 *  - the list is read in one file (lib/useJiraList.ts), and the body does not read the view a second time when it has a Main;
 *  - the selection store hands a request to the body once and shows where the tab is.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { globalStubs } from "./stubGlobal";

const stubGlobal = globalStubs();
stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000", search: "" });
const { JIRA_BOARD } = await import("../src/lib/jiraBoard.ts");
const { CLICKUP_BOARD } = await import("../src/lib/boardSource.ts");
const { JiraListView } = await import("../src/components/jira/list/JiraListView.tsx");
const sel = await import("../src/lib/jiraSelection.ts");

const at = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SRC = at("../src/components/TasksPanel.tsx");
const body = (() => {
  const from = SRC.indexOf("function ClickUpBody(");
  expect(from).toBeGreaterThanOrEqual(0);
  return SRC.slice(from, SRC.indexOf("\n}\n", from) + 2);
})();
const code = strip(body);

describe("ClickUp is drawn as it was", () => {
  test("only Jira has a Main", () => {
    expect(CLICKUP_BOARD.Main).toBeUndefined();
    expect(JIRA_BOARD.Main).toBe(JiraListView);
    const sources = readdirSync(new URL("../src/lib/", import.meta.url)).filter((f) => f.endsWith("Board.ts") || f === "boardSource.ts");
    const withMain = sources.filter((f) => /^\s*Main:/m.test(strip(at(`../src/lib/${f}`))));
    expect(withMain).toEqual(["jiraBoard.ts"]);
  });

  test("the top bar and the table column are drawn only without a Main, and the card shells only for a picked card, which a Main never has", () => {
    expect(code).toContain('{!Main && <div className="flex flex-col min-w-0" style={{ gridColumn: 2, gridRow: 1 }}>');
    expect(code).toContain('{!Main && <div className="flex flex-col min-w-0 min-h-0" style={{ gridColumn: 2, gridRow: 2 }}>');
    // the last three follow `picked`, which is nothing while a Main owns the cards
    expect(code).toContain("const picked = Main ? null : [...tasks, ...looked].find((t) => t.id === sel) ?? null;");
    // the rail is the body's in both
    expect(code).toContain('<nav ref={railNav} aria-label="Lists"');
    expect(code).not.toMatch(/Main &&[^\n]*<nav ref=\{railNav\}/);
  });

  test("Main is mounted once, in its own column, and gets the rail's selection", () => {
    expect(code.match(/<Main /g)).toHaveLength(1);
    const at = code.indexOf("<Main ");
    const mount = code.slice(at, code.indexOf("/>", at));
    expect(mount).toContain("source={source}");
    expect(mount).toContain("areaId={areaSel}");
    expect(mount).toContain("viewId={reset ? null : (wanted ?? data?.view?.id ?? null)}");
    expect(mount).toContain("feed={feed}");
    expect(code.slice(code.lastIndexOf("{Main && (", at), at)).toContain('gridRow: "1 / 3"');
  });
});

describe("the list is read in one place", () => {
  test("with a Main the body's load only says which view and when, and never reads", () => {
    const from = code.indexOf("const load = useCallback(");
    const fn = code.slice(from, code.indexOf("\n  }, [settle, source, Main]);", from));
    expect(fn.indexOf("if (Main) {")).toBeGreaterThan(0);
    const branch = fn.slice(fn.indexOf("if (Main) {"), fn.indexOf("const ticket"));
    expect(branch).toContain("return;");
    expect(branch).not.toContain("source.read(");
    // the first read, the focus re-read, the context and the areas are the Main's own
    expect(code).toContain("if (active) { void loadBoards(); if (!Main) void load(); }");
    expect(code).toContain("if (!active || Main) return;");
    expect(code).toContain("if (Main) return; // the Main's own read feeds `ctx`");
    expect(code).toContain("if (Main) return; // the Main's own read feeds `areas`");
  });

  test("no file of the pane but the hook reads the site", () => {
    const dir = new URL("../src/components/jira/list/", import.meta.url);
    const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f));
    expect(files).toContain("JiraListView.tsx");
    for (const f of files) {
      const t = strip(at(`../src/components/jira/list/${f}`));
      // the list is read by the hook; the two files below ask the site on a person's Enter, which is not the list
      const asks = f === "SearchSheet.tsx" || f === "JiraSearch.tsx" ? "read|views|boardContext|boardAreas|searchStream|rank" : "read|views|boardContext|boardAreas|find|search|searchStream|rank";
      expect(t, f).not.toMatch(new RegExp(`\\bsource\\.(${asks})\\(`));
      expect(t, f).not.toMatch(/api\.jira|fetch\(|useJiraSelection|jiraSelection/);
    }
    const hook = strip(at("../src/lib/useJiraList.ts"));
    for (const call of ["source.read(", "source.boardContext(", "source.boardAreas("]) expect(hook).toContain(call);
    expect(strip(at("../src/components/jira/list/JiraListView.tsx"))).toContain("useJiraList({");
  });

  test("a read that names the view the body already asked for is not read twice", () => {
    const hook = strip(at("../src/lib/useJiraList.ts"));
    expect(hook).toContain('d.id === (viewId ?? "") && d.quick === quickKey && d.reload === reload.n');
    expect(hook).toContain("if (r.view?.id) done.current = { ...done.current, id: r.view.id };");
  });
});

describe("the selection store", () => {
  beforeEach(() => sel.__resetJiraSelection());

  test("a request is numbered, fields left out stay out", () => {
    const n0 = sel.getJiraRequest().seq;
    sel.setJiraSelection({ viewId: "board:7" });
    expect(sel.getJiraRequest()).toEqual({ seq: n0 + 1, want: { viewId: "board:7" } });
    sel.setJiraSelection({ areaId: null });
    expect(sel.getJiraRequest().want).toEqual({ areaId: null });
    expect("viewId" in sel.getJiraRequest().want).toBe(false);
  });

  test("the body publishes where the tab is, once per change", () => {
    sel.publishJiraSelection({ viewId: "board:7", areaId: "ORB-9" });
    expect(sel.getJiraSelection()).toEqual({ viewId: "board:7", areaId: "ORB-9" });
    const same = sel.getJiraSelection();
    sel.publishJiraSelection({ viewId: "board:7", areaId: "ORB-9" });
    expect(sel.getJiraSelection()).toBe(same); // an equal publish keeps the object, so nothing re-renders
  });

  test("a request does not move the published selection: only the body does", () => {
    sel.publishJiraSelection({ viewId: "board:7", areaId: null });
    sel.setJiraSelection({ viewId: "board:9", areaId: "ORB-9" });
    expect(sel.getJiraSelection()).toEqual({ viewId: "board:7", areaId: null });
  });

  test("the body takes a request once and opens the area after the view has landed", () => {
    expect(code).toContain("const seenReq = useRef(getJiraRequest().seq);");
    expect(code).toContain("if (!Main || jiraReq.seq === seenReq.current) return;");
    expect(code).toContain("pendingArea.current = areaId; void load(viewId, false, true);");
    expect(code).toContain("if (!Main || pendingArea.current === undefined || !data?.view?.id || wanted) return;");
    expect(code).toContain("publishJiraSelection({ viewId: wanted ?? data?.view?.id ?? null, areaId: areaSel });");
    expect(code).toContain("onSelect={setJiraSelection}");
  });
});

describe("Looked up and the card the body wants open", () => {
  test("the body hands a Main the Looked up list and one ask per selection, and forgets from one place", () => {
    expect(code).toContain("looked={lookedFor} show={show}");
    expect(code).toContain("setShow((p) => ({ id: sel, n: (p?.n ?? 0) + 1 }))");
    expect(code).toContain("[Main, sel, jump?.n, onLooked]");
    expect(code).toMatch(/const forgetLooked = useCallback\(\(id: string\) => \{[\s\S]*?if \(!left\.length\) setOnLooked\(false\)/);
  });
  test("the list draws Looked up in place of the view, forgets through the body, and opens an asked card once it is there", () => {
    const t = strip(at("../src/components/jira/list/JiraListView.tsx"));
    expect(t).toContain("lookedOn ? lookedModel(model, looked!.cards)");
    expect(t).toContain("onForget={lookedOn ? forget : undefined}");
    expect(t).toContain("useState<number>(show?.n ?? 0)");
    expect(t).toContain("if (want && wanted) { setAsked(want.n); openCard(wanted); }");
  });
  test("a card the search found off every lane goes to Looked up, and a card on a lane does not", () => {
    const t = strip(at("../src/components/jira/list/JiraListView.tsx"));
    expect(t).toContain("if (!model.cards.some((c) => c.id === t.id)) looked?.add(t); openCard(t);");
    expect(t).toContain("onOpenCard={openFound}");
    expect(strip(at("../src/components/TasksPanel.tsx"))).toContain("forget: forgetLooked, add: addLooked");
  });
  test("a move or assign answers into the card's own copy of the task too, so the next write does not send the old stamp", () => {
    const t = strip(at("../src/components/jira/JiraCard.tsx"));
    expect(t).toContain("const took = useCallback((task: ProviderTask) => { setDetail((d) => (d ? { ...d, task } : d)); onTaskRef.current(task); }, []);");
    expect(t).toContain("onTask={took}");
    expect(t).toContain("onTask: took })");
    expect(strip(at("../src/components/jira/list/JiraDock.tsx"))).toContain("onTask={r.onTask}");
  });
});
