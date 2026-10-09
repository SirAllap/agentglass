/*
 * The spaces read the ClickUp page and every picker share.
 *
 * Two ways it could say something false: a Re-read press that joined a read already in the air (which the
 * server may have answered from its memo, so the press looked fresh and was not), and an answer that left
 * before the account or workspace changed and landed after it.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();
let calls: { url: string; done: (spaces: string[]) => void }[] = [];
stubGlobal("location", { origin: "http://127.0.0.1:1", hostname: "127.0.0.1", search: "", href: "http://127.0.0.1:1/" });
stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
stubGlobal("fetch", (url: string) => new Promise((res) => {
  calls.push({ url: String(url), done: (names) => res(new Response(JSON.stringify({ ok: true, spaces: names.map((n, i) => ({ id: String(i), name: n, statuses: [] })) }), { headers: { "content-type": "application/json" } })) });
}));

const S = await import("../src/lib/clickupSpaces.ts");
afterAll(() => S.__forgetClickupSpaces());
beforeEach(() => { S.__forgetClickupSpaces(); calls = []; });

/** The request leaves a tick after the call: the api wrapper does one async step first. */
const tick = () => Bun.sleep(5);
const names = (s: Awaited<ReturnType<typeof S.readSpaces>>) => (s.kind === "ok" ? s.spaces.map((x) => x.name) : []);

describe("readSpaces", () => {
  test("two readers at once are one request, and a later one inside ten minutes is none", async () => {
    const a = S.readSpaces(), b = S.readSpaces();
    await tick();
    expect(calls.length).toBe(1);
    calls[0]!.done(["Engineering"]);
    expect(names(await a)).toEqual(["Engineering"]);
    expect(names(await b)).toEqual(["Engineering"]);
    await S.readSpaces();
    expect(calls.length).toBe(1);
  });

  test("a Re-read press goes out on its own, and asks the server to skip its memo", async () => {
    const a = S.readSpaces();
    await tick();
    const b = S.readSpaces(true);
    await tick();
    expect(calls.length).toBe(2);
    expect(calls[1]!.url).toContain("fresh=1");
    calls[0]!.done(["Old"]); calls[1]!.done(["New"]);
    await a;
    expect(names(await b)).toEqual(["New"]);
  });

  test("a changed pick of spaces is read again past the held answer, and does not ask the server to skip its memo", async () => {
    const a = S.readSpaces();
    await tick();
    calls[0]!.done(["Engineering"]);
    await a;
    const b = S.readSpaces(false, true);
    await tick();
    expect(calls.length).toBe(2);
    expect(calls[1]!.url).not.toContain("fresh=1");
    calls[1]!.done(["Engineering", "Support"]);
    expect(names(await b)).toEqual(["Engineering", "Support"]);
    expect(names(await S.readSpaces())).toEqual(["Engineering", "Support"]);
    expect(calls.length).toBe(2);
  });

  test("an answer that left before the credential changed is not kept for the new one", async () => {
    const a = S.readSpaces();
    await tick();
    S.__forgetClickupSpaces();
    calls[0]!.done(["Old workspace"]);
    await a;
    const b = S.readSpaces();
    await tick();
    expect(calls.length).toBe(2);
    calls[1]!.done(["New workspace"]);
    expect(names(await b)).toEqual(["New workspace"]);
  });
});

describe("readAnswer: what an answer from the server is to the page", () => {
  const sp = [{ id: "1", name: "Orbit", statuses: [], counted: false, pending: true }, { id: "2", name: "Sales", statuses: [], counted: false, pending: true }];
  test("'pending' is not an answer about the spaces: the page waits, and nothing is held as counted", () => {
    expect(S.readAnswer({ spaces: sp, source: "pending", note: "Reading" }, 1)).toEqual({ kind: "pending" });
    expect(S.readAnswer({ spaces: sp, source: "pending" }, S.MAX_PENDING - 1)).toEqual({ kind: "pending" });
  });
  test("after MAX_PENDING asks it gives up: every space counts, it says the cards did not load", () => {
    const a = S.readAnswer({ spaces: sp, source: "pending" }, S.MAX_PENDING);
    expect(a.kind).toBe("spaces");
    if (a.kind !== "spaces") return;
    expect(a.spaces.every((s) => !("pending" in s) && !("counted" in s))).toBe(true);
    expect(a.note).toContain("did not load");
  });
  test("a narrowed answer carries no note, and one that could not narrow keeps the server's", () => {
    expect(S.readAnswer({ spaces: sp, source: "tasks" }, 1)).toEqual({ kind: "spaces", spaces: sp });
    expect(S.readAnswer({ spaces: sp, source: "spaces", note: "No cards" }, 1)).toEqual({ kind: "spaces", spaces: sp, note: "No cards" });
  });
});
