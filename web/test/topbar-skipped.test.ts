/*
 * The top bar is not drawn by the live socket.
 *
 * The root renders on every flush of the socket and the bar rendered with it:
 * its whole body, the quota strip and every chip, several times a second, for
 * content that had not changed. It was handed four fresh arrows and a needs
 * list rebuilt from `agents` on each of those renders. The bar is now compared
 * by identity, the root hands it values that keep their identity while their
 * content is the same, and what the bar reads on its own tells it so.
 */
import { describe, expect, test } from "bun:test";
import { stubStorage } from "./stubStorage";

const store = new Map<string, string>();
stubStorage({
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});

const { kept, sameOrBothNull, sameRows, sameStrings } = await import("../src/lib/keptValue.ts");
const { __resetUsageBar, setShowInBar, subscribeUsageBar } = await import("../src/lib/usageBarPref.ts");

const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
const bar = await Bun.file(new URL("../src/components/TopBar.tsx", import.meta.url)).text();

describe("the same content keeps the same object", () => {
  const need = (over: Record<string, unknown> = {}) => ({
    key: "al-1", sessionId: "s-1", label: "orbit-auth", because: "wants to run make test", level: "warn",
    cwd: "/home/dev/orbit", project: "/home/dev/orbit", otherProject: null, gated: false, ...over,
  });

  test("a needs list rebuilt with nothing new in it is the one the bar already has", () => {
    const first = [need(), need({ key: "al-2", label: "orbit-billing" })];
    const again = [need(), need({ key: "al-2", label: "orbit-billing" })];
    expect(kept(first, again, sameRows)).toBe(first);
    // A different reason, one more row, a different order: each is a new list.
    const reason = [need({ because: "wants to push" }), again[1]!];
    expect(kept(first, reason, sameRows)).toBe(reason);
    const more = [...again, need({ key: "al-3" })];
    expect(kept(first, more, sameRows)).toBe(more);
    const swapped = [again[1]!, again[0]!];
    expect(kept(first, swapped, sameRows)).toBe(swapped);
  });

  test("the chip: nothing stays nothing, and a plan that appears is a change", () => {
    const chip = { count: 1, label: "orbit-auth", because: "wants to run make test" };
    expect(kept<typeof chip | null>(null, null, sameOrBothNull)).toBeNull();
    expect(kept<typeof chip | null>(chip, { ...chip }, sameOrBothNull)).toBe(chip);
    expect(kept<typeof chip | null>(chip, null, sameOrBothNull)).toBeNull();
    const counted = { ...chip, count: 2 };
    expect(kept<typeof chip | null>(chip, counted, sameOrBothNull)).toBe(counted);
    const planned = { ...chip, plan: "fp_orbit1042" };
    expect(kept<Record<string, unknown> | null>(chip, planned, sameOrBothNull)).toBe(planned);
  });

  test("the open projects: the same paths from a new poll are the same list", () => {
    const open = ["/home/dev/orbit", "/home/dev/acme-v2"];
    expect(kept<readonly string[]>(open, [...open], sameStrings)).toBe(open);
    const one = ["/home/dev/orbit"];
    expect(kept<readonly string[]>(open, one, sameStrings)).toBe(one);
  });
});

describe("what the bar reads on its own tells it", () => {
  test("a bar switch moved in Settings reaches whoever asked", () => {
    __resetUsageBar();
    let told = 0;
    const off = subscribeUsageBar(() => { told++; });
    setShowInBar("codex", false);
    expect(told).toBe(1);
    off();
    setShowInBar("codex", true);
    expect(told).toBe(1);
  });

  test("the bar subscribes to the three things it used to pick up from the render above", () => {
    expect(bar).toContain("const offs = [subscribeAccounts(again), subscribeBindings(again), subscribeUsageBar(again)];");
    expect(bar).toContain("export const TopBar = memo(function TopBar({");
  });
});

describe("what the root hands the bar", () => {
  const at = app.indexOf("<TopBar");
  const tag = app.slice(at, app.indexOf("\n      />", at));

  test("no arrow is made in the tag, and the clock goes with it", () => {
    expect(at).toBeGreaterThan(-1);
    const code = tag.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    expect(code).not.toContain("=>");
    expect(code).toContain("tick={tick}");
  });

  test("the derived values are the kept ones", () => {
    expect(tag).toContain("needs={barNeeds}");
    expect(tag).toContain("needsList={barNeedsList}");
    expect(tag).toContain("workspaces={barWorkspaces}");
  });
});
