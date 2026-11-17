/*
 * Settings names only the services this machine uses.
 *
 * A user who never connected a tracker was told, on the privacy page, that the
 * app talks to it, and offered a "note on the card" prompt to edit for a card
 * they cannot have. Both read as the app assuming one workflow. Pinned off the
 * source because neither page has a renderer to mount it in.
 */
import { describe, expect, it } from "bun:test";

const settings = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url)).text();
const pane = await Bun.file(new URL("../src/components/ReviewPromptsPane.tsx", import.meta.url)).text();

describe("what Settings says follows what is connected", () => {
  it("the privacy page names ClickUp only when a token is saved", () => {
    expect(settings).toContain('{d?.clickup ? "ClickUp through its API, " : ""}');
    expect(settings).not.toContain("GitHub through <code>gh</code>, ClickUp through its API");
  });

  it("the note-on-card prompt is listed only where ClickUp is connected", () => {
    expect(pane).toContain('hasCards || r.id !== "note-on-card"');
    // Both the rows and the 'everything hidden' count go through it.
    expect(pane).toContain("offered(r) && (kind ===");
    expect(pane).toContain("hiddenList.filter((r) => offered(r) && matches(r)");
    expect(pane).toContain("list.filter(offered).length");
    // A list the page draws without offered() would show the hidden prompt: no bare `list.map(`, and `offered` is used in exactly the six places that count or list.
    expect(pane).not.toMatch(/\b(?:list|hiddenList)\.map\(/);
    expect((pane.match(/\boffered\(|filter\(offered\)/g) ?? []).length).toBe(6);
  });
});
