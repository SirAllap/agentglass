import { expect, test } from "bun:test";
import { createTabFactsStore } from "../src/lib/tabFacts.ts";

// The terminal's effects write a tab's root and branch each time they run.
// A write that repeats what is stored must not wake subscribers, or the
// redraw re-runs the effect and React stops at its update-depth limit.
test("a write that changes nothing does not notify", () => {
  const s = createTabFactsStore();
  let calls = 0;
  s.subscribe(() => { calls++; });
  s.write("@7", { root: "/home/acme/orbit", branch: "main" });
  expect(calls).toBe(1);
  s.write("@7", { root: "/home/acme/orbit", branch: "main" });
  s.write("@7", { root: "/home/acme/orbit" });
  expect(calls).toBe(1);
  s.write("@7", { branch: "ORBIT-1042" });
  expect(calls).toBe(2);
  expect(s.get("@7")?.branch).toBe("ORBIT-1042");
});
