/*
 * The relay's half of `observe --delta`: it remembers what it last handed each
 * caller, and hands that to the page as the baseline. The page's half — the
 * diff itself — is in web/test/browser-observe-delta.test.ts.
 *
 * The baseline is the relay's record rather than something the caller sends,
 * so these pin that a body cannot supply one, that one caller's look is not
 * another's baseline, and that the act-then-look paths (`--observe`, `do
 * --observe`) ask for a delta.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  askBrowser, noteBrowserReady, parseAsk, resetAudit, resetBrowserDrive, runSteps, setBrowserSink, settleBrowser,
  withObservation, type BrowserAsk,
} from "../src/browserdrive.ts";

let stateScratch = "";
let stateBefore: string | undefined;
beforeAll(() => {
  stateScratch = mkdtempSync(join(tmpdir(), "agx-delta-state-"));
  stateBefore = process.env.AGENTGLASS_STATE_DIR;
  process.env.AGENTGLASS_STATE_DIR = stateScratch;
});
afterAll(() => {
  if (stateBefore === undefined) delete process.env.AGENTGLASS_STATE_DIR;
  else process.env.AGENTGLASS_STATE_DIR = stateBefore;
  try { rmSync(stateScratch, { recursive: true, force: true }); } catch { /* fine */ }
});
afterEach(() => { resetBrowserDrive(); resetAudit(); });

/** A window that records every ask and answers observe with a page-stamped
 *  doc and a counting seq, the way the observe script does. */
function windowRecording(answer?: (a: BrowserAsk) => { ok: boolean; value?: unknown; error?: string }) {
  const asks: BrowserAsk[] = [];
  let seq = 0;
  setBrowserSink({
    send: (a) => {
      asks.push(a);
      const r = answer?.(a) ?? (a.op === "observe"
        ? { ok: true, value: { url: "u", doc: "d1", seq: ++seq } }
        : { ok: true, value: {} });
      settleBrowser(a.id, r);
    },
    listeners: () => 1,
  });
  noteBrowserReady("w1", true);
  return asks;
}

const observe = (body: Record<string, unknown>) => {
  const p = parseAsk("observe", body);
  if ("error" in p) throw new Error(p.error);
  return askBrowser(p.ask);
};

describe("the relay keeps each caller's baseline", () => {
  test("delta is accepted; a baseline in the body is not", () => {
    const p = parseAsk("observe", { delta: true, base: { doc: "forged", seq: 1 } });
    expect("ask" in p && p.ask.args.delta).toBe(true);
    expect("ask" in p && p.ask.args.base).toBeUndefined();
    const plain = parseAsk("observe", {});
    expect("ask" in plain && plain.ask.args.delta).toBeUndefined();
  });

  test("the first delta has no base; the next carries what the last answer said", async () => {
    const asks = windowRecording();
    await observe({ delta: true, as: "orbit-a" });
    await observe({ delta: true, as: "orbit-a" });
    expect(asks[0]!.args.base).toBeNull();
    expect(asks[1]!.args.base).toEqual({ doc: "d1", seq: 1 });
  });

  test("a plain observe counts as a look: the delta after it is against it", async () => {
    const asks = windowRecording();
    await observe({ as: "orbit-a" });
    await observe({ delta: true, as: "orbit-a" });
    expect(asks[0]!.args.base).toBeUndefined();
    expect(asks[1]!.args.base).toEqual({ doc: "d1", seq: 1 });
  });

  test("another caller's look, or another tab's, is not your baseline", async () => {
    const asks = windowRecording();
    await observe({ as: "orbit-a" });
    await observe({ delta: true, as: "orbit-b" });
    await observe({ delta: true, as: "orbit-a", page: "t9-other" });
    expect(asks[1]!.args.base).toBeNull();
    expect(asks[2]!.args.base).toBeNull();
  });

  test("a failed observe leaves the baseline where it was", async () => {
    let fail = false;
    let seq = 0;
    const asks = windowRecording((a) => (fail
      /* With a value on it, the way a half-finished answer can arrive: the
         failure is what decides, not whether something came back. */
      ? { ok: false, error: "the page threw", value: { doc: "d2", seq: 99 } }
      : { ok: true, value: { doc: "d1", seq: ++seq, op: a.op } }));
    await observe({ as: "orbit-a" });
    fail = true;
    await observe({ delta: true, as: "orbit-a" }).catch(() => {});
    fail = false;
    await observe({ delta: true, as: "orbit-a" });
    expect(asks.at(-1)!.args.base).toEqual({ doc: "d1", seq: 1 });
  });
});

describe("a look the caller only saw part of is not a baseline", () => {
  test("a partial observe forgets the baseline, so the next delta answers in full", async () => {
    const asks = windowRecording();
    await observe({ as: "orbit-a" });
    await observe({ as: "orbit-a", partial: true });
    await observe({ delta: true, as: "orbit-a" });
    expect(asks[2]!.args.base).toBeNull();
  });

  test("and it rides from an act verb onto the look after it", async () => {
    const asks = windowRecording();
    await withObservation(
      { id: "a9", op: "click", args: { selector: "e4", as: "orbit-a", partial: true } } as never,
      { ok: true, value: { clicked: "e4" } },
    );
    expect(asks.find((a) => a.op === "observe")!.args.partial).toBe(true);
  });
});

describe("act-then-look asks for a delta", () => {
  test("`click --observe` looks with delta, for the same caller and tab", async () => {
    const asks = windowRecording();
    await withObservation(
      { id: "a1", op: "click", args: { selector: "e4", as: "orbit-a", page: "t2-own" } } as never,
      { ok: true, value: { clicked: "e4" } },
    );
    const look = asks.find((a) => a.op === "observe")!;
    expect(look.args.delta).toBe(true);
    expect(look.args.as).toBe("orbit-a");
    expect(look.args.page).toBe("t2-own");
  });

  test("`do --observe` ends with a delta look too", async () => {
    const asks = windowRecording();
    const r = await runSteps([{ op: "click", args: { selector: "e4" } }], { observe: true, caller: { as: "orbit-a" } });
    expect(r.ok).toBe(true);
    expect(asks.at(-1)!.op).toBe("observe");
    expect(asks.at(-1)!.args.delta).toBe(true);
  });
});
