/*
 * The floating scratch, and what the app must do around it.
 *
 * One keystroke here opens a tmux popup running `tmux attach -t scratch`. That
 * is not a decoration: it is a SECOND client on the same server, it is drawn on
 * top of the first one's screen, and it holds the keyboard. Two consequences,
 * both reported from the desk and both reproduced here against a real server:
 *
 *   1. `switch-client` with no `-c` moves the most recently used client, which
 *      while a popup is open is the POPUP. So a pull request opened from the
 *      board landed inside a 60%-wide floating window instead of the terminal.
 *   2. A tab selected or created underneath the popup is a tab nobody can see
 *      or type into — "the tab shows up on top of the scratch and won't let me close it".
 *
 * These run a real tmux on an isolated socket with an empty config: the popup
 * behaviour is the thing under test, and it cannot be faked.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { closePopup, outerClientTty, runAction, type TmuxTarget } from "../src/tmuxctl.ts";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";

const SOCK = [...TMUX_ISOLATED, "-L", "agx-popup-suite"];
const tmux = (...a: string[]) =>
  Bun.spawnSync(["tmux", ...SOCK, ...a], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `kill-server` returns as soon as the signal is sent, not once the server is
 *  actually gone. Measured: the `new-session` right after it can still land on
 *  the dying server — it accepts the command, then dies moments later and takes
 *  the session with it, so the `attach` after THAT finds nothing and never
 *  will. The stale socket FILE is not a usable signal (tmux never unlinks it,
 *  measured too); asking the server itself is — a `list-sessions` that fails is
 *  a server confirmed gone, not one merely slow to answer. */
async function killServer(): Promise<void> {
  tmux("kill-server");
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const r = Bun.spawnSync(["tmux", ...SOCK, "list-sessions"], { stdout: "ignore", stderr: "ignore" });
    if (r.exitCode !== 0) return;
    await sleep(20);
  }
}
const clients = () => tmux("list-clients", "-F", "#{client_tty}\t#{client_session}")
  .split("\n").filter(Boolean).map((l) => { const [tty, session] = l.split("\t"); return { tty: tty!, session: session! }; });

/** A real attached client, which needs a real terminal — `script` is the
 *  smallest way to get one without a pty library in the test. */
function attach(session: string) {
  // TERM is set explicitly: a CI runner has none (or `dumb`), and tmux then
  // refuses to attach — "missing or unsuitable terminal" — so the desk client
  // never appeared and every assertion below read an empty client list.
  Bun.spawn(["script", "-qc", `tmux ${SOCK.join(" ")} attach -t ${session}`, "/dev/null"],
    { env: { ...process.env, TERM: "xterm-256color" }, stdout: "ignore", stderr: "ignore" });
}

/** Wait for the client count to settle rather than sleeping a guess: a server
 *  that was just killed and restarted takes longer on a loaded machine, and a
 *  fixed sleep turns that into a flake nobody can reproduce. */
async function until(n: number, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (clients().length === n) return;
    await sleep(150);
  }
}

afterAll(() => { tmux("kill-server"); });

describe("a scratch popup on the same server", () => {
  test("it is a second client, and the app can tell which one is the desk", async () => {
    await killServer();
    tmux("new-session", "-d", "-s", "desk");
    tmux("new-session", "-d", "-s", "scratch");
    attach("desk");
    await until(1);
    const desk = clients()[0]?.tty;
    expect(desk).toBeTruthy();

    Bun.spawn(["tmux", ...SOCK, "display-popup", "-d", "/tmp", "-w", "60%", "-h", "60%",
      "-E", `tmux ${SOCK.join(" ")} attach -t scratch`], { stdout: "ignore", stderr: "ignore" });
    await until(2);

    // The whole problem in one assertion: there are now two of them.
    expect(clients()).toHaveLength(2);
    expect(clients().map((c) => c.session).sort()).toEqual(["desk", "scratch"]);
  }, 20_000);

  test("closing it takes the floating window and leaves the session running", async () => {
    const desk = clients().find((c) => c.session === "desk")!.tty;
    closePopup(SOCK, desk);
    await until(1);

    expect(clients()).toHaveLength(1);
    expect(clients()[0]!.session).toBe("desk");
    /* The session is not the popup. Nothing running in the scratch is lost by
       closing the window that was showing it — which is what makes closing it
       on the user's behalf acceptable at all. */
    expect(tmux("list-sessions", "-F", "#{session_name}").split("\n")).toContain("scratch");
  }, 20_000);

  test("without a client it does nothing, and says so by doing nothing", async () => {
    // Measured: `display-popup -C` with no `-c` resolves "the client" to the
    // popup itself and leaves both standing. A no-op is the honest response;
    // issuing a command that looks like it worked is not.
    Bun.spawn(["tmux", ...SOCK, "display-popup", "-d", "/tmp", "-w", "50%", "-h", "50%",
      "-E", `tmux ${SOCK.join(" ")} attach -t scratch`], { stdout: "ignore", stderr: "ignore" });
    await until(2);
    expect(clients()).toHaveLength(2);

    closePopup(SOCK, null);
    await sleep(600);
    expect(clients()).toHaveLength(2);

    closePopup(SOCK, clients().find((c) => c.session === "desk")!.tty);
    await until(1);
    expect(clients()).toHaveLength(1);
  }, 25_000);
});

describe("opening a tab while the scratch is up", () => {
  test("the popup goes, the tab is created, and the desk stays the desk", async () => {
    await killServer();
    tmux("new-session", "-d", "-s", "desk");
    tmux("new-session", "-d", "-s", "scratch");
    attach("desk");
    await until(1);
    expect(clients()).toHaveLength(1);
    const desk = clients()[0]!.tty;
    Bun.spawn(["tmux", ...SOCK, "display-popup", "-d", "/tmp", "-w", "60%", "-h", "60%",
      "-E", `tmux ${SOCK.join(" ")} attach -t scratch`], { stdout: "ignore", stderr: "ignore" });
    await until(2);
    expect(clients()).toHaveLength(2);

    const sessionId = tmux("display-message", "-p", "-t", "desk", "#{session_id}");
    const target = { socket: SOCK, id: sessionId } as unknown as TmuxTarget;
    // Exactly what the terminal does when you press `+` or a review opens a
    // tab — including the client it passes, which is the half that was missing.
    expect(runAction(target, "new", undefined, undefined, undefined, undefined, false, undefined, desk)).toBe(true);
    await until(1);

    expect(clients()).toHaveLength(1);
    expect(clients()[0]!.tty).toBe(desk);
    expect(tmux("list-windows", "-t", "desk", "-F", "#{window_index}").split("\n")).toHaveLength(2);
    expect(tmux("list-sessions", "-F", "#{session_name}").split("\n")).toContain("scratch");
  }, 25_000);
});

describe("which client the app aims at", () => {
  test("a nested client is never mistaken for the desk", () => {
    /* The rule the rest of this file already used for sessions: a client
       started inside another tmux reports a tmux TERM. `outerClientTty` returns
       null rather than guessing when every client looks nested — the caller
       then passes its own tty, which is the answer and not a heuristic. */
    expect(outerClientTty([...TMUX_ISOLATED, "-L", "agx-popup-nothing-here"])).toBe(null);
  });
});
