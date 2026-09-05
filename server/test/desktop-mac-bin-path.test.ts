/*
 * A .dmg has the CLIs and nothing on PATH knows it.
 *
 * `bin/` ships inside every package (extraResources in electron/package.json),
 * so a Mac install carries agentglass-agent, agentglass-browser and
 * agentglass-browser-mcp at `agentglass.app/Contents/Resources/bin/`. The Linux
 * installer symlinks them into ~/.local/bin; a .dmg has no installer, so an
 * agent typing `agentglass-browser` on a Mac got "command not found" from an
 * app that had the file all along. The shell now prepends that directory to
 * the sidecar's PATH on darwin, and every agent the sidecar seats inherits it.
 *
 * Lifted out of main.js and run, the way desktop-token.test.ts does, rather
 * than grepped for: the two ways this regresses are a rename and a stray guard,
 * and a string match sees neither. The suite runs on Linux and states a Mac.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import path from "node:path";

const MAIN = readFileSync(resolve(import.meta.dir, "..", "..", "electron", "main.js"), "utf8");
const PKG = JSON.parse(readFileSync(resolve(import.meta.dir, "..", "..", "electron", "package.json"), "utf8"));

function lift(name: string, deps: string[]): (...args: unknown[]) => any {
  const open = MAIN.indexOf(`function ${name}(`);
  if (open < 0) throw new Error(`main.js no longer declares ${name}()`);
  const end = MAIN.indexOf("\n}\n", open);
  if (end < 0) throw new Error(`could not find the end of ${name}()`);
  return new Function(...deps, `${MAIN.slice(open, end + 3)}\nreturn ${name};`) as never;
}

const withBundledBin = lift("withBundledBin", ["path"])(path) as
  (current: string | undefined, where: { platform: string; packaged: boolean; resourcesPath: string; delimiter?: string }) => string | undefined;

const MAC = { platform: "darwin", packaged: true, resourcesPath: "/Applications/agentglass.app/Contents/Resources", delimiter: ":" };

describe("the sidecar's PATH on a Mac", () => {
  it("starts with the bundle's bin/ on a packaged darwin build", () => {
    const got = withBundledBin("/usr/bin:/bin", MAC);
    expect(got).toBe("/Applications/agentglass.app/Contents/Resources/bin:/usr/bin:/bin");
  });

  it("does not add it twice when a relaunch inherits a PATH that already has it", () => {
    const once = withBundledBin("/usr/bin:/bin", MAC)!;
    expect(withBundledBin(once, MAC)).toBe(once);
  });

  it("copes with no PATH at all — the bundle's bin/ is then the whole of it", () => {
    expect(withBundledBin(undefined, MAC)).toBe("/Applications/agentglass.app/Contents/Resources/bin");
  });

  it("does the same for a packaged Linux build: a .deb or AppImage user without the installer has the same gap", () => {
    const linux = { platform: "linux", packaged: true, resourcesPath: "/opt/agentglass/resources", delimiter: ":" };
    expect(withBundledBin("/home/x/.local/bin:/usr/bin", linux)).toBe("/opt/agentglass/resources/bin:/home/x/.local/bin:/usr/bin");
    expect(withBundledBin(undefined, linux)).toBe("/opt/agentglass/resources/bin");
  });

  it("leaves a development run alone on any platform — bin/ is in the checkout, not in resources/", () => {
    const dev = { ...MAC, packaged: false };
    expect(withBundledBin("/usr/bin", dev)).toBe("/usr/bin");
  });

  it("uses the platform's own delimiter when none is stated", () => {
    // On the machine running the suite path.delimiter is ":"; the assertion is
    // that the default is taken from `path`, not hardcoded.
    const got = withBundledBin("/usr/bin", { platform: "darwin", packaged: true, resourcesPath: "/R" })!;
    expect(got.split(path.delimiter)[0]).toBe(path.join("/R", "bin"));
  });
});

describe("the wiring that makes it matter", () => {
  it("sidecarEnv sets PATH through withBundledBin, from the real platform and resourcesPath", () => {
    const open = MAIN.indexOf("function sidecarEnv(");
    const body = MAIN.slice(open, MAIN.indexOf("\n}\n", open));
    expect(body).toContain("PATH: withBundledBin(process.env.PATH, { platform: process.platform, packaged: PACKAGED, resourcesPath: process.resourcesPath })");
  });

  it("bin/ is an extraResource for every platform, so the directory exists to be found", () => {
    const extra = PKG.build.extraResources as { from: string; to: string }[];
    const bin = extra.find((e) => e.from === "../bin");
    expect(bin?.to).toBe("bin");
    // Unfiltered by platform: electron-builder's top-level extraResources apply
    // to mac, linux and win alike; a per-platform copy would have to be added
    // to each block, and none of them has one.
    for (const os of ["mac", "linux", "win"]) expect(PKG.build[os].extraResources).toBeUndefined();
  });
});
