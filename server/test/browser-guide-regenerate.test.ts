/* "Suggest another" on a draft card: the person's ask reaches the agent as a regenerate event
   with their note, the agent answers with guide say --suggest, and plans carry suggest too. */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setBrowserAsker, askBrowser, guidePanelEvent, parseAsk, resetBrowserDrive, type BrowserAsk, type BrowserReply } from "../src/browserdrive.ts";
import { parsePlan, regenerateNote, resetGuides, setGuideClock } from "../src/browserGuide.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-guide-regen-"));
process.env.AGENTGLASS_STATE_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const DRAFT = "Thanks for the review. I moved the check into the hook.";

describe("guide say --suggest", () => {
  test("a new draft alone is enough", () => {
    const r = parseAsk("guide", { action: "say", suggest: DRAFT });
    expect("ask" in r && r.ask.args).toMatchObject({ action: "say", suggest: DRAFT });
    expect("ask" in r && "say" in r.ask.args).toBe(false);
  });
  test("neither words nor a draft is refused", () => {
    expect("error" in parseAsk("guide", { action: "say" })).toBe(true);
  });
  test("an empty or too long draft is refused", () => {
    expect("error" in parseAsk("guide", { action: "say", suggest: "  " })).toBe(true);
    expect("error" in parseAsk("guide", { action: "say", suggest: "a".repeat(2001) })).toBe(true);
  });
  test("suggest with another guide action is refused", () => {
    const r = parseAsk("guide", { action: "next", suggest: DRAFT });
    expect("error" in r && r.error).toContain("suggest goes with guide say");
  });
});

describe("plan steps carry suggest", () => {
  test("with a target it parses", () => {
    const r = parsePlan([{ target: "#reply", say: "Edit the reply, then press OK.", wait: "ok", suggest: DRAFT }]);
    if ("error" in r) throw new Error(r.error);
    expect(r.steps[0]!.suggest).toBe(DRAFT);
  });
  test("without a target it is refused", () => {
    const r = parsePlan([{ say: "Edit the reply.", suggest: DRAFT }]);
    expect("error" in r && r.error).toContain("suggest goes with target");
  });
});

describe("the note", () => {
  test("one line, trimmed, at most 200 characters, or none", () => {
    expect(regenerateNote("  shorter,\n less salesy ")).toBe("shorter, less salesy");
    expect(regenerateNote("   ")).toBeUndefined();
    expect(regenerateNote(42)).toBeUndefined();
    expect(regenerateNote("x".repeat(500))!.length).toBe(200);
  });
});

describe("the relay", () => {
  let seen: BrowserAsk[] = [];
  let nextEvents: Array<Record<string, unknown>> = [];
  beforeEach(() => {
    resetBrowserDrive(); resetGuides(); seen = []; nextEvents = [];
    setGuideClock(() => Date.parse("2026-11-14T10:00:00"));
    __setBrowserAsker(async (a): Promise<BrowserReply> => {
      seen.push(a);
      if (a.op === "tabs") return { ok: true, value: [{ id: "t1", active: true }] };
      if (a.op === "point") return { ok: true, value: { followed: true } };
      if (a.op === "guide" && a.args.action === "next") return { ok: true, value: nextEvents.shift() ?? { event: null } };
      return { ok: true, value: {} };
    });
  });
  afterEach(() => { __setBrowserAsker(null); setGuideClock(null); resetBrowserDrive(); });
  const ask = async (op: string, body: Record<string, unknown>): Promise<BrowserReply> => {
    const p = parseAsk(op, body);
    if ("error" in p) return { ok: false, error: p.error };
    return askBrowser(p.ask);
  };
  const start = () => ask("guide", { action: "start", why: "Reply to the review", as: "orbit-keys", page: "t1" });

  test("guide next hears regenerate with the note; the step stays open for its answer", async () => {
    await start();
    await ask("point", { selector: "e14", say: "Edit and send.", suggest: DRAFT, as: "orbit-keys" });
    nextEvents = [{ event: "regenerate", note: " shorter " }, { event: "ok" }];
    const first = await ask("guide", { action: "next", as: "orbit-keys", page: "t1" });
    expect(first.value).toMatchObject({ event: "regenerate", step: 1, note: "shorter" });
    const second = await ask("guide", { action: "next", as: "orbit-keys", page: "t1" });
    expect(second.value).toMatchObject({ event: "ok", step: 1 });
  });

  test("guide say --suggest sends the new draft to the card, words untouched", async () => {
    await start();
    await ask("point", { selector: "e14", say: "Edit and send.", suggest: DRAFT, as: "orbit-keys" });
    const r = await ask("guide", { action: "say", suggest: "Thanks. Moved it.", as: "orbit-keys", page: "t1" });
    expect(r.ok).toBe(true);
    const act = seen.filter((a) => a.op === "guide" && a.args.action === "say").pop()!.args.activity as Record<string, unknown>;
    expect(act).toMatchObject({ phase: "say", suggest: "Thanks. Moved it." });
    expect("say" in act).toBe(false);
  });

  test("a run: the panel's regenerate is queued for guide next, the plan does not move", async () => {
    const plan = [{ target: "#reply", say: "Edit the reply, then press OK.", wait: "ok", suggest: DRAFT }, { say: "Press OK when sent.", wait: "ok" }];
    expect((await ask("guide", { action: "run", why: "Reply", plan, as: "orbit-keys", page: "t1" })).ok).toBe(true);
    const point = seen.find((a) => a.op === "point")!;
    expect(point.args.suggest).toBe(DRAFT);
    expect((point.args.activity as Record<string, unknown>).suggest).toBe(DRAFT);
    const pe = await guidePanelEvent({ tab: "t1", event: "regenerate", note: "less salesy" }, async () => ({ ok: true, value: {} }));
    expect(pe).toEqual({ ok: true, value: { regenerate: true } });
    let ev: BrowserReply | undefined;
    for (let i = 0; i < 4; i++) {
      ev = await ask("guide", { action: "next", as: "orbit-keys", page: "t1", waitMs: 0 });
      if ((ev.value as { event?: string })?.event === "regenerate") break;
    }
    expect(ev!.value).toMatchObject({ event: "regenerate", step: 1, of: 2, note: "less salesy" });
  });
});
