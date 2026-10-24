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
import { Socket } from "node:net";
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
  bool(v: boolean) { this.u32(v ? 1 : 0); }
  /** BYTE ARRAY content, written as is. */
  raw(b: Buffer) { this.need(b.length); b.copy(this.buf, this.len); this.len += b.length; }
  /** ARRAY: u32 byte length of the elements, padding up to the element's own
   *  alignment (which is NOT counted in the length), then the elements. The
   *  length is written last, once `body` has said how long it was. */
  array(elemAlign: number, body: () => void) {
    this.u32(0);
    const at = this.len - 4;
    this.align(elemAlign);
    const start = this.len;
    body();
    this.buf.writeUInt32LE(this.len - start, at);
  }
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
  /** `ao`: a list of object paths. */
  paths(): string[] {
    const stop = this.u32() + this.pos;
    const out: string[] = [];
    while (this.pos < stop) out.push(this.str());
    return out;
  }
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
    // Only REPLY_SERIAL names the call a reply answers; UNIX_FDS is a 'u' too.
    if (type === "u") { const v = r.u32(); if (code === F.REPLY_SERIAL) replySerial = v; }
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
  private queue = new Map<number, (m: Msg | Error) => void>();
  private buf = Buffer.alloc(0);

  private constructor(sock: Socket) {
    this.sock = sock;
    sock.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      for (;;) {
        // Only little-endian is read. Anything else cannot be framed, so the
        // connection is dropped rather than read as garbage until a timeout.
        if (this.buf.length && this.buf[0] !== 0x6c) { this.drain(new Error("unsupported byte order")); this.sock.destroy(); return; }
        const got = parse(this.buf);
        if (!got) break;
        this.buf = this.buf.subarray(got.used);
        const done = this.queue.get(got.msg.replySerial);
        if (done) { this.queue.delete(got.msg.replySerial); done(got.msg); }
      }
    });
    // A bus that goes away answers nothing: every call waiting on it fails now,
    // not after its own five seconds each (inside `exclusive`, those add up).
    sock.on("error", () => this.drain(new Error("the session bus connection failed")));
    sock.on("close", () => this.drain(new Error("the session bus connection closed")));
  }

  private drain(why: Error): void {
    const waiting = [...this.queue.values()];
    this.queue.clear();
    for (const done of waiting) done(why);
  }

  static async open(): Promise<Bus | null> {
    const where = busPath();
    if (!where) return null;
    const sock = await new Promise<Socket | null>((res) => {
      // Listeners first, connect after: with no D-Bus socket (a container, a
      // CI runner) Bun 1.3.14 emits ENOENT synchronously inside connect(), and
      // an `error` nobody listens to yet is thrown, which killed the server.
      const s = new Socket();
      // A connect that comes after the wait would otherwise hold its fd for good.
      const late = setTimeout(() => { s.destroy(); res(null); }, 2000);
      s.once("connect", () => { clearTimeout(late); res(s); });
      s.once("error", () => { clearTimeout(late); res(null); });
      s.connect({ path: where.path });
    });
    if (!sock) return null;
    // EXTERNAL auth: a leading NUL, then the uid in hex. No SASL round trips
    // beyond this one on a session bus we already own.
    const uid = Buffer.from(String(userInfo().uid), "ascii").toString("hex");
    const hello = await new Promise<string>((res) => {
      let acc = "";
      const wait = setTimeout(() => { sock.off("data", on); res(acc); }, 2000);
      const on = (d: Buffer) => {
        acc += d.toString("ascii");
        if (acc.includes("\r\n")) { clearTimeout(wait); sock.off("data", on); res(acc); }
      };
      sock.on("data", on);
      sock.write(`\0AUTH EXTERNAL ${uid}\r\n`);
    });
    if (!hello.startsWith("OK")) { sock.destroy(); return null; }
    sock.write("BEGIN\r\n");
    const bus = new Bus(sock);
    try { await bus.call("/org/freedesktop/DBus", "org.freedesktop.DBus", "Hello", "org.freedesktop.DBus", "", Buffer.alloc(0)); }
    catch { bus.close(); return null; }
    return bus;
  }

  call(path: string, iface: string, member: string, dest: string, sig: string, body: Buffer): Promise<Msg> {
    const serial = ++this.serial;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.queue.delete(serial); rej(new Error(`${member} timed out`)); }, 5000);
      this.queue.set(serial, (m) => { clearTimeout(timer); m instanceof Error ? rej(m) : m.error ? rej(new Error(m.error)) : res(m); });
      if (this.sock.destroyed) { this.drain(new Error("the session bus connection closed")); return; }
      this.sock.write(frame(serial, path, iface, member, dest, sig, body));
    });
  }

  close() { try { this.sock.destroy(); } catch { /* already gone */ } }
}

/* ----------------------------------------------------------------- the ask */

const SECRETS = "org.freedesktop.secrets";
const ROOT = "/org/freedesktop/secrets";
const SVC = "org.freedesktop.Secret.Service";

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

/* ------------------------------------------------------- writing, by hand too */

/*
 * The write side: put, get and drop one item in the DEFAULT collection, for the
 * option that keeps agentglass's own secrets in the keyring instead of a 0600
 * file. Same hand-written marshalling, same one-connection-per-operation, and
 * one rule that the read side above does not need to state: nothing here ever
 * prompts. A locked collection is reported as locked and left alone, because a
 * password dialog that appears while a person is pasting a token into a form
 * is the app asking for something it has no business asking for. Unlocking is
 * the desktop's job (login does it).
 *
 * The ceiling: only the collection the `default` alias points to (gnome-keyring
 * and KeePassXC's login collection, kwallet's Secret Service bridge). A machine
 * whose keyring has no default collection is "unavailable", not "create one".
 */

