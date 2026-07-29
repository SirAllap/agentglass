// The remote-access panel is only worth having if it tells the truth, so the
// parts that decide what it says are pinned here: which addresses count as
// reachable, what the subnet is, which firewall command is printed, whether a
// device has actually been seen, and — the one with teeth — that the token is
// never handed to a caller that is not on this machine.
import { describe, expect, test, beforeEach } from "bun:test";
import {
  noteClient,
  noteSocket,
  blockDevice,
  isBlocked,
  remoteDevices,
  deviceLabel,
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

    noteClient("192.168.1.42", { now: 1000 });
    expect(remoteClients()).toMatchObject({ count: 1, lastAt: 1000, addresses: ["192.168.1.42"] });
  });

  test("one entry per address, keeping the most recent time", () => {
    noteClient("192.168.1.42", { now: 1000 });
    noteClient("192.168.1.42", { now: 5000 });
    expect(remoteClients()).toMatchObject({ count: 1, lastAt: 5000 });
  });

  test("newest first, and the address list is capped", () => {
    noteClient("192.168.1.10", { now: 1000 });
    noteClient("192.168.1.11", { now: 3000 });
    noteClient("192.168.1.12", { now: 2000 });
    expect(remoteClients().addresses.slice(0, 2)).toEqual(["192.168.1.11", "192.168.1.12"]);
  });

  test("cannot be grown without limit by an unauthenticated caller", () => {
    // This is fed by connection metadata from anything that can reach the port.
    for (let i = 0; i < 300; i++) noteClient(`10.0.${Math.floor(i / 250)}.${i % 250}`, { now: 1000 + i });
    expect(remoteClients().count).toBeLessThanOrEqual(64);
  });

  test("a v4-mapped address is the same device as its plain form", () => {
    noteClient("192.168.1.42", { now: 1000 });
    noteClient("::ffff:192.168.1.42", { now: 2000 });
    expect(remoteClients().count).toBe(1);
  });

  test("a later request without a User-Agent does not erase the name", () => {
    // The phone's service worker sends none, and it must not turn a named
    // device back into "Unnamed device" between two polls.
    noteClient("192.168.1.42", { now: 1000, agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1" });
    noteClient("192.168.1.42", { now: 2000, agent: null });
    expect(remoteDevices()[0]!.label).toBe("iPhone · Safari");
  });
});

describe("connected right now", () => {
  test("a held-open socket is what makes a device live, not its last request", () => {
    noteClient("192.168.1.42", { now: 1000 });
    expect(remoteDevices()[0]!.live).toBe(0);
    noteSocket("192.168.1.42", 1, 2000);
    expect(remoteDevices()[0]!.live).toBe(1);
    expect(remoteClients().liveCount).toBe(1);
    noteSocket("192.168.1.42", -1, 3000);
    expect(remoteDevices()[0]!.live).toBe(0);
    expect(remoteClients().liveCount).toBe(0);
  });

  test("counts several sockets from one device, and never goes negative", () => {
    // A phone holds the event stream and a terminal at once; a close that
    // arrives twice must not leave a live device stuck at -1, which would read
    // as "not connected" forever after.
    noteSocket("192.168.1.42", 1, 1000);
    noteSocket("192.168.1.42", 1, 1000);
    expect(remoteDevices()[0]!.live).toBe(2);
    noteSocket("192.168.1.42", -1, 2000);
    noteSocket("192.168.1.42", -1, 2000);
    noteSocket("192.168.1.42", -1, 2000);
    expect(remoteDevices()[0]!.live).toBe(0);
  });

  test("a socket from an address we never saw registers the device", () => {
    noteSocket("192.168.1.77", 1, 1000);
    expect(remoteDevices().map((d) => d.address)).toEqual(["192.168.1.77"]);
    expect(remoteDevices()[0]!.live).toBe(1);
  });

  test("loopback holds no sockets: the app talking to itself is not a device", () => {
    noteSocket("127.0.0.1", 1, 1000);
    noteSocket("::1", 1, 1000);
    expect(remoteClients().count).toBe(0);
  });

  test("live devices sort above ones that merely visited", () => {
    noteClient("192.168.1.10", { now: 9000 });
    noteClient("192.168.1.11", { now: 1000 });
    noteSocket("192.168.1.11", 1, 1000);
    expect(remoteDevices().map((d) => d.address)).toEqual(["192.168.1.11", "192.168.1.10"]);
  });
});

describe("disconnecting a device", () => {
  test("blocks by address and lets it back in", () => {
    noteClient("192.168.1.42", { now: 1000 });
    expect(blockDevice("192.168.1.42", true)).toBe(true);
    expect(isBlocked("192.168.1.42")).toBe(true);
    // The gate reads whatever the socket reports, which may be v4-mapped.
    expect(isBlocked("::ffff:192.168.1.42")).toBe(true);
    expect(blockDevice("192.168.1.42", false)).toBe(true);
    expect(isBlocked("192.168.1.42")).toBe(false);
  });

  test("an address that was never seen cannot be blocked into existence", () => {
    // Otherwise the list becomes writable by anything that can POST a string.
    expect(blockDevice("8.8.8.8", true)).toBe(false);
    expect(remoteClients().count).toBe(0);
  });

  test("nothing and loopback are never blocked", () => {
    expect(isBlocked(null)).toBe(false);
    expect(isBlocked("127.0.0.1")).toBe(false);
  });

  test("the cap never evicts a connected or a blocked device", () => {
    // The two rows the user is relying on are exactly the two that must not
    // quietly vanish when 300 strangers touch the port.
    noteClient("192.168.1.5", { now: 1 });
    noteSocket("192.168.1.5", 1, 1);
    noteClient("192.168.1.6", { now: 2 });
    blockDevice("192.168.1.6", true);
    for (let i = 0; i < 300; i++) noteClient(`10.0.${Math.floor(i / 250)}.${i % 250}`, { now: 1000 + i });
    const kept = remoteDevices().map((d) => d.address);
    expect(kept).toContain("192.168.1.5");
    expect(kept).toContain("192.168.1.6");
    expect(remoteDevices().length).toBeLessThanOrEqual(64);
  });
});

describe("deviceLabel", () => {
  test("names the phones a person would recognise", () => {
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"))
      .toBe("Pixel 8 Pro · Chrome");
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"))
      .toBe("iPhone · Safari");
    expect(deviceLabel("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1")).toBe("iPad · Safari");
  });

  test("names the machines too, and prefers Edge over the Chrome it also claims", () => {
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36")).toBe("Mac · Chrome");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0")).toBe("Windows PC · Edge");
    expect(deviceLabel("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36")).toBe("Linux machine · Chrome");
  });

  test("says plainly when it is not a browser", () => {
    expect(deviceLabel("curl/8.4.0")).toBe("A script (curl)");
    expect(deviceLabel("python-requests/2.31.0")).toBe("A script (python-requests)");
  });

  test("stays vague rather than guessing", () => {
    // A wrong-but-specific name is worse than an honest blank: the user acts
    // on this by deciding whether to cut a device off.
    expect(deviceLabel("")).toBe("Unnamed device");
    expect(deviceLabel(null)).toBe("Unnamed device");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36"))
      .toBe("An Android device · Chrome");
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
    noteClient("192.168.1.42", { now: 4242 });
    const st = remoteStatus({ ...base, bind: "0.0.0.0", token: null, includeToken: true });
    expect(st.clients).toMatchObject({ count: 1, lastAt: 4242 });
  });
});
