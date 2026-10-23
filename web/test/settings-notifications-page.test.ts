import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url)).text();

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
  test("four cards, in order", () => {
    const at = ["Interrupt me for", "How it reaches you", "Pull requests", "From other apps"].map((t) => notif.indexOf(`<SettingsCard title="${t}"`));
    expect(at.every((n) => n > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  test("Silence all is the header control of the first card", () => {
    const head = notif.slice(notif.indexOf('<SettingsCard title="Interrupt me for"'), notif.indexOf("</SettingsCard>"));
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
    expect(count(notif, "Only when the pull request is approved") + count(notif, "only when the pull request is approved")).toBe(1);
    expect(count(notif, "When somebody says something") + count(notif, "when somebody says something")).toBe(1);
    // Quiet is a setting to find, not a row behind a fold.
    expect(count(notif, "<Fold ")).toBe(0);
  });

  test("Keep Codex usage current moved to budgets", () => {
    expect(count(src, 'label="Keep Codex usage current"')).toBe(1);
    expect(budgetsBody).toContain('label="Keep Codex usage current"');
    expect(notif).not.toContain("Codex");
  });

  test("the three sound gates keep their keys and paths", async () => {
    // The voice picker is the row under the Sound switch.
    expect(notif).toContain("prefs.channels[c]");
    expect(notif).toContain("NOTIFY_VOICES");
    expect(notif).toContain("p.onSound");
    expect(src).toContain("setNotifyVoice(v); setNotifyVoiceState(v)");
    expect(src).toContain("sound={sound} onSound={onSound}");
    expect(await Bun.file(new URL("../src/lib/sysNotify.ts", import.meta.url)).text()).toContain("agentglass.notifyVoice");
  });

  test("the chime toggle sits directly below the Sound row", () => {
    const sound = notif.indexOf("NOTIFY_VOICES");
    const chime = notif.indexOf('label="Chime this session"');
    expect(chime).toBeGreaterThan(sound);
    expect(notif.slice(sound, chime)).not.toContain("<Toggle key=");
  });

  test("the alarm voice is on the reminders row", () => {
    expect(notif).toContain('k === "reminders"');
    expect(notif).toContain("ALARM_VOICES");
  });
});
