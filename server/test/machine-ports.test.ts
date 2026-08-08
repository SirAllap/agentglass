// Reading `ss -ltnp`. Every bug this can have is a parsing bug, and a parsing
// bug here does not look like a crash — it looks like a port that is open and
// not listed, or a pid attributed to the wrong process. The fixtures below are
// verbatim lines from a real machine, including the awkward ones.
import { describe, expect, test } from "bun:test";
import { parsePorts } from "../src/machine.ts";

describe("parsePorts", () => {
  test("a socket with a process behind it", () => {
    const r = parsePorts(`LISTEN 0      512          0.0.0.0:4000  0.0.0.0:* users:(("agentglass-serv",pid=1800888,fd=24))`);
    expect(r.ports).toHaveLength(1);
    expect(r.ports[0]).toMatchObject({ port: 4000, addr: "0.0.0.0", proc: "agentglass-serv", pid: 1800888 });
  });

  test("a socket with none — another user's, which the kernel will not name", () => {
    const r = parsePorts(`LISTEN 0      4096         0.0.0.0:10001 0.0.0.0:*`);
    expect(r.ports[0]).toMatchObject({ port: 10001, proc: null, pid: null, mine: false });
  });

  test("the interface suffix is not part of the address", () => {
    // systemd-resolved binds 127.0.0.53%lo. Kept as written, the panel would
    // print an address no browser can open.
    const r = parsePorts(`LISTEN 0      4096   127.0.0.53%lo:53    0.0.0.0:*`);
    expect(r.ports[0]!.addr).toBe("127.0.0.53");
    expect(r.ports[0]!.port).toBe(53);
  });

  test("IPv6 loses its brackets and keeps its port", () => {
    // The last colon is the port separator, and an IPv6 address is all colons —
    // splitting on the first would report port 0 for every one of them.
    const r = parsePorts(`LISTEN 0      4096            [::]:443   [::]:*`);
    expect(r.ports[0]).toMatchObject({ addr: "::", port: 443 });
  });

  test("a header line is not a socket", () => {
    // `ss` without -H prints one, and older iproute2 has no -H at all.
    const r = parsePorts(`State  Recv-Q Send-Q Local Address:Port Peer Address:Port\nLISTEN 0 512 0.0.0.0:4000 0.0.0.0:*`);
    expect(r.ports).toHaveLength(1);
    expect(r.ports[0]!.port).toBe(4000);
  });

  test("the same port on two addresses is two rows, the same row twice is one", () => {
    const r = parsePorts([
      `LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*`,
      `LISTEN 0 4096 100.64.0.1:443 0.0.0.0:*`,
      `LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*`,
    ].join("\n"));
    expect(r.ports).toHaveLength(2);
  });

  test("only the first process of a shared socket is named", () => {
    // A pre-forking server lists every worker. The panel wants "who is this",
    // not a roll call, and the pid it offers to stop must be a single one.
    const r = parsePorts(`LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=100,fd=6),("nginx",pid=101,fd=6))`);
    expect(r.ports).toHaveLength(1);
    expect(r.ports[0]!.pid).toBe(100);
  });

  test("ours sort above the rest, and the counts say which is which", () => {
    // `mine` is decided by process ownership, which no fixture can fake — so
    // what is pinned here is that everything unowned lands in `external` and
    // nothing is lost between the two.
    const r = parsePorts([
      `LISTEN 0 4096 0.0.0.0:53 0.0.0.0:*`,
      `LISTEN 0 512 0.0.0.0:4000 0.0.0.0:* users:(("agentglass-serv",pid=999999999,fd=24))`,
    ].join("\n"));
    expect(r.mine + r.external).toBe(r.ports.length);
    expect(r.ports.map((p) => p.port).sort((a, b) => a - b)).toEqual([53, 4000]);
  });

  test("garbage is skipped rather than becoming a row of NaN", () => {
    const r = parsePorts(`\n   \nnonsense\nLISTEN 0 512 not-an-address 0.0.0.0:*\nLISTEN 0 512 0.0.0.0:0 0.0.0.0:*`);
    expect(r.ports).toHaveLength(0);
  });
});
