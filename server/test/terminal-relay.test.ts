// The terminal relay: its pure decisions, its one-use door, and one real
// relay process moving bytes between a socket and a child. The reason it exists
// (a week of 5-31 s terminal freezes from sharing the main loop with SQLite,
// tmux and sweeps) is written in server/src/relay/wire.ts; these tests pin the
// parts a regression would break quietly: a ticket that works twice, a relay
// that imports the database, a restart storm.
import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TicketBook, lineSplitter, restartDelay } from "../src/relay/wire.ts";
import { relayArgv, mintTickets, startRelay, stopRelay, relayInfo, relayPid, laneOf } from "../src/relay/relayHost.ts";
import { ptyDataFrom } from "../src/relay/ptyData.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

describe("TicketBook", () => {
  test("a ticket opens one door, once", () => {
    const b = new TicketBook();
    b.add("a", 1000);
    expect(b.burn("a", 1001)).toBe(true);
    expect(b.burn("a", 1002)).toBe(false);
    expect(b.burn("never-minted")).toBe(false);
  });
  test("a ticket past its time is refused and spent", () => {
    const b = new TicketBook(1000);
    b.add("a", 0);
    expect(b.burn("a", 1001)).toBe(false);
  });
  test("the book is capped: the oldest goes first", () => {
    const b = new TicketBook(10_000, 2);
    b.add("a", 0); b.add("b", 0); b.add("c", 0);
    expect(b.size).toBe(2);
    expect(b.burn("a", 1)).toBe(false);
    expect(b.burn("c", 1)).toBe(true);
  });
});

describe("restartDelay", () => {
  test("backs off, then gives up after four deaths in a minute", () => {
    expect(restartDelay([], 0)).toBe(250);
    expect(restartDelay([0], 1)).toBe(500);
    expect(restartDelay([0, 1, 2], 3)).toBe(2000);
    expect(restartDelay([0, 1, 2, 3], 4)).toBeNull();
    // Old deaths are forgiven.
    expect(restartDelay([0, 1, 2, 3], 120_000)).toBe(250);
  });
});

