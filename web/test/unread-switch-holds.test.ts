/*
 * The "N unread" chip on the board did nothing: a panel effect cleared the
 * switch the moment it was set, because it counted unread in the table's pool
 * while the board was drawing its own queues. The board's chip said 3 unread
 * for acme/orbit #1042 and two more, the table pool held none of them.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { unreadSwitchHolds } from "../src/lib/prUnread.ts";

const PANEL = readFileSync(new URL("../src/components/PrPanel.tsx", import.meta.url), "utf8");

describe("unreadSwitchHolds", () => {
  it("stays on while the surface in front has unread cards", () => expect(unreadSwitchHolds(true, 3)).toBe(true));
  it("lets go on an empty surface", () => expect(unreadSwitchHolds(true, 0)).toBe(false));
  it("is never switched on by itself", () => expect(unreadSwitchHolds(false, 3)).toBe(false));
});

describe("PrPanel counts the surface in front", () => {
  it("on the board, the count is the board's, not the table pool's", () => {
    const code = PANEL.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).toMatch(/unreadInFront\s*=\s*boardShown\s*\?\s*boardUnreadCount\s*:\s*unreadPrs\.length/);
    expect(code).not.toMatch(/unreadSwitchHolds\(unreadOnly,\s*unreadPrs\.length\)/);
  });
});
