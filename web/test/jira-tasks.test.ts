/*
 * The Jira tab: when it is on the bar, what it says above its rows, how a jump
 * finds its card and what it costs to keep it fresh.
 *
 * What a mistake costs: a tab for a tracker nobody connected on every existing
 * install, a failed read that blanks a list that was fine a minute ago, a bell
 * that opens the wrong tracker's tab, and a window that reads the list on a
 * timer of its own. The screen has no renderer here, so rules about the screen
 * are asserted against its source.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";
import { visibleTaskSources, type TaskConnected } from "../src/lib/taskConnected.ts";
import { OPTIONAL_TASK_SOURCES, TASK_SOURCES, type TaskSourceId } from "../src/lib/taskSources.ts";
import { mineNote, rowFor } from "../src/lib/jiraMine.ts";
import { onOpenCard, openCard, type CardJump } from "../src/lib/openCard.ts";
import { gotoOfTarget } from "../src/lib/notifyRoute.ts";
import type { ProviderTask } from "../../shared/providers.ts";

const stubGlobal = globalStubs();
const OLD: TaskSourceId[] = ["github", "local", "clickup"];
const ALL: TaskSourceId[] = [...OLD, "jira"];
const set = (...on: TaskSourceId[]): TaskConnected =>
  ({ github: on.includes("github"), local: on.includes("local"), clickup: on.includes("clickup"), jira: on.includes("jira") });

describe("when the tab is on the bar", () => {
  test("only once Jira is connected: a fresh install and an existing one keep the bar they had", () => {
    expect(OPTIONAL_TASK_SOURCES).toEqual(["jira"]);
    expect(visibleTaskSources(ALL, set())).toEqual(OLD);
    expect(visibleTaskSources(ALL, set("github", "clickup"))).toEqual(["github", "clickup"]);
    expect(visibleTaskSources(ALL, null)).toEqual(OLD);
  });

  test("connected, it sits where the person put it", () => {
    expect(visibleTaskSources(ALL, set("github", "jira"))).toEqual(["github", "jira"]);
    expect(visibleTaskSources(["jira", "github", "local", "clickup"], set("github", "jira"))).toEqual(["jira", "github"]);
  });

  test("alone, it is a bar of one", () => {
    expect(visibleTaskSources(ALL, set("jira"))).toEqual(["jira"]);
  });

  test("it is the last thing in the catalogue, so nobody's saved order moves", () => {
    expect(TASK_SOURCES.at(-1)!.id).toBe("jira");
    expect(TASK_SOURCES.slice(0, 3).map((s) => s.id)).toEqual(OLD);
  });
});

const card = (id: string, key: string): ProviderTask => ({ id, customId: key } as ProviderTask);

describe("above the rows", () => {
  test("a good read says nothing; a cut-short one says so", () => {
    expect(mineNote({ ok: true }, true)).toBeNull();
    expect(mineNote({ ok: true, truncated: true }, true)).toMatchObject({ bad: false });
  });

  test("a failed read keeps the rows it had and says they are old", () => {
    const n = mineNote({ ok: false, error: "Could not reach Jira" }, true)!;
    expect(n.text).toContain("Could not reach Jira");
    expect(n.text).toContain("last read");
    expect(n.bad).toBe(true);
  });

  test("with nothing to fall back on it is just the sentence", () => {
    expect(mineNote({ ok: false, error: "Jira is not connected" }, false)!.text).toBe("Jira is not connected");
  });

  test("a rate limit is a wait, not an alarm", () => {
    expect(mineNote({ ok: false, throttled: true, error: "Jira is limiting requests, try again in 30s" }, true)!.bad).toBe(false);
  });
});

describe("a jump finds its row", () => {
  const rows = [card("20042", "ORBIT-1042"), card("20050", "ORBIT-1050")];
  test("by key in any case, or by the site's own id", () => {
    expect(rowFor(rows, "orbit-1050")?.id).toBe("20050");
    expect(rowFor(rows, " ORBIT-1042 ")?.id).toBe("20042");
    expect(rowFor(rows, "20050")?.customId).toBe("ORBIT-1050");
  });
  test("a card that is not among them, and a blank, are not found", () => {
    expect(rowFor(rows, "ORBIT-9")).toBeUndefined();
    expect(rowFor(rows, "")).toBeUndefined();
  });
});

describe("the bell opens the tracker the card is in", () => {
  test("the tracker travels with the errand, and its absence still means ClickUp", () => {
    const seen: CardJump[] = [];
    const off = onOpenCard((j) => seen.push(j));
    openCard("ORBIT-1042", "ORBIT-1042", "jira");
    openCard("86dyn0001", "ORBIT-1042");
    off();
    expect(seen[0]!.tracker).toBe("jira");
    expect(seen[1]).not.toHaveProperty("tracker");
  });

  test("a notification target keeps it on the way to the router", () => {
    expect(gotoOfTarget({ kind: "card", id: "ORBIT-1", label: "ORBIT-1", tracker: "jira" })).toEqual({ kind: "card", id: "ORBIT-1", label: "ORBIT-1", tracker: "jira" });
    expect(gotoOfTarget({ kind: "card", id: "86dyn", label: "ORBIT-2" })).toEqual({ kind: "card", id: "86dyn", label: "ORBIT-2" });
  });
});

describe("what it costs to stay fresh", () => {
  let screen = "", panel = "", live = "";
  beforeAll(async () => {
    screen = await Bun.file(new URL("../src/components/JiraTasks.tsx", import.meta.url)).text();
    panel = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
    live = await Bun.file(new URL("../src/lib/useLive.ts", import.meta.url)).text();
  });
  const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/?\*|\/\/)/.test(l)).join("\n");

  test("the only timer is the board heartbeat, and it asks only when the rows are old", () => {
    const c = code(screen);
    expect(c.match(/setInterval\(/g)).toHaveLength(1);
    expect(c).toContain("setInterval(() => ask(\"tick\"), BOARD_TICK_MS)");
    expect(c).toContain("boardDue(Date.now(), at.current, cause)");
    expect(c).not.toContain("setTimeout(");
  });

  test("Refresh is the one read that skips the server's minute", () => {
    const c = code(screen);
    expect(c).toContain("void load(true)");
    expect(c.match(/load\(false\)/g)!.length).toBe(2);
    expect(c.match(/jiraMine\(fresh\)/g)).toHaveLength(1);
  });

  test("one read in the air at a time", () => {
    expect(code(screen)).toContain("if (flying.current) return;");
  });

  test("the panel gives a Jira jump to Jira and keeps it from ClickUp", () => {
    const c = code(panel);
    expect(c).toContain('source === "jira" ? <JiraBody active={active} jump={cardJump} />');
    expect(c).toContain('jump={cardJump?.tracker === "jira" ? null : cardJump}');
    expect(c).toContain('const which = cardJump.tracker === "jira" ? "jira" : "clickup";');
  });

  test("a Jira note in the bell is called Jira and carries its tracker", () => {
    const c = code(live);
    expect(c).toContain('app: c.tracker === "jira" ? "Jira" : "ClickUp"');
    expect(c).toContain("...(c.tracker ? { tracker: c.tracker } : null)");
  });
});

describe("what the connection check says about a provider it was not told of", () => {
  test("an optional source is off, a plain one stays on", async () => {
    stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000" });
    stubGlobal("fetch", async () => Response.json({ providers: [{ id: "github", state: "connected" }] }));
    const m = await import("../src/lib/taskConnected.ts");
    m.__forgetTaskConnected();
    expect(await m.taskConnected()).toEqual({ github: true, local: true, clickup: true, jira: false });
    stubGlobal("fetch", async () => Response.json({ providers: [{ id: "jira", state: "connected" }] }));
    m.__forgetTaskConnected();
    expect((await m.taskConnected()).jira).toBe(true);
    stubGlobal("fetch", async () => { throw new TypeError("no network"); });
    m.__forgetTaskConnected();
    expect(await m.taskConnected()).toEqual({ github: true, local: true, clickup: true, jira: false });
    m.__forgetTaskConnected();
  });
});

describe("the request the screen sends", () => {
  let calls: string[] = [];
  beforeAll(() => {
    stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000" });
    stubGlobal("fetch", async (url: string) => { calls.push(url); return Response.json({ ok: true, tasks: [] }); });
  });
  beforeEach(() => { calls = []; });

  test("Refresh adds fresh=1 and nothing else does", async () => {
    const { api } = await import("../src/lib/api.ts");
    await api.jiraMine();
    await api.jiraMine(true);
    expect(calls.map((u) => new URL(u).pathname + new URL(u).search)).toEqual(["/jira/mine", "/jira/mine?fresh=1"]);
  });
});
