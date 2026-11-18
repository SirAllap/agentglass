import { describe, expect, it } from "bun:test";

// A gate hold shows once: gateStore records it (an agentglass card with Allow /
// Deny, or one desktop popup when nobody is looking). The bar's caption lane
// used to toast it as well, which was the same hold twice.
describe("a gate hold has one surface", () => {
  it("the caption lane does not subscribe to new gates", async () => {
    const bar = await Bun.file(new URL("../src/components/TopBarNotes.tsx", import.meta.url)).text();
    expect(bar).not.toContain("subscribeNewGates(");
  });
  it("gateStore still records the hold as a note", async () => {
    const store = await Bun.file(new URL("../src/lib/gateStore.ts", import.meta.url)).text();
    expect(store).toMatch(/recordNote\(\{\s*app: "gate"/);
  });
});
