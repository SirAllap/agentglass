/*
 * Reopening the session you left, without going outside the app to attach.
 *
 * The complaint, exactly: close agentglass, open it again, and the tmux session
 * you were working in is not on offer — `tmux attach -t <name>` in some other
 * terminal is what brings it back. After every rebuild.
 *
 * Two losses cause it and both are ours. The panel's client is usually the only
 * client on that server, so closing the app detaches the session; `listPanes`
 * skips servers with no client at all. And the socket was only ever held in a
 * module variable, so the next run did not know which server was yours.
 *
 * Real tmux on sockets of this file's own, because the claim is about what tmux
 * reports for a detached server, and a mock would only confirm what I already
 * believed. `-f /dev/null` on every one of them: nothing here may read the
 * user's configuration, and nothing here may touch their tmux.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryPath, recall, remember, STALE_AFTER_MS } from "../src/tmuxmemory.ts";
import { deskAttachArgv, listPanes } from "../src/tmuxctl.ts";

let home = "";
let sockdir = "";
let sockets: string[] = [];

const tmux = (sock: string, ...args: string[]): string => {
  const r = Bun.spawnSync(["tmux", "-f", "/dev/null", "-S", sock, ...args], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? new TextDecoder().decode(r.stdout).trim() : "";
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agx-tmuxmem-"));
  process.env.XDG_CONFIG_HOME = home;
  /*
   * Discovery lists `$TMUX_TMPDIR/tmux-<uid>`, and with TMUX_TMPDIR unset that
   * is the developer's own socket directory — the sessions they are working in
   * right now. Same rule as tmuxTmp.ts, one per test so two runs never meet.
   */
  process.env.TMUX_TMPDIR = home;
  sockdir = join(home, `tmux-${process.getuid?.() ?? 0}`);
  mkdirSync(sockdir, { recursive: true });
  sockets = [];
});

