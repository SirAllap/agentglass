/*
 * Read marks between this browser and the server.
 *
 * Two directions that must never meet: a local write is sent, a server row is
 * applied, and applying one must not send it back — that loop is every device
 * re-POSTing every mark and the server broadcasting each one again.
 *
 * The transport is handed in rather than `fetch` stubbed: `bun test` shares
 * `globalThis.fetch` with every other file, and api-cold-start-retry.test.ts
 * explains at length what a stub written for one file does to its neighbours.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { MarkOp, MarkRow } from "../../shared/types.ts";

/* A real store, installed before the modules under test are imported — see
   pr-new.test.ts for why a shared no-op stub is not good enough. */
const cell = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => cell.get(k) ?? null,
  setItem: (k: string, v: string) => { cell.set(k, v); },
  removeItem: (k: string) => { cell.delete(k); },
};

const { SEEN_KEY, readSeen, writeSeen, clearSeen, markAllSeen, onSeenChange } = await import("../src/lib/prNew.ts");
const { __resetMarks, doneIds, isDone, isSaved, setDone, setSaved, subscribeMarks } = await import("../src/lib/inboxMarks.ts");
const { MIGRATED_KEY, QUEUE_KEY, FLUSH_MS, applyMarkRows, flushMarks, localMarkOps, startMarksSync, stopMarksSync, syncMarks } = await import("../src/lib/marksSync.ts");

const T = 1_780_000_000_000;
const row = (kind: MarkRow["kind"], key: string, seenAt: number, state = ""): MarkRow => ({ kind, key, seenAt, state, updatedAt: T });

/** A server that records what it was sent and answers GET with `rows`. */
function fake(rows: MarkRow[] = [], opts: { refuse?: boolean; offline?: boolean } = {}) {
  const posts: MarkOp[][] = [];
  const gets: (number | undefined)[] = [];
  return {
    posts, gets,
    get: async (since?: number) => { gets.push(since); return { marks: rows, now: T + 60_000 }; },
    post: async (ops: MarkOp[]) => {
      if (opts.offline) throw new TypeError("Failed to fetch");
      posts.push(ops);
      return { ok: !opts.refuse };
    },
  };
}

beforeEach(() => {
  cell.clear();
  // The epoch migration in prNew would otherwise wipe what the test seeds.
  readSeen();
  __resetMarks();
});
afterEach(() => stopMarksSync());

const seed = () => {
  cell.set(SEEN_KEY, JSON.stringify({ "acme/orbit#1": T - 100, "acme/orbit#2": T - 200 }));
  cell.set("agx.inbox.done", JSON.stringify(["90000000001"]));
  cell.set("agx.inbox.saved", JSON.stringify(["90000000002"]));
  __resetMarks();
};

describe("first sync", () => {
  it("sends what this browser holds: pull requests as they are, shelves only where the server has none", async () => {
    seed();
    const srv = fake();
    startMarksSync(srv);
    await syncMarks();
    expect(srv.posts).toHaveLength(1);
    expect(srv.posts[0]).toEqual([
      { kind: "pr", key: "acme/orbit#1", seenAt: T - 100 },
      { kind: "pr", key: "acme/orbit#2", seenAt: T - 200 },
      { kind: "inbox", key: "90000000001", state: "done", ifAbsent: true },
      { kind: "inbox", key: "90000000002", state: "saved", ifAbsent: true },
    ]);
    expect(cell.get(MIGRATED_KEY)).toBe("1");
    expect(srv.gets).toEqual([undefined]);
  });

  it("happens once per browser, and later syncs ask only for what moved since", async () => {
    seed();
    const srv = fake();
    startMarksSync(srv);
    await syncMarks();
    await syncMarks();
    expect(srv.posts).toHaveLength(1);
    expect(srv.gets).toEqual([undefined, T + 60_000 - 1000]);
  });

  it("is tried again next time if the server refused it", async () => {
    seed();
    startMarksSync(fake([], { refuse: true }));
    await syncMarks();
    expect(cell.get(MIGRATED_KEY)).toBeUndefined();
  });
});

