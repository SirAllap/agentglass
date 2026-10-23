/*
 * What a review of the several-computers work found, held in place: each
 * assertion is a scenario that went wrong on paper and is read from source
 * because there is no renderer here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { alertRoute } from "../src/notifications/target.ts";

const read = (p: string): string => readFileSync(join(import.meta.dir, "..", p), "utf8");
const provider = read("src/state/host-context.tsx");
const layout = read("app/_layout.tsx");
const terminal = read("app/(tabs)/terminal.tsx");
const pair = read("app/pair.tsx");

function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe("a revoked computer and the service", () => {
  test("the active one being removed does not stop the service while others are usable", () => {
    // Broken on purpose: an unconditional stop here silenced the other
    // computers' alerts the moment the one in front was removed.
    const effect = between(provider, "The computer in front being removed is not a reason", "let timer");
    expect(effect).toMatch(/some\(\(h\) => !h\.revoked\)/);
  });
  test("a 401 marks the entry for the key that got it, and a failed write is not a crash", () => {
    const load = between(provider, "error === REVOKED", "const list = <T,>");
    expect(load).toContain("markRevoked(which.id, which.token)");
    expect(load).toMatch(/catch/);
    expect(provider).toMatch(/markRevoked\(id, token\)/);
  });
});

describe("the list in React and the list in the keystore", () => {
  test("one place says which computer is in front, written when the list is", () => {
    // Broken on purpose: reading it from the last render made a second tap in
    // the same frame compare against a list that was already out of date.
    expect(provider).toContain("const activeId = useRef");
    expect(provider).toContain("const commit = useCallback");
    expect(between(provider, "switchTo: async", "rename: async")).toContain("activeId.current");
  });
  test("renaming the computer in front shows at once", () => {
    expect(provider).toMatch(/\[active\?\.id, active\?\.origin, active\?\.token, active\?\.revoked, active\?\.name\]/);
  });
  test("reads that started on the computer just left are dropped when they land", () => {
    const prs = between(provider, "const loadPrs = useCallback", "const loadMe");
    expect(prs).toContain("activeId.current !== which.id");
    const me = between(provider, "const loadMe = useCallback", "const refresh = useCallback");
    expect(me).toContain("activeId.current === which.id");
  });
  test("the marks read is per computer, not one shared in-flight request", () => {
    expect(read("src/state/read-marks.ts")).toMatch(/loadingEpoch/);
  });
});

describe("a tap on an alert", () => {
  test("carries the computer in the route so the terminal can wait for its own strip", () => {
    expect(alertRoute({ kind: "alert", pane: "%7", hostId: "a" }))
      .toEqual({ pathname: "/terminal", params: { pane: "%7", host: "a" } });
    expect(alertRoute({ kind: "alert", pane: "%7" })).toEqual({ pathname: "/terminal", params: { pane: "%7" } });
  });
  test("of a computer that is gone or removed opens the terminal without its pane", () => {
    // Broken on purpose: the pane id of a forgotten computer opened an
    // unrelated window of the one in front.
    expect(layout).toMatch(/h\.id === hostId && !h\.revoked/);
    expect(layout).toMatch(/pathname: "\/terminal" \}/);
  });
  test("a switch that throws still opens the terminal", () => {
    expect(between(layout, "watchAlertTaps(", "[ready, host")).toMatch(/try \{[\s\S]*switchTo[\s\S]*\} catch/);
  });
});

describe("the terminal on a switch", () => {
  test("drops what it had read for the computer left, and answers that arrive late", () => {
    const own = between(terminal, "const paneOwner = useRef", "}, [host?.id, active]);");
    for (const ref of ["seen.current = null", "wanted.current = null", "stripOwner.current = undefined"]) {
      expect(own).toContain(ref);
    }
    expect(terminal).toMatch(/paneOwner\.current !== hid/);
  });
  test("takes a tapped alert's pane only from the strip of the computer it names", () => {
    const arriving = between(terminal, "A tapped alert names the pane itself", "paneFor(strip");
    expect(arriving).toContain("arriving.host");
    expect(arriving).toContain("stripOwner.current");
  });
});

describe("pairing", () => {
  test("a sixth computer is refused before the handshake, not after the ticket is spent", () => {
    const submit = between(pair, "if (!randomnessReady())", "setBusy(true);");
    expect(pair).toContain("MAX_HOSTS");
    expect(pair.indexOf("MAX_HOSTS")).toBeLessThan(pair.indexOf("setBusy(true);"));
    expect(submit.length).toBeGreaterThan(0);
  });
  test("editing the code by hand forgets that the address came from a link", () => {
    expect(pair).toMatch(/if \(!absorb\(text\)\) \{ setTicket\(text\); setFromLink\(false\); \}/);
  });
});

describe("a background computer's name", () => {
  test("is learned once from the computer, not shown as its address", () => {
    expect(read("src/state/use-computer.ts")).toContain("export async function learnName");
    expect(between(provider, "function Watcher(", "export function HostProvider")).toContain("learnName(");
  });
});
