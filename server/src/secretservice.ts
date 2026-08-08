/*
 * Asking the desktop keyring for one password, over D-Bus, by hand.
 *
 * This exists because Chrome does not store its cookies in the clear. On Linux
 * it seals each value with AES, under a key derived from a password called
 * "Chrome Safe Storage" that lives in gnome-keyring or kwallet. Without that
 * password the importer can only ever say "locked", which is what it said —
 * wrongly, and with some confidence — until this was written.
 *
 * Why by hand rather than with a library:
 *
 *   - `secret-tool` is a separate package and is not installed on the machine
 *     this was written for;
 *   - libsecret through PyGObject works, and needs the SYSTEM python with `gi`,
 *     which the packaged app cannot count on (the python first on PATH here is
 *     a brew one, without it);
 *   - `gdbus call` cannot do it AT ALL, and the reason is worth writing down:
 *     the Secret Service hands out a session bound to the D-Bus CONNECTION
 *     that opened it, and every `gdbus call` is its own connection. Open a
 *     session in one invocation and ask for a secret in the next and the
 *     answer is "The session does not exist". Measured, not guessed.
 *
 * So: one connection, held open across the four calls the protocol needs. The
 * marshalling below covers exactly the signatures those four calls use and
 * nothing else — this is not a D-Bus library, it is the shortest path to one
 * password.
 */
import { createConnection, type Socket } from "node:net";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const LE = true;

/* ------------------------------------------------------------- marshalling */

class Writer {
  buf = Buffer.alloc(256);
  len = 0;
  private need(n: number) {
    while (this.len + n > this.buf.length) this.buf = Buffer.concat([this.buf, Buffer.alloc(this.buf.length)]);
  }
  /** D-Bus aligns every value to its own size; the padding is zero bytes. */
  align(n: number) { const p = (n - (this.len % n)) % n; this.need(p); this.buf.fill(0, this.len, this.len + p); this.len += p; }
  byte(v: number) { this.need(1); this.buf.writeUInt8(v, this.len); this.len += 1; }
  u32(v: number) { this.align(4); this.need(4); this.buf.writeUInt32LE(v, this.len); this.len += 4; }
  /** STRING and OBJECT_PATH: u32 length, bytes, NUL. */
  str(v: string) { const b = Buffer.from(v, "utf8"); this.u32(b.length); this.need(b.length + 1); b.copy(this.buf, this.len); this.len += b.length; this.buf.writeUInt8(0, this.len); this.len += 1; }
  /** SIGNATURE: one length byte instead of four. */
  sig(v: string) { const b = Buffer.from(v, "ascii"); this.byte(b.length); this.need(b.length + 1); b.copy(this.buf, this.len); this.len += b.length; this.buf.writeUInt8(0, this.len); this.len += 1; }
  out(): Buffer { return this.buf.subarray(0, this.len); }
}

class Reader {
  constructor(private b: Buffer, public pos = 0) {}
  align(n: number) { this.pos += (n - (this.pos % n)) % n; }
  byte(): number { return this.b.readUInt8(this.pos++); }
  u32(): number { this.align(4); const v = this.b.readUInt32LE(this.pos); this.pos += 4; return v; }
  str(): string { const n = this.u32(); const s = this.b.toString("utf8", this.pos, this.pos + n); this.pos += n + 1; return s; }
  sig(): string { const n = this.byte(); const s = this.b.toString("ascii", this.pos, this.pos + n); this.pos += n + 1; return s; }
  bytes(n: number): Buffer { const s = this.b.subarray(this.pos, this.pos + n); this.pos += n; return s; }
  get end(): number { return this.b.length; }
}

/** Header field codes, of the six this needs. */
const F = { PATH: 1, INTERFACE: 2, MEMBER: 3, ERROR: 4, REPLY_SERIAL: 5, DESTINATION: 6, SIGNATURE: 8 } as const;

interface Msg { type: number; serial: number; replySerial: number; error: string; signature: string; body: Buffer }

