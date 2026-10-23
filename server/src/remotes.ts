/*
 * The finder's remotes: SFTP and SMB shares, mounted by GVfs through `gio`.
 *
 * `gio mount -l` says what is mounted (parsed into the same rows as a local
 * volume, with the path GVfs exposes it at). Connecting is `gio mount <uri>`,
 * and gio asks for what it needs on its own stdout — a message and "User: ",
 * "Password: ", or a numbered question and "Choice: " — and reads the answer
 * from stdin. Those prompts are carried to the person as steps, one request
 * per step, so nothing polls: the next request is the answer to the last.
 *
 * Two rules the rest of this file follows:
 *   - A host key is never accepted on anyone's behalf. gio asks "Log In
 *     Anyway / Cancel" with the fingerprint in the message; the message goes
 *     to the person verbatim and only the choice they make is written back.
 *   - A credential exists in one place: the session's memory, from the moment
 *     it is typed until the prompt that asked for it is answered. It is not in
 *     the address (an address with a password is refused), not in argv, not in a
 *     file or a log, and whatever gio says afterwards is scrubbed of it.
 */
import { join } from "node:path";
import type { RemoteStep, Volume } from "../../shared/types.ts";

export interface GioProc {
  out: ReadableStream<string>;
  err: () => Promise<string>;
  write: (s: string) => void;
  kill: () => void;
  exited: Promise<number>;
}
export type SpawnGio = (argv: string[]) => GioProc;

export function spawnGio(argv: string[]): GioProc {
  const bin = Bun.which(argv[0]!);
  if (!bin) {
    return { out: new ReadableStream<string>({ start(c) { c.close(); } }), err: async () => "gio is not installed", write() {}, kill() {}, exited: Promise.resolve(127) };
  }
  const p = Bun.spawn([bin, ...argv.slice(1)], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LC_ALL: "C.UTF-8" } });
  const err = new Response(p.stderr).text();
  return {
    out: (p.stdout as ReadableStream<Uint8Array>).pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>),
    err: () => err,
    write: (s) => { try { p.stdin.write(s); void p.stdin.flush(); } catch { /* it already exited */ } },
    kill: () => { try { p.kill(); } catch { /* gone */ } },
    exited: p.exited,
  };
}

const SCHEMES = new Set(["smb", "sftp"]);
const schemeOf = (uri: string) => /^([a-z][a-z0-9+.-]*):/i.exec(uri)?.[1]?.toLowerCase() ?? "";

export interface Mounted { name: string; uri: string; path?: string }
/** `gio mount -l`: the mounts whose address is smb or sftp (ssh counts as sftp), with the path gio says they are at. */
export function parseMounts(text: string): Mounted[] {
  const out: Mounted[] = [];
  let cur: Mounted | null = null;
  for (const line of text.split("\n")) {
    const m = /^\s*Mount\(\d+\): (.+) -> (\S+)\s*$/.exec(line);
    if (m) {
      const sc = schemeOf(m[2]!);
      cur = sc === "smb" || sc === "sftp" || sc === "ssh" ? { name: m[1]!, uri: m[2]! } : null;
      if (cur) out.push(cur);
      continue;
    }
    const d = /^\s*default_location=file:\/\/(\/\S+)\s*$/.exec(line);
    if (d && cur) { try { cur.path = decodeURIComponent(d[1]!); } catch { /* not a path we understand */ } }
  }
  return out;
}

/** The folder GVfs shows a mount at, found by name when gio did not say: smb-share:server=H,share=S or sftp:host=H[,user=U]. */
function pathFromEntries(uri: string, entries: readonly string[], dir: string): string | undefined {
  let u: URL;
  try { u = new URL(uri); } catch { return undefined; }
  const host = u.hostname.toLowerCase();
  const hit = entries.find((e) => {
    const l = e.toLowerCase();
    if (schemeOf(uri) === "smb") return l.startsWith("smb-share:") && l.includes(`server=${host}`) && l.includes(`share=${decodeURIComponent(u.pathname.split("/")[1] ?? "").toLowerCase()}`);
    return l.startsWith("sftp:") && l.includes(`host=${host}`) && (!u.username || l.includes(`user=${decodeURIComponent(u.username).toLowerCase()}`));
  });
  return hit ? join(dir, hit) : undefined;
}

