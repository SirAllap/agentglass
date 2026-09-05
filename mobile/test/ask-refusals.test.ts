/*
 * Which refusals end the pairing, and what the phone sends to earn one.
 *
 * Two bugs from one audit, both in `ask`:
 *
 *   * Every 401 AND every 403 became `REVOKED`, and `REVOKED` drops the
 *     keystore record. The server answers 403 for four different things and
 *     only one of them is about the credential — so a phone paired for reading
 *     that opened the Docker card was logged out with nothing wrong with it,
 *     and a 500 from a route in trouble read as "the machine took you off".
 *   * No `Origin` header. The server's CSRF gate refuses an Origin-less write
 *     from anywhere but loopback, and a phone is never on loopback — so every
 *     POST from off-box was "cross-origin write blocked" (403) and, by the
 *     first bug, a log-out.
 *
 * `fetch` is stubbed here rather than a server booted: the question is what
 * the helper does with an answer, not what the server answers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ask, isRevoked, REVOKED } from "../src/lib/api.ts";
import type { Host } from "../src/lib/host.ts";

const host: Host = {
  origin: "http://192.168.7.20:4000",
  token: "a-device-token",
  label: "Test phone",
  scope: "full",
  pairedAt: 0,
};

type Sent = { url: string; init: RequestInit };
let sent: Sent[] = [];
let answer: () => Response = () => new Response("{}", { status: 200 });
const realFetch = globalThis.fetch;

beforeEach(() => {
  sent = [];
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(answer());
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const headers = (): Record<string, string> => sent[0]?.init.headers as Record<string, string>;

describe("every request carries the paired host as its Origin", () => {
  test("on a read", async () => {
    await ask(host, "/sessions");
    expect(headers().origin).toBe("http://192.168.7.20:4000");
    expect(headers().authorization).toBe("Bearer a-device-token");
  });

  test("on a write, next to the content type", async () => {
    await ask(host, "/tasks/move", { method: "POST", body: { id: "1" } });
    expect(headers().origin).toBe("http://192.168.7.20:4000");
    expect(headers()["content-type"]).toBe("application/json");
    expect(sent[0]?.init.method).toBe("POST");
  });
});

describe("what ends the pairing", () => {
  test("a 401: the token is unknown", async () => {
    answer = () => json(401, { ok: false, error: "unauthorized — pass ?token= or Authorization: Bearer" });
    const r = await ask(host, "/sessions");
    expect(r).toEqual({ ok: false, error: REVOKED, status: 401 });
  });

  test("a 403 saying the device was disconnected — the server's blocked-device sentence", async () => {
    answer = () => json(403, { ok: false, error: "this device was disconnected from this machine" });
    const r = await ask(host, "/sessions");
    expect(r).toEqual({ ok: false, error: REVOKED, status: 403 });
  });
});

describe("what does not", () => {
  test("a scope refusal is a sentence for the screen, not a log-out", async () => {
    answer = () => json(403, {
      ok: false,
      error: 'this device is paired for "read" access, and /docker/overview needs "act"',
      scope: "read",
      needs: "act",
    });
    const r = await ask(host, "/docker/overview");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).not.toBe(REVOKED);
    expect(r.error).toContain('paired for "read" access');
    expect(r.status).toBe(403);
  });

  test("the CSRF gate's own refusal", async () => {
    answer = () => json(403, { ok: false, error: "cross-origin write blocked" });
    const r = await ask(host, "/tasks/move", { method: "POST", body: {} });
    expect(r).toEqual({ ok: false, error: "cross-origin write blocked", status: 403 });
  });

  test("a 500 surfaces the server's `error`, parsed out of the JSON body", async () => {
    // Before: the raw body — `{"ok":false,"error":"could not write that down"}`
    // — went to the screen as-is, braces and all.
    answer = () => json(500, { ok: false, error: "could not write that down" });
    const r = await ask(host, "/agents/note", { method: "POST", body: {} });
    expect(r).toEqual({ ok: false, error: "could not write that down", status: 500 });
  });

  test("a 409 and a 429 likewise", async () => {
    for (const [status, error] of [[409, "already moving"], [429, "rate limited"]] as const) {
      answer = () => json(status, { ok: false, error });
      const r = await ask(host, "/x");
      expect(r).toEqual({ ok: false, error, status });
    }
  });

  test("a body that is not JSON falls back to the status", async () => {
    // A reverse proxy's 502 page is HTML; nobody wants it on a phone.
    answer = () => new Response("<html><body><h1>502 Bad Gateway</h1></body></html>", { status: 502 });
    const r = await ask(host, "/sessions");
    expect(r).toEqual({ ok: false, error: "The computer answered 502", status: 502 });
  });

  test("JSON with no sentence in it is the status, not the braces", async () => {
    answer = () => json(500, { ok: false });
    const r = await ask(host, "/x");
    expect(r).toEqual({ ok: false, error: "The computer answered 500", status: 500 });
  });

  test("a short plain-text body is kept as the reason", async () => {
    answer = () => new Response("Not Found", { status: 404 });
    const r = await ask(host, "/nothing");
    expect(r).toEqual({ ok: false, error: "Not Found", status: 404 });
  });
});

describe("isRevoked, the rule on its own", () => {
  test("401 regardless of body", () => {
    expect(isRevoked(401, null)).toBe(true);
    expect(isRevoked(401, { error: "anything" })).toBe(true);
  });
  test("403 only with the disconnected sentence", () => {
    expect(isRevoked(403, { error: "this device was disconnected from this machine" })).toBe(true);
    expect(isRevoked(403, { error: "cross-origin write blocked" })).toBe(false);
    expect(isRevoked(403, { error: "terminal is disabled" })).toBe(false);
    expect(isRevoked(403, null)).toBe(false);
  });
  test("nothing else", () => {
    for (const status of [400, 404, 409, 429, 500, 502]) {
      expect(isRevoked(status, { error: "this device was disconnected from this machine" }), String(status)).toBe(false);
    }
  });
});
