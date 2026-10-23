/*
 * "Update branch" is one request per pull request, not one per panel.
 *
 * The panel kept a single busy flag for every write, so pressing the button on
 * one pull request greyed — with a spinner on the button, as if it had been
 * pressed — the same button on every other pull request of the repository
 * until the first one came back. Several syncs in a row meant waiting on each.
 *
 * What is pinned: a flight belongs to (repository, number); a second press on
 * the same pull request is refused, a press on another one is not; and what a
 * finished request leaves behind (the hold, the refusal) is kept per pull
 * request, so A finishing after B was opened never overwrites B's.
 */
import { describe, expect, test } from "bun:test";
import { enterFlight, leaveFlight, inFlight, flightKey } from "../src/lib/updateFlight.ts";

const SRC = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

/** The text of `name`'s body, from its signature to its own closing brace at the same indent. */
function bodyOf(src: string, signature: string): string {
  const at = src.indexOf(signature);
  expect(at).toBeGreaterThan(-1);
  const indent = /^ */.exec(src.slice(src.lastIndexOf("\n", at) + 1))![0];
  const end = src.indexOf(`\n${indent}};`, at);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end);
}
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");

describe("the flights", () => {
  const A = flightKey("/work/orbit", 1042);
  const B = flightKey("/work/orbit", 1043);

  test("a press on another pull request of the same repository is not refused", () => {
    const a = enterFlight(new Set(), A)!;
    expect(a).not.toBeNull();
    const ab = enterFlight(a, B);
    expect(ab).not.toBeNull();
    expect(inFlight(ab!, "/work/orbit", 1043)).toBe(true);
  });

  test("the same pull request twice is refused: that one is already on its way", () => {
    const a = enterFlight(new Set(), A)!;
    expect(enterFlight(a, A)).toBeNull();
  });

  test("A coming back leaves B in flight, and the other way round", () => {
    const ab = enterFlight(enterFlight(new Set(), A)!, B)!;
    const b = leaveFlight(ab, A);
    expect(inFlight(b, "/work/orbit", 1042)).toBe(false);
    expect(inFlight(b, "/work/orbit", 1043)).toBe(true);
    expect(leaveFlight(b, B).size).toBe(0);
  });

  test("the same number in another repository is another pull request", () => {
    const a = enterFlight(new Set(), A)!;
    expect(inFlight(a, "/work/other", 1042)).toBe(false);
  });

  test("a set is never changed in place: React compares by reference", () => {
    const s = new Set<string>();
    enterFlight(s, A);
    expect(s.size).toBe(0);
    const a = enterFlight(s, A)!;
    leaveFlight(a, A);
    expect(a.size).toBe(1);
  });
});

describe("the panel", () => {
  const press = code(bodyOf(SRC, "const doUpdateBranch = (syncLocal: boolean) =>"));

  test("Update branch does not go through the panel-wide act()", () => {
    // act() sets the one `busy` every button of every pull request reads.
    expect(press).not.toContain("act(");
    expect(press).toContain("enterFlight(");
    expect(press).toContain("leaveFlight(");
  });

  test("a finished press refetches the pull request it was made on, not whichever is open", () => {
    expect(press).not.toContain("selected)");
    // The detail is one slot: refetching A while B is open would paint A over B.
    expect(press).toContain("if (selectedRef.current === num) loadDetail(num, true);");
  });

  test("act() does not repaint the detail with a pull request that is no longer open", () => {
    const act = code(bodyOf(SRC, "const act = useCallback(async (label: string,"));
    expect(act).toContain("selectedRef.current === selected");
  });

  test("what a press leaves behind is kept per repository and pull request", () => {
    expect(SRC).toContain("useState<Record<string, { at: number; headBefore: string; note?: string }>>({})");
    expect(SRC).toContain("useState<Record<string, string>>({})");
    expect(press).toContain("setAsked((cur) => ({ ...cur, [key]:");
    expect(press).toContain("setRefusedUpdate((cur) => ({ ...cur, [key]:");
  });

  test("the buttons of the pull request on screen read only that pull request's flight", () => {
    expect(SRC).toContain("const updatingHere = detail != null && inFlight(updating, root, detail.number)");
    expect(SRC).toMatch(/const busy = running \|\| readOnly \|\| updatingHere;/);
    expect(SRC).toContain('const busyWhat = updatingHere ? "Update branch" : busyWhatAct;');
  });
});
