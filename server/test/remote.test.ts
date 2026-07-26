// The remote-access panel is only worth having if it tells the truth, so the
// parts that decide what it says are pinned here: which addresses count as
// reachable, what the subnet is, which firewall command is printed, whether a
// device has actually been seen, and — the one with teeth — that the token is
// never handed to a caller that is not on this machine.
import { describe, expect, test, beforeEach } from "bun:test";
import {
  noteClient,
  remoteClients,
  __resetRemoteClients,
  isLoopback,
  reachableAddresses,
  subnetOf,
  firewallHint,
  remoteStatus,
} from "../src/remote.ts";

const iface = (name: string, address: string, netmask = "255.255.255.0", internal = false) => ({
  address, netmask, family: "IPv4" as const, mac: "00:00:00:00:00:00", internal, cidr: null,
});

beforeEach(() => __resetRemoteClients());

describe("isLoopback", () => {
  test("covers the whole 127/8 range, ::1, and v4-mapped v6", () => {
    for (const ip of ["127.0.0.1", "127.0.1.5", "::1", "::ffff:127.0.0.1"]) {
      expect(isLoopback(ip)).toBe(true);
    }
    for (const ip of ["192.168.1.5", "100.85.155.119", "::ffff:192.168.1.5", "8.8.8.8"]) {
      expect(isLoopback(ip)).toBe(false);
    }
  });
});

describe("noteClient", () => {
  test("records off-box callers and ignores loopback", () => {
    noteClient("127.0.0.1");
    noteClient("::1");
    noteClient(null);
    noteClient(undefined);
    expect(remoteClients().count).toBe(0);

    noteClient("192.168.1.42", 1000);
    expect(remoteClients()).toMatchObject({ count: 1, lastAt: 1000, addresses: ["192.168.1.42"] });
  });

  test("one entry per address, keeping the most recent time", () => {
    noteClient("192.168.1.42", 1000);
    noteClient("192.168.1.42", 5000);
    expect(remoteClients()).toMatchObject({ count: 1, lastAt: 5000 });
  });

  test("newest first, and the address list is capped", () => {
    noteClient("192.168.1.10", 1000);
    noteClient("192.168.1.11", 3000);
    noteClient("192.168.1.12", 2000);
    expect(remoteClients().addresses.slice(0, 2)).toEqual(["192.168.1.11", "192.168.1.12"]);
  });

  test("cannot be grown without limit by an unauthenticated caller", () => {
    // This is fed by connection metadata from anything that can reach the port.
    for (let i = 0; i < 300; i++) noteClient(`10.0.${Math.floor(i / 250)}.${i % 250}`, 1000 + i);
    expect(remoteClients().count).toBeLessThanOrEqual(64);
  });

  test("a v4-mapped address is the same device as its plain form", () => {
    noteClient("192.168.1.42", 1000);
    noteClient("::ffff:192.168.1.42", 2000);
    expect(remoteClients().count).toBe(1);
  });
});

describe("subnetOf", () => {
  test("masks the address down to its network", () => {
    expect(subnetOf("192.168.1.131", "255.255.255.0")).toBe("192.168.1.0/24");
    expect(subnetOf("10.1.2.3", "255.0.0.0")).toBe("10.0.0.0/8");
    expect(subnetOf("172.20.30.40", "255.255.0.0")).toBe("172.20.0.0/16");
  });

  test("null rather than a guess when the mask is missing or malformed", () => {
    expect(subnetOf("192.168.1.1", undefined)).toBe(null);
    expect(subnetOf("192.168.1.1", "not-a-mask")).toBe(null);
    expect(subnetOf("192.168.1.1", "255.255.999.0")).toBe(null);
  });
});

