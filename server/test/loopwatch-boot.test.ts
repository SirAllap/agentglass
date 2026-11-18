import { expect, test } from "bun:test";
import { bootStep, openBootSteps, unlabelledHead, unlabelledWhat } from "../src/loopwatch.ts";

test("an unlabelled stall names the last open boot step", () => {
  expect(unlabelledHead([])).toBe("unlabelled");
  expect(unlabelledHead(["boot:a", "boot:plugins"])).toBe("unlabelled (inside boot:plugins)");
  expect(unlabelledWhat("Error\n    at f (x.ts:1:1)", false, "", ["boot:plugins"])).toBe("unlabelled (inside boot:plugins): f (x.ts:1:1)");
  expect(unlabelledWhat("Error\n    at f (x.ts:1:1)")).toBe("unlabelled: f (x.ts:1:1)");
  // The watcher's own frame names no culprit: no bundle position, but every open step.
  const own = "Error\n    at tickStack (/$bunfs/root/agentglass-server:1000:19)";
  expect(unlabelledWhat(own, false, "", ["boot:a", "boot:b"])).toBe("unlabelled (inside boot:b): no JS frame (the watcher only sees itself); open boot steps: boot:a, boot:b");
  expect(unlabelledWhat(own)).toBe("unlabelled: no JS frame (the watcher only sees itself)");
});

test("bootStep stays open until its promise settles, then closes", async () => {
  let release!: () => void;
  const p = bootStep("slow", () => new Promise<void>((r) => { release = r; }));
  // No public view of the open list: closing is proven by the sync step returning its value.
  expect(bootStep("sync", () => 7)).toBe(7);
  release(); await p;
  expect(() => bootStep("boom", () => { throw new Error("x"); })).toThrow("x");
});

test("a boot timer's callback runs under its boot:<step>:<what> label", async () => {
  const { setTimeoutAs, currentLabel } = await import("../src/loopwatch.ts");
  const seen = await new Promise<string>((res) => { setTimeoutAs("boot:session-risk-warm:step", () => res(currentLabel()), 1); });
  expect(seen).toBe("boot:session-risk-warm:step");
});

test("the warmers schedule their steps under boot labels, not raw timers", async () => {
  const src = await Bun.file(new URL("../src/db.ts", import.meta.url)).text();
  expect(src).toContain('setTimeoutAs("boot:session-risk-warm:step"');
  expect(src).toContain('setTimeoutAs("boot:slim-old-events:pass"');
});

test("a boot step whose promise never settles stops being 'inside' after its limit", async () => {
  bootStep("never", () => new Promise<void>(() => {}), 20);
  expect(openBootSteps()).toContain("boot:never");
  await new Promise((r) => setTimeout(r, 60));
  expect(openBootSteps()).not.toContain("boot:never");
});

test("a settled step's old timer does not close a newer step with the same label", async () => {
  let release!: () => void;
  const p = bootStep("again", () => new Promise<void>((r) => { release = r; }), 40);
  release(); await p;
  expect(openBootSteps()).not.toContain("boot:again");
  bootStep("again", () => new Promise<void>(() => {}), 500);
  await new Promise((r) => setTimeout(r, 80));
  expect(openBootSteps()).toContain("boot:again");
});
