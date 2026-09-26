/*
 * Read marks on the server: the merge rules, the limits, and what gets told.
 *
 * The unit half runs against the scratch database `bun test` gives db.ts. The
 * live half boots a real server with a socket open, because "a replayed batch
 * broadcasts nothing" is a claim about what a second device receives, and only
 * a real socket can show an absence.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { applyMarks, listMarks, parseMarkOps, MARK_BATCH_MAX, MARK_FUTURE_MS, MARK_KEY_MAX, MARK_ROWS_MAX } from "../src/marks.ts";
import { db } from "../src/db.ts";
import { scopeNeeded } from "../src/auth.ts";
import { issueDevice } from "../src/devices.ts";
import type { MarkOp } from "../../shared/types.ts";

const NOW = 1_780_000_000_000;
const PR = "acme/orbit#42";

describe("pull request marks only move forward", () => {
  test("a later mark wins, an earlier one is a no-op that returns nothing", () => {
    const first = applyMarks([{ kind: "pr", key: PR, seenAt: NOW - 1000 }], NOW);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: "pr", key: PR, seenAt: NOW - 1000, updatedAt: NOW });

    expect(applyMarks([{ kind: "pr", key: PR, seenAt: NOW - 5000 }], NOW + 1)).toEqual([]);
    expect(listMarks("pr").find((r) => r.key === PR)?.seenAt).toBe(NOW - 1000);

    const later = applyMarks([{ kind: "pr", key: PR, seenAt: NOW }], NOW + 2);
    expect(later.map((r) => r.seenAt)).toEqual([NOW]);
  });

  test("replaying the same batch changes nothing the second time", () => {
    const batch: MarkOp[] = [
      { kind: "pr", key: "acme/orbit#7", seenAt: NOW },
      { kind: "card", key: "ORBIT-1042", seenAt: NOW },
      { kind: "inbox", key: "90000000001", state: "saved" },
    ];
    expect(applyMarks(batch, NOW)).toHaveLength(3);
    expect(applyMarks(batch, NOW + 10)).toEqual([]);
  });

  test("clear is the one way back, and only when there is something to clear", () => {
    const key = "acme/orbit#8";
    applyMarks([{ kind: "pr", key, seenAt: NOW }], NOW);
    const cleared = applyMarks([{ kind: "pr", key, clear: true }], NOW + 1);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ seenAt: 0, updatedAt: NOW + 1 });
    expect(applyMarks([{ kind: "pr", key, clear: true }], NOW + 2)).toEqual([]);
    expect(applyMarks([{ kind: "pr", key: "acme/orbit#never", clear: true }], NOW + 2)).toEqual([]);
    // After a clear any real mark is ahead of it again.
    expect(applyMarks([{ kind: "pr", key, seenAt: NOW - 1 }], NOW + 3)).toHaveLength(1);
  });

  test("a mark from the far future is held to five minutes ahead of the server", () => {
    const key = "acme/orbit#9";
    const [r] = applyMarks([{ kind: "pr", key, seenAt: NOW + 86_400_000 }], NOW);
    expect(r!.seenAt).toBe(NOW + MARK_FUTURE_MS);
  });
});

describe("inbox shelves", () => {
  test("last write wins, and the same state twice is silent", () => {
    const key = "90000000002";
    expect(applyMarks([{ kind: "inbox", key, state: "saved" }], NOW)).toHaveLength(1);
    expect(applyMarks([{ kind: "inbox", key, state: "done" }], NOW + 1)[0]?.state).toBe("done");
    expect(applyMarks([{ kind: "inbox", key, state: "done" }], NOW + 2)).toEqual([]);
    expect(applyMarks([{ kind: "inbox", key, state: "" }], NOW + 3)[0]?.state).toBe("");
  });

  test("ifAbsent never overrides what the server already holds", () => {
    const key = "90000000003";
    applyMarks([{ kind: "inbox", key, state: "done" }], NOW);
    expect(applyMarks([{ kind: "inbox", key, state: "saved", ifAbsent: true }], NOW + 1)).toEqual([]);
    expect(listMarks("inbox").find((r) => r.key === key)?.state).toBe("done");
    // ...and does write where there is nothing.
    const fresh = applyMarks([{ kind: "inbox", key: "90000000004", state: "saved", ifAbsent: true }], NOW + 1);
    expect(fresh[0]?.state).toBe("saved");
  });
});

describe("since", () => {
  test("only rows moved after it, by the server's clock", () => {
    applyMarks([{ kind: "pr", key: "acme/orbit#100", seenAt: NOW }], NOW + 50_000);
    const after = listMarks(undefined, NOW + 49_999).map((r) => r.key);
    expect(after).toContain("acme/orbit#100");
    expect(after).not.toContain(PR);
    expect(listMarks(undefined, NOW + 50_000).map((r) => r.key)).not.toContain("acme/orbit#100");
  });
});

describe("validation", () => {
  const bad = (ops: unknown) => parseMarkOps({ ops });
  test("the batch is refused whole", () => {
    expect(bad([{ kind: "pr", key: PR, seenAt: NOW }, { kind: "branch", key: "x", seenAt: 1 }])).toHaveProperty("error");
    expect(bad([{ kind: "pr", key: "", seenAt: NOW }])).toHaveProperty("error");
    expect(bad([{ kind: "pr", key: "k".repeat(MARK_KEY_MAX + 1), seenAt: NOW }])).toHaveProperty("error");
    expect(bad([{ kind: "pr", key: PR, seenAt: Number.POSITIVE_INFINITY }])).toHaveProperty("error");
    expect(bad([{ kind: "pr", key: PR, seenAt: 0 }])).toHaveProperty("error");
    expect(bad([{ kind: "inbox", key: "1", state: "archived" }])).toHaveProperty("error");
    expect(bad(Array.from({ length: MARK_BATCH_MAX + 1 }, (_, i) => ({ kind: "pr", key: `acme/orbit#${i}`, seenAt: NOW })))).toHaveProperty("error");
    expect(parseMarkOps({})).toHaveProperty("error");
  });
  test("a fraction of a millisecond is not a mark: floored first, then held to at least 1", () => {
    // 0.5 floors to 0, and 0 is what a clear writes — a new key would land as
    // a cleared row and be broadcast as one.
    expect(bad([{ kind: "pr", key: PR, seenAt: 0.5 }])).toHaveProperty("error");
    expect(parseMarkOps({ ops: [{ kind: "pr", key: PR, seenAt: 1.5 }] })).toEqual({ ops: [{ kind: "pr", key: PR, seenAt: 1 }] });
  });
  test("each kind's key has its own shape", () => {
    // pr: what the web writes, `${repo || "?"}#n`.
    expect(bad([{ kind: "pr", key: "acme/orbit", seenAt: NOW }])).toHaveProperty("error");
    expect(bad([{ kind: "pr", key: "acme orbit#1", seenAt: NOW }])).toHaveProperty("error");
    expect(bad([{ kind: "pr", key: "__proto__", seenAt: NOW }])).toHaveProperty("error");
    expect(bad([{ kind: "pr", key: "acme/orbit#1", clear: true }])).not.toHaveProperty("error");
    expect(bad([{ kind: "pr", key: "?#1", seenAt: NOW }])).not.toHaveProperty("error");
    // inbox: a GitHub notification thread id, which ghinbox.ts already only
    // accepts as digits.
    for (const key of ["__proto__", "constructor", "toString", "90000000001x"]) {
      expect(bad([{ kind: "inbox", key, state: "done" }]), key).toHaveProperty("error");
    }
    // card: any id a board uses.
    expect(bad([{ kind: "card", key: "ORBIT-1042", seenAt: NOW }])).not.toHaveProperty("error");
  });
  test("what passes comes out in the shape applyMarks takes", () => {
    const ok = parseMarkOps({ ops: [
      { kind: "pr", key: PR, seenAt: NOW + 0.7 },
      { kind: "card", key: "ORBIT-1042", clear: true, seenAt: 5 },
      { kind: "inbox", key: "1", state: "done", ifAbsent: "yes" },
    ] });
    expect(ok).toEqual({ ops: [
      { kind: "pr", key: PR, seenAt: NOW },
      { kind: "card", key: "ORBIT-1042", clear: true },
      { kind: "inbox", key: "1", state: "done" },
    ] });
    expect(parseMarkOps({ ops: Array.from({ length: MARK_BATCH_MAX }, () => ({ kind: "pr", key: PR, seenAt: 1 })) })).toHaveProperty("ops");
  });
});

describe("cap", () => {
  test("past the cap a kind loses its oldest rows, and no other kind's", () => {
    db.run(`DELETE FROM read_marks WHERE kind = 'card'`);
    const prBefore = listMarks("pr").length;
    for (let start = 0; start < MARK_ROWS_MAX + 10; start += MARK_BATCH_MAX) {
      const ops: MarkOp[] = [];
      for (let i = start; i < Math.min(start + MARK_BATCH_MAX, MARK_ROWS_MAX + 10); i++) ops.push({ kind: "card", key: `ORBIT-${i}`, seenAt: NOW });
      applyMarks(ops, NOW + start);
    }
    const cards = listMarks("card").map((r) => r.key);
    expect(cards).toHaveLength(MARK_ROWS_MAX);
    expect(cards).not.toContain("ORBIT-0");
    expect(cards).toContain(`ORBIT-${MARK_ROWS_MAX + 9}`);
    expect(listMarks("pr").length).toBe(prBefore);
  });
});

describe("scope", () => {
  test("writing is answer scope, reading is read scope", () => {
    expect(scopeNeeded("POST", "/marks")).toBe("answer");
    expect(scopeNeeded("GET", "/marks")).toBe("read");
  });
});

describe("live: the route and the socket", () => {
  let dir = "", base = "", readPhone = "", proc: ReturnType<typeof Bun.spawn> | null = null;
  const sockets: WebSocket[] = [];
  const savedXdg = process.env.XDG_CONFIG_HOME;
  // A token, so the server asks every caller who it is: without one a loopback
  // caller is never checked for scope, and a read device would pass as the
  // machine.
  const TOKEN = "machine-token-for-marks";
  const machine = { authorization: `Bearer ${TOKEN}` };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "agx-marks-"));
    // The device store is read from XDG_CONFIG_HOME at call time, so the
    // credential is minted into the directory the server is about to use.
    process.env.XDG_CONFIG_HOME = dir;
    readPhone = issueDevice("Look-only tablet", "read").token;
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
      env: {
        PATH: process.env.PATH ?? "", TMUX_TMPDIR: TMUX_TEST_TMPDIR, HOME: process.env.HOME ?? "",
        XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir,
        AGENTGLASS_STATE_DIR: dir, AGENTGLASS_ROOT: dir, AGENTGLASS_DB: join(dir, "m.db"),
        AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port), AGENTGLASS_TOKEN: TOKEN,
      },
      stdout: "ignore", stderr: "pipe",
    });
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(base + "/health", { headers: machine })).ok) break; } catch { /* not up yet */ }
      await Bun.sleep(100);
    }
  }, SERVER_BOOT_MS);

  afterAll(() => {
    for (const s of sockets) { try { s.close(); } catch { /* gone */ } }
    try { proc?.kill(); } catch { /* gone */ }
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
  });

  /** A `/stream` client that keeps every `marks` frame it is sent. */
  async function listener(): Promise<any[]> {
    const ws = new WebSocket(base.replace("http", "ws") + `/stream?token=${TOKEN}`);
    sockets.push(ws);
    const frames: any[] = [];
    ws.addEventListener("message", (ev) => {
      try { const f = JSON.parse(String((ev as MessageEvent).data)); if (f.type === "marks") frames.push(f); } catch { /* not json */ }
    });
    await new Promise((r) => ws.addEventListener("open", r));
    return frames;
  }

  const post = (body: unknown, origin: string | null = base) => fetch(base + "/marks", {
    method: "POST",
    headers: { "content-type": "application/json", ...machine, ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });

  test("a change is broadcast once; the same batch again is answered and not broadcast", async () => {
    const frames = await listener();
    const ops = [{ kind: "pr", key: "acme/orbit#42", seenAt: Date.now() - 1000 }];
    const first = await (await post({ ops })).json() as any;
    expect(first.ok).toBe(true);
    expect(first.changed).toHaveLength(1);
    await Bun.sleep(200);
    expect(frames).toHaveLength(1);
    expect(frames[0].data[0]).toMatchObject({ kind: "pr", key: "acme/orbit#42" });

    const again = await (await post({ ops })).json() as any;
    expect(again).toEqual({ ok: true, changed: [] });
    await Bun.sleep(200);
    expect(frames).toHaveLength(1);

    const got = await (await fetch(base + "/marks?kind=pr", { headers: machine })).json() as any;
    expect(got.marks.map((r: any) => r.key)).toEqual(["acme/orbit#42"]);
    expect(typeof got.now).toBe("number");
  });

  test("a bad batch is a 400 and changes nothing, not even its good ops", async () => {
    const good = { kind: "pr", key: "acme/orbit#44", seenAt: Date.now() - 1000 };
    const mixed = await post({ ops: [good, { kind: "branch", key: "x", seenAt: 1 }] });
    expect(mixed.status).toBe(400);
    const tooMany = Array.from({ length: MARK_BATCH_MAX + 1 }, (_, i) => ({ kind: "pr", key: `acme/orbit#${1000 + i}`, seenAt: Date.now() - 1000 }));
    expect((await post({ ops: tooMany })).status).toBe(400);
    const got = await (await fetch(base + "/marks?kind=pr", { headers: machine })).json() as any;
    const keys = got.marks.map((m: any) => m.key);
    expect(keys).not.toContain("acme/orbit#44");
    expect(keys).not.toContain("acme/orbit#1000");
    expect((await fetch(base + "/marks?kind=nope", { headers: machine })).status).toBe(400);
  });

  test("a device paired for read may ask, and may not write", async () => {
    const auth = { authorization: `Bearer ${readPhone}` };
    const r = await fetch(base + "/marks", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: base, ...auth },
      body: JSON.stringify({ ops: [{ kind: "pr", key: "acme/orbit#45", seenAt: Date.now() - 1000 }] }),
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).needs).toBe("answer");
    const got = await fetch(base + "/marks?kind=pr", { headers: auth });
    expect(got.status).toBe(200);
    expect(((await got.json()) as any).marks.map((m: any) => m.key)).not.toContain("acme/orbit#45");
  });

  test("a page on another origin cannot mark things read", async () => {
    const r = await post({ ops: [{ kind: "pr", key: "acme/orbit#43", seenAt: Date.now() }] }, "https://evil.example");
    expect(r.status).toBe(403);
    const got = await (await fetch(base + "/marks?kind=pr", { headers: machine })).json() as any;
    expect(got.marks.map((m: any) => m.key)).not.toContain("acme/orbit#43");
  });
});