describe("server rows into the cache", () => {
  it("moves pull requests forward, clears on 0, and sets shelves", async () => {
    seed();
    cell.set(MIGRATED_KEY, "1");
    startMarksSync(fake([
      row("pr", "acme/orbit#1", T),          // later than ours: taken
      row("pr", "acme/orbit#2", 0),          // marked unread elsewhere
      row("pr", "acme/orbit#3", T - 5),      // new to this browser
      row("inbox", "90000000002", 0, "done"),
      row("inbox", "90000000003", 0, "saved"),
      row("card", "ORBIT-1042", T),          // nothing here keeps these
    ]));
    await syncMarks();
    expect(readSeen()).toEqual({ "acme/orbit#1": T, "acme/orbit#3": T - 5 });
    expect(isDone("90000000002")).toBe(true);
    expect(isSaved("90000000002")).toBe(false);
    expect(isSaved("90000000003")).toBe(true);
  });

  it("never moves a mark backwards", () => {
    seed();
    applyMarkRows([row("pr", "acme/orbit#1", T - 1_000_000)]);
    expect(readSeen()["acme/orbit#1"]).toBe(T - 100);
  });

  it("is not sent back — not from the GET, not from a socket frame", async () => {
    cell.set(MIGRATED_KEY, "1");
    const srv = fake([row("pr", "acme/orbit#5", T), row("inbox", "90000000005", 0, "saved")]);
    startMarksSync(srv);
    await syncMarks();
    applyMarkRows([row("pr", "acme/orbit#6", T), row("pr", "acme/orbit#5", 0), row("inbox", "90000000005", 0, "done")]);
    await Bun.sleep(FLUSH_MS + 50);
    await flushMarks();
    expect(srv.posts).toEqual([]);
  });
});

describe("local writes", () => {
  it("are batched into one POST", async () => {
    cell.set(MIGRATED_KEY, "1");
    const srv = fake();
    startMarksSync(srv);
    markAllSeen([7, 8], "acme/orbit", T);
    clearSeen("acme/orbit#7");
    setSaved("90000000007", true);
    setDone("90000000007", true);
    expect(srv.posts).toEqual([]);
    await Bun.sleep(FLUSH_MS + 50);
    expect(srv.posts).toEqual([[
      { kind: "pr", key: "acme/orbit#7", seenAt: T },
      { kind: "pr", key: "acme/orbit#8", seenAt: T },
      { kind: "pr", key: "acme/orbit#7", clear: true },
      { kind: "inbox", key: "90000000007", state: "saved" },
      { kind: "inbox", key: "90000000007", state: "done" },
    ]]);
  });

  it("that changed nothing send nothing", async () => {
    cell.set(MIGRATED_KEY, "1");
    const srv = fake();
    writeSeen("acme/orbit#9", T);
    startMarksSync(srv);
    writeSeen("acme/orbit#9", T - 1);
    clearSeen("acme/orbit#never-read");
    await flushMarks();
    expect(srv.posts).toEqual([]);
  });

  it("wait for the next sync when the server is unreachable", async () => {
    cell.set(MIGRATED_KEY, "1");
    const down = fake([], { offline: true });
    startMarksSync(down);
    writeSeen("acme/orbit#10", T);
    await flushMarks();
    expect(down.posts).toEqual([]);
    // Back up: the queued op goes out with the reconnect's sync.
    const up = fake();
    down.post = up.post;
    await syncMarks();
    expect(up.posts).toEqual([[{ kind: "pr", key: "acme/orbit#10", seenAt: T }]]);
  });

  it("go nowhere once sync has stopped", async () => {
    cell.set(MIGRATED_KEY, "1");
    const srv = fake();
    startMarksSync(srv);
    stopMarksSync();
    writeSeen("acme/orbit#11", T);
    setSaved("90000000011", true);
    await Bun.sleep(FLUSH_MS + 50);
    await flushMarks();
    expect(srv.posts).toEqual([]);
    expect(cell.get(QUEUE_KEY)).toBeUndefined();
    // ...and they still land where the panels read them.
    expect(readSeen()["acme/orbit#11"]).toBe(T);
    expect(isSaved("90000000011")).toBe(true);
  });
});

