/**
 * ClickUp makes the same requests through the board's source as it did when the
 * board called `api.clickup*` itself.
 *
 * board-source.test.ts shows each source method is the call it replaced, by
 * arguments. This one goes down to the wire: every method is run once through
 * `CLICKUP_BOARD` and once the old way, and what was sent (method, path, query,
 * body) is compared, one request each, in that order. A source that added a
 * request, dropped one or changed an address fails here.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";

const stubGlobal = globalStubs();
let sent: string[] = [];
stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000", search: "" });
stubGlobal("fetch", async (input: unknown, init?: { method?: string; body?: string }) => {
  const u = new URL(String(input));
  sent.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}${init?.body ? ` ${init.body}` : ""}`);
  return new Response(JSON.stringify({ ok: true, views: [], tasks: [], statuses: [], fields: [], at: 0 }), { headers: { "content-type": "application/json" } });
});
const { api } = await import("../src/lib/api.ts");
const { CLICKUP_BOARD } = await import("../src/lib/boardSource.ts");

const ac = new AbortController();
const calls: [string, () => unknown, () => unknown][] = [
  ["views", () => CLICKUP_BOARD.views(), () => api.clickupViews()],
  ["read", () => CLICKUP_BOARD.read("list:7", false), () => api.clickupView("list:7", false)],
  ["forced read", () => CLICKUP_BOARD.read("list:7", true), () => api.clickupView("list:7", true)],
  ["the open board", () => CLICKUP_BOARD.read(undefined, false), () => api.clickupView(undefined, false)],
  ["list", () => CLICKUP_BOARD.list("901"), () => api.clickupList("901")],
  ["list views", () => CLICKUP_BOARD.listViews("901"), () => api.clickupListViews("901")],
  ["add view", () => CLICKUP_BOARD.addView("https://example.test/l/1"), () => api.clickupAddView("https://example.test/l/1")],
  ["replace view", () => CLICKUP_BOARD.replaceView("v1", "https://example.test/l/2"), () => api.clickupReplaceView("v1", "https://example.test/l/2")],
  ["remove view", () => CLICKUP_BOARD.removeView("v1"), () => api.clickupRemoveView("v1")],
  ["add folder", () => CLICKUP_BOARD.addFolder("f1", "Acme"), () => api.clickupAddFolder("f1", "Acme")],
  ["remove folder", () => CLICKUP_BOARD.removeFolder("f1"), () => api.clickupRemoveFolder("f1")],
  ["where", () => CLICKUP_BOARD.where("ORBIT-1042"), () => api.clickupWhere("ORBIT-1042")],
  // `find` is left out: pr-card-store.test.ts replaces `api.clickupFind` for the rest of the process, so a wire test would read the stub.
  // Its arguments are checked in board-source.test.ts.
  ["search", () => CLICKUP_BOARD.search("rematch", false, ac.signal), () => api.clickupSearch("rematch", false, ac.signal)],
  ["streamed search", () => CLICKUP_BOARD.searchStream("rematch", false, () => {}, ac.signal), () => api.clickupSearchStream("rematch", false, () => {}, ac.signal)],
];

describe("the ClickUp source on the wire", () => {
  beforeEach(() => { sent = []; });

  for (const [name, through, direct] of calls) {
    test(`${name}: the same request as the call it replaced`, async () => {
      await direct();
      const before = [...sent];
      sent = [];
      await through();
      expect(sent, name).toEqual(before);
      expect(sent.length, name).toBeGreaterThan(0);
    });
  }

  test("the write switch is one POST and nothing else (the setup copy is dropped locally)", async () => {
    await CLICKUP_BOARD.setWrites(true);
    expect(sent).toEqual(['POST /clickup/writes {"on":true}']);
  });

  test("opening the board in the tracker and the open link make no request at all", () => {
    CLICKUP_BOARD.openAddress({ view: { url: "https://example.test/l/1" } } as never);
    expect(sent).toEqual([]);
  });
});
