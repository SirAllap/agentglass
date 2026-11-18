/*
 * JIRA FIRST, CLICKUP AS THE READ-ONLY FALLBACK.
 *
 * Two habits, each with a cost when it is wrong:
 *
 *   ordering   A branch cut from an old ClickUp prefix (`LEGACY-123-fix`) with a
 *              Jira key in the title must resolve to the Jira key. Before this,
 *              the branch won and the panel opened the ClickUp card while the
 *              button beside it moved the ClickUp card too.
 *
 *   writing    A ClickUp card reached by a pull request that only ever named a
 *              ClickUp id is READ on a machine whose tracker has moved to Jira.
 *              Moving it is a write to a board the team left, so the controls
 *              are gone until somebody turns them on for that repository.
 *
 * A machine with no Jira is not in any of this: every answer below is the one
 * it always gave.
 */
import { describe, expect, it } from "bun:test";
import { cardRef } from "../src/lib/cardRef.ts";
import { trackerFor } from "../src/lib/trackerApi.ts";
import { CLICKUP_READ_ONLY, clickupReadOnly } from "../src/lib/cardWrites.ts";
import { clickupWritesOn } from "../src/lib/trackerView.ts";
import type { TrackerSetup } from "../src/lib/trackerSetup.ts";

const reach = (...keys: string[]) => ({ keys, site: "acme.atlassian.net" });
const jira = (...prefixes: string[]): TrackerSetup["jira"] => ({ connected: true, prefixes, site: "acme.atlassian.net" });
const cu = (prefix?: string): TrackerSetup["clickup"] => ({ connected: true, prefix });

describe("a Jira key beats a ClickUp-shaped id from another field", () => {
  it("the title's key wins over the branch's ClickUp prefix", () => {
    const ref = cardRef({ headRefName: "LEGACY-123-fix-retry", title: "[ORBIT-1042] Retry the webhook" }, reach("ORBIT"));
    expect(ref).toMatchObject({ label: "ORBIT-1042", from: "title", tracker: null });
  });

  it("is the branch alone again when no Jira site is connected", () => {
    const ref = cardRef({ headRefName: "LEGACY-123-fix-retry", title: "[ORBIT-1042] Retry the webhook" });
    expect(ref).toMatchObject({ label: "LEGACY-123", from: "branch" });
  });

  it("the title's key wins over ClickUp's own CU- id in the branch", () => {
    const ref = cardRef({ headRefName: "CU-86abc123_retry", title: "ORBIT-7 fix the export" }, reach("ORBIT"));
    expect(ref).toMatchObject({ label: "ORBIT-7", from: "title", tracker: null });
  });

  it("a key in the branch still beats a key in the title, and reads lower case", () => {
    const ref = cardRef({ headRefName: "fix/orbit-7-retry", title: "ORBIT-1042 the sequel" }, reach("ORBIT"));
    expect(ref).toMatchObject({ label: "ORBIT-7", from: "branch" });
  });

  it("a prefix no Jira project claims is still the branch's id", () => {
    const ref = cardRef({ headRefName: "LEGACY-123-fix", title: "Retry the webhook" }, reach("ORBIT"));
    expect(ref).toMatchObject({ label: "LEGACY-123", from: "branch" });
  });
});

describe("a Jira key beats a ClickUp address in the body", () => {
  const pr = {
    headRefName: "fix/retry-the-webhook",
    title: "[ORBIT-1042] Retry the webhook",
    body: "The card this came from: https://app.clickup.com/t/86abc123",
  };

  it("is the key, and the address it beat is kept as a secondary link", () => {
    const ref = cardRef(pr, reach("ORBIT"))!;
    expect(ref).toMatchObject({ label: "ORBIT-1042", query: "ORBIT-1042", from: "title", tracker: null });
    expect(ref.also).toEqual({
      label: "86abc123", query: "86abc123", tracker: "clickup",
      url: "https://app.clickup.com/t/86abc123",
    });
  });

  it("and the owner is Jira, not the ClickUp card the address named", () => {
    const ref = cardRef(pr, reach("ORBIT"))!;
    expect(trackerFor(ref, { clickup: cu("ORBIT-"), jira: jira("ORBIT") }, "auto")?.id).toBe("jira");
  });

  it("a machine with no Jira site still reads the address, as it always did", () => {
    const ref = cardRef(pr)!;
    expect(ref).toMatchObject({ label: "ORBIT-1042", query: "86abc123", from: "url", tracker: "clickup" });
    expect(ref.also).toBeUndefined();
  });

  it("an id from another field does not beat the address that was pasted", () => {
    const ref = cardRef({ headRefName: "LEGACY-123-fix", title: "Retry the webhook", body: pr.body }, reach("ORBIT"))!;
    expect(ref).toMatchObject({ query: "86abc123", from: "url", tracker: "clickup" });
  });
});