afterEach(() => {
  for (const s of sockets) tmux(s, "kill-server");
  rmSync(home, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.TMUX_TMPDIR;
});

/** A detached tmux server with one session in it, on a socket of its own. */
const detachedServer = (name: string): string => {
  const sock = join(sockdir, name);
  sockets.push(sock);
  tmux(sock, "new-session", "-d", "-s", name, "-x", "80", "-y", "24", "sleep 300");
  return sock;
};

describe("what is remembered", () => {
  it("keeps the socket and the session, and reads them back", () => {
    remember("/tmp/tmux-1000/default", "workbench");
    expect(recall()).toMatchObject({ socket: "/tmp/tmux-1000/default", session: "workbench" });
  });

  it("has nothing to say before anything has been written", () => {
    expect(recall()).toBe(null);
  });

  it("refuses a socket path of nothing rather than writing an empty one", () => {
    // The default socket can resolve to "", and a remembered "" would match
    // every socket discovery finds — the filter would stop filtering.
    remember("", "workbench");
    expect(recall()).toBe(null);
  });

  it("forgets a socket older than a week", () => {
    /*
     * A socket path is reused for ever — /tmp/tmux-1000/default is that name on
     * every boot — so an old one names whatever server holds it today, which is
     * a guess rather than a memory.
     */
    remember("/tmp/tmux-1000/default", "workbench", Date.now() - STALE_AFTER_MS - 1000);
    expect(recall()).toBe(null);
  });

  it("still trusts one from six days ago, so a machine off for a week comes back", () => {
    remember("/tmp/tmux-1000/default", "workbench", Date.now() - 6 * 24 * 60 * 60 * 1000);
    expect(recall()?.session).toBe("workbench");
  });

  it("survives a file somebody edited into nonsense", () => {
    // A corrupt memory costs the feature, never the run: every caller reads
    // null as "we have never been anywhere", which is how this behaved before
    // the file existed.
    mkdirSync(join(home, "agentglass"), { recursive: true });
    for (const junk of ["", "{", "null", "[]", '{"socket":42}', '{"socket":"/x"}']) {
      writeFileSync(memoryPath(), junk);
      expect(recall()).toBe(null);
    }
  });

  it("writes only under our own directory", () => {
    remember("/tmp/tmux-1000/default", "workbench");
    expect(memoryPath()).toBe(join(home, "agentglass", "tmux-last.json"));
    // And it is JSON somebody could read, not an opaque blob.
    expect(JSON.parse(readFileSync(memoryPath(), "utf8")).session).toBe("workbench");
  });
});

describe("the session you left is on offer again", () => {
  it("lists the panes of a detached server we were last attached to", () => {
    /*
     * THE BUG. Before this, a server with no client was skipped outright, so
     * the session agentglass itself had just detached was the one it would not
     * show — and the only way back was to attach from outside the app.
     */
    const sock = detachedServer("workbench");
    expect(tmux(sock, "list-clients", "-F", "#{client_tty}")).toBe(""); // nobody is attached
    remember(sock, "workbench");
    const rows = listPanes([]).filter((r) => r.session === "workbench");
    expect(rows.length).toBeGreaterThan(0);
  });

  it("still skips a detached server that is not ours", () => {
    /*
     * The filter is not being removed, and this is why it exists: the suite
     * leaves servers behind on scratch sockets and a resurrect config restores
     * real sessions into them, so an unattached server can be a convincing
     * duplicate of the one you work in, with different pane ids.
     */
    const ours = detachedServer("workbench");
    const stray = detachedServer("not-ours");
    remember(ours, "workbench");
    const names = listPanes([]).map((r) => r.session);
    expect(names).toContain("workbench");
    expect(names).not.toContain("not-ours");
    expect(stray).toBeTruthy();
  });

  it("shows nothing extra when nothing is remembered", () => {
    // The behaviour this app had before the file existed, asserted so that a
    // machine with no memory yet cannot start seeing stray servers.
    detachedServer("workbench");
    expect(listPanes([]).map((r) => r.session)).not.toContain("workbench");
  });

  it("does not resurrect a socket whose server has since died", () => {
    // A remembered path that answers nothing is not an error and not a row: the
    // tmux call fails and the caller reports no panes.
    const sock = detachedServer("workbench");
    remember(sock, "workbench");
    tmux(sock, "kill-server");
    expect(listPanes([]).map((r) => r.session)).not.toContain("workbench");
  });
});

describe("the command that puts the desk back", () => {
  it("attaches to the remembered session by its id, not its name", () => {
    /*
     * A name is matched by PREFIX unless you fight the syntax, so attaching to
     * a remembered `work` could land in `workbench` — silently, in somebody
     * else's windows. Asserted with exactly that pair.
     */
    const sock = detachedServer("work");
    tmux(sock, "new-session", "-d", "-s", "workbench", "sleep 300");
    const argv = deskAttachArgv(sock, "work");
    /*
     * Read through `list-sessions` rather than `display-message -t =work`:
     * measured on tmux 3.7, the `=name` form answers NOTHING here — the same
     * shape as `set-option -t =name` being refused outright while
     * `list-windows -t =name` accepts it. Asserting through it made the code
     * look wrong when it had returned the right id.
     */
    const id = tmux(sock, "list-sessions", "-F", "#{session_id}\t#{session_name}")
      .split("\n").find((l) => l.endsWith("\twork"))!.split("\t")[0];
    expect(argv).toEqual(["tmux", "-S", sock, "attach-session", "-t", id]);
  });

  it("is a plain attach — no grouped session, nothing owed back", () => {
    // Deliberately not the phone's attach: that one makes a session of its own
    // so two screens can differ in size, and marks window-size to hand back.
    // The desk IS the session.
    const sock = detachedServer("workbench");
    const argv = deskAttachArgv(sock, "workbench")!;
    expect(argv).toContain("attach-session");
    expect(argv).not.toContain("new-session");
    expect(argv.join(" ")).not.toContain("window-size");
  });

  it("says no when that session is gone, so the panel opens a shell instead", () => {
    const sock = detachedServer("workbench");
    expect(deskAttachArgv(sock, "gone")).toBe(null);
    tmux(sock, "kill-server");
    expect(deskAttachArgv(sock, "workbench")).toBe(null);
  });

  it("says no to an empty socket or an empty name rather than attaching to whatever", () => {
    expect(deskAttachArgv("", "workbench")).toBe(null);
    expect(deskAttachArgv("/nope", "")).toBe(null);
  });
});
