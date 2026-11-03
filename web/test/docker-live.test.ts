/*
 * The Docker panel's connection to /docker/live. EventSource only retries on
 * its own while the connection merely dropped; a refusal (a 401, the server's
 * cap of open feeds) closes it for good, so a refusal needs a retry of ours,
 * with a growing wait, or the panel would go quiet for the rest of the session.
 * What it does NOT fall back to is polling.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { connectDockerLive, liveBackoffMs, parseLive } from "../src/lib/dockerLive.ts";

class FakeES {
  static all: FakeES[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeES.all.push(this); }
  close() { this.closed = true; this.readyState = 2; }
  open() { this.readyState = 1; this.onopen?.(); }
  say(m: unknown) { this.onmessage?.({ data: typeof m === "string" ? m : JSON.stringify(m) }); }
  refuse() { this.readyState = 2; this.onerror?.(); }
  drop() { this.readyState = 0; this.onerror?.(); }
}

function rig() {
  FakeES.all = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const deps = {
    EventSource: FakeES as unknown as typeof EventSource,
    setTimeout: ((fn: () => void, ms: number) => { timers.push({ fn, ms, live: true }); return timers.length; }) as unknown as typeof setTimeout,
    clearTimeout: ((id: number) => { if (timers[id - 1]) timers[id - 1]!.live = false; }) as unknown as typeof clearTimeout,
  };
  const got: string[] = [];
  const stop = connectDockerLive("http://x/docker/live", () => ({
    onChanged: (s) => got.push(`changed:${s}`),
    onStats: (s) => got.push(`stats:${s.length}`),
    onDown: () => got.push("down"),
    onUp: () => got.push("up"),
    onReconnect: () => got.push("reconnect"),
  }), deps);
  const fire = () => { const t = timers.filter((x) => x.live).at(-1); if (t) { t.live = false; t.fn(); } };
  return { got, stop, fire, timers, es: () => FakeES.all.at(-1)! };
}

describe("messages", () => {
  test("each kind reaches its handler", () => {
    const r = rig();
    r.es().open();
    r.es().say({ kind: "changed", scope: "volumes" });
    r.es().say({ kind: "stats", stats: [{ id: "aaaaaaaaaaaa" }] });
    r.es().say({ kind: "down" });
    r.es().say({ kind: "up" });
    expect(r.got).toEqual(["changed:volumes", "stats:1", "down", "up"]);
  });

  test("a message that is not one of ours is dropped, not thrown", () => {
    const r = rig();
    r.es().say("not json");
    r.es().say({ kind: "changed", scope: "everything" });
    r.es().say({ kind: "stats" });
    r.es().say({ kind: "reboot" });
    expect(r.got).toEqual([]);
    expect(parseLive('{"kind":"up"}')).toEqual({ kind: "up" });
  });
});

describe("connection", () => {
  test("a dropped connection is EventSource's to retry, and the panel hears about the gap once it is back", () => {
    const r = rig();
    r.es().open();
    expect(r.got).toEqual([]);            // the first open is not a reconnect: the panel just fetched
    r.es().drop();
    expect(FakeES.all.length).toBe(1);     // no second socket of ours
    r.es().open();
    expect(r.got).toEqual(["reconnect"]);  // events in the gap are gone: ask for everything once
  });

  test("a refusal is retried with a growing wait, and never by polling", () => {
    const r = rig();
    r.es().refuse();
    expect(r.es().closed).toBe(true);
    expect(r.timers.filter((t) => t.live).map((t) => t.ms)).toEqual([liveBackoffMs(0)]);
    r.fire();
    expect(FakeES.all.length).toBe(2);
    r.es().refuse();
    expect(r.timers.filter((t) => t.live).map((t) => t.ms)).toEqual([liveBackoffMs(1)]);
    expect(liveBackoffMs(1)).toBeGreaterThan(liveBackoffMs(0));
    r.fire();
    r.es().open();
    expect(r.got).toEqual(["reconnect"]);
    r.es().refuse();
    expect(r.timers.filter((t) => t.live).map((t) => t.ms)).toEqual([liveBackoffMs(0)]);  // an open resets the wait
  });

  test("the wait is capped", () => {
    expect(liveBackoffMs(50)).toBe(30_000);
  });

  test("stopping closes the socket and cancels the retry", () => {
    const r = rig();
    r.es().refuse();
    r.stop();
    expect(r.timers.some((t) => t.live)).toBe(false);
    const r2 = rig();
    r2.es().open();
    r2.stop();
    expect(r2.es().closed).toBe(true);
    r2.es().say({ kind: "up" });           // a late message after stop is nobody's
    expect(r2.got).toEqual([]);
  });

  test("no url (the demo) opens nothing", () => {
    FakeES.all = [];
    const stop = connectDockerLive(null, () => ({}), { EventSource: FakeES as unknown as typeof EventSource });
    stop();
    expect(FakeES.all.length).toBe(0);
  });
});

test("the hook and the api expose the feed and the Resume verb", () => {
  const api = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");
  expect(api).toContain(`dockerUnpause: (id: string) => post<DockerActionResult>("/docker/unpause", { id })`);
  expect(api).toContain(`withToken(\`\${SERVER}/docker/live\`)`);
  const hook = readFileSync(new URL("../src/lib/useDockerLive.ts", import.meta.url), "utf8");
  expect(hook).toContain("connectDockerLive(");
  expect(hook).not.toMatch(/setInterval|usePoll/);
});