describe("an id both trackers claim is Jira's in auto", () => {
  const ref = cardRef({ headRefName: "feat/ORBIT-1042-x" })!;
  const claimed = { clickup: cu("ORBIT-"), jira: jira("ORBIT", "ACME") };

  it("auto gives it to Jira, which listed the key itself", () => {
    expect(trackerFor(ref, claimed, "auto")?.id).toBe("jira");
  });

  it("a repository pinned to ClickUp keeps it", () => {
    expect(trackerFor(ref, claimed, "clickup")?.id).toBe("clickup");
  });

  it("one claimant is still decided by the prefix", () => {
    expect(trackerFor(ref, { clickup: cu("ORBIT-"), jira: jira("ACME") }, "auto")?.id).toBe("clickup");
    expect(trackerFor(ref, { clickup: cu("ACME-"), jira: jira("ORBIT") }, "auto")?.id).toBe("jira");
    expect(trackerFor(ref, { clickup: cu("ACME-"), jira: jira("PLAT") }, "auto")).toBeNull();
  });

  it("ClickUp's own id stays ClickUp's, whatever the pin says", () => {
    const native = cardRef({ headRefName: "CU-86abc123_fix" })!;
    expect(trackerFor(native, claimed, "jira")?.id).toBe("clickup");
  });
});

describe("a ClickUp card is read-only while Jira is the tracker", () => {
  it("is read-only in auto and under a Jira pin, and says so", () => {
    expect(clickupReadOnly({ jiraConnected: true, choice: "auto" })).toBe(CLICKUP_READ_ONLY);
    expect(clickupReadOnly({ jiraConnected: true, choice: "jira" })).toBe(CLICKUP_READ_ONLY);
  });

  it("writes again once the repository's switch is on", () => {
    expect(clickupReadOnly({ jiraConnected: true, choice: "auto", writesOn: true })).toBeNull();
  });

  it("a repository pinned to ClickUp needs no switch", () => {
    expect(clickupReadOnly({ jiraConnected: true, choice: "clickup" })).toBeNull();
  });

  it("a machine with no Jira has no fallback to be read-only about", () => {
    for (const choice of ["auto", "clickup", "jira"] as const) {
      expect(clickupReadOnly({ jiraConnected: false, choice })).toBeNull();
    }
  });

  it("the switch is per repository, lower-cased, and off when unset", () => {
    const on = { "acme/orbit": true as const };
    expect(clickupWritesOn(on, "Acme/Orbit")).toBe(true);
    expect(clickupWritesOn(on, "acme/other")).toBe(false);
    expect(clickupWritesOn(on, undefined)).toBe(false);
    expect(clickupWritesOn({}, "acme/orbit")).toBe(false);
  });
});

describe("a pull request re-pointed at another card after its branch was cut", () => {
  // A head branch cannot be renamed without closing the pull request, so the
  // title and the Card reference are where a re-pointed card is written.
  const pr = { headRefName: "ORBIT-882-cache-to-json", title: "[ORBIT-1042] - Cache to JSON", body: "## Card reference\nORBIT-1042\n\n## Notes\nfollow-up of ORBIT-882" };
  it("names the key that opens the title, not the branch's", () => {
    expect(cardRef(pr, reach("ORBIT"))).toMatchObject({ label: "ORBIT-1042", from: "title" });
  });
  it("names the Card reference key over the branch's when the title has none up front", () => {
    expect(cardRef({ ...pr, title: "Cache to JSON" }, reach("ORBIT"))).toMatchObject({ label: "ORBIT-1042", from: "body" });
  });
  it("still reads the branch when nothing else names a key", () => {
    expect(cardRef({ headRefName: pr.headRefName, title: "Cache to JSON" }, reach("ORBIT"))).toMatchObject({ label: "ORBIT-882", from: "branch" });
  });
  it("a key later in the title does not beat the branch", () => {
    expect(cardRef({ headRefName: pr.headRefName, title: "Cache to JSON, after ORBIT-1042" }, reach("ORBIT"))?.label).toBe("ORBIT-882");
  });
});
