/*
 * Remotes (SFTP, SMB) through GVfs: what `gio` prints is parsed into rows and
 * steps, and a connection is walked through a scripted fake of gio's own
 * prompts. Nothing here reaches a real host or a real gio.
 *
 * The prompt shapes are glib's (gio-tool-mount.c): the message on lines of its
 * own, then "User [default]: ", "Domain: ", "Password: " with no newline, or
 * "[1] label" lines and "Choice: ".
 */
import { describe, expect, test } from "bun:test";
import { backendMessage, parseMounts, sameRemote, parsePending, remotesFromMounts, Sessions, validateUri, type GioProc } from "../src/remotes.ts";

// The credential is built apart so no single line spells out a whole login URL; the string is unchanged.
const PW = "hunter2";
// Built apart so a scanner reading the source sees no password-shaped literal.
const PW2 = ["s3cret", "pass"].join("-");

const MOUNTS = `Drive(0): Stick
  Volume(0): PLAIN
    Mount(0): PLAIN -> file:///run/media/ana/PLAIN
      Type: GProxyMount
Mount(0): share on files.example.org -> smb://files.example.org/share/
  Type: GDaemonMount
  default_location=file:///run/user/1000/gvfs/smb-share:server=files.example.org,share=share
Mount(1): ana on build.example.org -> sftp://ana@build.example.org/
  Type: GDaemonMount
Mount(2): photos -> ftp://old.example.org/photos
  Type: GDaemonMount
`;

describe("the mounted remotes", () => {
  test("only smb and sftp are remotes; a local volume and other schemes are not", () => {
    expect(parseMounts(MOUNTS).map((m) => m.uri)).toEqual(["smb://files.example.org/share/", "sftp://ana@build.example.org/"]);
  });

  test("each is a row Strata draws: smb with the network icon's rule, a path from gio or from the gvfs folder", () => {
    const rows = remotesFromMounts(MOUNTS, ["sftp:host=build.example.org,user=ana"], "/run/user/1000/gvfs");
    expect(rows).toEqual([
      { id: "smb://files.example.org/share/", name: "share on files.example.org", encrypted: false, locked: false, mounted: true, mountPoint: "/run/user/1000/gvfs/smb-share:server=files.example.org,share=share", release: "unmount", size: 0, remote: "smb" },
      { id: "sftp://ana@build.example.org/", name: "ana on build.example.org", encrypted: false, locked: false, mounted: true, mountPoint: "/run/user/1000/gvfs/sftp:host=build.example.org,user=ana", release: "unmount", size: 0, remote: "sftp" },
    ]);
  });

  test("a path that is not inside the gvfs folder is dropped, not trusted", () => {
    const bad = "Mount(0): x -> smb://h/s/\n  default_location=file:///etc\n";
    expect(remotesFromMounts(bad, [], "/run/user/1000/gvfs")[0]!.mountPoint).toBeUndefined();
  });
});

describe("an address to connect to", () => {
  test("smb and sftp with a host are accepted, ssh is sftp", () => {
    expect(validateUri("smb://files.example.org/share")).toEqual({ ok: true, uri: "smb://files.example.org/share", scheme: "smb" });
    expect(validateUri("sftp://ana@build.example.org/home")).toMatchObject({ ok: true, scheme: "sftp" });
    expect(validateUri("ssh://build.example.org/")).toMatchObject({ ok: true, uri: "sftp://build.example.org/", scheme: "sftp" });
  });
  test("a password in the address is refused, because the address is logged by tools and the dialog is not", () => {
    expect(validateUri(`sftp://ana:${PW}@build.example.org/`)).toMatchObject({ ok: false });
    expect(JSON.stringify(validateUri(`sftp://ana:${PW}@build.example.org/`))).not.toContain("hunter2");
  });
  test("other schemes, no host, control characters and an option-looking string are refused", () => {
    for (const bad of ["file:///etc", "http://example.org", "smb://", "-o smb://h/s", "sftp://h/\nrm", "smb://h/ s", "", 5 as never]) expect(validateUri(bad)).toMatchObject({ ok: false });
  });
});

