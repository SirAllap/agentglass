/*
 * `open --as <name> --show <url>` answered with the person's own tab: the list
 * folded into the mint reply still marked the tab in front as active, and it
 * carried every container's tabs. The answer must name the tab it made.
 */
import { describe, expect, test } from "bun:test";
import { openedReply, type TabRow } from "../../shared/browserTabReplies.ts";

const PERSON: TabRow = { id: "t1-person", title: "Your Repositories", url: "https://git.example/me?tab=repositories", active: true, profile: "default" };
const MADE: TabRow = { id: "t5-new", title: "Sign in", url: "https://git.example/settings/profile", active: false, profile: "vault-test" };

describe("openedReply", () => {
  test("names the tab it opened, not the one in front", () => {
    const v = openedReply({ id: MADE.id }, [PERSON, MADE]).value;
    expect({ id: v.id, url: v.url, title: v.title, profile: v.profile })
      .toEqual({ id: MADE.id, url: MADE.url, title: MADE.title, profile: "vault-test" });
  });

  test("lists only the made tab's container, never another identity's tabs", () => {
    const v = openedReply({ id: MADE.id }, [PERSON, MADE]).value;
    expect(v.tabs.map((t) => t.id)).toEqual([MADE.id]);
    expect(JSON.stringify(v)).not.toContain("Your Repositories");
  });

  test("the person's own container keeps its own tabs", () => {
    const fresh: TabRow = { id: "t6-mine", title: "", url: "https://x.example/", active: false };
    const v = openedReply({ id: fresh.id }, [PERSON, MADE, fresh]).value;
    expect(v.tabs.map((t) => t.id)).toEqual([PERSON.id, fresh.id]);
    expect(v.url).toBe(fresh.url);
  });

  test("a made id missing from the list lists nothing", () => {
    expect(openedReply({ id: "t9-gone" }, [PERSON]).value).toEqual({ id: "t9-gone", tabs: [] });
  });
});
