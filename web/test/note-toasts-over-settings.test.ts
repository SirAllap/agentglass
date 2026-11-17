/*
 * A notification card that pops up while Settings is open.
 *
 * The reported bug: Volume = Normal, the bell's Quiet off, `notify-send -a test
 * "Test" "body"` with Settings ▸ Notifications open. The note landed in the bell
 * list and no card was seen.
 *
 * The delivery decision was right — with those switches the note interrupts
 * (first test). The card was then drawn in a portal at 10040, under the
 * full-window Settings page at LAYER.settings (10120), which paints an opaque
 * background over everything below it. The card sat behind the page for its
 * seven seconds and left. Same for the Flow editor and the catalog.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { LAYER } from "../src/lib/layers.ts";
import { deliveryFor } from "../src/lib/notePolicy.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("a desktop note with Volume = Normal", () => {
  it("is allowed to interrupt: the policy is not what dropped it", () => {
    // Volume Normal writes agentglass.sysNotify.quiet = "0" and
    // agentglass.appNotify = "0"; only `quiet` reaches a mirrored note.
    const note = { app: "test", source: "desktop:test", urgency: 1 as const };
    expect(deliveryFor(note, { muted: new Set(), quiet: false })).toEqual({ keep: true, badge: true, interrupt: true });
  });
});

describe("where the card is drawn", () => {
  it("is above every full-window sheet it can pop up over", () => {
    for (const sheet of ["settings", "flowEditor", "catalog"] as const) {
      expect(LAYER.noteToasts, `card under ${sheet}`).toBeGreaterThan(LAYER[sheet]);
      expect(LAYER.askedBanners, `asked banner under ${sheet}`).toBeGreaterThan(LAYER[sheet]);
    }
  });

  it("stays under the bell panel, the menus and the dialogs raised from Settings", () => {
    expect(LAYER.notesPanel).toBeGreaterThan(LAYER.noteToasts);
    expect(LAYER.notesPanel).toBeGreaterThan(LAYER.askedBanners);
    expect(LAYER.settingsDialog).toBeGreaterThan(LAYER.notesPanel);
    expect(LAYER.menu).toBeGreaterThan(LAYER.noteToasts);
  });

  it("stays under the usage popover, which opens in the same corner", () => {
    expect(LAYER.usage).toBeGreaterThan(LAYER.noteToasts);
    expect(LAYER.usage).toBeGreaterThan(LAYER.askedBanners);
    expect(LAYER.settingsDialog).toBeGreaterThan(LAYER.usage);
  });

  it("stays under the waiting-on-you panel, raised from the same title bar", () => {
    expect(LAYER.needs).toBeGreaterThan(LAYER.noteToasts);
    expect(LAYER.needs).toBeGreaterThan(LAYER.askedBanners);
    expect(LAYER.settingsDialog).toBeGreaterThan(LAYER.needs);
  });

  it("is the layer the components use", () => {
    expect(read("../src/components/NoteToasts.tsx")).toMatch(/<Portal[^>]*\bz=\{LAYER\.noteToasts\}/);
    expect(read("../src/components/AskedBanners.tsx")).toMatch(/<Portal[^>]*\bz=\{LAYER\.askedBanners\}/);
    expect(read("../src/components/TopBarNotes.tsx")).toMatch(/<Portal[^>]*\bz=\{LAYER\.notesPanel\}/);
  });
});
