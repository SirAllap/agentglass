/*
 * The `pr.unstick` door and the places Unstick could run from. An agent may open
 * the dialog on a pull request; nothing it can call may close or reopen one.
 * Rules about source are asserted against source, because there is no renderer.
 */
import { describe, expect, it } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";
import type { ControlCmd } from "../../shared/types.ts";
import { mergePath } from "../../shared/mergePath.ts";
import { UNSTICK_LABEL } from "../../shared/unstick.ts";

const stubGlobal = globalStubs();
stubGlobal("window", new EventTarget());
stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 } as unknown as Storage);
stubGlobal("location", new URL("http://localhost:5173/"));
stubGlobal("document", { documentElement: { getAttribute: () => "graphite", setAttribute: () => {}, style: { setProperty: () => {}, getPropertyValue: () => "" } } });
stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
const { runControl, UI_HANDLERS } = await import("../src/lib/uiActions.ts");
const { takeUnstick, latchUnstick, subscribeUnstick, UNSTICK_TTL_MS } = await import("../src/lib/unstickIntent.ts");

const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();

describe("the door", () => {
  it("latches the request and brings the pull request view up; calls no API", () => {
    const calls: unknown[][] = [];
    const c = { goView: (v: string) => calls.push(["goView", v]) } as never;
    const cmd = { cmd: "ui", do: "pr.unstick", args: { root: "/home/dev/orbit", number: 1042 } } as unknown as ControlCmd;
    expect(runControl(cmd, c)).toBe("pr.unstick");
    expect(calls).toEqual([["goView", "pr"]]);
    expect(takeUnstick()).toEqual({ root: "/home/dev/orbit", number: 1042 });
    expect(takeUnstick()).toBeNull();
  });
  it("a request nobody was there for does not fire at the next visit", () => {
    latchUnstick({ root: "/home/dev/orbit", number: 7 });
    expect(takeUnstick(Date.now() + UNSTICK_TTL_MS + 1000)).toBeNull();
  });
  it("tells a listener, so a view that is already up opens it", () => {
    let n = 0;
    const off = subscribeUnstick(() => { n++; });
    latchUnstick({ root: "/home/dev/orbit", number: 7 });
    off();
    takeUnstick();
    expect(n).toBe(1);
  });
  it("the handler is the latch and the view, and nothing that could run it", async () => {
    const text = await read("../src/lib/uiActions.ts");
    const line = text.split("\n").find((l) => l.includes('"pr.unstick":'))!;
    expect(line).toContain("latchUnstick(");
    expect(line).not.toMatch(/api\.|runUnstick|prUnstick|prClose/);
    expect(typeof UI_HANDLERS["pr.unstick"]).toBe("function");
  });
});

describe("nothing outside a click runs it", () => {
  it("the dialog starts the run in one place, a click handler, and no effect calls it", async () => {
    const text = await read("../src/components/UnstickDialog.tsx");
    expect(text.match(/runUnstick\(/g)?.length).toBe(1);
    expect(text.match(/\brun\(\)/g)?.length).toBe(1);
    expect(text).toContain("onClick={() => void run()}");
    // The run is refused outright when the gate said no, whatever called it.
    const fn = text.slice(text.indexOf("const run = async"), text.indexOf("const reopenNow"));
    expect(fn).toContain("!p.gate.show");
    // No useEffect body mentions run, the close or the reopen.
    for (const m of text.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[/g)) expect(m[1]).not.toMatch(/run\(|prUnstick|runUnstick/);
  });
  it("the panel opens the dialog from the row's button or the door, and gives it the gate as it stands", async () => {
    const text = await read("../src/components/PrPanel.tsx");
    const opens = [...text.matchAll(/\bopenUnstick\(/g)].length;
    expect(opens).toBe(1); // the agent's door; the button passes the function itself, below
    expect(text).toContain("onUnstick={openUnstick}");
    expect(text).toContain("{unstickShown && (");
    // The dialog keeps what it was opened on: it must not vanish or change its question after the run re-reads the pull request.
    expect(text).not.toContain("{unstickOpen &&");
    expect((await read("../src/components/UnstickDialog.tsx"))).toContain("useState(() => ({ gate: props.gate, facts: props.facts }))");
    expect(text).toContain("unstickOffer={!!unstickGate?.show}");
  });
  it("only a stuck row carries the button, and only when the gate said so", () => {
    const base = { state: "OPEN", mergeState: "UNKNOWN", mergeable: "UNKNOWN", baseRefName: "main", unknownSince: 1, now: 31 * 60_000 + 1 };
    const withOffer = mergePath({ ...base, unstickOffer: true } as never);
    const without = mergePath({ ...base } as never);
    expect(withOffer.rows.filter((r) => r.action).map((r) => r.action!.id)).toEqual(["unstick"]);
    expect(withOffer.rows.find((r) => r.action)!.action!.label).toBe(UNSTICK_LABEL);
    expect(without.rows.some((r) => r.action)).toBe(false);
  });
  it("a blocked pull request GitHub did not explain is not a stuck one: no button even with the flag set", () => {
    const p = mergePath({ state: "OPEN", mergeState: "BLOCKED", mergeable: "MERGEABLE", baseRefName: "main", unstickOffer: true } as never);
    expect(p.rows.some((r) => r.kind === "unexplained")).toBe(true);
    expect(p.rows.some((r) => r.action)).toBe(false);
  });
  it("a healthy pull request gets no such row even with the flag set", () => {
    const p = mergePath({ state: "OPEN", mergeState: "CLEAN", mergeable: "MERGEABLE", baseRefName: "main", unstickOffer: true } as never);
    expect(p.rows.some((r) => r.action)).toBe(false);
  });
});
