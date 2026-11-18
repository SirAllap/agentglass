/*
 * An acknowledgement the computer did not take puts the fire back.
 *
 * The row leaves on the press, because a fire already open on screen that did
 * not move reads as a tap that missed. But the row is a copy of something the
 * computer holds: if the POST is refused — no network, or a scope that changed
 * in another tab — the fire is still there, and the bell was left one short
 * until the next minute's read. `ack` is fire-and-forget no longer.
 *
 * Asserted against source: it is a module-level queue and a hook, and what the
 * finding turns on is what the answer does.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (...p: string[]): string => readFileSync(join(import.meta.dir, "..", ...p), "utf8");
const strip = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const inbox = strip(src("src", "state", "use-inbox.ts"));
const at = inbox.indexOf("const ack = (seq: number): void => {");
const ack = inbox.slice(at, inbox.indexOf("\n  };", at));

describe("acknowledging a watch fire", () => {
  test("keeps the fire it removed, so it can come back as it was", () => {
    expect(at).toBeGreaterThan(-1);
    expect(ack).toContain("held.fires.find((f) => f.seq === seq)");
  });

  test("reads the answer, and a refusal publishes the fire again and asks the computer", () => {
    const after = ack.slice(ack.indexOf(".then("));
    expect(ack).toContain(".then(");
    expect(after).toContain("answer.value.ok !== false");
    expect(after).toContain("fires: [...held.fires, fire]");
    expect(after).toContain("if (answer.ok) void readInbox(host)");
  });

  test("still leaves on the press when the answer is a yes", () => {
    expect(ack.indexOf("publish({ ...held, fires: held.fires.filter")).toBeLessThan(ack.indexOf(".then("));
  });
});
