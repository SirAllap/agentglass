/*
 * The published binary must not also be a general-purpose Node runtime.
 *
 * Every Electron binary ships with three doors open by default, and until this
 * repo moved to electron-builder 26 there was no supported way to shut them:
 *
 *   * ELECTRON_RUN_AS_NODE=1 turns the app into `node`. Whatever the installed
 *     agentglass binary is allowed to do — and it is on a developer's machine,
 *     often on the autostart list — an attacker who can set one environment
 *     variable can do with a script of their choosing, out of a signed,
 *     allowlisted, familiar-looking executable. This is the "living off the
 *     land" shape; the binary is the payload's own interpreter.
 *   * NODE_OPTIONS lets that same environment inject `--require /tmp/x.js` into
 *     the app's own startup.
 *   * --inspect opens a debugger port on the MAIN process — the one holding the
 *     API token, the cookie reader and every IPC handler.
 *
 * Nothing here needs any of them. The sidecar and the cookie reader are both
 * `bun build --compile` binaries with their own runtime (see build.mjs and
 * runCookieReader in main.js); the shell never spawns itself as node. So the
 * cost of closing all three is zero and the fuses are set in
 * electron/package.json.
 *
 * Pinned here because a fuse is invisible: nothing about the app looks or
 * behaves differently with them on, so a merge that drops the block, or an
 * electron-builder downgrade that ignores it, would be silent. That is also why
 * the check is not "is the config there" alone — see the last case, which is
 * the one that would actually catch a broken toolchain.
 *
 * VERIFIED in the packaged binary, not just here. `bun run dist:dir`, then
 * `@electron/fuses read --app electron/dist-app/linux-unpacked/agentglass` says
 * RunAsNode / EnableNodeOptionsEnvironmentVariable / EnableNodeCliInspectArguments
 * are all Disabled — and, because a fuse read is still only a byte in a binary,
 * the behaviour was measured against the stock unfused Electron 43 as a control:
 *
 *   ELECTRON_RUN_AS_NODE=1 <stock electron> --version   ->  v24.18.1
 *   ELECTRON_RUN_AS_NODE=1 <packaged agentglass> --ver  ->  starts the APP
 *   <stock electron> --inspect=9445                     ->  "Debugger listening
 *                                                            on ws://127.0.0.1:9445"
 *   <packaged agentglass> --inspect=9444                ->  nothing listening
 *
 * The first line is the whole point: an unfused build of this app IS a Node 24
 * runtime for anyone who can set one environment variable.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ELECTRON_DIR = resolve(import.meta.dir, "..", "..", "electron");
const pkg = JSON.parse(readFileSync(resolve(ELECTRON_DIR, "package.json"), "utf8"));

describe("electron fuses", () => {
  it("shuts the three doors that turn the app into a Node runtime", () => {
    // The signing directive below is not a door and is checked on its own; what
    // is asserted here is that the doors are exactly these three and all shut,
    // so a FOURTH one appearing still fails rather than passing unnoticed.
    const { resetAdHocDarwinSignature: _resign, ...doors } = pkg.build.electronFuses;
    expect(doors).toEqual({
      runAsNode: false,
      enableNodeCliInspectArguments: false,
      enableNodeOptionsEnvironmentVariable: false,
    });
  });

  it("re-signs the app after flipping them, or macOS arm64 will not start it", () => {
    /*
     * Shutting the doors is what BROKE the app on Apple Silicon for four
     * releases (#517). Flipping a fuse rewrites bytes inside the Electron
     * Framework, which invalidates the signature covering that page; Apple
     * Silicon validates pages as they are first read, and the kernel kills the
     * process. The crash was in `electron::fuses::IsRunAsNodeEnabled()` — it
     * died reading the very fuse this file exists to set, before main.js ran.
     *
     * electron-builder signs after flipping, but skips signing entirely when
     * there is no identity, and this project has none. This flag is what makes
     * @electron/fuses re-apply an ad-hoc signature itself, and unset it does
     * nothing at all.
     *
     * Pinned for the same reason as the fuses: it is invisible. Nothing about
     * the config looks wrong without it, and the only symptom is on hardware
     * neither CI nor most contributors have.
     */
    expect(pkg.build.electronFuses.resetAdHocDarwinSignature).toBe(true);
  });

  it("is built by a toolchain that understands the key", () => {
    // `electronFuses` was added in electron-builder 26. On 25 it is not an
    // error — it is an unknown key, silently ignored, and the block above would
    // read as protection that is not there.
    const eb: string = pkg.devDependencies["electron-builder"];
    expect(Number(eb.replace(/^\D+/, "").split(".")[0])).toBeGreaterThanOrEqual(26);
  });

  it("is on a supported Electron line", () => {
    // 33.4.11 was the last patch of a line that went EOL in April 2025: fifteen
    // months of Chromium 130 with no security backports, packaged and published
    // by .github/workflows/desktop-binaries.yml. Electron supports the latest
    // three majors; this is the floor that keeps the app inside that window.
    const e: string = pkg.devDependencies.electron;
    expect(Number(e.replace(/^\D+/, "").split(".")[0])).toBeGreaterThanOrEqual(41);
  });
});

