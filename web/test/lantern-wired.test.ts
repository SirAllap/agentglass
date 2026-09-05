/*
 * THE LANTERN IS WIRED THROUGH, NOT JUST DRAWN.
 *
 * The seams: a view that exists but is not in the rail, a rail pip nothing
 * feeds, a settings section that saves nowhere, a Go button that goes nowhere,
 * and the old tab inside Clone still there beside the new view. Read from
 * source, as the other settings tests in this directory are, because each of
 * these lives in a component that needs the app around it to render.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { VIEWS, LETTER_TO_VIEW } from "../src/components/workspace/views.ts";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url).pathname, "utf8");
const settings = read("src/components/SettingsModal.tsx");
const api = read("src/lib/api.ts");
const workspace = read("src/components/workspace/Workspace.tsx");
const understudy = read("src/components/understudy/UnderstudyPanel.tsx");
const view = read("src/components/LanternView.tsx");
const app = read("src/App.tsx");

describe("in the rail", () => {
  test("is a view of its own, in the bottom drawer, on a letter nobody else has", () => {
    const v = VIEWS.find((x) => x.id === "lantern");
    expect(v, "not registered").toBeDefined();
    expect(v!.group).toBe("utility");
    expect(v!.label).toBe("Lantern");
    expect(LETTER_TO_VIEW[v!.key]).toBe("lantern");
    expect(VIEWS.filter((x) => x.key === v!.key)).toHaveLength(1);
  });

  test("its icon lights with how many need you, fed by the one store the view reads too", () => {
    expect(workspace).toContain("lantern: lanternWaiting > 0 ? { count: lanternWaiting } : {}");
    expect(workspace).toContain("useSyncExternalStore(subscribeLantern, lanternNeed, lanternNeed)");
    expect(view).toContain("subscribeLantern(l, active)");
  });

  test("and it is mounted", () => {
    expect(workspace).toContain('case "lantern": return <LanternView active={active}');
  });
});

describe("no longer a tab inside Clone", () => {
  test("the Crew tab and its component are gone", () => {
    expect(understudy).not.toContain('"crew"');
    expect(understudy).not.toContain("CrewView");
    expect(() => read("src/components/CrewPanel.tsx")).toThrow();
  });
});

describe("Ask about the field", () => {
  test("opens the Lantern's chat as an agent tab on the floating bench — general, and over this view", () => {
    // Not the Chat view (hidden from his rail; it landed on Git) and not the
    // Terminal view (leaves the board behind): the bench floats over whatever
    // view you are in and its tab is a tmux session that outlives the window.
    expect(view).toContain('import { askLantern, hasLanternTab } from "../lib/lanternAsk.ts";');
    expect(view).toContain("const r = await askLantern();");
    const ask = read("src/lib/lanternAsk.ts");
    expect(ask).toContain('addTab(root, { kind: "agent", slot, title: LANTERN_TAB_TITLE, agent: r.ticket });');
    expect(ask).toContain("openBench();");
    // Asking twice brings the tab there to the front rather than seating a
    // second agent — Lantern's own `open` rule.
    expect(ask).toContain("activateTab(there.root, there.id);");
    // …but only a tab whose session is still on the engine: one whose chat
    // was ended or whose engine restarted would reattach as an empty shell
    // called "lantern", so it is forgotten and a fresh chat opens instead.
    expect(ask).toContain("live = r.ok && r.slots.includes(t.slot);");
    expect(ask).toContain("closeTab(root, t.id);");
    // And reuse is decided BEFORE a ticket is minted — a ticket is single-use.
    expect(ask.indexOf("await lanternTabAlive()")).toBeLessThan(ask.indexOf("await api.lanternTicket()"));
  });

  test("the first message is composed on the server, never sent by the client", () => {
    const whole = read("src/lib/lanternAsk.ts");
    // The Lantern's own opener: the server composes it, the client only picks
    // a slot. (askOnBench beside it carries a person's OWN words to a chat,
    // through the same ticket the start menu uses — a different thing.)
    const ask = whole.slice(whole.indexOf("export async function askLantern("));
    expect(ask).not.toContain("prompt");
    expect(api).toContain('("/lantern/ticket", { cwd })');
    expect((api.match(/lanternTicket:/g) ?? []).length, "real and demo").toBe(2);
    // And Workspace no longer routes it through a seeded Chat view.
    expect(workspace).not.toContain("onAsk=");
  });
});

describe("Go", () => {
  test("goes through the registry App fills — the same resolver a notification uses", () => {
    expect(view).toContain('import { jumpToPane } from "../lib/paneJump.ts";');
    expect(view).not.toContain("sysNotify");
    expect(app).toContain("setPaneJump((pane) => { void goFromNote({ kind: \"pane\", pane }); })");
  });
});

describe("the Lantern section in Settings", () => {
  const section = settings.slice(settings.indexOf("function LanternSection("), settings.indexOf("function AgentsSection("));

  test("exists, on the Agents page, and is searchable from it", () => {
    expect(settings).toContain('{pane === "hooks" && <><HooksPane open={open} /><LanternSection open={open} />');
    const kw = /id: "hooks", label: "Agents", group: "Agents & work", kw: "([^"]*)"/.exec(settings)?.[1] ?? "";
    for (const word of ["lantern", "reminder", "needs you"]) expect(kw, word).toContain(word);
  });

  test("reads and writes through the api, never a local guess", () => {
    expect(section).toContain("api.lanternSettings()");
    expect(section).toContain("api.lanternSettingsSave(");
    expect(section).toContain("save({ nudge: !nudge })");
    // The watch beside it: its own switch and its own clock, through the same api.
    expect(section).toContain("save({ watch: !watch })");
    expect(section).toContain("save({ watchMinutes: Number(m) })");
    expect(section).toContain("Watch the agents and notify me");
    expect(section).toContain("save({ cacheTtlMinutes: Number(m) })");
    expect(section).toContain("save({ minutes: Number(m) })");
  });

  test("the api has both halves, in the real client and the demo", () => {
    expect(api).toContain('("/lantern/settings")');
    expect(api).toContain('("/lantern/settings", f)');
    expect((api.match(/lanternSettingsSave:/g) ?? []).length, "real and demo").toBe(2);
  });
});

/*
 * "OPEN IT" MEANS OPEN IT, even when the view is hidden from the rail.
 *
 * Workspace received the bare `setWsView` and used it for every "open X" a
 * panel offers — a chat seeded from Tasks, a review from a pull request, the
 * Lantern's "Ask about the field". App's own effect corrects a view that is
 * not in the rail to the first visible one, so on a rail with Chat hidden
 * every one of those buttons landed on Git's Changes tab. Measured on the
 * Lantern: "this ask takes me to git". `goView` brings the hidden view back
 * first; it existed for the rail's own use and was never handed down.
 */
describe("opening a view a panel asks for", () => {
  test("Workspace is handed goView, which un-hides before it switches", () => {
    expect(app).toContain("view={wsView} onView={goView}");
    expect(app).not.toContain("onView={setWsView}");
    const go = app.slice(app.indexOf("const goView = useCallback"), app.indexOf("const goView = useCallback") + 200);
    expect(go).toContain('if (!isVisibleView(v)) moveView(v, "work");');
  });
});

describe("the rail's number", () => {
  test("counts blockages only — a turn that ended is waiting, not blocked, and the Lantern's own chat is nobody", async () => {
    const { __setLanternRows, lanternNeed } = await import("../src/lib/lanternStore.ts");
    __setLanternRows([
      { name: "a", from: "seen", state: "waiting", needsYou: { kind: "permission", why: "", since: 1 } },
      { name: "b", from: "seen", state: "waiting", needsYou: { kind: "gate", why: "", since: 1 } },
      { name: "c", from: "seen", state: "waiting", needsYou: { kind: "input", why: "", since: 1 } },
      { name: "L", from: "seen", state: "idle", role: "lantern" },
    ]);
    expect(lanternNeed()).toBe(2);
  });
});

