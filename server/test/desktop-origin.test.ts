import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The desktop shell must serve its UI from a stable origin.
 *
 * This is a guard against a bug that shipped and stayed shipped, because every
 * gate we had looked straight past it: the shell hosted web/dist over loopback
 * HTTP on an *ephemeral* port, so the renderer's origin changed on every
 * launch. localStorage is keyed by origin, so each start handed the app an
 * empty store — theme, display size, chats, drafts, the saved token, every
 * preference, silently reset. Nobody was writing them wrong; nobody could read
 * them back.
 *
 * `make smoke` asserted that chats and drafts survive a *reload*, which is the
 * same origin and always passed. It never restarts the app, which is the case
 * that broke — and driving a real Electron restart from a test is a heavier
 * harness than this repo has. So this asserts the property that made the bug
 * possible, at the only place it can be decided: how main.js chooses to serve
 * the renderer.
 *
 * If you are here because this failed, the question to answer is not "how do I
 * get the test to pass" — it is "what origin will the renderer have on its
 * second launch, and is it the same one it had on its first".
 */
const MAIN = readFileSync(resolve(import.meta.dir, "..", "..", "electron", "main.js"), "utf8");

describe("desktop shell origin", () => {
  it("serves the renderer from a custom scheme, not a port", () => {
    expect(MAIN).toContain("registerSchemesAsPrivileged");
    expect(MAIN).toContain("protocol.handle");
    // `standard: true` is what gives the scheme a real, persistent origin.
    // Without it the page is opaque and localStorage is thrown away again.
    expect(MAIN).toMatch(/standard:\s*true/);
  });

  it("loads the window from that scheme", () => {
    const load = /win\.loadURL\(([^)]*)\)/.exec(MAIN)?.[1] ?? "";
    expect(load).toContain("APP_ORIGIN");
    expect(load).not.toContain("127.0.0.1");
    expect(load).not.toContain("localhost");
  });

  it("never binds an ephemeral port to serve the UI", () => {
    // `listen(0, …)` is the exact shape of the original bug. The sidecar's own
    // fixed port is a different thing and is not spelled this way.
    expect(MAIN).not.toMatch(/\.listen\(\s*0\s*,/);
  });

  it("stops the sidecar on every exit path, not only window-all-closed", () => {
    // An orphaned server keeps :4000, and the next launch adopts it — running
    // the new UI against the previous build's server, with nothing to show for
    // it. SIGKILL is the one case no in-process handler can cover.
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) expect(MAIN).toContain(sig);
    expect(MAIN).toContain("before-quit");
    expect(MAIN).toContain("window-all-closed");
  });
});

/**
 * The installer must refuse an artifact that is not an executable.
 *
 * `bun build --compile` wrote a 103 MB file that exited 0 and was not an ELF
 * binary at all (the outfile was on tmpfs). Installed, the app came up with a
 * server that started and vanished instantly, no error anywhere.
 */
const INSTALL = readFileSync(resolve(import.meta.dir, "..", "..", "electron", "install-local.sh"), "utf8");

describe("install-local.sh", () => {
  it("checks the built binaries really are executables", () => {
    expect(INSTALL).toContain("file -b");
    expect(INSTALL).toMatch(/ELF/);
    expect(INSTALL).toContain("refusing to install");
  });

  it("preserves the setuid chrome-sandbox", () => {
    // Replacing it drops root ownership and the setuid bit, and Electron then
    // refuses to start wherever unprivileged user namespaces are restricted —
    // recoverable only with sudo.
    expect(INSTALL).toContain("chrome-sandbox");
  });
});