/** A server that keeps what it is sent, with the same two merge rules as
 *  server/src/marks.ts, and logs every call in the order it arrived. */
function store(initial: MarkRow[] = []) {
  const rows = new Map(initial.map((r) => [`${r.kind}\0${r.key}`, { ...r }]));
  const log: string[] = [];
  const posts: MarkOp[][] = [];
  let offline = false;
  return {
    rows, log, posts,
    set offline(v: boolean) { offline = v; },
    get: async () => { log.push("get"); return { marks: [...rows.values()], now: T + 60_000 }; },
    post: async (ops: MarkOp[]) => {
      if (offline) throw new TypeError("Failed to fetch");
      log.push("post");
      posts.push(ops);
      for (const op of ops) {
        const id = `${op.kind}\0${op.key}`;
        const cur = rows.get(id) ?? { kind: op.kind, key: op.key, seenAt: 0, state: "", updatedAt: T };
        if ("state" in op) { if (!(op.ifAbsent && rows.has(id))) cur.state = op.state; }
        else if ("clear" in op) cur.seenAt = 0;
        else cur.seenAt = Math.max(cur.seenAt, op.seenAt);
        rows.set(id, cur);
      }
      return { ok: true };
    },
  };
}

describe("offline, then a reload", () => {
  it("keeps what could not be sent, and sends it before asking the server for its copy", async () => {
    cell.set(MIGRATED_KEY, "1");
    // What the server held before this browser went offline: the pull request
    // unread, the thread saved.
    const srv = store([row("pr", "acme/orbit#20", 0), row("inbox", "90000000020", 0, "saved")]);
    srv.offline = true;
    startMarksSync(srv);
    writeSeen("acme/orbit#20", T);
    setDone("90000000020", true);
    await flushMarks();
    expect(srv.posts).toEqual([]);
    expect(JSON.parse(cell.get(QUEUE_KEY) ?? "[]")).toHaveLength(2);

    // The tab is closed and opened again with the server back.
    stopMarksSync();
    __resetMarks();
    srv.offline = false;
    startMarksSync(srv);
    await syncMarks();
    expect(srv.log).toEqual(["post", "get"]);
    expect(srv.posts).toEqual([[
      { kind: "pr", key: "acme/orbit#20", seenAt: T },
      { kind: "inbox", key: "90000000020", state: "done" },
    ]]);
    expect(readSeen()["acme/orbit#20"]).toBe(T);
    expect(isDone("90000000020")).toBe(true);
    expect(cell.get(QUEUE_KEY)).toBeUndefined();
  });

  it("asks nothing of the server while its own writes are still unsent", async () => {
    cell.set(MIGRATED_KEY, "1");
    const srv = store([row("pr", "acme/orbit#21", 0)]);
    srv.offline = true;
    startMarksSync(srv);
    writeSeen("acme/orbit#21", T);
    // A GET that answers while the POST does not would put the server's stale
    // copy over the write it has not heard of yet.
    srv.get = async () => { srv.log.push("get"); return { marks: [...srv.rows.values()], now: T + 60_000 }; };
    await syncMarks();
    expect(srv.log).toEqual([]);
    expect(readSeen()["acme/orbit#21"]).toBe(T);
  });

  it("reads a queue it cannot parse as an empty one", async () => {
    cell.set(MIGRATED_KEY, "1");
    cell.set(QUEUE_KEY, "{not json");
    const srv = fake();
    startMarksSync(srv);
    await syncMarks();
    expect(srv.posts).toEqual([]);
    expect(srv.gets).toEqual([undefined]);
  });
});

