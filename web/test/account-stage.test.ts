/*
 * What the window does with an account switch an agent proposed
 * (usage.account.stage), without a renderer: the handler leaves the proposal in
 * the mailbox under the caller's name and does nothing else, the account helper
 * answers only for this kind of request, and the pull request panel leaves it
 * where it is. The popover that draws the confirmation is the chips' business;
 * what is pinned here is that no staging path can reach the switch route.
 *
 * The registry half (what the door takes) is server/test/ui-stage.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";
import type { ControlCmd } from "../../shared/types.ts";
import type { UiCtx } from "../src/lib/uiActions.ts";

const stubGlobal = globalStubs();
stubGlobal("window", new EventTarget());
stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 } as unknown as Storage);
stubGlobal("location", new URL("http://localhost:5173/"));
stubGlobal("document", { documentElement: { getAttribute: () => "graphite", setAttribute: () => {}, style: { setProperty: () => {}, getPropertyValue: () => "" } } });
stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
const fetched: unknown[] = [];
stubGlobal("fetch", ((...a: unknown[]) => { fetched.push(a); throw new Error("a staging handler must not fetch"); }) as unknown as typeof fetch);

const { runControl } = await import("../src/lib/uiActions.ts");
const { latchStage, peekStage, clearStage, accountStageOf } = await import("../src/lib/stageIntent.ts");
const { labelOf } = await import("../src/lib/offerLabels.ts");

const ui = (id: string, args: Record<string, unknown>) => ({ cmd: "ui", do: id, args }) as unknown as ControlCmd;
const ctx = (as?: string) => {
  const calls: unknown[][] = [];
  const c = new Proxy({ as } as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : (...a: unknown[]) => { calls.push([String(k), ...a]); }) }) as unknown as UiCtx;
  return { c, calls };
};
const read = (p: string) => Bun.file(new URL(`../src/${p}`, import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");
const A = { provider: "anthropic", id: "acme-b" } as const;

beforeEach(() => { clearStage(); fetched.length = 0; });
afterEach(() => { clearStage(); });

describe("the handler", () => {
  it("latches the proposal under the caller's name and moves nothing and calls nothing", () => {
    const k = ctx("tidy-bot");
    expect(runControl(ui("usage.account.stage", A), k.c)).toBe("usage.account.stage");
    expect(peekStage()).toMatchObject({ id: "usage.account.stage", by: "tidy-bot", a: A });
    expect(k.calls).toEqual([]);
    expect(fetched).toEqual([]);
  });

  it("refuses a provider or an id outside the closed shapes", () => {
    const k = ctx("x");
    expect(runControl(ui("usage.account.stage", { ...A, provider: "gemini" }), k.c)).toBeNull();
    expect(runControl(ui("usage.account.stage", { ...A, id: "../etc" }), k.c)).toBeNull();
    expect(peekStage()).toBeNull();
  });

  it("the handler is the latch alone: it names no api, switch, run or fetch", async () => {
    const src = await read("lib/uiActions.ts");
    const at = src.indexOf('"usage.account.stage":');
    expect(at).toBeGreaterThan(0);
    const h = code(src.slice(at, src.indexOf("\n", at)));
    expect(h).toContain("latchStage(");
    expect(h).not.toMatch(/\bapi\.|\bfetch\s*\(|switch\w*\(|\brun\w*\(/i);
  });

  it("has words for its chip", () => {
    expect(labelOf(ui("usage.account.stage", A))).toBe("Usage > Switch anthropic account to acme-b");
  });
});

describe("the mailbox is shared", () => {
  it("accountStageOf answers only for an account request", () => {
    latchStage({ id: "finder.op.stage", a: { op: "trash", path: "/home/acme/a.txt" } }, "x");
    expect(accountStageOf(peekStage())).toBeNull();
    latchStage({ id: "usage.account.stage", a: A }, "x");
    expect(accountStageOf(peekStage())?.a).toEqual(A);
    expect(accountStageOf(null)).toBeNull();
  });

  it("the pull request panel passes over an account request", async () => {
    const pr = code(await read("components/PrPanel.tsx"));
    expect(pr).toContain('r.id === "usage.account.stage"');
  });
});
