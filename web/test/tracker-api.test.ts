/*
 * Whose card is `ORBIT-1042`, once there are two trackers to ask.
 *
 * What a mistake costs: a chip that opens the wrong tracker (and is believed),
 * a lookup that says "no such card" for a card that exists next door, or a
 * merge form offering to move a card in a tracker it cannot write to. The one
 * promise the whole file leans on is the first block: with only ClickUp, the
 * answer is exactly what `looksLikeOurs` always said.
 */
import { describe, expect, it } from "bun:test";
import { cardRef, chipAction, looksLikeOurs, type CardRef } from "../src/lib/cardRef.ts";
import { mergeCardRef } from "../src/lib/cardMove.ts";
import { TRACKERS, looksLikeIdFor, trackerFor } from "../src/lib/trackerApi.ts";
import { choiceFor, ownerSetup } from "../src/lib/trackerView.ts";
import type { TrackerSetup } from "../src/lib/trackerSetup.ts";
import { looksLikeCardId } from "../../shared/cardRef.ts";

const cu = (prefix?: string): TrackerSetup["clickup"] => ({ connected: true, prefix });
const reach = (...keys: string[]) => ({ keys, site: "acme.atlassian.net" });
const jira = (...prefixes: string[]): TrackerSetup["jira"] => ({ connected: true, prefixes, site: "acme.atlassian.net" });
const ref = (pr: { headRefName?: string; title?: string; body?: string }): CardRef => cardRef(pr)!;
const branch = (b: string) => ref({ headRefName: b });
const JIRA_URL = ref({ headRefName: "fix/thing", body: "https://acme.atlassian.net/browse/ORBIT-1042" });
const CU_URL = ref({ headRefName: "fix/thing", body: "https://app.clickup.com/t/86abc123" });
const CU_NATIVE = branch("CU-86abc123_fix");

describe("a machine with only ClickUp answers as it always did", () => {
  // Every shape of reference the old rule saw, against every prefix state.
  const refs = [branch("feat/ORBIT-1042-x"), branch("feat/ABC-12-x"), JIRA_URL, CU_URL, CU_NATIVE, ref({ title: "ORBIT-77 fix" })];
  const prefixes = [undefined, "ORBIT-", "ORBIT", "ACME-"];
  it("is looksLikeOurs, for every reference and every way of asking", () => {
    for (const r of refs) for (const p of prefixes) for (const whenUnknown of [true, false]) for (const noCustomIds of [false, true]) {
      const got = trackerFor(r, { clickup: cu(p) }, "auto", { whenUnknown, noCustomIds })?.id === "clickup";
      expect(got, `${r.label} ${p} ${whenUnknown} ${noCustomIds}`).toBe(looksLikeOurs(r, p, whenUnknown, noCustomIds));
    }
  });
  it("ignores a stored choice for a tracker that is not connected", () => {
    for (const r of refs) {
      expect(trackerFor(r, { clickup: cu("ORBIT-") }, "jira")?.id).toBe(trackerFor(r, { clickup: cu("ORBIT-") }, "auto")?.id);
    }
  });
  it("owns nothing when nothing is connected", () => {
    expect(trackerFor(branch("feat/ORBIT-1042-x"), {})).toBeNull();
    expect(trackerFor(JIRA_URL, {})).toBeNull();
  });
});

