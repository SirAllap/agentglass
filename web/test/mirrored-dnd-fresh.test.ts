import { describe, expect, it } from "bun:test";

// A mirrored note's card is drawn only under Desktop DND. DND is re-read on
// focus and visibility, so a shown but unfocused window can hold a stale "on":
// the card would double the desktop's own popup. receiveMirrored asks again
// before it draws.
describe("a mirrored card re-reads Desktop DND when the window lacks focus", () => {
  it("refreshes before the card decision, only when unfocused", async () => {
    const src = await Bun.file(new URL("../src/lib/sysNotify.ts", import.meta.url)).text();
    const at = src.indexOf("export function receiveMirrored(");
    const body = src.slice(at, src.indexOf("\nfunction attach()", at));
    expect(body).toContain("!windowFocused()) void refreshDesktopDnd().then(show)");
    expect(body).toContain("else show();");
  });
});
