/*
 * An Inbox card answered elsewhere leaves the phone.
 *
 * Seen: a "Settings request · builder role: engine and model · expires in
 * 29 min" card, approved at the desk, still on the phone with Approve and
 * Decline — and under it the server's "no such request: it was answered…".
 * The phone ignored the server's push, kept the card on a 404, and never drew
 * the countdown again. The decisions are in model/inboxStale.ts; the wiring
 * is asserted against source, the way inbox-ack.test.ts does it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { answerGone, nextExpiryIn, refreshesInbox } from "../src/model/inboxStale.ts";
import { collectInbox } from "../src/model/inbox.ts";
import type { SettingRequestView } from "../../shared/settingClass.ts";

const src = (...p: string[]): string => readFileSync(join(import.meta.dir, "..", ...p), "utf8");
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const GONE = "no such request: it was answered, it expired (declined after 30 minutes), or the server restarted";

describe("the server's push", () => {
  test("a settings or flight-plan frame reads the Inbox again", () => {
    expect(refreshesInbox({ type: "settings-requests" })).toBe(true);
    expect(refreshesInbox({ type: "flight-plan" })).toBe(true);
    expect(refreshesInbox({ type: "marks" })).toBe(false);
  });

  test("the live socket hands every frame to the Inbox", () => {
    const host = strip(src("src", "state", "host-context.tsx"));
    expect(host).toContain("inboxHeard(host, frame);");
  });
});

describe("the answer to a press", () => {
  test("a settings request the server no longer has is gone", () => {
    expect(answerGone("settings", { ok: false, error: GONE, status: 404 })).toBe(true);
  });

  test("a plan already decided at the desk is gone", () => {
    expect(answerGone("plans", { ok: false, error: "a go plan cannot be told Go", status: 409 })).toBe(true);
    expect(answerGone("plans", { ok: false, error: "no such flight plan", status: 404 })).toBe(true);
  });

  test("a refusal that leaves the question open keeps the card", () => {
    expect(answerGone("settings", { ok: false, error: "This phone may only look.", status: 403 })).toBe(false);
    expect(answerGone("settings", { ok: false, error: "The computer did not answer." })).toBe(false);
    expect(answerGone("plans", { ok: false, error: "Go has to wait: Preflight has findings", status: 409 })).toBe(false);
    expect(answerGone("settings", { ok: true, value: { ok: true } })).toBe(false);
  });

  test("every card that answers checks it before showing the error", () => {
    for (const file of [["src", "inbox", "InboxRow.tsx"], ["src", "inbox", "PlanCard.tsx"], ["src", "terminal", "SettingsRequestCard.tsx"]]) {
      expect(strip(src(...file))).toMatch(/if \(answerGone\("(settings|plans)", \w+\)\)/);
    }
  });
});

describe("the countdown", () => {
  const req = (id: string, expires: number): SettingRequestView =>
    ({ id, at: 0, expires, who: "builder role", label: "Engine and model", diff: ["Engine and model"] }) as unknown as SettingRequestView;

  test("the next redraw is at the soonest expiry still ahead", () => {
    expect(nextExpiryIn([req("a", 5_000), req("b", 2_000), req("c", 500)], 1_000)).toBe(1_000);
    expect(nextExpiryIn([req("a", 500)], 1_000)).toBeNull();
    expect(nextExpiryIn([], 1_000)).toBeNull();
  });

  test("a request past its expiry is not drawn", () => {
    const list = [req("orbit-1", 60_000)];
    const card = (now: number) => collectInbox({ settings: list }, "full", now).items.filter((i) => i.source === "settings");
    expect(card(1_000)).toHaveLength(1);
    expect(card(60_000)).toHaveLength(0);
  });

  test("the Inbox sets a timer to that expiry and draws with its clock", () => {
    const inbox = strip(src("src", "state", "use-inbox.ts"));
    expect(inbox).toContain("nextExpiryIn(snap?.settings ?? [], clock)");
    expect(inbox).toContain("[fleet.gates, reviews, snap, host?.scope, clock]");
  });
});
