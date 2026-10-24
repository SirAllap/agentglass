/*
 * The D-Bus connection the keyring client holds, against a bus that misbehaves.
 *
 * The server below is a unix socket that does the EXTERNAL handshake and then
 * answers each method call with whatever the scenario says: a reply that
 * carries a header field other than REPLY_SERIAL, a socket closed mid-call, a
 * big-endian message. Nothing here touches the developer's own session bus or
 * keyring: DBUS_SESSION_BUS_ADDRESS points at a socket in a temp directory.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "agx-bus-"));
const SOCK = join(DIR, "bus");
const REAL_ADDR = process.env.DBUS_SESSION_BUS_ADDRESS;

const { keyringAvailability } = await import("../src/secretservice.ts");

/** Little-endian writer that knows where in the message it started. */
class W {
  b: number[] = [];
  constructor(private base = 0) {}
  get pos() { return this.base + this.b.length; }
  align(n: number) { while (this.pos % n) this.b.push(0); }
  u8(v: number) { this.b.push(v); }
  u32(v: number) { this.align(4); for (let i = 0; i < 4; i++) this.b.push((v >>> (8 * i)) & 0xff); }
  str(s: string) { this.u32(Buffer.byteLength(s)); this.b.push(...Buffer.from(s)); this.b.push(0); }
  sig(s: string) { this.u8(s.length); this.b.push(...Buffer.from(s)); this.b.push(0); }
  out() { return Buffer.from(this.b); }
}

type Fields = { unixFds?: boolean };
/** A method return for the call with serial `to`. */
function methodReturn(to: number, body: Buffer, o: Fields = {}): Buffer {
  const f = new W(16);
  f.align(8); f.u8(5); f.sig("u"); f.u32(to);               // REPLY_SERIAL
  if (o.unixFds) { f.align(8); f.u8(9); f.sig("u"); f.u32(0); } // UNIX_FDS, also a 'u'
  const fields = f.out();
  const h = new W();
  h.u8(0x6c); h.u8(2); h.u8(0); h.u8(1);
  h.u32(body.length); h.u32(1); h.u32(fields.length);
  const head = Buffer.concat([h.out(), fields]);
  return Buffer.concat([head, Buffer.alloc((8 - (head.length % 8)) % 8), body]);
}
const bodyOf = (fn: (w: W) => void): Buffer => { const w = new W(); fn(w); return w.out(); };
const NONE = Buffer.alloc(0);
const openSession = bodyOf((w) => { w.sig("s"); w.str(""); w.str("/org/freedesktop/secrets/session/s1"); });
const readAlias = bodyOf((w) => w.str("/org/freedesktop/secrets/collection/login"));
const unlocked = bodyOf((w) => { w.sig("b"); w.u32(0); });

/** What the fake bus does with call number n (1 is Hello): bytes to send, or "close". */
type Scenario = (n: number, serial: number) => Buffer | "close";
let scenario: Scenario = () => "close";
let server: Server;

beforeAll(async () => {
  server = createServer((s: Socket) => {
    let raw: Buffer = Buffer.alloc(0);
    let began = false;
    let authed = false;
    let calls = 0;
    s.on("error", () => {});
    s.on("data", (d: Buffer) => {
      raw = Buffer.concat([raw, d]);
      if (!began) {
        if (!authed) {
          const authEnd = raw.indexOf("\r\n");
          if (authEnd < 0) return;
          authed = true;
          s.write("OK 00000000000000000000000000000000\r\n");
          raw = raw.subarray(authEnd + 2);
        }
        const begin = raw.indexOf("BEGIN\r\n");
        if (begin < 0) return;
        began = true;
        raw = raw.subarray(begin + 7);
      }
      while (raw.length >= 16) {
        const fieldsLen = raw.readUInt32LE(12);
        const bodyStart = 16 + fieldsLen + ((8 - ((16 + fieldsLen) % 8)) % 8);
        const total = bodyStart + raw.readUInt32LE(4);
        if (raw.length < total) return;
        const serial = raw.readUInt32LE(8);
        raw = raw.subarray(total);
        const answer = scenario(++calls, serial);
        if (answer === "close") { s.destroy(); return; }
        s.write(answer);
      }
    });
  });
  await new Promise<void>((res) => server.listen(SOCK, res));
  process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${SOCK}`;
});
afterAll(() => {
  server.close();
  if (REAL_ADDR === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = REAL_ADDR;
  rmSync(DIR, { recursive: true, force: true });
});

const happy = (extra: Fields = {}): Scenario => (n, serial) => {
  if (n === 1) return methodReturn(serial, NONE);
  if (n === 2) return methodReturn(serial, openSession, extra);
  if (n === 3) return methodReturn(serial, readAlias);
  return methodReturn(serial, unlocked);
};

describe("the connection to the session bus", () => {
  test("a well-behaved bus reads as ready", async () => {
    scenario = happy();
    expect(await keyringAvailability()).toBe("ready");
  });

  test("a UNIX_FDS field in a reply does not take the place of the reply serial", async () => {
    // Every header field of type 'u' used to be read as REPLY_SERIAL, so the
    // later one won and the reply matched no call: it waited out its timeout.
    scenario = happy({ unixFds: true });
    expect(await keyringAvailability()).toBe("ready");
  }, 8000);

  test("a bus that closes mid-call fails the call at once, not after its timeout", async () => {
    scenario = (n, serial) => (n === 1 ? methodReturn(serial, NONE) : "close");
    const t = Date.now();
    expect(await keyringAvailability()).toBe("unavailable");
    expect(Date.now() - t, "the call sat out its own five seconds").toBeLessThan(2000);
  }, 8000);

  test("a big-endian message drops the connection instead of being read as little-endian", async () => {
    const be = Buffer.alloc(16); be[0] = 0x42; be[1] = 2; be[3] = 1;
    scenario = (n, serial) => (n === 1 ? methodReturn(serial, NONE) : be);
    const t = Date.now();
    expect(await keyringAvailability()).toBe("unavailable");
    expect(Date.now() - t, "the call sat out its own five seconds").toBeLessThan(2000);
  }, 8000);
});
