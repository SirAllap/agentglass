/*
 * A TAB YOU CAN NAME OUT LOUD, AND THAT STILL NAMES THE SAME THING LATER.
 *
 * "I want them to always be AI0X... or for it to match the task being worked
 * on." Two halves, and the numbering is the half that is easy to get
 * subtly wrong: a number derived from POSITION renumbers the whole strip every
 * time somebody closes a tab in the middle, which is the exact thing that
 * makes a name useless as an address.
 */
import { describe, expect, test } from "bun:test";
import { nextAgentName } from "../src/tmuxctl.ts";

describe("the next free AI0N", () => {
  test("a fresh session starts at AI01", () => {
    expect(nextAgentName([])).toBe("AI01");
  });

  test("it fills the lowest free number, so a closed tab gives its name back", () => {
    expect(nextAgentName(["AI01", "AI03"])).toBe("AI02");
    expect(nextAgentName(["AI01", "AI02", "AI03"])).toBe("AI04");
  });

  test("padded to two digits, and past ninety-nine it just keeps counting", () => {
    expect(nextAgentName(["AI01", "AI02", "AI03", "AI04", "AI05", "AI06", "AI07", "AI08"])).toBe("AI09");
    const ninetyNine = Array.from({ length: 99 }, (_, i) => `AI${String(i + 1).padStart(2, "0")}`);
    expect(nextAgentName(ninetyNine)).toBe("AI100");
  });

  test("windows named by a person are not counted as AI tabs", () => {
    /* A strip is somebody's own work as well as ours, and `bun`, `zsh` and
       `orbit` must not shift our numbering around. */
    expect(nextAgentName(["zsh", "bun", "AI01", "notes"])).toBe("AI02");
    expect(nextAgentName(["AI0", "AI", "AIX1", "ai01"])).toBe("AI01");
  });
});

describe("and tmux is not allowed to change it", () => {
  test("a new window is named and pinned in the same action", async () => {
    /*
     * tmux ships `automatic-rename on`, so a window is called whatever the
     * program inside last set its title to — `node`, then `bun`, then a
     * filename. That is why the strip could not be read: the tabs renamed
     * themselves under the person looking at them. `-n` alone does not survive
     * that; the option is what makes the name stick, and it is set on the
     * WINDOW so nothing anybody else opened is touched.
     */
    const src = await Bun.file(new URL("../src/tmuxctl.ts", import.meta.url)).text();
    const at = src.indexOf('case "new":');
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf('case "kill":', at));
    expect(body).toContain("nextAgentName(");
    expect(body).toContain('"-n", mine');
    expect(body).toContain('"automatic-rename", "off"');
    /* On the window it just made, never on the session. */
    expect(body).toContain('"set-window-option", "-t", born');
  });
});