interface Addr { scheme: string; user: string; host: string; port: string; path: string }
function addr(raw: string): Addr | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  const scheme = u.protocol.slice(0, -1).toLowerCase().replace(/^ssh$/, "sftp");
  if (scheme !== "sftp" && scheme !== "smb") return null;
  try { return { scheme, user: decodeURIComponent(u.username).toLowerCase(), host: u.hostname.toLowerCase(), port: u.port || (scheme === "sftp" ? "22" : "445"), path: decodeURIComponent(u.pathname).replace(/\/+$/, "") }; } catch { return null; }
}

/**
 * Whether two addresses name the same mount: scheme (ssh is sftp), host, port and path compare after the case of the scheme and host, the default port, a trailing slash and %-encoding are taken out. A user counts only when both name one, as gio lists a mount with or without it.
 * The ceiling: it says nothing about two hostnames for one machine.
 */
export function sameRemote(a: string, b: string): boolean {
  const x = addr(a), y = addr(b);
  if (!x || !y) return false;
  if (x.scheme !== y.scheme || x.host !== y.host || x.port !== y.port || x.path !== y.path) return false;
  return !x.user || !y.user || x.user === y.user;
}

export function remotesFromMounts(text: string, entries: readonly string[], gvfsDir: string): Volume[] {
  return parseMounts(text).map((m) => {
    const sc = schemeOf(m.uri) === "smb" ? "smb" : "sftp";
    // The path must be inside the gvfs folder, whoever claims otherwise: this is what the finder is then allowed to open.
    const mountPoint = (m.path && m.path.startsWith(gvfsDir + "/") && !m.path.includes("/../") ? m.path : undefined) ?? pathFromEntries(m.uri, entries, gvfsDir);
    return { id: m.uri, name: m.name, encrypted: false, locked: false, mounted: true, ...(mountPoint ? { mountPoint } : {}), release: "unmount" as const, size: 0, remote: sc };
  });
}

export function gvfsDir(): string { return join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`, "gvfs"); }

export type Validated = { ok: true; uri: string; scheme: "smb" | "sftp" } | { ok: false; error: string };
export function validateUri(raw: unknown): Validated {
  if (typeof raw !== "string" || raw === "" || raw.length > 2048 || /[\s\x00-\x1f\x7f]/.test(raw)) return { ok: false, error: "that is not an address gio can mount" };
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, error: "that is not an address gio can mount" }; }
  const sc = u.protocol.slice(0, -1);
  if (sc !== "smb" && sc !== "sftp" && sc !== "ssh") return { ok: false, error: "only smb:// and sftp:// addresses can be connected to" };
  if (!u.hostname) return { ok: false, error: "the address has no server" };
  if (u.password) return { ok: false, error: "type the password in the dialog, not in the address" };
  const uri = sc === "ssh" ? "sftp:" + raw.slice("ssh:".length) : raw;
  return { ok: true, uri, scheme: sc === "smb" ? "smb" : "sftp" };
}

export function backendMessage(uriOrScheme: string): string {
  const scheme = (uriOrScheme.split("://")[0] ?? "").toLowerCase();
  const pkg: Record<string, string> = { smb: "gvfs-smb or gvfs-backends", sftp: "gvfs or gvfs-backends", ftp: "gvfs or gvfs-backends", ftps: "gvfs or gvfs-backends", dav: "gvfs or gvfs-backends", davs: "gvfs or gvfs-backends" };
  return pkg[scheme]
    ? `The ${scheme}:// backend isn't installed. Install your distribution's GVfs ${scheme} backend, commonly packaged as ${pkg[scheme]}, then try again.`
    : `The ${scheme}:// backend isn't installed on this system, so ${scheme}:// locations can't be opened. Install the matching GVfs backend from your distribution, then try again.`;
}

export type Pending =
  | { kind: "prompt"; label: "User" | "Domain" | "Password"; fallback?: string; message: string }
  | { kind: "question"; message: string; choices: string[] };