describe("reachableAddresses", () => {
  test("skips loopback and container bridges, which lead nowhere for a phone", () => {
    const found = reachableAddresses({
      lo: [iface("lo", "127.0.0.1", "255.0.0.0", true)],
      wlan0: [iface("wlan0", "192.168.1.131")],
      docker0: [iface("docker0", "172.17.0.1", "255.255.0.0")],
      "br-abc123": [iface("br-abc123", "172.18.0.1", "255.255.0.0")],
      veth99: [iface("veth99", "10.9.9.9")],
    } as never);
    expect(found.map((a) => a.address)).toEqual(["192.168.1.131"]);
    expect(found[0]).toMatchObject({ iface: "wlan0", tailnet: false, subnet: "192.168.1.0/24" });
  });

  test("a plain LAN address is offered before a tailnet one", () => {
    // Both work; the LAN one works with no software installed on the phone.
    const found = reachableAddresses({
      tailscale0: [iface("tailscale0", "100.85.155.119", "255.192.0.0")],
      wlan0: [iface("wlan0", "192.168.1.131")],
    } as never);
    expect(found.map((a) => a.address)).toEqual(["192.168.1.131", "100.85.155.119"]);
    expect(found[1]!.tailnet).toBe(true);
  });
});

describe("firewallHint", () => {
  const which = (...present: string[]) => (cmd: string) => (present.includes(cmd) ? `/usr/bin/${cmd}` : null);

  test("names ufw and scopes the rule to the local subnet, not the world", () => {
    const hint = firewallHint(4000, "192.168.1.0/24", which("ufw"));
    expect(hint).toMatchObject({ tool: "ufw" });
    expect(hint!.command).toContain("from 192.168.1.0/24");
    expect(hint!.command).toContain("port 4000");
    expect(hint!.command).not.toContain("Anywhere");
    expect(hint!.undo).toContain("delete");
  });

  test("falls back to a private-range default when the subnet is unknown", () => {
    expect(firewallHint(4000, null, which("ufw"))!.command).toContain("192.168.0.0/16");
  });

  test("covers firewalld and nftables, and stays silent when none is installed", () => {
    expect(firewallHint(4000, null, which("firewall-cmd"))!.tool).toBe("firewalld");
    expect(firewallHint(4000, null, which("nft"))!.tool).toBe("nftables");
    expect(firewallHint(4000, null, which())).toBe(null);
  });

  test("prefers ufw when several are present — it is the one that is managing", () => {
    expect(firewallHint(4000, null, which("ufw", "nft"))!.tool).toBe("ufw");
  });
});

describe("remoteStatus", () => {
  const addresses = [{ address: "192.168.1.131", iface: "wlan0", tailnet: false, subnet: "192.168.1.0/24" }];
  const base = { port: 4000, trustLan: true, webUi: true, addresses, which: () => null };

  test("a loopback bind is not exposed; 0.0.0.0 is", () => {
    expect(remoteStatus({ ...base, bind: "127.0.0.1", token: null, includeToken: true }).exposed).toBe(false);
    expect(remoteStatus({ ...base, bind: "::1", token: null, includeToken: true }).exposed).toBe(false);
    expect(remoteStatus({ ...base, bind: "0.0.0.0", token: null, includeToken: true }).exposed).toBe(true);
  });

  test("a local caller gets URLs that carry the token", () => {
    const st = remoteStatus({ ...base, bind: "0.0.0.0", token: "s3cret", includeToken: true });
    expect(st.token).toBe("s3cret");
    expect(st.urls).toEqual(["http://192.168.1.131:4000/?token=s3cret"]);
  });

  test("a remote caller is never handed the token, in the field or in a URL", () => {
    // The page on the phone already proved it holds the token to get this far.
    // Re-serving the credential to whatever else is on the wifi is the risk.
    const st = remoteStatus({ ...base, bind: "0.0.0.0", token: "s3cret", includeToken: false });
    expect(st.token).toBeUndefined();
    expect(st.tokenRequired).toBe(true);
    expect(st.urls).toEqual(["http://192.168.1.131:4000/"]);
    expect(JSON.stringify(st)).not.toContain("s3cret");
  });

  test("reports the devices that have been seen", () => {
    noteClient("192.168.1.42", 4242);
    const st = remoteStatus({ ...base, bind: "0.0.0.0", token: null, includeToken: true });
    expect(st.clients).toMatchObject({ count: 1, lastAt: 4242 });
  });
});
