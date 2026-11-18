/*
 * The Login vault section's words (Settings ▸ Browser). Names and counts are
 * invented; nothing here is, or could be, a cookie value.
 */
import { describe, expect, it } from "bun:test";
import { boxSummary, chosenLine, goodUntil, lastTakenBy, looksSensitive, pullWhat, readListing, reimportAsks, reimportLine, signedInCards, signedInLine, siteLog, sourceOf, vaultBoxes, withPut, type PullRow, type VaultRow } from "../src/lib/loginVault.ts";

const NOW = 1_800_000_000;
const pulls: PullRow[] = [
  { at: NOW - 720, event: "pull", site: "acme.test", agent: "review-pr-540", lane: "lane_1", count: 31 },
  { at: NOW - 3600, event: "pull", site: "acme.test", agent: "triage-orbit-1042", lane: "lane_2", count: 31 },
  { at: NOW - 60, event: "refused", site: "orbit.test", agent: "notes-bot", lane: "lane_3", count: 0, why: "sensitive, needs OK" },
];

describe("login vault words", () => {
  it("says how long a login is good for", () => {
    expect(goodUntil(NOW + 41 * 86_400, NOW)).toBe("in 41 days");
    expect(goodUntil(NOW + 2 * 3600, NOW)).toBe("in 2 hours");
    expect(goodUntil(NOW - 86_400 - 5, NOW)).toBe("Expired yesterday");
    expect(goodUntil(null, NOW)).toBe("Ends with the session");
  });
  it("names the last agent that took a site, or Never", () => {
    expect(lastTakenBy(pulls, "acme.test", NOW)).toBe("review-pr-540 · 12 min ago");
    expect(lastTakenBy(pulls, "orbit.test", NOW)).toBe("Never");
  });
  it("logs newest first, and says what happened without a value", () => {
    expect(siteLog(pulls, "acme.test").map((p) => p.lane)).toEqual(["lane_1", "lane_2"]);
    expect(pullWhat(pulls[0]!)).toBe("Pulled 31");
    expect(pullWhat(pulls[2]!)).toBe("Refused: sensitive, needs OK");
  });
  it("reads main's answer and finds a vault's source", () => {
    expect(readListing({ ok: false, error: "keyring locked" })).toBeNull();
    expect(readListing({ ok: true, vaults: [{ vault: "zen-1/0", label: "Zen", updatedAt: 0, sites: [] }], pulls: [] })?.signOutAtEnd).toBe(true);
    expect(sourceOf("zen-1/0")).toBe("zen-1");
  });
});

describe("signed in and re-import cards (states 4 and 6)", () => {
  it("one signed-in card per lane and site, with the last pull's count", () => {
    const cards = signedInCards([{ lane: "lane_1", agent: "review-pr-540", sites: ["acme.test"] }], pulls);
    expect(cards).toEqual([{ lane: "lane_1", agent: "review-pr-540", site: "acme.test", count: 31, at: NOW - 720 }]);
    expect(signedInLine(cards[0]!, NOW)).toBe("From the vault · 31 cookies · 12 min ago");
  });
  it("asks for a re-import only after the vault's last import", () => {
    const vault: VaultRow = { vault: "zen:abc/1", label: "Zen", updatedAt: NOW - 7200, sites: [
      { site: "acme.test", cookies: 2, session: 0, expires: NOW - 10, sensitive: false, suggested: false, needsStorage: false, isDefault: false },
    ] };
    const expired: PullRow[] = [
      { at: NOW - 60, event: "refused", site: "acme.test", agent: "notes-bot", lane: "lane_4", count: 0, why: "expired" },
      { at: NOW - 9000, event: "refused", site: "acme.test", agent: "old-bot", lane: "lane_5", count: 0, why: "expired" },
    ];
    const asks = reimportAsks({ vaults: [vault], pulls: expired, signOutAtEnd: true });
    expect(asks.map((a) => a.agent)).toEqual(["notes-bot"]);
    expect(reimportLine(asks[0]!, NOW)).toBe("The vault login expired · last import 2 h ago from Zen");
    expect(reimportAsks({ vaults: [{ ...vault, updatedAt: NOW }], pulls: expired, signOutAtEnd: true })).toEqual([]);
  });
});