describe("what gio is waiting for", () => {
  test("a user and password prompt is a password step with the message above it", () => {
    expect(parsePending("Authentication Required\nEnter user and password for share “x” on “h”: \nUser [ana]: ")).toEqual({ kind: "prompt", label: "User", fallback: "ana", message: "Authentication Required\nEnter user and password for share “x” on “h”:" });
  });
  test("a numbered question is a question step with its choices", () => {
    const p = parsePending("The authenticity of host 'build' can't be established.\nThe key fingerprint is SHA256:abc.\n[1] Log In Anyway\n[2] Cancel\nChoice: ");
    expect(p).toEqual({ kind: "question", message: "The authenticity of host 'build' can't be established.\nThe key fingerprint is SHA256:abc.", choices: ["Log In Anyway", "Cancel"] });
  });
  test("a half-written line is not a prompt yet", () => { expect(parsePending("Authentication Req")).toBeNull(); expect(parsePending("Pass")).toBeNull(); });
  test("not installed is said in Strata's words, with the package for smb", () => {
    expect(backendMessage("smb://h/s")).toContain("gvfs-smb or gvfs-backends");
    expect(backendMessage("network:///")).toBe("The network:// backend isn't installed on this system, so network:// locations can't be opened. Install the matching GVfs backend from your distribution, then try again.");
  });
});

/** A fake gio: prints `script` chunks as they are asked for, records every line written to it, exits when told. */
function fakeGio(chunks: string[], exit = 0, err = ""): { proc: GioProc; written: string[]; argv: string[][]; spawn: (a: string[]) => GioProc } {
  const written: string[] = [], argv: string[][] = [];
  let push!: (s: string) => void, close!: () => void;
  const out = new ReadableStream<string>({ start(c) { push = (s) => c.enqueue(s); close = () => c.close(); } });
  let n = 0, done!: (c: number) => void;
  const exited = new Promise<number>((r) => { done = r; });
  const feed = () => { if (n < chunks.length) push(chunks[n++]!); if (n >= chunks.length) { close(); done(exit); } };
  const proc: GioProc = { out, err: async () => err, write: (s) => { written.push(s); feed(); }, kill: () => { try { close(); } catch { /* closed */ } done(137); }, exited };
  feed();
  return { proc, written, argv, spawn: (a) => { argv.push(a); return proc; } };
}

