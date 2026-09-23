/*
 * Every client-side push surface asks the diet before it does anything —
 * asserted against the SOURCE, the way board-keeps-its-own.test.ts and its
 * neighbours already pin a rule about wiring rather than about rendering:
 * there is no renderer in this project (CLAUDE.md), so a rule about source is
 * asserted against source. Four surfaces, four channels:
 *
 *   fireDesktopAlert (sysNotify.ts)   desktop popup, and the bell record
 *   useAlertSound's trigger (App.tsx) sound
 *   needs / needsList (App.tsx)       chip (the title-bar strip and its popover)
 *
 * Each assertion below was run once against a deliberately un-gated version
 * of its line and confirmed to fail — see agx-needsyou-diet-build.md for
 * which ones and how.
 */
import { describe, expect, test } from "bun:test";

const sysNotify = await Bun.file(new URL("../src/lib/sysNotify.ts", import.meta.url)).text();
const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
const gates = await Bun.file(new URL("../src/lib/gateStore.ts", import.meta.url)).text();

describe("fireDesktopAlert gates both the popup and the bell record", () => {
  test("the bell record only runs behind notifies(prefs, kind, \"bell\")", () => {
    expect(sysNotify).toContain('if (notifies(prefs, kind, "bell")) {');
  });
  test("the popup is refused before touching the Notification API when the desktop channel is off", () => {
    expect(sysNotify).toContain('if (!notifies(prefs, kind, "desktop")) return;');
  });
});

describe("App.tsx's chip and sound surfaces filter by the diet before they ever see an alert", () => {
  test("the alerts feeding the chip (needs / needsList) are filtered on the chip channel", () => {
    expect(app).toContain('notifies(notifyPrefs, alertKind(al, agents.find((a) => a.key === al.agent)), "chip")');
    expect(app).toContain("const needs = useMemo(() => {\n    if (!notifyingAlerts.length) return null;");
  });
  test("the chime's own trigger count is the sound-filtered list, not the raw alert count", () => {
    expect(app).toContain("useAlertSound(soundAlerts.length, sound);");
    expect(app).toContain('notifies(notifyPrefs, alertKind(al, agents.find((a) => a.key === al.agent)), "sound")');
  });
  test("a new gate hold is only announced (bell row, arrival toast) behind the blocked kind", () => {
    const start = gates.indexOf("function announce(");
    const body = gates.slice(start, gates.indexOf("\n}\n", start));
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('if (!notifies(getNotifyPrefs(), "blocked", "bell")) return;');
  });
});
