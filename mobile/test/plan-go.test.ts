/*
 * Go, once — and what the card says before and after.
 *
 * Go is the most expensive press in the app: it launches a builder and spends a
 * worker. The hold makes a thumb mean it; this is the half a network can break,
 * and the server has no rule against a second Go (the first moves the plan to
 * `go`, and the second finds it there). So the phone refuses the second press
 * itself, and only asks again after an answer it did not like.
 *
 * No renderer: the phase machine and the launch line are data.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PlanWaiting } from "../src/model/inbox.ts";
import { IN_FLIGHT, NO_PLAN, afterGo, launchLine, pressGo } from "../src/model/planGo.ts";

const plan = (over: Partial<PlanWaiting> = {}): PlanWaiting => ({
  id: "fp_0123456789abcdef",
  title: "Ship dark mode behind a flag",
  root: "/home/dev/code/orbit",
  state: "ready",
  size: "M",
  updatedAt: Date.parse("2026-11-04T11:00:00Z"),
  ...over,
});

describe("a press on Go", () => {
  test("posts when nothing is in flight", () => {
    expect(pressGo("ready")).toEqual({ post: true });
  });

  test("is refused locally while the first one is out", () => {
    expect(pressGo("posting")).toEqual({ post: false, said: IN_FLIGHT });
    expect(IN_FLIGHT).toContain("already on its way");
  });

  test("is refused once the plan took a Go", () => {
    expect(pressGo("sent")).toEqual({ post: false, said: NO_PLAN });
  });
});

describe("the answer to Go", () => {
  test("a launch moves the card out of the way", () => {
    expect(afterGo({ ok: true, took: true, where: "fix/dark-mode" }))
      .toEqual({ phase: "sent", said: "Go — building in fix/dark-mode." });
  });

  test("a queued Go is taken, and says it is waiting for a slot", () => {
    const after = afterGo({ ok: true, took: true, queued: true });
    expect(after.phase).toBe("sent");
    expect(after.said).toContain("as soon as one lands");
  });

  test("Go recorded but the builder could not start stays pressable, with the reason", () => {
    // The route answers `ok` and `launchError` together: the plan is at Go and
    // the launch is still there to try again. Hiding that would be a phone that
    // says a worker is running when none is.
    const after = afterGo({ ok: true, took: true, launchError: "no free slot" });
    expect(after).toEqual({ phase: "ready", said: "no free slot" });
  });

  test("a refusal — the network or the server — leaves the card as it was", () => {
    expect(afterGo({ ok: false, error: "Cannot reach the computer" }))
      .toEqual({ phase: "ready", said: "Cannot reach the computer" });
    expect(afterGo({ ok: true, took: false, error: "Go has to wait: the plan changed" }))
      .toEqual({ phase: "ready", said: "Go has to wait: the plan changed" });
  });
});

describe("the launch line", () => {
  test("names the model and the plan's own reason", () => {
    expect(launchLine(plan({ launch: { mode: "auto", model: "opus", why: "the plan is L" } })))
      .toBe("Opus · the plan is L");
  });

  test("names the model alone when the plan had no reason", () => {
    expect(launchLine(plan({ launch: { model: "sonnet", why: "" } }))).toBe("Sonnet");
  });

  test("falls back to the project's role rather than guessing a model", () => {
    expect(launchLine(plan())).toContain("builder role");
  });
});

describe("No-go, which is a tap", () => {
  const card = readFileSync(join(import.meta.dir, "..", "src", "inbox", "PlanCard.tsx"), "utf8");
  const at = card.indexOf("const decide = async (go: boolean): Promise<void> => {");
  const decide = card.slice(at, card.indexOf("\n  };", at));

  test("refuses a second press while the first is out, as the file says it does", () => {
    expect(at).toBeGreaterThan(-1);
    expect(decide).toContain("if (nogo) return;");
    expect(decide).toContain("setNogo(true)");
    expect(decide).toContain("setNogo(false)");
    // And the button shows the wait, which is what makes a second tap unlikely.
    expect(card).toContain("busy={nogo}");
  });
});
