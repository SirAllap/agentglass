/*
 * A quiet open of the app's own screen: when it lands and when it waits.
 *
 * The decision is a pure function of four things (the mode, the kind of door,
 * where the keyboard is, how long since the person typed), so each branch is a
 * row here. The window-side wiring (App.tsx subscribing to the control bus) is
 * pinned as source, and test/../server/test/ui-quiet.test.ts holds the wire.
 */
import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UI_ACTIONS, UI_ACTION_IDS, type UiActionDef } from "../../shared/uiActions.ts";
import {
  decidePresent, focusKindOf, idleDueAt, offerText, noteInput, sinceInputMs, resetInputClock, lastInputAt,
  TYPING_MS, IDLE_APPLY_MS, MAX_OFFERS, type PresentInput,
} from "../src/lib/quietPresent.ts";
import { OFFER_LABELS, labelOf } from "../src/lib/offerLabels.ts";
import { offers, routeControl, idleDue, attachIdleApply } from "../src/lib/agentOffers.ts";
import { AgentOffer } from "../src/components/AgentOffers.tsx";
import type { ControlCmd } from "../../shared/types.ts";

const base: PresentInput = { present: "quiet", kind: "open", inPlace: false, focus: "other", sinceInputMs: Infinity };
const el = (o: Record<string, unknown>) => o as never;
const settingsCmd = (page: string): ControlCmd => ({ cmd: "ui", do: "settings.open", args: { page } }) as ControlCmd;

afterEach(() => { offers.clear(); resetInputClock(); });

describe("decidePresent", () => {
  test("quiet while the keyboard is in a terminal or a field: held", () => {
    expect(decidePresent({ ...base, focus: "terminal" })).toBe("queue");
    expect(decidePresent({ ...base, focus: "field" })).toBe("queue");
  });
  test("quiet with the person just having typed, focus anywhere: held", () => {
    expect(decidePresent({ ...base, sinceInputMs: TYPING_MS - 1 })).toBe("queue");
    expect(decidePresent({ ...base, sinceInputMs: 0 })).toBe("queue");
  });
  test("quiet, nobody typing and nothing focused: runs", () => {
    expect(decidePresent({ ...base, sinceInputMs: TYPING_MS })).toBe("apply");
    expect(decidePresent(base)).toBe("apply");
  });
  test("now runs whatever the person is doing", () => {
    expect(decidePresent({ ...base, present: "now", focus: "terminal", sinceInputMs: 0 })).toBe("apply");
  });
  test("a read or a change has nothing to hold", () => {
    for (const kind of ["read", "change"] as const) expect(decidePresent({ ...base, kind, focus: "field", sinceInputMs: 0 })).toBe("apply");
  });
  test("a stage puts a dialog in front of the person, so it waits like an open", () => {
    expect(decidePresent({ ...base, kind: "stage", focus: "field", sinceInputMs: 0 })).toBe("queue");
  });
  test("an in-place door (Escape, theme, zoom) runs even when typing", () => {
    expect(decidePresent({ ...base, inPlace: true, focus: "terminal", sinceInputMs: 0 })).toBe("apply");
  });
});

describe("focusKindOf", () => {
  test("an xterm's helper textarea is a terminal, not just a field", () => {
    expect(focusKindOf(el({ tagName: "TEXTAREA", closest: (s: string) => (s === ".xterm" ? {} : null) }))).toBe("terminal");
  });
  test("text inputs, textareas, selects and contenteditable are fields", () => {
    expect(focusKindOf(el({ tagName: "INPUT", type: "text" }))).toBe("field");
    expect(focusKindOf(el({ tagName: "INPUT" }))).toBe("field");
    expect(focusKindOf(el({ tagName: "TEXTAREA" }))).toBe("field");
    expect(focusKindOf(el({ tagName: "SELECT" }))).toBe("field");
    expect(focusKindOf(el({ tagName: "DIV", isContentEditable: true }))).toBe("field");
  });
  test("a button, a checkbox you tabbed to, the body and nothing are not", () => {
    expect(focusKindOf(el({ tagName: "BUTTON" }))).toBe("other");
    expect(focusKindOf(el({ tagName: "INPUT", type: "checkbox" }))).toBe("other");
    expect(focusKindOf(el({ tagName: "BODY" }))).toBe("other");
    expect(focusKindOf(null)).toBe("other");
  });
});

