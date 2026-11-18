import { describe, expect, test } from "bun:test";
import { linkView, peerLabel, deviceCards, cardView, devicesIntro, pairButton, SCOPE_CHIP, SCOPE_CHOICES, CAPABILITIES, deviceKind, routeRows, routeLabel, accessSub, tailnetNote, seenHead, scopeTone, devicesWait, seenFold, PAIR_BUTTON_MIN_W } from "../src/lib/remoteView.ts";
import { navMarks, headerChips, remoteBadgeText, NO_FACTS } from "../src/lib/settingsNav.ts";

describe("nav badge", () => {
  test("words: paired count first, live second, No device only at 0", () => {
    expect(remoteBadgeText(0, 0)).toBe("No device");
    expect(remoteBadgeText(1, 0)).toBe("1 paired");
    expect(remoteBadgeText(1, 1)).toBe("1 paired · 1 live");
    expect(remoteBadgeText(40, 3)).toBe("40 paired · 3 live");
  });
  test("one paired and idle is on, never No device", () => {
    const m = navMarks({ ...NO_FACTS, remotePaired: 1, remoteLiveCount: 0 }).remote!;
    expect(m.state).toBe("on");
    expect(headerChips("remote", m)).toEqual([{ tone: "ok", text: "1 paired" }]);
  });
  test("zero paired is off and says No device", () => {
    const m = navMarks({ ...NO_FACTS, remotePaired: 0, remoteLiveCount: 0 }).remote!;
    expect(headerChips("remote", m)).toEqual([{ tone: "off", text: "No device" }]);
  });
  test("paired not read yet falls back to the old live fact", () => {
    expect(navMarks({ ...NO_FACTS, remoteLive: true }).remote).toEqual({ state: "on" });
    expect(navMarks(NO_FACTS).remote).toBeUndefined();
  });
});

describe("link strip", () => {
  test("off draws no line", () => expect(linkView({ enabled: false, paired: 2, live: 0 })).toEqual({ tone: "off", label: "Remote access is off", line: false }));
  test("on, idle, paired waits", () => expect(linkView({ enabled: true, paired: 1, live: 0 }).label).toBe("Waiting for a phone"));
  test("on, none paired", () => expect(linkView({ enabled: true, paired: 0, live: 0 }).label).toBe("No phone paired yet"));
  test("live count", () => {
    expect(linkView({ enabled: true, paired: 1, live: 1 }).label).toBe("1 phone connected");
    expect(linkView({ enabled: true, paired: 40, live: 5 }).label).toBe("5 phones connected");
  });
  test("peer label for 0, 1, 40", () => {
    expect(peerLabel([])).toEqual({ name: "Phones", sub: "none paired" });
    expect(peerLabel(["Pixel 8"])).toEqual({ name: "Pixel 8", sub: "paired" });
    expect(peerLabel(Array(40).fill("x")).name).toBe("40 phones");
  });
});

describe("device cards", () => {
  const d = (id: string, createdAt: number, lastSeenAt?: number, revokedAt?: number) => ({ id, createdAt, lastSeenAt, revokedAt });
  test("forgotten are dropped, newest use first", () => {
    expect(deviceCards([d("a", 1, 5), d("b", 9), d("c", 2, 50, 60), d("e", 1, 7)]).map((x) => x.id)).toEqual(["b", "e", "a"]);
  });
  test("empty and large", () => {
    expect(deviceCards([])).toEqual([]);
    expect(deviceCards(Array.from({ length: 40 }, (_, i) => d(String(i), i))).length).toBe(40);
  });
  const ago = (t: number) => `${t} ago`;
  test("card: used, chip, active within 2 minutes", () => {
    expect(cardView({ label: "Pixel 8", scope: "full", lastSeenAt: 1000 }, 1000 + 60_000, ago)).toEqual({ name: "Pixel 8", used: "Used 1000 ago", chip: "Full access", active: true, kind: "phone", tone: "warn" });
    expect(cardView({ label: "Pixel 8", scope: "read", lastSeenAt: 1000 }, 1000 + 120_000, ago).active).toBe(false);
  });
  test("card: never used, blank name", () => {
    expect(cardView({ label: "  ", scope: "answer" }, 5, ago)).toEqual({ name: "Unnamed phone", used: "Not used yet", chip: "Answer things", active: false, kind: "phone", tone: "acc" });
  });
  test("intro counts, 0 included", () => {
    expect(devicesIntro(0).startsWith("None paired.")).toBe(true);
    expect(devicesIntro(2).startsWith("2 paired.")).toBe(true);
    expect(devicesIntro(40).startsWith("40 paired.")).toBe(true);
  });
  test("pair button: one slot, Pair a phone or New code", () => {
    expect(pairButton({ off: false, pairing: false, busy: false })).toEqual({ label: "Pair a phone", primary: true, disabled: false });
    expect(pairButton({ off: true, pairing: false, busy: false }).disabled).toBe(true);
    expect(pairButton({ off: false, pairing: false, busy: true })).toEqual({ label: "Starting…", primary: true, disabled: true });
    expect(pairButton({ off: false, pairing: true, busy: false })).toEqual({ label: "New code", primary: false, disabled: false });
  });
});

describe("one word set for scopes", () => {
  test("chip, accept form and table say the same three words", () => {
    expect(SCOPE_CHIP).toEqual({ read: "Look only", answer: "Answer things", full: "Full access" });
    expect(SCOPE_CHOICES.map((c) => c.title)).toEqual(["Answer things", "Look only", "Full access"]);
    expect(SCOPE_CHOICES[0]!.key).toBe("answer");
  });
  test("tone: default is the accent, full is a warning", () => {
    expect(scopeTone("answer")).toBe("acc");
    expect(scopeTone("full")).toBe("warn");
    expect(scopeTone("read")).toBe("off");
  });
  test("capabilities: 8 rows, a level only gains", () => {
    const rows = CAPABILITIES.flatMap((g) => g.rows);
    expect(CAPABILITIES.map((g) => g.group)).toEqual(["See", "Answer", "Operate"]);
    expect(rows.length).toBe(8);
    for (const r of rows) {
      if (r.read) expect(r.answer).toBe(true);
      if (r.answer) expect(r.full).toBe(true);
    }
  });
});