function frame(serial: number, path: string, iface: string, member: string, dest: string, sigStr: string, body: Buffer): Buffer {
  const h = new Writer();
  h.byte(LE ? 0x6c : 0x42);   // 'l'
  h.byte(1);                  // METHOD_CALL
  h.byte(0);                  // no flags
  h.byte(1);                  // protocol version
  h.u32(body.length);
  h.u32(serial);
  // a(yv) — the header fields.
  const f = new Writer();
  const field = (code: number, type: string, v: string) => {
    f.align(8);
    f.byte(code);
    f.sig(type);
    if (type === "g") f.sig(v); else f.str(v);
  };
  field(F.PATH, "o", path);
  field(F.DESTINATION, "s", dest);
  field(F.INTERFACE, "s", iface);
  field(F.MEMBER, "s", member);
  if (sigStr) field(F.SIGNATURE, "g", sigStr);
  h.u32(f.len);
  const fb = f.out();
  const out = Buffer.concat([h.out(), fb]);
  // The body starts on an 8-byte boundary after the header.
  const pad = (8 - (out.length % 8)) % 8;
  return Buffer.concat([out, Buffer.alloc(pad), body]);
}

function parse(buf: Buffer): { msg: Msg; used: number } | null {
  if (buf.length < 16) return null;
  const bodyLen = buf.readUInt32LE(4);
  const serial = buf.readUInt32LE(8);
  const fieldsLen = buf.readUInt32LE(12);
  const headerEnd = 16 + fieldsLen;
  const bodyStart = headerEnd + ((8 - (headerEnd % 8)) % 8);
  if (buf.length < bodyStart + bodyLen) return null;

  const r = new Reader(buf.subarray(0, headerEnd), 16);
  let replySerial = 0, error = "", signature = "";
  while (r.pos < headerEnd) {
    r.align(8);
    if (r.pos >= headerEnd) break;
    const code = r.byte();
    const type = r.sig();
    if (type === "u") replySerial = r.u32();
    else if (type === "g") { const v = r.sig(); if (code === F.SIGNATURE) signature = v; }
    else { const v = r.str(); if (code === F.ERROR) error = v; }
  }
  return {
    msg: { type: buf.readUInt8(1), serial, replySerial, error, signature, body: buf.subarray(bodyStart, bodyStart + bodyLen) },
    used: bodyStart + bodyLen,
  };
}

/* ------------------------------------------------------------- the session */

/** Where the bus socket is. The address is normally `unix:path=…` or
 *  `unix:abstract=…`; the abstract form is a Linux namespace and is written
 *  with a leading NUL. */
function busPath(): { path: string } | null {
  const addr = process.env.DBUS_SESSION_BUS_ADDRESS
    || `unix:path=${join("/run/user", String(userInfo().uid), "bus")}`;
  const abstract = /unix:abstract=([^,]+)/.exec(addr);
  if (abstract) return { path: `\0${abstract[1]}` };
  const p = /unix:path=([^,]+)/.exec(addr);
  if (p) return { path: p[1]! };
  return null;
}

class Bus {
  private sock: Socket;
  private serial = 1;
  private queue = new Map<number, (m: Msg) => void>();
  private buf = Buffer.alloc(0);

  private constructor(sock: Socket) {
    this.sock = sock;
    sock.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      for (;;) {
        const got = parse(this.buf);
        if (!got) break;
        this.buf = this.buf.subarray(got.used);
        const done = this.queue.get(got.msg.replySerial);
        if (done) { this.queue.delete(got.msg.replySerial); done(got.msg); }
      }
    });
  }

  static async open(): Promise<Bus | null> {
    const where = busPath();
    if (!where) return null;
    const sock = await new Promise<Socket | null>((res) => {
      // `createConnection(path)` is the unix-socket overload; the typings
      // prefer the TCP one, hence the shape rather than a bare string.
      const s = createConnection({ path: where.path });
      s.once("connect", () => res(s));
      s.once("error", () => res(null));
      setTimeout(() => res(null), 2000);
    });
    if (!sock) return null;
    // EXTERNAL auth: a leading NUL, then the uid in hex. No SASL round trips
    // beyond this one on a session bus we already own.
    const uid = Buffer.from(String(userInfo().uid), "ascii").toString("hex");
    const hello = await new Promise<string>((res) => {
      let acc = "";
      const on = (d: Buffer) => {
        acc += d.toString("ascii");
        if (acc.includes("\r\n")) { sock.off("data", on); res(acc); }
      };
      sock.on("data", on);
      sock.write(`\0AUTH EXTERNAL ${uid}\r\n`);
      setTimeout(() => { sock.off("data", on); res(acc); }, 2000);
    });
    if (!hello.startsWith("OK")) { sock.destroy(); return null; }
    sock.write("BEGIN\r\n");
    const bus = new Bus(sock);
    await bus.call("/org/freedesktop/DBus", "org.freedesktop.DBus", "Hello", "org.freedesktop.DBus", "", Buffer.alloc(0));
    return bus;
  }

  call(path: string, iface: string, member: string, dest: string, sig: string, body: Buffer): Promise<Msg> {
    const serial = ++this.serial;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.queue.delete(serial); rej(new Error(`${member} timed out`)); }, 5000);
      this.queue.set(serial, (m) => { clearTimeout(timer); m.error ? rej(new Error(m.error)) : res(m); });
      this.sock.write(frame(serial, path, iface, member, dest, sig, body));
    });
  }

  close() { try { this.sock.destroy(); } catch { /* already gone */ } }
}