describe("order", () => {
  it("two flushes reach the server one after the other, in the order they were asked", async () => {
    cell.set(MIGRATED_KEY, "1");
    const log: string[] = [];
    let n = 0;
    startMarksSync({
      get: async () => ({ marks: [], now: T }),
      post: async (ops) => {
        const i = ++n;
        log.push(`start ${i} ${ops.map((o) => ("state" in o ? o.state : "pr")).join(",")}`);
        // The first is the slow one: unordered, the second lands first.
        await Bun.sleep(i === 1 ? 60 : 0);
        log.push(`end ${i}`);
        return { ok: true };
      },
    });
    setSaved("90000000030", true);
    const first = flushMarks();
    await Bun.sleep(5); // the first POST is on the wire
    setDone("90000000030", true);
    const second = flushMarks();
    await Promise.all([first, second]);
    expect(log).toEqual(["start 1 saved", "end 1", "start 2 done", "end 2"]);
  });

  it("a sync asked for while one runs runs once more after it, not alongside it", async () => {
    cell.set(MIGRATED_KEY, "1");
    let open = 0, most = 0, gets = 0;
    startMarksSync({
      get: async () => {
        gets++; open++; most = Math.max(most, open);
        await Bun.sleep(30);
        open--;
        return { marks: [], now: T };
      },
      post: async () => ({ ok: true }),
    });
    const a = syncMarks();
    await Bun.sleep(5);
    const b = syncMarks();
    const c = syncMarks();
    await Promise.all([a, b, c]);
    expect(gets).toBe(2);
    expect(most).toBe(1);
  });
});

describe("a device paired for read", () => {
  it("stops writing for the page after the first refusal, and still reads", async () => {
    seed();
    const posts: MarkOp[][] = [];
    let gets = 0;
    startMarksSync({
      get: async () => { gets++; return { marks: [row("pr", "acme/orbit#40", T)], now: T }; },
      post: async (ops) => { posts.push(ops); return { ok: false, needs: "answer" }; },
    });
    await syncMarks();
    expect(posts).toHaveLength(1); // the migration, refused
    expect(readSeen()["acme/orbit#40"]).toBe(T);

    writeSeen("acme/orbit#41", T);
    await Bun.sleep(FLUSH_MS + 50);
    await flushMarks();
    await syncMarks();
    expect(posts).toHaveLength(1);
    expect(gets).toBe(2);
    expect(cell.get(QUEUE_KEY)).toBeUndefined();
    expect(cell.get(MIGRATED_KEY)).toBeUndefined();
  });
});

describe("the Done shelf against the server's", () => {
  const dones = (n: number) => Array.from({ length: n }, (_, i) => ({ ...row("inbox", String(90000100000 + i), 0, "done"), updatedAt: T + i }));

  it("a server full of finished threads is taken once, and a reload changes nothing", async () => {
    cell.set(MIGRATED_KEY, "1");
    // As many as the server keeps: a local cap below that re-added the ids it
    // had evicted on every full GET, and threads came back into the inbox.
    const all = dones(2000);
    startMarksSync(fake(all));
    await syncMarks();
    expect(doneIds()).toHaveLength(2000);
    const stored = cell.get("agx.inbox.done");

    stopMarksSync();
    __resetMarks();
    let changes = 0;
    const off = subscribeMarks(() => { changes++; });
    startMarksSync(fake(all));
    await syncMarks();
    off();
    expect(changes).toBe(0);
    expect(cell.get("agx.inbox.done")).toBe(stored);
  });

  it("past the cap it keeps the newest, whatever order the rows came in", () => {
    applyMarkRows(dones(2100).reverse());
    const kept = doneIds();
    expect(kept).toHaveLength(2000);
    expect(kept).toContain(String(90000100000 + 2099));
    expect(kept).not.toContain(String(90000100000 + 99));
  });
});

describe("keys that are not keys", () => {
  it("are never written into the map from the server", () => {
    seed();
    let told = 0;
    const off = onSeenChange(() => { told++; });
    applyMarkRows([row("pr", "__proto__", T), row("pr", "toString", 0), row("pr", "constructor", T)]);
    off();
    expect(told).toBe(0);
    expect(Object.keys(readSeen()).sort()).toEqual(["acme/orbit#1", "acme/orbit#2"]);
  });

  it("are left out of the first sync rather than have the server refuse the whole batch", () => {
    cell.set(SEEN_KEY, JSON.stringify({ "acme/orbit#1": T, "not a pr key": T }));
    cell.set("agx.inbox.done", JSON.stringify(["90000000001", "__proto__"]));
    __resetMarks();
    expect(localMarkOps().map((o) => o.key)).toEqual(["acme/orbit#1", "90000000001"]);
  });
});
