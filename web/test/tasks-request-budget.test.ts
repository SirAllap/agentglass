/*
 * What the Tasks panel asks for on its own, asserted on the source.
 *
 * There is no renderer here, so the rules are held where they are written. Each
 * one is a measured request count against a stand-in workspace: a status change
 * was followed by a forced read of the whole board (92 KB, two or three upstream
 * calls), a card's own Refresh press did the same because its answer looked
 * like a write, and two timers kept asking while the window had no focus.
 */
import { describe, expect, it } from "bun:test";

const panel = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");

describe("the board is re-read after a write only when a card moved", () => {
  const at = panel.indexOf("const moved = useRef(false);");
  const body = at < 0 ? "" : code(panel.slice(at, panel.indexOf("}, [wrote, over]);", at)));

  it("gates the catch-up read on a card having left its list", () => {
    expect(at).toBeGreaterThan(0);
    expect(body).toContain("!moved.current");
    expect(body).toContain("load(data?.view?.id, true)");
  });

  it("only a sprint change marks a card as moved", () => {
    const apply = code(panel.slice(panel.indexOf("const apply = (t: ProviderTask"), panel.indexOf("const apply = (t: ProviderTask") + 400));
    expect(apply).toContain('if (key === "sprint") moved.current = true;');
  });
});

describe("the polls that ask while nobody looks", () => {
  it("the local task list and the issue bundle go through usePoll", () => {
    const c = code(panel);
    expect(c).toContain("usePoll(active, load, 15_000)");
    expect(c).toContain("usePoll(active, load, 60_000)");
    expect(c).not.toMatch(/setInterval\(load, (15|60)_000\)/);
  });
});
