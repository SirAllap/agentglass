// The "Memory reserve" card's words and its one button, for each state the
// server can report. Three of the levels need a password and one does not;
// the app's own unit is never the button's to set.
import { expect, test } from "bun:test";
import { MEMORY_RESERVE_WHAT, memoryReserveNote } from "../src/lib/memoryReserveNote.ts";
import { deskGated } from "../src/lib/deskGate.ts";
import type { MemoryReserveLevel, MemoryReserveReport } from "../../shared/memoryReserve.ts";

const WANT = 1536 * 1024 * 1024;
const levels = (lows: number[]): MemoryReserveLevel[] => [
  { unit: "app-agentglass-electron-4242.scope", low: lows[0]!, owner: "app" },
  { unit: "app.slice", low: lows[1]!, owner: "user" },
  { unit: "user@1000.service", low: lows[2]!, owner: "root" },
  { unit: "user-1000.slice", low: lows[3]!, owner: "root" },
  { unit: "user.slice", low: lows[4]!, owner: "root" },
];
const report = (lows: number[], missing: string[]): MemoryReserveReport =>
  ({ state: missing.length ? "missing" : "effective", want: WANT, levels: levels(lows), missing, why: "" });

test("the levels above the app at 0: says which, and the button says it asks a password once", () => {
  const n = memoryReserveNote(report([WANT, 0, 0, 0, 0], ["user.slice", "user-1000.slice", "user@1000.service", "app.slice"]));
  expect(n.tone).toBe("warn");
  expect(n.badge).toBe("Not effective");
  expect(n.line).toContain("user.slice, user-1000.slice, user@1000.service, app.slice");
  expect(n.action).toEqual({ id: "apply", label: "Reserve 1.6 GB (asks your password once)" });
});

test("only the person's own slice missing: no password is mentioned", () => {
  const n = memoryReserveNote(report([WANT, 0, WANT, WANT, WANT], ["app.slice"]));
  expect(n.action).toEqual({ id: "apply", label: "Reserve 1.6 GB" });
});

test("only the app's own unit missing: nothing to press, and it says what sets it", () => {
  const n = memoryReserveNote(report([0, WANT, WANT, WANT, WANT], ["app-agentglass-electron-4242.scope"]));
  expect(n.tone).toBe("warn");
  expect(n.action).toBeNull();
  expect(n.line).toContain("restart the app");
});

test("effective: says so, and the one button takes it off again", () => {
  const n = memoryReserveNote(report([WANT, WANT, WANT, WANT, WANT], []));
  expect(n).toMatchObject({ tone: "ok", badge: "Effective", action: { id: "undo", label: "Remove reserve" } });
});

test("not applicable: the server's reason, and no button", () => {
  const n = memoryReserveNote({ state: "not-applicable", want: 0, levels: [], missing: [], why: "Only Linux has this reserve." });
  expect(n).toEqual({ tone: "off", badge: "Not applicable", line: "Only Linux has this reserve.", action: null });
});

test("one plain line says what it is for", () => {
  expect(MEMORY_RESERVE_WHAT.split(". ").length).toBe(1);
  expect(MEMORY_RESERVE_WHAT).toContain("pushed to disk");
});

test("the press carries the desktop app's key, or the server reads it as somebody else's", () => {
  expect(deskGated("/machine/memory-reserve")).toBe(true);
});

const card = await Bun.file(new URL("../src/components/MemoryReserveCard.tsx", import.meta.url)).text();

test("the card asks only on a press, and has no native tooltip", () => {
  const code = card.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // The one write is inside the button's handler, never in an effect.
  expect(code.match(/api\.setMemoryReserve\(/g)?.length).toBe(1);
  const effect = code.slice(code.indexOf("useEffect("), code.indexOf("if (!report)"));
  expect(effect).not.toContain("setMemoryReserve");
  expect(code).not.toContain(" title={");
  expect(code).toContain('title="Memory reserve"');
});
