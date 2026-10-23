/*
 * Reading a folder a page at a time, without losing the place.
 *
 * The store is the half of the columns that is not drawing: it asks for pages
 * in order, appends them, lets a newer ask for the same folder replace an older
 * one (a refresh must not be overwritten by the slow answer it replaced), and
 * says what it knows so a 100,000-entry folder can show its first 128 rows
 * while the other 99,872 are still arriving.
 */
import { describe, expect, test } from "bun:test";
import { FolderStore, type Fetcher } from "../src/lib/finderFolders.ts";
import type { BrowsePage } from "../../shared/types.ts";

const entry = (n: string) => ({ name: n, kind: "file" as const, bytes: 1, items: null, mtime: 0, hidden: false });
/** A folder of `n` files served in pages, with a hook to hold or fail one page. */
function folder(n: number, o: { hold?: (cursor: number) => Promise<void>; fail?: number; refuse?: boolean } = {}) {
  const calls: { cursor: number; limit: number; hidden: boolean }[] = [];
  const fetch: Fetcher = async (path, cursor, hidden, limit, signal) => {
    calls.push({ cursor, limit, hidden });
    if (o.hold) await o.hold(cursor);
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    if (o.refuse) return { ok: false, path, total: 0, entries: [], next: null, hiddenSkipped: 0, error: "outside the places this may look" };
    if (o.fail === cursor) throw new Error("boom");
    const end = Math.min(n, cursor + limit);
    const entries = Array.from({ length: end - cursor }, (_, i) => entry(`f${cursor + i}`));
    return { ok: true, path, total: n, entries, next: end < n ? end : null, hiddenSkipped: 0 } satisfies BrowsePage;
  };
  return { fetch, calls };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("a folder arrives in pages", () => {
  test("the first page is small, the rest are larger, and the state ends done with every row once", async () => {
    const f = folder(1300);
    const s = new FolderStore(f.fetch, () => {}, 0);
    s.load("/a", false);
    await settle();
    const st = s.get("/a")!;
    expect(st.done).toBe(true);
    expect(st.rows.length).toBe(1300);
    expect(new Set(st.rows.map((r) => r.name)).size).toBe(1300);
    expect(f.calls[0]).toEqual({ cursor: 0, limit: 128, hidden: false });
    expect(f.calls[1]!.limit).toBe(512);
    expect(st.total).toBe(1300);
  });

  test("while later pages are still coming the first rows are already readable", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const f = folder(1000, { hold: (c) => (c > 0 ? gate : Promise.resolve()) });
    const s = new FolderStore(f.fetch, () => {}, 0);
    s.load("/a", false);
    await settle();
    const mid = s.get("/a")!;
    expect(mid.rows.length).toBe(128);
    expect(mid.done).toBe(false);
    expect(mid.total).toBe(1000);
    release();
    await settle();
    expect(s.get("/a")!.done).toBe(true);
  });

  test("a refused folder keeps the reason and no rows", async () => {
    const s = new FolderStore(folder(0, { refuse: true }).fetch, () => {}, 0);
    s.load("/etc", false);
    await settle();
    const st = s.get("/etc")!;
    expect(st.error).toBe("outside the places this may look");
    expect(st.rows).toEqual([]);
    expect(st.done).toBe(true);
  });

  test("a failing request is an error on that folder, not a throw out of the store", async () => {
    const s = new FolderStore(folder(500, { fail: 128 }).fetch, () => {}, 0);
    s.load("/a", false);
    await settle();
    const st = s.get("/a")!;
    expect(st.error).toBe("could not read this folder");
    expect(st.rows.length).toBe(128);
    expect(st.done).toBe(true);
  });
});

describe("asking again", () => {
  test("a refresh replaces the rows; the slow first answer cannot overwrite it", async () => {
    const order: string[] = [];
    let first = true;
    const fetch: Fetcher = async (path, cursor, _h, _l, signal) => {
      const mine = first; first = false;
      if (mine) await new Promise((r) => setTimeout(r, 40));
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      order.push(mine ? "old" : "new");
      return { ok: true, path, total: 1, entries: [entry(mine ? "old" : "new")], next: null, hiddenSkipped: 0 };
    };
    const s = new FolderStore(fetch, () => {}, 0);
    s.load("/a", false);
    s.load("/a", false, true);
    await new Promise((r) => setTimeout(r, 80));
    expect(s.get("/a")!.rows.map((r) => r.name)).toEqual(["new"]);
    expect(order).toEqual(["new"]);
  });

  test("an answer that lands after its folder was asked again is dropped even when the transport ignored the cancel", async () => {
    let n = 0;
    const fetch: Fetcher = async (path) => {
      const mine = ++n;
      await new Promise((r) => setTimeout(r, mine === 1 ? 40 : 5));
      return { ok: true, path, total: 1, entries: [entry(mine === 1 ? "old" : "new")], next: null, hiddenSkipped: 0 };
    };
    const s = new FolderStore(fetch, () => {}, 0);
    s.load("/a", false);
    s.load("/a", false, true);
    await new Promise((r) => setTimeout(r, 80));
    expect(s.get("/a")!.rows.map((r) => r.name)).toEqual(["new"]);
  });

  test("an unchanged ask is served from what is already there", async () => {
    const f = folder(10);
    const s = new FolderStore(f.fetch, () => {}, 0);
    s.load("/a", false);
    await settle();
    s.load("/a", false);
    await settle();
    expect(f.calls.length).toBe(1);
  });

  test("asking with the hidden switch flipped is a different question and is asked again", async () => {
    const f = folder(10);
    const s = new FolderStore(f.fetch, () => {}, 0);
    s.load("/a", false);
    await settle();
    s.load("/a", true);
    await settle();
    expect(f.calls.map((c) => c.hidden)).toEqual([false, true]);
  });

  test("only the most recent folders are kept", async () => {
    const f = folder(1);
    const s = new FolderStore(f.fetch, () => {}, 0, 3);
    for (const p of ["/a", "/b", "/c", "/d"]) { s.load(p, false); await settle(); }
    expect(s.get("/a")).toBeUndefined();
    expect(s.get("/d")).toBeDefined();
  });

  test("dispose stops everything in flight and silences the listener", async () => {
    let changes = 0;
    const f = folder(5000, { hold: () => new Promise((r) => setTimeout(r, 10)) });
    const s = new FolderStore(f.fetch, () => { changes++; }, 0);
    s.load("/a", false);
    await new Promise((r) => setTimeout(r, 15));
    s.dispose();
    const seen = changes;
    await new Promise((r) => setTimeout(r, 60));
    expect(changes).toBe(seen);
  });
});
