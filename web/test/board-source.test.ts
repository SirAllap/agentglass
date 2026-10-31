/**
 * The board asks a source, not ClickUp.
 *
 * `ClickUpBody` made about forty `api.clickup*` calls of its own, which is why a
 * second tracker could only have a board by copying the body. The board's calls
 * now go through `BoardSource` (lib/boardSource.ts), and ClickUp is the source
 * it was written against. Two things have to stay true: the body no longer
 * names ClickUp's API for anything a source supplies, and `CLICKUP_BOARD` is
 * each call it replaced, with the same arguments, so the requests do not change.
 *
 * Read from source for the first, because the body is a component and what
 * matters is which calls it contains; run for the second.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { api } from "../src/lib/api.ts";
import { CLICKUP_BOARD, boardStorageKey } from "../src/lib/boardSource.ts";

const SRC = readFileSync(new URL("../src/components/TasksPanel.tsx", import.meta.url), "utf8");

/** One top-level function, from its header to the closing brace in column 0,
 *  without comments (a comment may name a call it no longer makes). */
function bodyOf(header: string): string {
  const from = SRC.indexOf(header);
  expect(from, `${header} is in the file`).toBeGreaterThanOrEqual(0);
  const to = SRC.indexOf("\n}\n", from);
  expect(to).toBeGreaterThan(from);
  return SRC.slice(from, to + 2)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the board body", () => {
  const body = bodyOf("function ClickUpBody(");

  test("no longer reads a board through ClickUp's API", () => {
    expect(body).not.toContain("api.clickupView(");
    expect(body).toContain("source.read(");
  });

  test("keeps only the two ClickUp calls that tests pin by line", () => {
    const left = [...body.matchAll(/api\.(clickup\w+)\(/g)].map((m) => m[1]).sort();
    /* `clickupWarm` is gated on a line note-lookup-gate reads, and the id
       lookup is raced against the sweep in search-id-race. A third name here
       is a call that should have gone through the source. */
    expect(left).toEqual(["clickupFind", "clickupWarm"]);
  });

  test("takes its source as a prop and defaults to ClickUp's", () => {
    expect(body).toContain("source = CLICKUP_BOARD, onWrites }");
    expect(body).toContain("source?: BoardSource;");
  });

  test("the tab mounts ClickUp's board without naming a source", () => {
    const mount = SRC.slice(SRC.indexOf("<ClickUpBody active={active}"), SRC.indexOf("<ClickUpBody active={active}") + 260);
    expect(mount).not.toContain("source=");
  });
});

describe("CLICKUP_BOARD", () => {
  /** Stub one api method for one call and hand back what it was called with. */
  async function through<K extends keyof typeof api>(name: K, call: () => unknown): Promise<unknown[]> {
    const holder = api as unknown as Record<string, unknown>;
    const before = holder[name];
    const seen: unknown[][] = [];
    holder[name] = (...a: unknown[]) => { seen.push(a); return Promise.resolve({ ok: true }); };
    try { await call(); } finally { holder[name] = before; }
    expect(seen, `${String(name)} was called once`).toHaveLength(1);
    return seen[0]!;
  }

  test("each method is the ClickUp call it replaced, argument for argument", async () => {
    expect(await through("clickupViews", () => CLICKUP_BOARD.views())).toEqual([]);
    expect(await through("clickupView", () => CLICKUP_BOARD.read("list:7", true))).toEqual(["list:7", true]);
    expect(await through("clickupView", () => CLICKUP_BOARD.read(undefined, false))).toEqual([undefined, false]);
    expect(await through("clickupList", () => CLICKUP_BOARD.list("901"))).toEqual(["901"]);
    expect(await through("clickupListViews", () => CLICKUP_BOARD.listViews("901"))).toEqual(["901"]);
    expect(await through("clickupAddView", () => CLICKUP_BOARD.addView("https://example.test/l/1"))).toEqual(["https://example.test/l/1"]);
    expect(await through("clickupReplaceView", () => CLICKUP_BOARD.replaceView("v1", "https://example.test/l/2"))).toEqual(["v1", "https://example.test/l/2"]);
    expect(await through("clickupRemoveView", () => CLICKUP_BOARD.removeView("v1"))).toEqual(["v1"]);
    expect(await through("clickupAddFolder", () => CLICKUP_BOARD.addFolder("f1", "Acme"))).toEqual(["f1", "Acme"]);
    expect(await through("clickupRemoveFolder", () => CLICKUP_BOARD.removeFolder("f1"))).toEqual(["f1"]);
    expect(await through("clickupWhere", () => CLICKUP_BOARD.where("ORBIT-1042"))).toEqual(["ORBIT-1042"]);
    expect(await through("clickupFind", () => CLICKUP_BOARD.find("1042"))).toEqual(["1042"]);
  });

  test("search passes the abort signal through, and the stream passes its listener", async () => {
    const ac = new AbortController();
    expect(await through("clickupSearch", () => CLICKUP_BOARD.search("rematch", false, ac.signal))).toEqual(["rematch", false, ac.signal]);
    const onSome = () => {};
    expect(await through("clickupSearchStream", () => CLICKUP_BOARD.searchStream("rematch", false, onSome, ac.signal)))
      .toEqual(["rematch", false, onSome, ac.signal]);
  });

  test("the write switch is one call, and drops the setup copy after it", async () => {
    expect(await through("clickupSetWrites", () => CLICKUP_BOARD.setWrites(true))).toEqual([true]);
  });

  test("the board's own address is the view's, and nothing before a read", () => {
    expect(CLICKUP_BOARD.openAddress(null)).toBeUndefined();
    expect(CLICKUP_BOARD.openAddress({ view: { url: "https://example.test/l/1" } } as never)).toBe("https://example.test/l/1");
    expect(CLICKUP_BOARD.openAddress({} as never)).toBeUndefined();
  });

  test("storage keys are the strings ClickUp has always used; another tracker gets its own id", () => {
    const keys = readFileSync(new URL("../src/components/TasksPanel.tsx", import.meta.url), "utf8");
    for (const [name, field] of [["listRail", "RAIL_KEY"], ["listRail.shut", "RAIL_SHUT_KEY"], ["listRail.width", "RAIL_W_KEY"],
      ["cardMode", "CARD_MODE_KEY"], ["cardWidth", "CARD_W_KEY"]] as const) {
      expect(keys, field).toContain(`const ${field} = "${CLICKUP_BOARD.storageKey(name)}";`);
    }
    expect(boardStorageKey("jira", "listRail")).toBe("agentglass.jira.listRail");
  });

  test("a source that cannot list a list's views is not asked", () => {
    expect(CLICKUP_BOARD.caps.listViews).toBe(true);
    expect(bodyOf("function ClickUpBody(")).toContain("!source.caps.listViews");
  });
});