/*
 * And the shape of the app inside the asar.
 *
 * `files` is an allowlist, so the failure it produces is a crash at startup
 * ("Cannot find module") rather than something subtle — but only for a file
 * that main.js requires at the top. guest-guard.js is exactly that, and it was
 * added to this list at the same time it was created; this is what stops the
 * two drifting apart in a merge.
 */
describe("what gets packed into app.asar", () => {
  it("lists every file main.js requires from its own directory", () => {
    const main = readFileSync(resolve(ELECTRON_DIR, "main.js"), "utf8");
    const local = [...main.matchAll(/require\("\.\/([^"]+)"\)/g)].map((m) => m[1]);
    expect(local.length).toBeGreaterThan(0);
    for (const f of local) {
      expect(existsSync(resolve(ELECTRON_DIR, f)), f).toBe(true);
      expect(pkg.build.files, f).toContain(f);
    }
  });

  it("keeps `files` an allowlist, so nothing rides along implicitly", () => {
    // Measured on `bun run dist:dir` with electron-builder 26 out of a bun
    // workspace: the asar holds main.js, preload.js, guest-guard.js, icons/**
    // and package.json, 1.4MB, and no dependency tree. electron-builder says so
    // out loud while packing ("no node modules returned while searching
    // directories") because bun has no CLI for a dependency tree and it falls
    // back to traversal. That is the desired outcome and an accident of the
    // package manager at the same time, so it is pinned here: `files` is an
    // allowlist and must stay one.
    expect(pkg.build.files.some((f: string) => f.includes("node_modules"))).toBe(false);
    expect(new Set(pkg.build.files)).toEqual(new Set(["main.js", "guest-guard.js", "preload.js", "icons/**"]));
  });
});

/*
 * The Linux windowing backend, pinned as a decision rather than a constant.
 *
 * This is a regression lock, not a unit test, and it exists because both
 * constants were measured to fail and each failure is invisible: the app starts,
 * serves its port, answers /health, and never maps a window. `x11` did that on
 * David's GNOME 46 Wayland session (the shipped case). `wayland` does the same
 * to anyone on an X11 login — and this repo publishes an AppImage and a .deb.
 *
 * A comment cannot stop a one-word "fix". This can.
 */
describe("the ozone platform", () => {
  const main = readFileSync(resolve(ELECTRON_DIR, "main.js"), "utf8");

  it("is chosen from the session, never hard-coded", () => {
    const call = main.match(/appendSwitch\(\s*\n?\s*"ozone-platform",[\s\S]{0,220}?\);/);
    expect(call, "no ozone-platform switch in main.js").toBeTruthy();
    const src = call![0];
    expect(src).toContain("WAYLAND_DISPLAY");
    expect(src).toContain("XDG_SESSION_TYPE");
    // Both spellings must be reachable. A pin to either one is the bug.
    expect(src).toContain('"wayland"');
    expect(src).toContain('"x11"');
    expect(src, "a hard pin is a headless app on the other session type")
      .not.toMatch(/"ozone-platform",\s*"(x11|wayland)"\s*\)/);
  });

  it("does not persist a window position the platform cannot honour", () => {
    // Wayland never tells a client where it is. getNormalBounds() still answers
    // with an origin, and writing that into window.json would look like a
    // working feature to the next reader while restoring nothing.
    expect(main).toContain("APP_PLACES_ITS_WINDOW");
    expect(main).toMatch(/APP_PLACES_ITS_WINDOW\s*=\s*process\.platform\s*!==\s*"linux"/);
  });
});