/** What gio is waiting for, from what it has printed so far; null while a line is still being written. */
export function parsePending(buf: string): Pending | null {
  const lines = buf.split("\n");
  const last = lines.pop() ?? "";
  const p = /^(User|Domain|Password)(?: \[(.*)\])?: $/.exec(last);
  if (p) return { kind: "prompt", label: p[1] as "User" | "Domain" | "Password", ...(p[2] ? { fallback: p[2] } : {}), message: lines.join("\n").trim() };
  if (last === "Choice: ") {
    const choices: string[] = [];
    while (lines.length && /^\[\d+\] /.test(lines[lines.length - 1]!)) choices.unshift(lines.pop()!.replace(/^\[\d+\] /, ""));
    if (choices.length) return { kind: "question", message: lines.join("\n").trim(), choices };
  }
  return null;
}

const failure = (uri: string, raw: string, secrets: string[]): Extract<RemoteStep, { state: "error" }> => {
  let line = (raw.split("\n").find((l) => l.trim()) ?? "").trim().replace(/^gio:\s*/, "");
  line = line.replace(uri, "").replace(/^:\s*/, "").trim();
  for (const s of secrets) if (s) line = line.split(s).join("");
  if (/not supported/i.test(line)) return { state: "error", error: backendMessage(uri), missing: true };
  return { state: "error", error: line.slice(0, 240) || "gio could not mount it" };
};

interface Live { proc: GioProc; uri: string; buf: string; answers: Record<string, string>; code: number | null; pumped: boolean; lastAt: number; wake: (() => void) | null; timer: ReturnType<typeof setTimeout>; asked: Pending | null; used: string[] }

/** The connections in flight. A session is one `gio mount`, and it is gone the moment it ends, is cancelled, or sits unanswered for two minutes. */
export class Sessions {
  private live = new Map<string, Live>();
  constructor(private spawn: SpawnGio = spawnGio, private where: (uri: string) => Promise<string | undefined> = async () => undefined, private ttlMs = 120_000, private quietMs = 250) {}

  async start(raw: unknown): Promise<RemoteStep> {
    const v = validateUri(raw);
    if (!v.ok) return { state: "error", error: v.error };
    if (this.live.size >= 4) return { state: "error", error: "too many connections are waiting for an answer" };
    const proc = this.spawn(["gio", "mount", v.uri]);
    const id = crypto.randomUUID();
    const s: Live = { proc, uri: v.uri, buf: "", answers: {}, code: null, pumped: false, lastAt: Date.now(), wake: null, asked: null, used: [], timer: setTimeout(() => this.end(id), this.ttlMs) };
    this.live.set(id, s);
    void proc.exited.then((c) => { s.code = c; s.wake?.(); });
    void (async () => {
      try { const r = proc.out.getReader(); for (;;) { const { value, done } = await r.read(); if (done) break; s.buf += value; s.lastAt = Date.now(); s.wake?.(); } } catch { /* the pipe closed */ }
      s.pumped = true; s.wake?.();
    })();
    return this.next(id);
  }

  async answer(id: string, a: { answers?: Record<string, unknown>; choice?: unknown }): Promise<RemoteStep> {
    const s = this.live.get(id);
    if (!s) return { state: "error", error: "no such connection" };
    const q = s.asked;
    if (q?.kind === "question") {
      const n = Number(a.choice);
      if (!Number.isInteger(n) || n < 1 || n > q.choices.length) { this.end(id); return { state: "error", error: "that is not one of the choices" }; }
      s.buf = ""; s.asked = null; s.proc.write(`${n}\n`);
    } else if (q?.kind === "prompt") {
      for (const k of ["User", "Domain", "Password"] as const) { const v = a.answers?.[k]; if (typeof v === "string" && v.length <= 1024 && !/[\r\n]/.test(v)) s.answers[k] = v; }
    }
    return this.next(id);
  }

  cancel(id: string) { this.end(id); }

