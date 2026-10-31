import { describe, expect, test } from "bun:test";
import { termState, type TermStateInput } from "../src/lib/termStates.ts";

const base: TermStateInput = { status: "live", tmux: true, due: false, settled: true, windows: 2, noTmux: false, retrying: false, noteDismissed: false };
const at = (o: Partial<TermStateInput>) => termState({ ...base, ...o });

describe("which state the pane area is in", () => {
  test("a live tmux with windows is the normal Terminal", () => {
    expect(at({})).toBe("ready");
  });
  test("a frame still on its way, or a connection in flight, is loading", () => {
    expect(at({ due: true })).toBe("loading");
    expect(at({ status: "connecting", windows: 0 })).toBe("loading");
  });
  test("a reconnect in progress stays loading, so 'can't reach' does not flash between tries", () => {
    expect(at({ status: "error", retrying: true })).toBe("loading");
    expect(at({ status: "error", retrying: false })).toBe("error");
  });
  test("tmux answered with no windows is empty", () => {
    expect(at({ windows: 0 })).toBe("empty");
  });
  test("no tmux on the machine says so once it has drawn, until put away", () => {
    const none = { tmux: false, noTmux: true, windows: 0 };
    expect(at(none)).toBe("notmux");
    expect(at({ ...none, settled: false })).toBe("ready");
    expect(at({ ...none, noteDismissed: true })).toBe("ready");
  });
  test("a plain shell on a machine that has tmux says nothing", () => {
    expect(at({ tmux: false, windows: 0 })).toBe("ready");
  });
  test("a bad token is the token's own button, not a card", () => {
    expect(at({ status: "unauthorized" })).toBe("ready");
  });
});
