import { describe, expect, test } from "bun:test";
import { modalSource, pagesSource } from "./settingsSource.ts";

const src = modalSource();

// Slice a top-level function by its own closing brace, never a fixed window.
function fn(name: string): string {
  const a = src.indexOf(`function ${name}(`);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf("\n}\n", a);
  return src.slice(a, b + 3);
}
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
const count = (s: string, needle: string) => s.split(needle).length - 1;

const notif = code(fn("NotificationsSection"));
// The modal body between the budgets and browser page markers.
const budgetsBody = src.slice(src.indexOf('show("budgets") && ('), src.indexOf('show("notifications") && ('));

describe("notifications page, rebuilt", () => {
  test("cards, in order", () => {
    const at = ["How it reaches you", "Sound and voice", "Interrupt me for", "From other apps"].map((t) => notif.indexOf(`<SettingsCard title="${t}"`));
    expect(at.every((n) => n > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  test("Silence all is the header control of the first card", () => {
    const head = notif.slice(notif.indexOf('<SettingsCard title="How it reaches you"'), notif.indexOf("</SettingsCard>"));
    expect(head).toContain("actions={");
    expect(head).toContain('label="Silence all"');
    expect(head).toContain("none: !prefs.none");
  });

  test("each control is present exactly once", () => {
    for (const l of [
      'label="Silence all"', 'settingId="notifications.volume"', 'label="Chime this session"',
      'label="Mirror this machine\'s notifications"',
      'label="How much of the message"',
    ]) expect(count(notif, l)).toBe(1);
    // The pull request rows moved to the Git page (lot 4): none here, one there.
    expect(count(notif, "Checks fail")).toBe(0);
    expect(count(notif, "Conversation")).toBe(0);
    // The Git & PRs page draws them from its row table (GIT_ROWS): one row each.
    expect(count(pagesSource(), 'row("notifications.ciOnlyApproved")')).toBe(1);
    expect(count(pagesSource(), 'row("notifications.talk")')).toBe(1);
    // Quiet is a setting to find, not a row behind a fold.
    expect(count(notif, "<Fold ")).toBe(0);
  });

  test("Check Codex usage in the background moved to budgets", () => {
    // It lives on the Engines & usage page now (budgets folds into it).
    expect(count(pagesSource(), '<SettingRow kind="control" label="Check Codex usage in the background"')).toBe(1);
    expect(notif).not.toContain("Codex");
  });

  test("the three sound gates keep their keys and paths", async () => {
    // The voice picker is the row under the Sound switch.
    expect(notif).toContain("prefs.channels[c]");
    expect(notif).toContain("NOTIFY_VOICES");
    expect(notif).toContain("p.onSound");
    expect(pagesSource()).toContain("setNotifyVoice(x); setNotifyVoiceState(x)");
    expect(pagesSource()).toContain("onSound");
    expect(await Bun.file(new URL("../src/lib/sysNotify.ts", import.meta.url)).text()).toContain("agentglass.notifyVoice");
  });

  test("the chime toggle sits directly below the Sound row", () => {
    const sound = notif.indexOf("NOTIFY_VOICES");
    const chime = notif.indexOf('label="Chime this session"');
    expect(chime).toBeGreaterThan(sound);
    expect(notif.slice(sound, chime)).not.toContain("<Toggle key=");
  });

  test("the alarm voice sits with the other voices, under Sound and voice", () => {
    const sv = notif.slice(notif.indexOf('<SettingsCard title="Sound and voice"'), notif.indexOf('<SettingsCard title="Interrupt me for"'));
    expect(sv).toContain('label="Alarm voice"');
    expect(notif).toContain("ALARM_VOICES");
  });
});