describe("an address names its tracker", () => {
  it("a Jira address with Jira connected is Jira's", () => {
    expect(trackerFor(JIRA_URL, { jira: jira("ORBIT") })?.id).toBe("jira");
    expect(trackerFor(JIRA_URL, { clickup: cu("ORBIT-"), jira: jira("ORBIT") })?.id).toBe("jira");
  });
  it("a Jira address with only ClickUp is nobody's", () => {
    expect(trackerFor(JIRA_URL, { clickup: cu("ORBIT-") })).toBeNull();
  });
  it("a ClickUp address or CU- id is ClickUp's, and with only Jira nobody's", () => {
    for (const r of [CU_URL, CU_NATIVE]) {
      expect(trackerFor(r, { clickup: cu(), jira: jira("ORBIT") })?.id).toBe("clickup");
      expect(trackerFor(r, { jira: jira("ORBIT") })).toBeNull();
    }
  });
  it("beats the repository's choice", () => {
    expect(trackerFor(JIRA_URL, { clickup: cu("ORBIT-"), jira: jira("ORBIT") }, "clickup")?.id).toBe("jira");
    expect(trackerFor(CU_URL, { clickup: cu(), jira: jira("ORBIT") }, "jira")?.id).toBe("clickup");
  });
  it("another tracker's address (not ClickUp, not Jira) is nobody's here", () => {
    const linear = ref({ headRefName: "x", body: "https://linear.app/acme/issue/ORBIT-1042" });
    expect(trackerFor(linear, { clickup: cu("ORBIT-"), jira: jira("ORBIT") })).toBeNull();
  });
});

describe("a bare id is settled by prefix when both are connected", () => {
  const r = branch("feat/ORBIT-1042-x");
  it("a prefix only Jira has is Jira's", () => {
    expect(trackerFor(r, { clickup: cu("ACME-"), jira: jira("ORBIT") })?.id).toBe("jira");
  });
  it("a prefix only ClickUp has is ClickUp's", () => {
    expect(trackerFor(r, { clickup: cu("ORBIT-"), jira: jira("ACME") })?.id).toBe("clickup");
  });
  it("a prefix both claim is nobody's", () => {
    expect(trackerFor(r, { clickup: cu("ORBIT-"), jira: jira("ORBIT", "ACME") })).toBeNull();
  });
  it("a prefix neither claims is nobody's", () => {
    expect(trackerFor(r, { clickup: cu("ACME-"), jira: jira("PLAT") })).toBeNull();
  });
  it("an unread ClickUp prefix is no longer yes once Jira is connected", () => {
    // Alone, whenUnknown=true says yes (the chip must not come and go)...
    expect(trackerFor(r, { clickup: cu() })?.id).toBe("clickup");
    // ...beside Jira that yes would be said for Jira's ids too.
    expect(trackerFor(r, { clickup: cu(), jira: jira("PLAT") })).toBeNull();
    expect(trackerFor(r, { clickup: cu(), jira: jira("ORBIT") })?.id).toBe("jira");
  });
  it("with only Jira, its keys decide; a site that reported none follows whenUnknown", () => {
    expect(trackerFor(r, { jira: jira("ORBIT") })?.id).toBe("jira");
    expect(trackerFor(r, { jira: jira("PLAT") })).toBeNull();
    expect(trackerFor(r, { jira: jira() })?.id).toBe("jira");
    expect(trackerFor(r, { jira: jira() }, "auto", { whenUnknown: false })).toBeNull();
  });
  it("prefixes compare whole, so ORBITAL is not ORBIT", () => {
    expect(trackerFor(branch("feat/ORBITAL-1042-x"), { jira: jira("ORBIT") })).toBeNull();
    expect(trackerFor(branch("feat/ORB-1042-x"), { jira: jira("ORBIT") })).toBeNull();
  });
});

describe("the repository's choice settles what the prefix cannot", () => {
  const r = branch("feat/ORBIT-1042-x");
  const both = { clickup: cu("ORBIT-"), jira: jira("ORBIT") };
  it("jira resolves the id the prefix gave to both, and clickup the other way", () => {
    expect(trackerFor(r, both, "jira")?.id).toBe("jira");
    expect(trackerFor(r, both, "clickup")?.id).toBe("clickup");
    expect(trackerFor(r, both, "auto")).toBeNull();
  });
  it("applies even when the prefix names the other one", () => {
    expect(trackerFor(r, { clickup: cu("ACME-"), jira: jira("ORBIT") }, "clickup")?.id).toBe("clickup");
    expect(trackerFor(r, { clickup: cu("ORBIT-"), jira: jira("PLAT") }, "jira")?.id).toBe("jira");
  });
  it("is read per repository, lower-cased, auto when unset", () => {
    expect(choiceFor({ "acme/orbit": "jira" }, "Acme/Orbit")).toBe("jira");
    expect(choiceFor({ "acme/orbit": "jira" }, "acme/other")).toBe("auto");
    expect(choiceFor({ "acme/orbit": "jira" }, undefined)).toBe("auto");
  });
});

