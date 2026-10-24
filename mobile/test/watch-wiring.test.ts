/*
 * Where the watch alerts are plugged in. A rule about source is asserted
 * against source (there is no renderer here): the right frames reach the
 * runtime, `ci` stays a doorbell so a watch fire is not announced twice, and a
 * tap both routes and answers the computer.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (...p: string[]): string => readFileSync(join(import.meta.dir, "..", ...p), "utf8");
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the provider", () => {
  const host = strip(src("src", "state", "host-context.tsx"));
  const start = host.indexOf("const onWatchFrame = useCallback(");
  const fn = host.slice(start, host.indexOf("[watch, decorate]);", start));

  test("the four frames reach the runtime, and only those", () => {
    for (const t of ["prwatchfire", "card", "askedalert", "askedclosed"]) expect(fn).toContain(`"${t}"`);
    expect(fn).not.toMatch(/"ci"|"prchecks"|"talk"/);
  });

  test("both the computer in front and the others use it, and both catch up on connect", () => {
    expect(host).toContain("onWatchFrame(host, frame)");
    expect(host).toContain("onWatchFrame(from, frame)");
    expect(host).toContain("watch.catchUp(host, decorate(host))");
    expect(host).toContain("watch.catchUp(from, decorate(from))");
  });

  test("a talk note stays quiet when a comment watch has just said it", () => {
    expect(host).toContain("watch.watchToldRecently(host, note.repo, note.number)");
    expect(host).toContain("watch.noteTalk(host, note.repo, note.number)");
  });

  test("another computer is never counted as the one on screen", () => {
    expect(host).toMatch(/foreground: \(h\) => AppState\.currentState === "active" && h\.id === activeId\.current/);
  });
});

describe("the tap", () => {
  const layout = src("app", "_layout.tsx");
  test("routes through alertRoute and answers the computer's alert", () => {
    expect(layout).toContain("alertRoute(data)");
    expect(layout).toContain("if (answered && landed) void answerWatch(answered, data)");
  });
  test("a tap that only reaches the list does not answer the computer's alert, unless it was the summary", () => {
    expect(layout).toContain('let landed = to?.pathname !== "/prs" ||');
    expect(layout).toContain("summary?: unknown } | null)?.summary === true");
  });
  test("a computer that is gone lands on the pull-request list, not the terminal", () => {
    expect(layout).toContain('{ pathname: "/prs" }');
  });
});

describe("the setting", () => {
  const settings = src("app", "(tabs)", "settings.tsx");
  test("sits in the Notifications group, waits for the computer's answer, and is the computer's to change only with full access", () => {
    const group = settings.slice(settings.indexOf('<GroupTitle text="Notifications" />'), settings.indexOf('<GroupTitle text="Appearance"'));
    expect(group).toContain('title="Alerts on this phone"');
    expect(group).toContain("phoneAlerts === null");
    expect(settings).toContain('host?.scope === "full"');
    // Its own permission and channel, not the agent alerts card's answer.
    expect(settings).toContain("watchAlertsDeliverable().then(setWatchOk)");
    expect(group).toContain("(watchOk.ok && (phoneAlerts === null || !mayChangePhone))");
    // Blocked: the row asks for the permission or opens Android's settings, and is not drawn ON.
    expect(group).toContain("else void turnOn();");
    expect(group).toContain("checked={watchOk?.ok === true && phoneAlerts === true}");
    expect(group).not.toContain("disabled={!alerts?.ok || phoneAlerts");
    expect(settings).toContain("readPhoneAlerts(host)");
    // Read again on focus and on return to the app, so a change made at the desk shows.
    expect(settings).toContain("useFocusEffect(readPhone)");
    expect(settings).toContain('state === "active") readPhone()');
    expect(settings).toContain("setPhoneAlerts(host, on)");
  });
});