describe("routeControl", () => {
  test("a quiet settings.open while a field has the keyboard is queued with the words on the chip", () => {
    expect(routeControl(settingsCmd("notifications"), "quiet", "field", Infinity))
      .toEqual({ route: "queue", key: 'settings.open:{"page":"notifications"}', label: "Settings > Notifications" });
  });
  test("the same under now runs", () => {
    expect(routeControl(settingsCmd("notifications"), "now", "field", 0)).toEqual({ route: "apply" });
  });
  test("a legacy spelling is held like the entry it spells", () => {
    expect(routeControl({ cmd: "view", to: "git" } as ControlCmd, "quiet", "terminal", Infinity)).toMatchObject({ route: "queue", label: "the git view" });
  });
  test("Escape, zoom and theme are never held", () => {
    for (const c of [{ cmd: "esc" }, { cmd: "zoom", dir: 1 }, { cmd: "theme", dir: 1 }] as ControlCmd[]) expect(routeControl(c, "quiet", "terminal", 0)).toEqual({ route: "apply" });
  });
  test("reads and settings changes are never held", () => {
    expect(routeControl({ cmd: "ui", do: "ui.state", args: {} } as ControlCmd, "quiet", "terminal", 0)).toEqual({ route: "apply" });
    expect(routeControl({ cmd: "ui", do: "settings.set", args: { id: "diff.wrap", value: true } } as ControlCmd, "quiet", "terminal", 0)).toEqual({ route: "apply" });
  });
  test("a frame that names no door runs (and fails) rather than vanishing behind a chip", () => {
    expect(routeControl({ cmd: "nonsense" } as unknown as ControlCmd, "quiet", "terminal", 0)).toEqual({ route: "apply" });
  });
});

describe("the chip's words", () => {
  const holdable = UI_ACTION_IDS.filter((id) => { const d = UI_ACTIONS[id] as UiActionDef; return d.kind === "open" && !d.inPlace; });
  test("every door that can be held has words, and a door that cannot be held has none", () => {
    expect(Object.keys(OFFER_LABELS).sort()).toEqual([...holdable].sort());
  });
  test("the sentence names who and what, and falls back to 'An agent'", () => {
    expect(offerText("claude-1", "Settings > Notifications")).toBe("claude-1 wants to show you: Settings > Notifications");
    expect(offerText(undefined, "the git view")).toBe("An agent wants to show you: the git view");
  });
  test("a row and a file come through the label", () => {
    expect(labelOf({ cmd: "ui", do: "settings.open", args: { page: "diff", row: "wrap" } } as ControlCmd)).toBe("Settings > Diff > Wrap");
  });
});