  private end(id: string) {
    const s = this.live.get(id);
    if (!s) return;
    clearTimeout(s.timer); s.answers = {}; s.used = []; s.buf = "";
    this.live.delete(id);
    try { s.proc.kill(); } catch { /* gone */ }
  }

  private async next(id: string): Promise<RemoteStep> {
    const s = this.live.get(id)!;
    for (;;) {
      const p = parsePending(s.buf);
      // gio waits for its answer after a real prompt and says nothing more. A server's own banner or share name can end in "Password: ", so a prompt counts only once the line has been quiet (L1 of the p67 review: a ceiling, not a proof: a server that stalls on purpose still looks like gio waiting).
      const quiet = this.quietMs - (Date.now() - s.lastAt);
      if (p && quiet > 0 && s.code === null) {
        await new Promise<void>((res) => { s.wake = res; setTimeout(res, quiet).unref?.(); });
        s.wake = null;
        if (!this.live.has(id)) return { state: "error", error: "no such connection" };
        continue;
      }
      if (p?.kind === "prompt" && p.label in s.answers) {
        const typed = s.answers[p.label]!;
        delete s.answers[p.label];
        if (typed) s.used.push(typed);
        s.buf = ""; s.asked = null;
        s.proc.write((typed === "" && p.fallback ? "" : typed) + "\n");
        continue;
      }
      if (p?.kind === "prompt") {
        s.asked = p;
        const m = p.message;
        const fields = (["User", "Domain", "Password"] as const).filter((f) => f === p.label || (f === "User" && /user/i.test(m)) || (f === "Domain" && /domain/i.test(m)) || (f === "Password" && /password|passphrase/i.test(m)));
        return { state: "password", session: id, message: m, fields, defaults: p.label === "User" && p.fallback ? { User: p.fallback } : p.label === "Domain" && p.fallback ? { Domain: p.fallback } : {} };
      }
      if (p?.kind === "question") { s.asked = p; return { state: "question", session: id, message: p.message, choices: p.choices }; }
      if (s.code !== null && s.pumped) {
        const secrets = [...s.used, ...Object.values(s.answers)];
        const code = s.code, uri = s.uri, err = await s.proc.err().catch(() => "");
        this.end(id);
        // gio refuses an address that is already mounted, and that is where the person wanted to be.
        if (code === 0 || /already mounted/i.test(err)) return { state: "done", uri, mountPoint: await this.where(uri) };
        return failure(uri, err, secrets);
      }
      await new Promise<void>((res) => { s.wake = res; setTimeout(res, 60_000).unref?.(); });
      s.wake = null;
      if (!this.live.has(id)) return { state: "error", error: "no such connection" };
    }
  }
}

/** Who may connect, or answer a prompt: only a request with the desk key. The dialog is where credentials are typed and a host key is judged, and an Origin header or the machine token does not prove a person is there. */
export function remotePolicy(deskProven: boolean): string | null {
  return deskProven ? null : "only the desktop app can connect to a server for a person: credentials and host keys are theirs to give and judge";
}

/** What the Network row lists: gio's own view of `network:///`, or Strata's sentence when that backend is not installed. */
export async function discoverNetwork(run: (argv: string[]) => Promise<{ code: number; out: string; err: string }>): Promise<{ ok: boolean; entries: { name: string; uri: string }[]; error?: string }> {
  const r = await run(["gio", "list", "-u", "network:///"]);
  if (r.code === 127) return { ok: false, entries: [], error: "gio is not installed" };
  if (r.code !== 0) return { ok: false, entries: [], error: /not supported/i.test(r.err) ? backendMessage("network:///") : (r.err.split("\n").find((l) => l.trim()) ?? "").replace(/^gio:\s*/, "").slice(0, 240) || "the network could not be listed" };
  const entries = r.out.split("\n").map((l) => l.trim()).filter((u) => /^[a-z][a-z0-9+.-]*:\/\//i.test(u) && !/[\x00-\x1f]/.test(u)).map((uri) => {
    const seg = uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "").split("/").pop() ?? uri;
    let name = seg; try { name = decodeURIComponent(seg); } catch { /* keep the raw spelling */ }
    return { name, uri };
  });
  return { ok: true, entries };
}