describe("one box per browser (state 3) and the import list (state 2)", () => {
  const site = (s: string, over: Partial<VaultRow["sites"][number]> = {}) => ({ site: s, cookies: 3, session: 0, expires: NOW + 86_400, sensitive: false, suggested: false, needsStorage: false, isDefault: false, ...over });
  const vaults: VaultRow[] = [
    { vault: "zen:default/0", label: "Zen · default", updatedAt: NOW - 3600, sites: [site("app.orbit.dev"), site("acme.test")] },
    { vault: "zen:default/2", label: "Zen · default — container 2", updatedAt: NOW - 60, sites: [site("app.orbit.dev")] },
    { vault: "firefox:work/0", label: "Firefox · work", updatedAt: NOW - 7200, sites: [site("billing.orbit.dev")] },
    { vault: "chrome:p1/0", label: "Chrome", updatedAt: NOW, sites: [] },
  ];
  it("groups every container of a browser into one box, and skips empty vaults", () => {
    const boxes = vaultBoxes(vaults);
    expect(boxes.map((b) => [b.source, b.label, b.vaults])).toEqual([
      ["zen:default", "Zen · default", ["zen:default/0", "zen:default/2"]],
      ["firefox:work", "Firefox · work", ["firefox:work/0"]],
    ]);
    expect(boxes[0]!.sites.map((s) => `${s.site}@${s.vaults.join("+")}`)).toEqual(["acme.test@zen:default/0", "app.orbit.dev@zen:default/0+zen:default/2"]);
    expect(boxes[0]!.updatedAt).toBe(NOW - 60);
  });
  it("shows a site once per box: leading dot and bare host merge, good until the latest expiry", () => {
    const two: VaultRow[] = [
      { vault: "zen:default/0", label: "Zen · default", updatedAt: NOW, sites: [site(".app.orbit.dev", { expires: NOW + 100, cookies: 2 }), site("app.orbit.dev", { expires: NOW + 900, cookies: 1, session: 1 })] },
      { vault: "zen:default/2", label: "Zen · default — container 2", updatedAt: NOW, sites: [site("APP.orbit.dev", { expires: null, sensitive: true })] },
      { vault: "firefox:work/0", label: "Firefox · work", updatedAt: NOW, sites: [site("app.orbit.dev", { expires: NOW + 5 })] },
    ];
    const boxes = vaultBoxes(two);
    expect(boxes[0]!.sites).toHaveLength(1);
    const s = boxes[0]!.sites[0]!;
    expect([s.site, s.expires, s.cookies, s.session, s.sensitive, s.vaults]).toEqual(["app.orbit.dev", NOW + 900, 6, 1, true, ["zen:default/0", "zen:default/2"]]);
    /* Another browser is another box: its row stays its own. */
    expect(boxes[1]!.sites.map((x) => [x.site, x.expires])).toEqual([["app.orbit.dev", NOW + 5]]);
  });
  it("counts a site in two containers once", () => {
    expect(boxSummary(vaultBoxes(vaults)[0]!, NOW)).toBe("2 sites from Zen · default · imported 1 min ago");
  });
  it("names a box without the container when only a container was imported", () => {
    expect(vaultBoxes([vaults[1]!])[0]!.label).toBe("Zen · default");
  });
  it("draws a put at once, then gives way to the real listing", () => {
    const put = { source: "firefox:play", label: "Firefox · play", at: NOW, sites: [{ site: "app.orbit.dev", cookies: 12 }, { site: "billing.orbit.dev", cookies: 6 }] };
    const l = { vaults: [], pulls: [], signOutAtEnd: true };
    const shown = vaultBoxes(withPut(l, put).vaults);
    expect(shown.map((b) => [b.label, b.pending, b.sites.length])).toEqual([["Firefox · play", true, 2]]);
    expect(shown[0]!.sites[1]!.suggested).toBe(true);
    expect(boxSummary(shown[0]!, NOW)).toBe("2 sites from Firefox · play · just put in");
    const landed = { ...l, vaults: [{ vault: "firefox:play/0", label: "Firefox · play", updatedAt: NOW, sites: [site("app.orbit.dev")] }] };
    expect(withPut(landed, put)).toBe(landed);
    expect(withPut(l, null)).toBe(l);
  });
  it("tags sensitive-looking sites and counts the picks", () => {
    expect(looksSensitive("billing.orbit.dev")).toBe(true);
    expect(looksSensitive("app.orbit.dev")).toBe(false);
    expect(chosenLine(8, 214)).toBe("8 of 214 chosen");
  });
});
