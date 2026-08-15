/*
 * A mirrored notification that carries no link is still openable, sometimes.
 *
 * Reported: clicking a Slack message in agentglass does nothing, while clicking
 * the desktop pop-up it was copied from opens Slack at that message. The reason
 * is structural and cannot be fixed here — a notification's default action
 * belongs to the app that posted it, and a bus monitor cannot invoke one — so
 * what is offered instead is the app's own URI scheme, and the button says the
 * app rather than the message.
 */
import { describe, expect, it } from "bun:test";
import { appLinkFor } from "../src/lib/appLink.ts";

describe("which app a notification can be opened in", () => {
  it("knows the messaging apps by name, however they capitalise themselves", () => {
    expect(appLinkFor("Slack")).toBe("Slack");
    expect(appLinkFor("slack")).toBe("Slack");
    // A desktop app names itself variously across versions and packaging.
    expect(appLinkFor("Slack Desktop")).toBe("Slack");
  });

  it("says nothing about an app it cannot open", () => {
    /* The button must not appear where pressing it would do nothing — which is
       the bug being fixed, wearing different clothes. */
    expect(appLinkFor("Thunderbird")).toBeNull();
    expect(appLinkFor("")).toBeNull();
    expect(appLinkFor(null)).toBeNull();
    expect(appLinkFor(undefined)).toBeNull();
  });

  it("never takes a scheme from the notification's own words", () => {
    // This path turns a notification into a launcher. It launches only from a
    // closed table of published schemes, never from text off the bus.
    expect(appLinkFor("x-evil://run-me")).toBeNull();
    expect(appLinkFor("slackish")).toBeNull();
  });
});
