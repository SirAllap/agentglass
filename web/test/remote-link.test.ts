// The Remote pane's two pure decisions: which address to offer back, and how
// much of the link to put on screen. Both exist because of something that
// happened rather than something imagined — a chosen tailnet address that
// reverted to the LAN on every open, and an access code legible in a
// screenshot.
import { describe, expect, test } from "bun:test";
import { pickIndex, readPick, writePick, maskToken, type PickedAddress } from "../src/lib/remoteLink.ts";

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

describe("masking the access code", () => {
  test("covers the code and nothing else", () => {
    // An obviously fake code on purpose: this file is public, and a realistic
    // one is the kind of string that gets copied out of a test into a shell.
    const masked = maskToken("http://192.168.1.131:4000/?token=EXAMPLE-not-a-real-access-code-0000");
    expect(masked).toStartWith("http://192.168.1.131:4000/?token=");
    expect(masked).not.toContain("EXAMPLE-not-a-real");
    expect(masked).toMatch(/token=•+$/);
  });

  test("leaves a link that carries no code alone", () => {
    expect(maskToken("http://192.168.1.131:4000/")).toBe("http://192.168.1.131:4000/");
  });

  test("keeps whatever follows the code", () => {
    expect(maskToken("http://x:4000/?token=abc123&view=fleet")).toBe("http://x:4000/?token=••••••&view=fleet");
  });

  test("the mask length does not leak the code length", () => {
    const short = maskToken("http://x:4000/?token=ab");
    const long = maskToken("http://x:4000/?token=" + "a".repeat(64));
    expect(short.split("=")[1]).toBe("••••••");
    expect(long.split("=")[1]).toBe("••••••••••••");
  });
});