describe("the offers line", () => {
  const mk = (key: string, heldAt = 0, apply = () => {}) => ({ key, label: key, heldAt, apply });
  test("the same door held twice is one chip, moved to the end", () => {
    offers.hold(mk("a")); offers.hold(mk("b")); offers.hold(mk("a"));
    expect(offers.list().map((o) => o.key)).toEqual(["b", "a"]);
  });
  test("the line is capped; the oldest goes", () => {
    for (let i = 0; i < MAX_OFFERS + 3; i++) offers.hold(mk("k" + i));
    expect(offers.list()).toHaveLength(MAX_OFFERS);
    expect(offers.list()[0]!.key).toBe("k3");
  });
  test("accept runs it once and takes it off; dismiss takes it off and never runs it", () => {
    let ran = 0;
    offers.hold(mk("a", 0, () => { ran++; }));
    offers.hold(mk("b", 0, () => { ran += 10; }));
    offers.dismiss("b");
    expect(ran).toBe(0);
    offers.accept("a"); offers.accept("a");
    expect(ran).toBe(1);
    expect(offers.list()).toHaveLength(0);
  });
  test("idle: due only IDLE_APPLY_MS after the later of the last input and the hold", () => {
    expect(idleDueAt(null, 1000)).toBe(1000 + IDLE_APPLY_MS);
    expect(idleDueAt(5000, 1000)).toBe(5000 + IDLE_APPLY_MS);
    expect(idleDueAt(500, 1000)).toBe(1000 + IDLE_APPLY_MS);
    const list = [mk("old", 0), mk("new", 40_000)];
    expect(idleDue(list, null, IDLE_APPLY_MS)).toEqual(["old"]);
    expect(idleDue(list, 30_000, IDLE_APPLY_MS + 1)).toEqual([]);
    expect(idleDue(list, null, 40_000 + IDLE_APPLY_MS)).toEqual(["old", "new"]);
  });
  test("the idle timer applies what has waited out the idle stretch and leaves a fresh one", async () => {
    const t0 = 1_000_000;
    let ran = "";
    offers.hold(mk("stale", t0 - IDLE_APPLY_MS - 1, () => { ran += "s"; }));
    offers.hold(mk("fresh", t0, () => { ran += "f"; }));
    const detach = attachIdleApply(() => t0);
    await Bun.sleep(30);
    detach();
    expect(ran).toBe("s");
    expect(offers.list().map((o) => o.key)).toEqual(["fresh"]);
  });
  test("typing since the hold pushes the idle apply out", async () => {
    const t0 = 1_000_000;
    let ran = 0;
    noteInput(t0 - 10);
    offers.hold(mk("a", t0 - IDLE_APPLY_MS - 1, () => { ran++; }));
    const detach = attachIdleApply(() => t0);
    await Bun.sleep(30);
    detach();
    expect(ran).toBe(0);
  });
});

describe("the input clock", () => {
  test("never typed is infinitely long ago", () => {
    expect(lastInputAt()).toBeNull();
    expect(sinceInputMs(5)).toBe(Infinity);
    noteInput(100);
    expect(sinceInputMs(350)).toBe(250);
  });
});

describe("the chip, rendered", () => {
  const html = renderToStaticMarkup(React.createElement(AgentOffer, { o: { key: "k", as: "claude-1", label: "Settings > Notifications", heldAt: 0, apply: () => {} }, onShow: () => {}, onDismiss: () => {} }));
  test("says who wants to show what, with one button that opens it and one that dismisses", () => {
    expect(html).toContain("claude-1 wants to show you: Settings &gt; Notifications");
    expect(html).toContain(">Show me<");
    expect(html).toContain('title="Dismiss"');
  });
  test("is built from house tokens and sizes, not new numbers or raw colours", () => {
    expect(html).toContain("var(--surface-card)");
    expect(html).toContain("min-height:");
    expect(html).not.toMatch(/(color|background)\s*:\s*#/);
  });
});

describe("a quiet open never takes the keyboard or the OS window", async () => {
  // Source guard: the files that decide, hold and show a quiet open take no
  // focus and raise nothing. A dialog's own autofocus once it runs is the
  // documented limit (quietPresent.ts); this keeps the channel itself honest.
  const files = ["lib/quietPresent.ts", "lib/agentOffers.ts", "lib/offerLabels.ts", "components/AgentOffers.tsx"];
  for (const f of files) {
    test(f + " calls no focus(), show(), raise or electron bridge", async () => {
      const src = (await Bun.file(new URL("../src/" + f, import.meta.url)).text()).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      expect(src).not.toMatch(/\.focus\(|autoFocus|\.show\(|raise|window\.focus|electron/i);
    });
  }
});

describe("the window is wired to it", async () => {
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  const sub = app.slice(app.indexOf("return subscribeControl("));
  const body = sub.slice(0, sub.indexOf("\n  }, []);"));
  test("a command off the socket is routed with its present mode; one without is now", () => {
    expect(body).toContain('meta?.present ?? "now"');
    expect(body).toContain("routeControl(");
    expect(body).toContain("focusKindOf(document.activeElement)");
  });
  test("a held open is answered as queued, not as applied", () => {
    expect(body).toContain("applied: false, queued: true");
  });
  test("the input clock listens for keys, pointer and paste, and the idle timer is attached", () => {
    expect(app).toContain('["keydown", "pointerdown", "paste"]');
    expect(app).toContain("attachIdleApply()");
  });
});