/** Why an operation could not run: the keyring needs a person, or is not there. */
export class KeyringError extends Error {
  constructor(readonly state: "locked" | "unavailable", message: string) { super(message); }
}

export type KeyringState = "ready" | "locked" | "unavailable";

const COLLECTION = "org.freedesktop.Secret.Collection";
const ITEM = "org.freedesktop.Secret.Item";
const PROMPT = "org.freedesktop.Secret.Prompt";

interface Ctx { bus: Bus; session: string; collection: string }

/** One connection with a plain session and an unlocked default collection, or a KeyringError saying which part was missing. */
async function inDefaultCollection<T>(fn: (c: Ctx) => Promise<T>): Promise<T> {
  const bus = await Bus.open();
  if (!bus) throw new KeyringError("unavailable", "no session bus");
  try {
    let session = "", collection = "";
    try {
      const w1 = new Writer();
      w1.str("plain");
      w1.sig("s"); w1.str("");
      const open = await bus.call(ROOT, SVC, "OpenSession", SECRETS, "sv", w1.out());
      const r1 = new Reader(open.body);
      r1.sig(); r1.str();
      session = r1.str();
      const w2 = new Writer();
      w2.str("default");
      collection = new Reader((await bus.call(ROOT, SVC, "ReadAlias", SECRETS, "s", w2.out())).body).str();
    } catch {
      throw new KeyringError("unavailable", "nothing answers as the Secret Service");
    }
    if (!session || !collection || collection === "/") throw new KeyringError("unavailable", "the keyring has no default collection");
    let locked = true;
    try {
      const w3 = new Writer();
      w3.str(COLLECTION); w3.str("Locked");
      const r3 = new Reader((await bus.call(collection, "org.freedesktop.DBus.Properties", "Get", SECRETS, "ss", w3.out())).body);
      r3.sig();
      locked = r3.u32() !== 0;
    } catch {
      throw new KeyringError("unavailable", "the default collection does not answer");
    }
    if (locked) throw new KeyringError("locked", "the keyring is locked");
    return await fn({ bus, session, collection });
  } finally {
    bus.close();
  }
}

/** `a{ss}` */
function attributes(w: Writer, attrs: Record<string, string>) {
  w.array(8, () => { for (const [k, v] of Object.entries(attrs)) { w.align(8); w.str(k); w.str(v); } });
}

/** The body of Collection.CreateItem(a{sv}, (oayays), b): label and attributes
 *  as variants, the secret in the clear over the plain session, replace on. */
export function createItemBody(label: string, attrs: Record<string, string>, session: string, value: string): Buffer {
  const w = new Writer();
  w.array(8, () => {
    w.align(8); w.str(`${ITEM}.Label`); w.sig("s"); w.str(label);
    w.align(8); w.str(`${ITEM}.Attributes`); w.sig("a{ss}"); attributes(w, attrs);
  });
  w.align(8); w.str(session);
  w.array(1, () => {});
  w.array(1, () => w.raw(Buffer.from(value, "utf8")));
  w.str("text/plain");
  w.bool(true);
  return w.out();
}

async function search(c: Ctx, attrs: Record<string, string>): Promise<string[]> {
  const w = new Writer();
  attributes(w, attrs);
  return new Reader((await c.bus.call(c.collection, COLLECTION, "SearchItems", SECRETS, "a{ss}", w.out())).body).paths();
}

/** A method that answers with a prompt path means the desktop wants a person:
 *  say no to it and report locked. */
async function noPrompt(c: Ctx, prompt: string): Promise<void> {
  if (prompt === "/") return;
  await c.bus.call(prompt, PROMPT, "Dismiss", SECRETS, "", Buffer.alloc(0)).catch(() => {});
  throw new KeyringError("locked", "the keyring asked for a person");
}

export async function keyringAvailability(): Promise<KeyringState> {
  try { await inDefaultCollection(async () => {}); return "ready"; }
  catch (e) { return e instanceof KeyringError ? e.state : "unavailable"; }
}

/** Store one secret, replacing the item with the same attributes. */
export async function keyringPut(attrs: Record<string, string>, label: string, value: string): Promise<void> {
  await inDefaultCollection(async (c) => {
    const made = await c.bus.call(c.collection, COLLECTION, "CreateItem", SECRETS, "a{sv}(oayays)b", createItemBody(label, attrs, c.session, value));
    const r = new Reader(made.body);
    r.str();
    await noPrompt(c, r.str());
  });
}

/** The secret, or null when no item has these attributes. */
export async function keyringGet(attrs: Record<string, string>): Promise<string | null> {
  return inDefaultCollection(async (c) => {
    const item = (await search(c, attrs))[0];
    if (!item) return null;
    const w = new Writer();
    w.str(c.session);
    const got = new Reader((await c.bus.call(item, ITEM, "GetSecret", SECRETS, "o", w.out())).body);
    got.align(8); got.str();
    got.bytes(got.u32());
    return got.bytes(got.u32()).toString("utf8");
  });
}

/** Delete every item with these attributes; none is not an error. */
export async function keyringDrop(attrs: Record<string, string>): Promise<void> {
  await inDefaultCollection(async (c) => {
    for (const item of await search(c, attrs)) {
      await noPrompt(c, new Reader((await c.bus.call(item, ITEM, "Delete", SECRETS, "", Buffer.alloc(0))).body).str());
    }
  });
}
