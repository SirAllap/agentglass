/**
 * socketOwners skips rows cheaply before the full split. The security answer
 * must not move: every verdict over a large synthetic /proc/net/tcp equals what
 * the row data says, and far fewer rows get the full parse.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { proxiedByTailscaled, __resetProxyProbe, __setProcNetFiles, __trustProxyUid, __procRowsParsed } from "../src/remote.ts";

const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const me = typeof process.getuid === "function" ? process.getuid() : 1000;
const daemon = me + 1;
const ours = 4000;

describe("socketOwners on a large table", () => {
  const dir = mkdtempSync(join(tmpdir(), "agx-bigtbl-"));
  afterAll(() => {
    __setProcNetFiles(null);
    __resetProxyProbe();
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives the same verdicts and parses only candidate rows", () => {
    const rows: string[] = [];
    const expected = new Map<number, boolean>();
    const N = 5000;
    for (let i = 0; i < N; i++) {
      const lport = 20000 + i;
      // every 50th row targets us; others target a different port (some a near-miss).
      const toUs = i % 50 === 0;
      const rport = toUs ? ours : i % 7 === 0 ? ours + 1 : 1000 + (i % 3000);
      const st = i % 100 === 0 ? "06" : "01"; // TIME_WAIT rows to us are ignored
      const uid = i % 2 === 0 ? daemon : me;
      rows.push(`${String(i).padStart(4)}: 0100007F:${hex(lport)} 0100007F:${hex(rport)} ${st} 00000000:00000000 00:00000000 00000000  ${uid}        0 ${i} 1 0000000000000000 20 4 30 10 -1`);
      // Absent from the table (not ours, or TIME_WAIT) fails closed: proxied.
      expected.set(lport, !toUs || st === "06" ? true : uid === daemon);
    }
    const f = join(dir, "tcp");
    writeFileSync(f, header + "\n" + rows.join("\n") + "\n");
    __resetProxyProbe();
    __setProcNetFiles([f]);
    __trustProxyUid(daemon);

    const H = new Headers();
    // One read, then everything is served from the cached table.
    const before = __procRowsParsed();
    expect(proxiedByTailscaled({ address: "127.0.0.1", port: 20000 + 50 }, ours, H)).toBe(expected.get(20050)!);
    const parsed = __procRowsParsed() - before;
    expect(parsed).toBeGreaterThan(0);
    expect(parsed).toBeLessThan(N / 10);
    // Verdicts over a spread of ports, hits and misses alike.
    for (let i = 0; i < N; i += 37) {
      const lport = 20000 + i;
      expect(proxiedByTailscaled({ address: "127.0.0.1", port: lport }, ours, H)).toBe(expected.get(lport)!);
    }
    for (let i = 0; i < N; i += 50) {
      const lport = 20000 + i;
      expect(proxiedByTailscaled({ address: "127.0.0.1", port: lport }, ours, H)).toBe(expected.get(lport)!);
    }
  });
});
