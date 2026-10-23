/*
 * `openSettings("clickup")` right after connecting ClickUp landed nowhere new.
 *
 * The ClickUp page is only offered while ClickUp is connected, and an effect
 * sent the modal back to Tools & services whenever `cuConnected` read false.
 * Right after a token is saved that state is still the old false, so the jump
 * was undone in the same commit, before the fresh read could say the page now
 * exists. The decision is taken from the read itself now.
 */
import { describe, expect, it } from "bun:test";
import { paneWhenClickupKnown } from "../src/lib/openSettings.ts";

const modal = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url)).text();
const code = modal.split("\n").filter((l) => !l.trim().startsWith("/*") && !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");

describe("the way off a ClickUp page that is not there", () => {
  it("leaves the page alone when ClickUp is connected, and any other page whatever the answer", () => {
    expect(paneWhenClickupKnown("clickup", true)).toBe("clickup");
    expect(paneWhenClickupKnown("clickup", false)).toBe("connections");
    expect(paneWhenClickupKnown("terminal", false)).toBe("terminal");
  });

  it("is applied to the fresh read, not to the last value held in state", () => {
    expect(code).toContain("setPane((p) => paneWhenClickupKnown(p, c.connected)");
    expect(code).not.toMatch(/cuConnected === false\) setPane/);
  });
});
