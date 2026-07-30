// The Remote pane's one pure decision: which of this machine's addresses to
// offer back. It exists because of something that happened rather than
// something imagined — a chosen tailnet address that reverted to the LAN on
// every open.
//
// There used to be a second: how much of the link to cover up, because the
// link carried the access code. Nothing hands a credential out in a URL any
// more (see server/src/pairing.ts), so there is nothing left to mask — what
// the pane shows is an address and only an address.
import { describe, expect, test } from "bun:test";
import { pickIndex, readPick, writePick, type PickedAddress } from "../src/lib/remoteLink.ts";

const lan: PickedAddress = { address: "192.168.1.131", iface: "enp42s0", tailnet: false };
const tail: PickedAddress = { address: "100.85.155.119", iface: "tailscale0", tailnet: true };

describe("which address to offer", () => {
  test("nothing saved falls back to the first, which is the no-extra-software one", () => {
    expect(pickIndex([lan, tail], null)).toBe(0);
    expect(pickIndex([], tail)).toBe(0);
  });

  test("the saved address wins, wherever the list puts it now", () => {
    expect(pickIndex([lan, tail], tail)).toBe(1);
    // reachableAddresses() sorts tailnet last, so the index is not stable
    // between reads; the address is what was chosen.
    expect(pickIndex([tail, lan], tail)).toBe(0);
  });

  test("a new DHCP lease on the same interface keeps the choice", () => {
    const moved: PickedAddress = { address: "192.168.1.140", iface: "enp42s0", tailnet: false };
    expect(pickIndex([moved, tail], lan)).toBe(0);
  });

  test("on a different network entirely, the kind of address carries the intent", () => {
    // Saved a tailnet address, now on café wifi with a tailnet that came up
    // under a different name: "the one that works from anywhere" is still
    // answerable even though neither the address nor the interface matches.
    const otherTail: PickedAddress = { address: "100.99.1.2", iface: "tailscale1", tailnet: true };
    const otherLan: PickedAddress = { address: "10.0.0.9", iface: "wlan0", tailnet: false };
    expect(pickIndex([otherLan, otherTail], tail)).toBe(1);
  });

  test("a saved address that has no counterpart at all falls back to the first", () => {
    expect(pickIndex([lan], tail)).toBe(0);
  });
});

describe("remembering it", () => {
  const fake = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v); },
    };
  };

  test("round-trips the choice", () => {
    const store = fake();
    writePick(tail, store);
    expect(readPick(store)).toEqual(tail);
  });

  test("survives a hand-edited or absent value without throwing", () => {
    const store = fake();
    expect(readPick(store)).toBeNull();
    store.setItem("agentglass.remote.address", "{not json");
    expect(readPick(store)).toBeNull();
    store.setItem("agentglass.remote.address", JSON.stringify({ nope: true }));
    expect(readPick(store)).toBeNull();
  });

  test("a storage that refuses to write is not fatal", () => {
    // Private mode: the choice lasts as long as the pane is open, and nothing
    // in the pane breaks.
    const throwing = { setItem: () => { throw new Error("denied"); } };
    expect(() => writePick(tail, throwing)).not.toThrow();
  });
});
