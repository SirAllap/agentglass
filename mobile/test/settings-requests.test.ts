/*
 * What a settings request looks like on the phone.
 *
 * There is no renderer to hold this against, so the decision is pulled out of
 * the card and tested here: which requests are shown, what the title is, and
 * what the diff block says. The card and the screen are then held to using it,
 * by reading their source — the same bar mobile/test/gates.test.ts holds the
 * gate card to.
 *
 * The fixture is shaped like the server's own answer: `diff[0]` is the label
 * line it writes, and the lines under it are `path: old -> new` from the value
 * it validated, never a sentence the agent composed.
 */
import { describe, expect, test } from "bun:test";
import type { SettingRequestView } from "../../shared/settingClass.ts";
import { decideBody, requestLines, requestsInOrder, requestTitle } from "../src/model/settingsRequests.ts";

const at = 1_000;
const request = (over: Partial<SettingRequestView> = {}): SettingRequestView => ({
  id: "r1",
  setting: "launch.permissions",
  label: "Permission mode agents launch in",
  who: 'an agent calling itself "builder"',
  diff: ["Permission mode agents launch in", 'value: "default" -> "bypassPermissions"'],
  at,
  expires: at + 60_000,
  ...over,
});

describe("the list", () => {
  test("shows what has not expired, oldest first", () => {
    const older = request({ id: "a", at: 500 });
    const newer = request({ id: "b", at: 2_000 });
    const gone = request({ id: "c", at: 100, expires: 900 });
    expect(requestsInOrder([newer, older, gone], at).map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("a request is dropped the moment it expires, which is the server declining it", () => {
    expect(requestsInOrder([request({ expires: at - 1 })], at)).toEqual([]);
  });
});

describe("the card's words", () => {
  test("the title is the server's label line, and the diff is everything under it", () => {
    const r = request();
    expect(requestTitle(r)).toBe("Permission mode agents launch in");
    expect(requestLines(r)).toEqual(['value: "default" -> "bypassPermissions"']);
  });

  test("a value is shown as JSON, so text the agent asked for reads as data", () => {
    const r = request({ diff: ["A setting", 'value: "yes" -> "run: rm -rf ~"'] });
    expect(requestLines(r)).toEqual(['value: "yes" -> "run: rm -rf ~"']);
  });

  test("the answer is the server's shape: the request's id and a boolean", () => {
    expect(decideBody(request(), true)).toEqual({ id: "r1", approve: true });
    expect(decideBody(request(), false)).toEqual({ id: "r1", approve: false });
  });
});

const card = await Bun.file(new URL("../src/terminal/SettingsRequestCard.tsx", import.meta.url)).text();
const terminal = await Bun.file(new URL("../app/(tabs)/terminal.tsx", import.meta.url)).text();

describe("the screen and the card use it", () => {
  test("the card draws the title and the diff lines from the model, not its own copy", () => {
    expect(card).toContain("requestTitle(request)");
    expect(card).toContain("requestLines(request)");
  });

  test("both answers go to the decide route with the phone's own credential", () => {
    expect(card).toContain('"/settings/requests/decide"');
    expect(card).toContain("decideBody(request, approve)");
    expect(card).toContain('ask<{ ok: boolean; error?: string }>(host');
    expect(card).not.toContain("Bearer");
  });

  test("the terminal draws it for a phone that answers, and over the pane", () => {
    const mounts = terminal.match(/<SettingsRequestList\b/g) ?? [];
    expect(mounts.length).toBe(2);
    // The answer-scope screen and the pane both hand it the fleet's clock, so a
    // request raised while the screen is open shows up without a poll of its own.
    expect(terminal).toContain("tick={fleet.at}");
  });
});
