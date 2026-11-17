/*
 * The detail panel's menus: which rows exist, which are off and why. A row with no write path behind it is off with a reason, and a
 * write is off with the switch.
 */
import { describe, expect, test } from "bun:test";
import { NO_CHECKOUT_WHY, NO_PATH_WHY, headerMenu, rankAsk, sendMenu, sendPrompt, subtaskDetailMenu, swapped } from "../src/lib/cardDetailMenu.ts";
import { WRITES_OFF_WHY, type JiraMenu, type JiraMenuItem } from "../src/components/jira/list/menus/menuModel.ts";
import type { ProviderTask } from "../../shared/providers.ts";

const task = (o: Partial<ProviderTask> = {}): ProviderTask => ({ id: "10042", customId: "ORBIT-1042", title: "Session tokens are not rotated", url: "https://orbit.example/browse/ORBIT-1042", status: "In progress", statusKind: "open", ...o } as ProviderTask);
const items = (m: JiraMenu): JiraMenuItem[] => m.rows.filter((r): r is JiraMenuItem => r.kind === "item");
const row = (m: JiraMenu, id: string): JiraMenuItem => items(m).find((i) => i.id === id)!;

describe("the header's more menu", () => {
  test("opens the card, copies its key, link and branch, reads it again; no write", () => {
    const m = headerMenu(task());
    expect(items(m).map((i) => i.id)).toEqual(["openJira", "copyKey", "copyLink", "copyBranch", "reread"]);
    expect(items(m).every((i) => !i.why)).toBe(true);
    expect(row(m, "copyBranch").sub).toMatch(/^ORBIT-1042-/);
  });
  test("a card with no address cannot open or copy one", () => {
    const m = headerMenu(task({ url: "" }));
    expect(row(m, "openJira").why).toBeTruthy();
    expect(row(m, "copyLink").why).toBeTruthy();
  });
});

describe("the header's more menu carries what the one square group dropped", () => {
  const more = { back: true, watch: { on: false, label: "Watch" }, place: { mode: "dock" } };
  test("back, watch, float and the bottom strip come first, then the card's own rows, so nothing is unreachable", () => {
    const m = headerMenu(task(), more);
    expect(items(m).map((i) => i.id)).toEqual(["back", "watch", "placeFloat", "placeBottom", "openJira", "copyKey", "copyLink", "copyBranch", "reread"]);
  });
  test("a watch that cannot be pressed says why, and a lit one offers to stop", () => {
    expect(row(headerMenu(task(), { watch: { on: true, label: "Stop watching", why: "No" } }), "watch").why).toBe("No");
    expect(row(headerMenu(task(), { watch: { on: true, label: "Stop watching" } }), "watch").icon).toBe("eyeoff");
  });
  test("the header draws one group: re-read joins it beside close, eye and back stay in the menu", async () => {
    const src = (await Bun.file(new URL("../src/components/jira/detail/DetailHeader.tsx", import.meta.url)).text()).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).toContain("<DockChrome {...chrome}>{reread}{close}</DockChrome>");
    expect(src).toContain("{reread}{close}</span>");
    expect(src).not.toContain("<JiraWatch");
  });
});

describe("send to terminal", () => {
  test("with a checkout, send and shell are on", () => {
    const m = sendMenu(task(), "/work/orbit");
    expect([row(m, "send").why, row(m, "shell").why]).toEqual([undefined, undefined]);
  });
  test("without one they say why, and the worktree command still copies", () => {
    const m = sendMenu(task(), null);
    expect([row(m, "send").why, row(m, "shell").why]).toEqual([NO_CHECKOUT_WHY, NO_CHECKOUT_WHY]);
    expect(row(m, "copyWorktree").why).toBeUndefined();
  });
  test("the prompt carries the key, the title and the address only", () => {
    expect(sendPrompt(task())).toBe("Work on ORBIT-1042: Session tokens are not rotated\nhttps://orbit.example/browse/ORBIT-1042");
  });
});

describe("a sub-task's menu (P09)", () => {
  const f = { writable: true, index: 1, count: 3, done: false };
  test("Promote and Change parent are off with the reason, even with writes on", () => {
    const m = subtaskDetailMenu(task(), f);
    expect(row(m, "promote").why).toBe(NO_PATH_WHY);
    expect(row(m, "reparent").why).toBe(NO_PATH_WHY);
  });
  test("move and mark done are on with writes on", () => {
    const m = subtaskDetailMenu(task(), f);
    expect([row(m, "up").why, row(m, "down").why, row(m, "done").why]).toEqual([undefined, undefined, undefined]);
    expect([row(m, "up").sub, row(m, "down").sub]).toEqual(["Alt+Up", "Alt+Down"]);
  });
  test("with writes off every change row says the switch is off", () => {
    const m = subtaskDetailMenu(task(), { ...f, writable: false });
    for (const id of ["promote", "reparent", "up", "down", "done"]) expect(row(m, id).why).toBe(WRITES_OFF_WHY);
    expect(row(m, "open").why).toBeUndefined();
  });
  test("the first cannot go up, the last cannot go down, a done one cannot be marked", () => {
    expect(row(subtaskDetailMenu(task(), { ...f, index: 0 }), "up").why).toBe("It is the first");
    expect(row(subtaskDetailMenu(task(), { ...f, index: 2 }), "down").why).toBe("It is the last");
    expect(row(subtaskDetailMenu(task(), { ...f, done: true }), "done").why).toBe("Already done");
  });
});

describe("moving a row", () => {
  test("the rank write names the sibling it goes before or after, none at an end", () => {
    const k = ["A-1", "A-2", "A-3"];
    expect(rankAsk(k, 1, -1)).toEqual({ before: "A-1" });
    expect(rankAsk(k, 1, 1)).toEqual({ after: "A-3" });
    expect(rankAsk(k, 0, -1)).toBeNull();
    expect(rankAsk(k, 2, 1)).toBeNull();
    expect(rankAsk(k, -1, 1)).toBeNull();
  });
  test("the order shown swaps with the neighbour and leaves the input alone", () => {
    const rows = ["a", "b", "c"];
    expect(swapped(rows, 0, 1)).toEqual(["b", "a", "c"]);
    expect(swapped(rows, 0, -1)).toEqual(["a", "b", "c"]);
    expect(rows).toEqual(["a", "b", "c"]);
  });
});