/* ----------------------------------------------------------------- the ask */

const SECRETS = "org.freedesktop.secrets";
const ROOT = "/org/freedesktop/secrets";

/**
 * The password an application stored in the keyring, by its attributes.
 *
 * Null whenever anything is not there — no bus, no keyring, no such item, a
 * locked collection nobody unlocked. Every one of those is "we cannot read
 * this browser", which the caller already knows how to say; none of them is
 * worth an exception.
 */
export async function keyringPassword(attrs: Record<string, string>): Promise<Buffer | null> {
  let bus: Bus | null = null;
  try {
    bus = await Bus.open();
    if (!bus) return null;

    // OpenSession("plain", variant("")) → (variant, objectpath)
    const w1 = new Writer();
    w1.str("plain");
    w1.sig("s"); w1.str("");          // the variant: signature then value
    const open = await bus.call(ROOT, "org.freedesktop.Secret.Service", "OpenSession", SECRETS, "sv", w1.out());
    const r1 = new Reader(open.body);
    r1.sig(); r1.str();                // skip the returned variant
    const session = r1.str();
    if (!session) return null;

    // SearchItems(a{ss}) → (ao unlocked, ao locked)
    const inner = new Writer();
    for (const [k, v] of Object.entries(attrs)) { inner.align(8); inner.str(k); inner.str(v); }
    const w2 = new Writer();
    w2.u32(inner.len);
    w2.align(8);
    const body2 = Buffer.concat([w2.out(), inner.out()]);
    const found = await bus.call(ROOT, "org.freedesktop.Secret.Service", "SearchItems", SECRETS, "a{ss}", body2);
    const r2 = new Reader(found.body);
    const readPaths = (): string[] => {
      const n = r2.u32();
      const stop = r2.pos + n;
      const out: string[] = [];
      while (r2.pos < stop) out.push(r2.str());
      return out;
    };
    const unlocked = readPaths();
    // Locked items are left alone on purpose: unlocking prompts, and a
    // password dialog nobody asked for is not what "import my logins" means.
    const item = unlocked[0];
    if (!item) return null;

    // GetSecrets(ao, o) → a{o(oayays)}
    const w3 = new Writer();
    const paths = new Writer();
    paths.str(item);
    w3.u32(paths.len);
    const body3 = Buffer.concat([w3.out(), paths.out()]);
    const w4 = new Writer();
    w4.str(session);
    const got = await bus.call(ROOT, "org.freedesktop.Secret.Service", "GetSecrets", SECRETS, "aoo",
      Buffer.concat([body3, alignTo(body3.length, 4), w4.out()]));

    const r3 = new Reader(got.body);
    const dictLen = r3.u32();
    const stop = r3.pos + dictLen;
    while (r3.pos < stop) {
      r3.align(8);                     // dict entry
      r3.str();                        // the item path
      r3.align(8);                     // the struct (oayays)
      r3.str();                        // session
      const paramsLen = r3.u32(); r3.bytes(paramsLen);
      const valueLen = r3.u32();
      const value = r3.bytes(valueLen);
      return Buffer.from(value);
    }
    return null;
  } catch {
    return null;
  } finally {
    bus?.close();
  }
}

/** Padding so the next value starts on its boundary. */
function alignTo(len: number, n: number): Buffer {
  return Buffer.alloc((n - (len % n)) % n);
}

/** Where Chrome-family browsers file their key. The application attribute is
 *  the browser's own name, which is why this takes it. */
export const chromeKeyringAttrs = (application: string): Record<string, string> => ({ application });

void homedir;