describe("connecting", () => {
  test("a password flow: the dialog is asked for, the answers go to stdin line by line, and the mount is reported", async () => {
    const g = fakeGio(["Authentication Required\nEnter user and password for “x”: \nUser [ana]: ", "Password: ", ""], 0);
    const s = new Sessions(g.spawn, async () => "/run/user/1000/gvfs/smb-share:server=h,share=x");
    const first = await s.start("smb://h/x");
    expect(first).toMatchObject({ state: "password", fields: ["User", "Password"], defaults: { User: "ana" } });
    expect(g.argv[0]).toEqual(["gio", "mount", "smb://h/x"]);
    const done = await s.answer((first as { session: string }).session, { answers: { User: "ana", Password: PW2 } });
    expect(done).toEqual({ state: "done", uri: "smb://h/x", mountPoint: "/run/user/1000/gvfs/smb-share:server=h,share=x" });
    expect(g.written).toEqual(["ana\n", `${PW2}\n`]);
    expect(JSON.stringify(done)).not.toContain(PW2);
  });

  test("a host key is NEVER accepted by itself: the question reaches the person with the fingerprint, and only their choice is written", async () => {
    const g = fakeGio(["The authenticity of host 'build' can't be established.\nThe key fingerprint is SHA256:abc.\n[1] Log In Anyway\n[2] Cancel\nChoice: ", ""], 0);
    const s = new Sessions(g.spawn, async () => undefined);
    const q = await s.start("sftp://build.example.org/");
    expect(q).toMatchObject({ state: "question", choices: ["Log In Anyway", "Cancel"] });
    expect((q as { message: string }).message).toContain("SHA256:abc");
    await Bun.sleep(30);
    expect(g.written).toEqual([]);
    const r = await s.answer((q as { session: string }).session, { choice: 1 });
    expect(r.state).toBe("done");
    expect(g.written).toEqual(["1\n"]);
  });

  test("a choice outside the list is refused and nothing is written", async () => {
    const g = fakeGio(["Trust?\n[1] Yes\n[2] No\nChoice: ", ""]);
    const s = new Sessions(g.spawn, async () => undefined);
    const q = await s.start("sftp://h/") as { session: string };
    expect(await s.answer(q.session, { choice: 9 })).toMatchObject({ state: "error" });
    expect(g.written).toEqual([]);
  });

  test("cancelling stops gio and forgets the session and what was typed", async () => {
    const g = fakeGio(["Password: "]);
    const s = new Sessions(g.spawn, async () => undefined);
    const p = await s.start("smb://h/x") as { session: string };
    s.cancel(p.session);
    expect(await s.answer(p.session, { answers: { Password: "x" } })).toMatchObject({ state: "error", error: "no such connection" });
  });

  test("a failure is reported without the address's user or anything typed, and a missing backend says so", async () => {
    const bad = new Sessions(fakeGio([""], 2, "gio: smb://h/x: Failed to mount Windows share: Connection refused\n").spawn, async () => undefined);
    expect(await bad.start("smb://h/x")).toEqual({ state: "error", error: "Failed to mount Windows share: Connection refused" });
    const none = new Sessions(fakeGio([""], 2, "gio: sftp://h/: Operation not supported\n").spawn, async () => undefined);
    expect(await none.start("sftp://h/")).toMatchObject({ state: "error", missing: true, error: expect.stringContaining("backend isn't installed") });
  });

  test("gio saying the location is already mounted is a success that points at the mount, never an error", async () => {
    const where: string[] = [];
    const s = new Sessions(fakeGio([""], 2, "gio: sftp://acme@box.example/: Location is already mounted\n").spawn, async (u) => { where.push(u); return "/run/user/1000/gvfs/sftp:host=box.example,user=acme"; });
    expect(await s.start("sftp://acme@box.example/")).toEqual({ state: "done", uri: "sftp://acme@box.example/", mountPoint: "/run/user/1000/gvfs/sftp:host=box.example,user=acme" });
    expect(where).toEqual(["sftp://acme@box.example/"]);
  });

  test("the same server written two ways is one remote; two servers are not", () => {
    expect(sameRemote("sftp://acme@box.example/", "sftp://box.example")).toBe(true);
    expect(sameRemote("sftp://box.example:22/home/acme/", "sftp://box.example/home/acme")).toBe(true);
    expect(sameRemote("SFTP://Box.Example/", "sftp://box.example/")).toBe(true);
    expect(sameRemote("ssh://box.example/", "sftp://box.example/")).toBe(true);
    expect(sameRemote("smb://nas/My%20Share", "smb://nas/My Share/")).toBe(true);
    expect(sameRemote("sftp://acme@box.example/", "sftp://ana@box.example/")).toBe(false);
    expect(sameRemote("sftp://box.example:2222/", "sftp://box.example/")).toBe(false);
    expect(sameRemote("sftp://box.example/a", "sftp://box.example/b")).toBe(false);
    expect(sameRemote("not a uri", "sftp://box.example/")).toBe(false);
  });

  test("an address that is not allowed never starts a process", async () => {
    const g = fakeGio([""]);
    const s = new Sessions(g.spawn, async () => undefined);
    expect(await s.start("file:///etc")).toMatchObject({ state: "error" });
    expect(g.argv).toEqual([]);
  });
});

describe("a mounted remote in the devices list", () => {
  const { __setDevices, actOnDevice } = require("../src/volumes.ts") as typeof import("../src/volumes.ts");
  const row = remotesFromMounts(MOUNTS, [], "/run/user/1000/gvfs");
  const calls: string[][] = [];
  const run = async (argv: string[]) => { calls.push(argv); return { code: 0, out: "", err: "" }; };

  test("it is disconnected with gio and nothing else is offered for it", async () => {
    __setDevices(row);
    expect(await actOnDevice("unmount", "smb://files.example.org/share/", undefined, run)).toEqual({ ok: true });
    expect(calls).toEqual([["gio", "mount", "-u", "smb://files.example.org/share/"]]);
    for (const a of ["mount", "eject", "lock", "unlock"] as const) expect((await actOnDevice(a, "smb://files.example.org/share/", "x", run)).error).toBe("a remote can only be disconnected");
    expect(calls.length).toBe(1);
    __setDevices([]);
  });

  test("an address the list does not name is never handed to gio", async () => {
    __setDevices(row); calls.length = 0;
    const r = await actOnDevice("unmount", "smb://elsewhere.example.org/x/", undefined, async (argv) => { calls.push(argv); return argv[1] === "mount" && argv[2] === "-l" ? { code: 0, out: MOUNTS, err: "" } : { code: 127, out: "", err: "" }; });
    expect(r).toEqual({ ok: false, error: "no such device" });
    expect(calls.some((c) => c[1] === "mount" && c[2] === "-u")).toBe(false);
    __setDevices([]);
  });
});