describe("lineSplitter", () => {
  test("keeps a half line until its end arrives", () => {
    const s = lineSplitter();
    expect(s('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(s(':2}\n\n')).toEqual(['{"b":2}']);
  });
});

describe("relayArgv", () => {
  test("a bun run re-enters the entry script; a compiled binary is its own second entry", () => {
    expect(relayArgv("/home/u/.bun/bin/bun", "/x/index.ts")).toEqual(["/home/u/.bun/bin/bun", "--no-env-file", "run", "/x/index.ts"]);
    expect(relayArgv("/opt/app/agentglass-server", "/x/index.ts")).toEqual(["/opt/app/agentglass-server"]);
  });
});

describe("ptyDataFrom", () => {
  const f = { worker: null, principal: null, ip: "127.0.0.1", local: true, deviceId: null };
  test("bounds what a URL can ask for", () => {
    const d = ptyDataFrom(new URLSearchParams("root=/p&line=99999999999&bench=500&edit=1&cols=100&rows=30"), f);
    expect(d.line).toBe(10_000_000);
    expect(d.bench).toBe(99);
    expect(d.edit).toBe(true);
    expect([d.cols, d.rows, d.root]).toEqual([100, 30, "/p"]);
  });
  test("the caller's standing comes from the ticket, never the query", () => {
    const d = ptyDataFrom(new URLSearchParams("worker=evil&principal=seat&local=1"), { ...f, worker: "w1", principal: "worker", local: false });
    expect([d.worker, d.principal, d.local]).toEqual(["w1", "worker", false]);
  });
});

test("no ticket is minted while the relay is down", () => {
  expect(mintTickets(2, { worker: null, principal: null, ip: null })).toBeNull();
});

/** Every module a file pulls in at run time, followed transitively. Uses the
 *  bundler's own scan, so a bare `import "./x"`, a dynamic `import()` and a
 *  `require` count, and a type-only import (erased) does not. */
function closure(entry: string): { files: Set<string>; bare: Set<string> } {
  const t = new Bun.Transpiler({ loader: "ts" });
  const files = new Set<string>(); const bare = new Set<string>();
  const walk = (f: string) => {
    if (files.has(f)) return; files.add(f);
    for (const imp of t.scanImports(readFileSync(f, "utf8"))) {
      if (imp.path.startsWith(".")) walk(resolve(dirname(f), imp.path)); else bare.add(imp.path);
    }
  };
  walk(entry);
  return { files, bare };
}
const RELAY_DIR = join(import.meta.dir, "../src/relay");

describe("the relay process stays off the database", () => {
  test("its run-time import graph is wire.ts, termrelay.ts, gate.ts and built-ins only", () => {
    const { files, bare } = closure(join(RELAY_DIR, "gate.ts"));
    expect([...files].map((f) => f.slice(RELAY_DIR.length + 1)).sort()).toEqual(["gate.ts", "termrelay.ts", "wire.ts"]);
    for (const b of bare) expect(b.startsWith("node:") || b === "bun").toBe(true);
  });
  test("the main-side half never imports terminal.ts at run time (it imports us)", () => {
    for (const f of ["relayHost.ts", "ptyData.ts"]) {
      const { files } = closure(join(RELAY_DIR, f));
      expect([...files].some((x) => x.endsWith("terminal.ts") || x.endsWith("db.ts"))).toBe(false);
    }
  });
  test("every file in relay/ is one of the five that were audited", () => {
    expect(readdirSync(RELAY_DIR).sort()).toEqual(["gate.ts", "ptyData.ts", "relayHost.ts", "termrelay.ts", "wire.ts"]);
  });
});

describe("the main half against a real relay", () => {
  const log: string[] = [];
  const opened: any[] = []; const closedWs: any[] = []; const msgs: string[] = [];
  let cat: any = null;
  const handlers = {
    open(ws: any) { opened.push(ws); cat = laneOf(ws)!.spawn(["cat"], { cwd: "/", env: { PATH: process.env.PATH ?? "" }, tap: false }); },
    message(_ws: any, raw: string) { msgs.push(raw); },
    close(ws: any) { closedWs.push(ws); },
  };
  afterAll(() => stopRelay());
  const until = async (ok: () => boolean, ms = 8000) => { for (let i = 0; i < ms / 50 && !ok(); i++) await Bun.sleep(50); return ok(); };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  test("start, mint, redeem, move bytes, die, restart, give up", async () => {
    expect(mintTickets(1, { worker: null, principal: null, ip: null })).toBeNull();
    startRelay(handlers, (l) => log.push(l));
    expect(await until(() => relayInfo() !== null)).toBe(true);

    const m = mintTickets(2, { worker: null, principal: null, ip: "127.0.0.1" })!;
    expect(m.tickets.length).toBe(2);
    const got: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${m.port}/pty?t=${m.tickets[0]}&root=%2Fp&bench=500`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => got.push(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer));
    expect(await until(() => opened.length === 1)).toBe(true);
    // Standing comes from the ticket; local by construction; the query is bounded.
    expect([opened[0].data.root, opened[0].data.bench, opened[0].data.local, opened[0].data.deviceId, opened[0].data.worker]).toEqual(["/p", 99, true, null, null]);
    // Spent: the same ticket never opens a second socket.
    expect((await fetch(`http://127.0.0.1:${m.port}/pty?t=${m.tickets[0]}`)).status).toBe(401);

    expect(await until(() => cat.pid > 0)).toBe(true);
    const bridge = cat.pid;
    ws.send(JSON.stringify({ t: "in", d: "ping\n" }));
    expect(await until(() => got.join("").includes("ping"))).toBe(true);
    // Main's own write path (an agent launch, a paste) reaches the same pty.
    cat.stdin.write(new TextEncoder().encode("pong\n"));
    expect(await until(() => got.join("").includes("pong"))).toBe(true);
    ws.send(JSON.stringify({ t: "resize", cols: 80, rows: 24 }));
    expect(await until(() => msgs.some((x) => x.includes("resize")))).toBe(true);

    // SIGKILL the relay: main closes the session, nothing is left running, it comes back.
    const gen0 = relayInfo()!.gen;
    process.kill(relayPid()!, "SIGKILL");
    expect(await until(() => closedWs.length === 1)).toBe(true);
    expect(await cat.exited).toBe(-1);
    expect(await until(() => !alive(bridge))).toBe(true);
    expect(await until(() => relayInfo() !== null && relayInfo()!.gen > gen0)).toBe(true);
    expect(log.some((l) => l.includes("restarting"))).toBe(true);

    // Four deaths in a minute and it stays down, with one line saying why.
    for (let i = 0; i < 4 && relayInfo() !== null || (i < 4 && (await until(() => relayInfo() !== null))); i++) {
      process.kill(relayPid()!, "SIGKILL");
      await until(() => relayInfo() === null, 3000);
    }
    expect(await until(() => log.some((l) => l.includes("stays in-process")), 12_000)).toBe(true);
    expect(relayInfo()).toBeNull();
    expect(mintTickets(1, { worker: null, principal: null, ip: null })).toBeNull();
  }, 60_000);
});

describe("a real relay process", () => {
  const dir = mkdtempSync(join(tmpdir(), "agx-relay-"));
  let child: ReturnType<typeof Bun.spawn> | null = null;
  afterAll(() => { try { child?.kill(); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); });

  test("refuses an unknown ticket, serves a good one once, and moves bytes both ways", async () => {
    child = Bun.spawn(relayArgv(process.execPath, join(import.meta.dir, "../src/index.ts")), {
      env: { PATH: process.env.PATH ?? "", HOME: dir, AGENTGLASS_RELAY_CHILD: "1", XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir, AGENTGLASS_STATE_DIR: dir, AGENTGLASS_DB: join(dir, "x.db") },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const lines: any[] = [];
    const waiters: (() => void)[] = [];
    (async () => {
      const split = lineSplitter(); const dec = new TextDecoder();
      for await (const c of child!.stdout as ReadableStream<Uint8Array>) for (const l of split(dec.decode(c))) { lines.push(JSON.parse(l)); waiters.splice(0).forEach((w) => w()); }
    })();
    const next = async (pred: (m: any) => boolean) => {
      for (let i = 0; i < 100; i++) { const m = lines.find(pred); if (m) return m; await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 100); }); }
      throw new Error("relay never said it: " + JSON.stringify(lines));
    };
    const say = (m: object) => { (child!.stdin as any).write(JSON.stringify(m) + "\n"); (child!.stdin as any).flush(); };

    const ready = await next((m) => m.op === "ready");
    const base = `ws://127.0.0.1:${ready.port}/pty`;

    // No ticket, a made-up one: refused before any socket exists.
    expect((await fetch(`http://127.0.0.1:${ready.port}/pty?t=nope`)).status).toBe(401);

    say({ op: "ticket", id: "t1" });
    await Bun.sleep(50);
    const ws = new WebSocket(`${base}?t=t1&root=/p`);
    ws.binaryType = "arraybuffer";
    const got: string[] = [];
    ws.onmessage = (e) => got.push(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer));
    const open = await next((m) => m.op === "open");
    expect(open.query).toBe("root=%2Fp");
    // The ticket is spent: a second connection with it never gets a socket.
    expect((await fetch(`http://127.0.0.1:${ready.port}/pty?t=t1`)).status).toBe(401);

    say({ op: "spawn", conn: open.conn, argv: ["cat"], cwd: dir, env: { PATH: process.env.PATH ?? "" }, tap: false });
    await next((m) => m.op === "spawned");
    ws.send(JSON.stringify({ t: "in", d: "hello\n" }));
    for (let i = 0; i < 50 && !got.join("").includes("hello"); i++) await Bun.sleep(50);
    expect(got.join("")).toContain("hello");

    // A frame that is not a keystroke is main's to answer.
    ws.send(JSON.stringify({ t: "resize", cols: 90, rows: 30 }));
    expect((await next((m) => m.op === "msg")).text).toContain("resize");

    // The property the whole design rests on, checked on the filesystem: this
    // process, started with the database path pointed at a file in `dir`,
    // never created it or anything like it.
    expect(existsSync(join(dir, "x.db"))).toBe(false);
    expect(readdirSync(dir).filter((f) => /\.(db|sqlite)/.test(f))).toEqual([]);

    // Closing the window hangs the shell up: `cat` ends and the relay says so.
    ws.close();
    const done = await next((m) => m.op === "closed");
    expect(done.conn).toBe(open.conn);
  }, SERVER_BOOT_MS + 15_000);
});