describe("how a card id is spelled depends on whose it is", () => {
  it("ORBIT-7 is a card id for Jira and not for ClickUp", () => {
    expect(looksLikeIdFor(TRACKERS.jira, "ORBIT-7")).toBe(true);
    expect(looksLikeIdFor(TRACKERS.clickup, "ORBIT-7")).toBe(false);
    expect(looksLikeIdFor(TRACKERS.clickup, "ORBIT-1042")).toBe(true);
  });
  it("the default floor is still three", () => {
    expect(looksLikeCardId("ORBIT-42")).toBe(false);
    expect(looksLikeCardId("ORBIT-42", { minDigits: 1 })).toBe(true);
  });
  it("beside Jira, ClickUp does not claim an id under its own floor", () => {
    const r = ref({ title: "ORBIT-42 fix" });
    expect(trackerFor(r, { clickup: cu("ORBIT-"), jira: jira("ACME") })).toBeNull();
    expect(trackerFor(r, { clickup: cu("ORBIT-") })?.id).toBe("clickup");
  });
});

describe("the chip and the merge form follow the owner", () => {
  const r = branch("feat/ORBIT-1042-x");
  const pr = { headRefName: "feat/ORBIT-1042-x", title: "x", body: "" };
  const view = (setup: TrackerSetup, choice: "auto" | "clickup" | "jira" = "auto") => ({ setup, choice });
  const withOwner = <S extends { connected: boolean; prefix?: string; jira?: ReturnType<typeof reach> }>(s: S, owner: "clickup" | "jira" | null, jiraSite?: string) =>
    ({ ...s, ownerOf: () => ({ owner, jiraSite }) });

  it("without Jira the setup is handed back untouched, the same object", () => {
    const s = { connected: true, prefix: "ORBIT-" };
    expect(ownerSetup(s, null)).toBe(s);
    expect(ownerSetup(null, null)).toBeNull();
    expect(ownerSetup(null, view({ jira: jira("ORBIT") }))).toBeNull();
  });
  it("without ownerOf the chip is the one it always was", () => {
    for (const setup of [{ connected: true }, { connected: false }, { connected: true, prefix: "ACME-" }, null]) {
      expect(chipAction(r, setup)).toEqual(chipAction(r, setup ? { ...setup } : null));
    }
    expect(chipAction(r, { connected: true })).toEqual({ in: "tasks" });
    expect(chipAction(r, { connected: true, prefix: "ACME-" })).toBeNull();
  });
  it("a Jira card opens on its site, by address when it has one", () => {
    expect(chipAction(r, withOwner({ connected: true }, "jira", "acme.atlassian.net")))
      .toEqual({ in: "away", url: "https://acme.atlassian.net/browse/ORBIT-1042" });
    expect(chipAction(JIRA_URL, withOwner({ connected: false }, "jira")))
      .toEqual({ in: "away", url: "https://acme.atlassian.net/browse/ORBIT-1042" });
    expect(chipAction(r, withOwner({ connected: true }, "jira"))).toBeNull();
  });
  it("a Jira card opens in the Jira tab once a Jira site is connected, and on its site otherwise", () => {
    expect(chipAction(r, withOwner({ connected: false, jira: reach("ORBIT") }, "jira", "acme.atlassian.net")))
      .toEqual({ in: "tasks", tracker: "jira" });
    expect(chipAction(JIRA_URL, withOwner({ connected: true, jira: reach("ORBIT") }, "jira")))
      .toEqual({ in: "tasks", tracker: "jira" });
    expect(chipAction(r, withOwner({ connected: true }, "jira", "acme.atlassian.net")))
      .toEqual({ in: "away", url: "https://acme.atlassian.net/browse/ORBIT-1042" });
  });
  it("a ClickUp card opens in the board, and only with a token", () => {
    expect(chipAction(r, withOwner({ connected: true }, "clickup"))).toEqual({ in: "tasks" });
    expect(chipAction(r, withOwner({ connected: false }, "clickup"))).toBeNull();
  });
  it("nobody's card gets a chip only when it carries an address", () => {
    expect(chipAction(r, withOwner({ connected: true }, null))).toBeNull();
    expect(chipAction(CU_URL, withOwner({ connected: false }, null))).toEqual({ in: "away", url: "https://app.clickup.com/t/86abc123" });
  });
  it("the merge form moves ClickUp's card, hands over Jira's with its tracker, and offers nothing for nobody's", () => {
    const setup = { connected: true, prefix: "ORBIT-" };
    expect(mergeCardRef(pr, withOwner(setup, "clickup"))?.label).toBe("ORBIT-1042");
    expect(mergeCardRef(pr, withOwner(setup, "jira"))).toEqual({ label: "ORBIT-1042", query: "ORBIT-1042", tracker: "jira" });
    expect(mergeCardRef(pr, withOwner(setup, null))).toBeNull();
    expect(mergeCardRef(pr, setup)?.label).toBe("ORBIT-1042");
    expect(mergeCardRef(pr, withOwner({ connected: false }, "clickup"))).toBeNull();
  });
  it("end to end: the real rule behind the setup, chip asking yes and merge asking no for an unread prefix", () => {
    const both = view({ clickup: cu(), jira: jira("PLAT") });
    const s = ownerSetup({ connected: true }, both)!;
    // ClickUp's prefix is unknown and Jira does not claim ORBIT: nobody's, in both readers
    expect(chipAction(r, s)).toBeNull();
    expect(mergeCardRef(pr, s)).toBeNull();
    // Jira claims it: a chip into the Jira tab, and the merge form is given its card
    const mine = ownerSetup({ connected: true }, view({ clickup: cu(), jira: jira("ORBIT") }))!;
    expect(chipAction(r, mine)).toEqual({ in: "tasks", tracker: "jira" });
    expect(mergeCardRef(pr, mine)).toEqual({ label: "ORBIT-1042", query: "ORBIT-1042", tracker: "jira" });
    // ClickUp's prefix is read and Jira's list lacks it: the board, and a move
    const board = ownerSetup({ connected: true, prefix: "ORBIT-" }, view({ clickup: cu("ORBIT-"), jira: jira("PLAT") }))!;
    expect(chipAction(r, board)).toEqual({ in: "tasks" });
    expect(mergeCardRef(pr, board)?.label).toBe("ORBIT-1042");
    // ClickUp read cards and none had a custom id: a bare ORBIT-1042 is not its, whatever the prefix says
    const noIds = ownerSetup({ connected: true, prefix: "ORBIT-", noCustomIds: true }, view({ clickup: cu("ORBIT-"), jira: jira("PLAT") }))!;
    expect(chipAction(r, noIds)).toBeNull();
    // Jira alone with a site that reported no projects: the chip says yes (it only picks where a tap goes)
    const alone = ownerSetup({ connected: false }, view({ jira: jira() }))!;
    expect(chipAction(r, alone)).toEqual({ in: "tasks", tracker: "jira" });
    // and the repository's choice settles what both claim
    const claimed = { clickup: cu("ORBIT-"), jira: jira("ORBIT") };
    expect(chipAction(r, ownerSetup({ connected: true, prefix: "ORBIT-" }, view(claimed)))).toBeNull();
    expect(chipAction(r, ownerSetup({ connected: true, prefix: "ORBIT-" }, view(claimed, "clickup")))).toEqual({ in: "tasks" });
    expect(chipAction(r, ownerSetup({ connected: true, prefix: "ORBIT-" }, view(claimed, "jira")))).toEqual({ in: "tasks", tracker: "jira" });
  });
});