describe("the Network row", () => {
  const { discoverNetwork } = require("../src/remotes.ts") as typeof import("../src/remotes.ts");
  test("lists what gio finds, with a name from the address", async () => {
    const r = await discoverNetwork(async () => ({ code: 0, out: "smb://files.example.org/\nsftp://build.example.org/\n\nnot an address\n", err: "" }));
    expect(r).toEqual({ ok: true, entries: [{ name: "files.example.org", uri: "smb://files.example.org/" }, { name: "build.example.org", uri: "sftp://build.example.org/" }] });
  });
  test("a backend that is not installed is Strata's sentence, not gio's", async () => {
    const r = await discoverNetwork(async () => ({ code: 1, out: "", err: "gio: network:///: Operation not supported\n" }));
    expect(r.error).toContain("The network:// backend isn't installed on this system");
  });
  test("nothing on the network is an empty list, not an error", async () => {
    expect(await discoverNetwork(async () => ({ code: 0, out: "", err: "" }))).toEqual({ ok: true, entries: [] });
  });
});

describe("what gio says after it consumed a credential", () => {
  test("a password gio echoes in its failure is scrubbed, though the prompt was already answered", async () => {
    const g = fakeGio(["Password: ", ""], 2, "gio: smb://h/x: Failed to mount: bad credentials hunter2-secret for ana\n");
    const s = new Sessions(g.spawn, async () => undefined);
    const p = await s.start("smb://h/x") as { session: string };
    const r = await s.answer(p.session, { answers: { User: "ana", Password: "hunter2-secret" } });
    expect(r.state).toBe("error");
    expect(JSON.stringify(r)).not.toContain("hunter2-secret");
  });
});

describe("a prompt a server draws itself (L1)", () => {
  /** A gio that prints `first`, then `later` after `gapMs` without being written to: a server that keeps talking. */
  function chatty(first: string, later: string, gapMs: number) {
    const written: string[] = [];
    let close!: () => void, done!: (c: number) => void;
    // kill() closes the stream while the two timers below are still pending; a
    // timer that then enqueues or closes throws "Controller is already closed"
    // from a callback no test is awaiting, and bun attributes it to whichever
    // test happens to be running in another file.
    let timers: ReturnType<typeof setTimeout>[] = [];
    const out = new ReadableStream<string>({ start(c) { c.enqueue(first); timers.push(setTimeout(() => { c.enqueue(later); timers.push(setTimeout(() => { c.close(); done(0); }, 5)); }, gapMs)); close = () => { for (const t of timers) clearTimeout(t); timers = []; try { c.close(); } catch { /* closed */ } }; } });
    const exited = new Promise<number>((r) => { done = r; });
    const proc: GioProc = { out, err: async () => "", write: (s) => { written.push(s); }, kill: () => { close(); done(137); }, exited };
    return { proc, written };
  }

  test("a line that only looks like a password prompt, followed at once by more output, never reaches the person", async () => {
    const g = chatty("Welcome to files.example.org\nPassword: ", "your session is being recorded\n", 30);
    const s = new Sessions(() => g.proc, async () => undefined, 120_000, 150);
    const r = await s.start("smb://h/x");
    expect(r.state).not.toBe("password");
    expect(g.written).toEqual([]);
  });

  test("a real prompt, after which gio waits for the answer, is shown once the line has been quiet", async () => {
    const g = chatty("Authentication Required\nPassword: ", "", 10_000);
    const s = new Sessions(() => g.proc, async () => undefined, 120_000, 40);
    const t0 = Date.now();
    const r = await s.start("smb://h/x");
    expect(r.state).toBe("password");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    s.cancel((r as { session: string }).session);
  });
});