describe("device kind", () => {
  test("phone, tablet, laptop; unsure is a phone", () => {
    expect(deviceKind("Field phone")).toBe("phone");
    expect(deviceKind("")).toBe("phone");
    expect(deviceKind("Kitchen tablet")).toBe("tablet");
    expect(deviceKind("iPad")).toBe("tablet");
    expect(deviceKind("Travel laptop")).toBe("laptop");
    expect(deviceKind("Firefox on Linux")).toBe("laptop");
  });
  test("every computer name guessName gives reads as a computer", () => {
    expect(deviceKind("Mac")).toBe("laptop");
    expect(deviceKind("Windows PC")).toBe("laptop");
    expect(deviceKind("iPhone")).toBe("phone");
    expect(deviceKind("Android phone")).toBe("phone");
  });
});

describe("route table", () => {
  const addrs = [
    { address: "studio-desk.tail1a2b.ts.net", iface: "tailscale0", tailnet: true, secure: true, label: "Tailscale (HTTPS)" },
    { address: "100.88.12.5:7420", iface: "tailscale0", tailnet: true },
    { address: "192.168.20.14:7420", iface: "wlan0", tailnet: false },
  ];
  test("every route, the pick marked, who can pair", () => {
    const r = routeRows(addrs, 1);
    expect(r.map((x) => x.label)).toEqual(["Tailscale (HTTPS)", "Tailscale", "Wi-Fi"]);
    expect(r.map((x) => x.on)).toEqual([false, true, false]);
    expect(r[0]!.pairing).toBe("HTTPS · app and browser");
    expect(r[2]!.pairing).toBe("Plain HTTP · app only");
  });
  test("empty", () => expect(routeRows([], 0)).toEqual([]));
  test("a wireless card is Wi-Fi, a wired one keeps its name", () => {
    expect(routeLabel({ iface: "wlp2s0", tailnet: false })).toBe("Wi-Fi");
    expect(routeLabel({ iface: "eth0", tailnet: false })).toBe("eth0");
    expect(routeLabel({ iface: "wlan0", tailnet: false, label: "Office" })).toBe("Office");
  });
});

describe("access line and tailnet note", () => {
  test("busy, off, tailnet, plain", () => {
    expect(accessSub({ enabled: true, busy: true, tailnet: false })).toBe("Restarting the server…");
    expect(accessSub({ enabled: false, busy: false, tailnet: true })).toBe("Off: nothing listens beyond this machine.");
    expect(accessSub({ enabled: true, busy: false, tailnet: true }).startsWith("Over Tailscale.")).toBe(true);
    expect(accessSub({ enabled: true, busy: false, tailnet: false })).toContain("in the clear");
  });
  test("no Tailscale: plain-network note; healthy: none", () => {
    expect(tailnetNote(undefined, false)?.title).toBe("No Tailscale route on this machine.");
    expect(tailnetNote({ installed: false, names: [] }, false)?.tone).toBe("off");
    expect(tailnetNote({ installed: true, names: ["a"] }, true)).toBeNull();
  });
  test("not answering: count and held name", () => {
    const n = tailnetNote({ installed: true, names: ["a"], problem: "tailscale status timed out", fails: 3 }, true)!;
    expect(n.tone).toBe("warn");
    expect(n.title).toBe("Tailscale is not answering · 3 failed probes.");
    expect(n.body).toContain("Still trusting the name");
    expect(tailnetNote({ installed: true, names: [], problem: "x", fails: 1 }, true)!.title).toContain("1 failed probe.");
    expect(tailnetNote({ installed: true, names: [], problem: "x", fails: 9, dropped: true }, true)!.tone).toBe("err");
  });
  test("seen heading", () => {
    expect(seenHead(2, 3)).toBe("2 devices are connected right now");
    expect(seenHead(0, 1)).toBe("One device has connected before");
    expect(seenHead(0, 0)).toBe("Nothing else has connected yet");
  });
});

describe("pair button", () => {
  test("off: disabled, in its place, with the reason beside it", () => {
    expect(pairButton({ off: true, pairing: false, busy: false })).toEqual({ label: "Pair a phone", primary: true, disabled: true, hint: "Turn on remote access first" });
    expect(pairButton({ off: false, pairing: false, busy: false }).hint).toBeUndefined();
  });
  test("wide enough for its longest label", () => expect(PAIR_BUTTON_MIN_W).toBe(112));
});

describe("paired devices before a status", () => {
  test("server unreachable says so, like Remote access", () => {
    expect(devicesWait({ failed: true, st: null })).toBe("unreachable");
    expect(devicesWait({ failed: false, st: null })).toBe("reading");
    expect(devicesWait({ failed: true, st: {} })).toBeNull();
  });
});

describe("who-has-reached fold", () => {
  const shut = { open: false, autoOpened: false };
  test("opens by itself once when an address is blocked", () => {
    expect(seenFold(shut, true)).toEqual({ open: true, autoOpened: true });
    expect(seenFold(shut, false)).toEqual(shut);
  });
  test("never closes by itself when the block is lifted", () => {
    expect(seenFold({ open: true, autoOpened: true }, false).open).toBe(true);
  });
  test("closed by hand, a second block does not reopen it", () => {
    expect(seenFold({ open: false, autoOpened: true }, true).open).toBe(false);
  });
});
