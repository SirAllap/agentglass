/*
 * The Mac's About pane, when a release is out.
 *
 * The updater rebuilds from source through self-update.sh → install-local.sh,
 * and that chain is Linux end to end (linux-unpacked, ~/.local/share, a
 * .desktop file). On a Mac the button ran into the first missing path and
 * stopped mid-way. It now says what a Mac actually does — download the .dmg
 * for this architecture — with the file named exactly as the release job
 * publishes it and the page it is on. Up to date stays "up to date".
 *
 * Platform and arch are parameters, because this runs on Linux.
 */
import { beforeAll, describe, expect, test } from "bun:test";

let macUpdateBlock: (tag: string, origin: string, platform?: string, arch?: string) => string | null;
let macDmgAsset: (tag: string, arch?: string) => string;
let releasePage: (origin: string, tag: string) => string;
beforeAll(async () => {
  // A cache-busted import, like selfupdate-win32.test.ts: the module pins
  // AGENTGLASS_UPDATE_SRC at load.
  ({ macUpdateBlock, macDmgAsset, releasePage } = await import(`../src/selfupdate.ts?d=${Math.random()}`));
});

describe("the .dmg a Mac is pointed at", () => {
  test("is named the way desktop-binaries.yml names it, per architecture", () => {
    // electron-builder: agentglass_${version}_${arch}.${ext}; the tag's `v` is
    // not part of the version.
    expect(macDmgAsset("v0.14.0", "arm64")).toBe("agentglass_0.14.0_arm64.dmg");
    expect(macDmgAsset("v0.14.0", "x64")).toBe("agentglass_0.14.0_x64.dmg");
  });

  test("the release page is derived from whatever spelling of the origin the build recorded", () => {
    expect(releasePage("https://github.com/someone/agentglass.git", "v0.14.0")).toBe("https://github.com/someone/agentglass/releases/tag/v0.14.0");
    expect(releasePage("git@github.com:someone/agentglass.git", "v0.14.0")).toBe("https://github.com/someone/agentglass/releases/tag/v0.14.0");
    expect(releasePage("https://github.com/someone/agentglass/", "v0.14.0")).toBe("https://github.com/someone/agentglass/releases/tag/v0.14.0");
  });
});

describe("macUpdateBlock", () => {
  test("on darwin it names the tag, the file for this arch and the page", () => {
    const msg = macUpdateBlock("v0.14.0", "https://github.com/someone/agentglass.git", "darwin", "arm64")!;
    expect(msg).toContain("v0.14.0");
    expect(msg).toContain("agentglass_0.14.0_arm64.dmg");
    expect(msg).toContain("https://github.com/someone/agentglass/releases/tag/v0.14.0");
    expect(msg.toLowerCase()).toContain(".dmg");
    // An Intel Mac gets the Intel file, not a guess.
    expect(macUpdateBlock("v0.14.0", "https://github.com/someone/agentglass.git", "darwin", "x64")).toContain("agentglass_0.14.0_x64.dmg");
  });

  test("is null everywhere else — Linux keeps its build-from-source button", () => {
    expect(macUpdateBlock("v0.14.0", "https://github.com/someone/agentglass.git", "linux", "x64")).toBeNull();
    expect(macUpdateBlock("v0.14.0", "https://github.com/someone/agentglass.git", "win32", "x64")).toBeNull();
  });
});

const src = await Bun.file(new URL("../src/selfupdate.ts", import.meta.url)).text();

describe("where updateStatus applies it", () => {
  test("after the tag comparison, so an up-to-date Mac reads up to date", () => {
    const compare = src.indexOf("if (cmpTag(latest, current) <= 0) return out;");
    const block = src.indexOf("const macBlock = macUpdateBlock(latest, info.origin);");
    expect(compare).toBeGreaterThan(0);
    expect(block).toBeGreaterThan(compare);
    expect(src).toContain("if (macBlock) out.blocked = macBlock;");
  });

  test("startUpdate refuses a blocked status before it reaches the spawn", () => {
    const start = src.indexOf("export async function startUpdate(");
    const refuse = src.indexOf("if (st.blocked) return { ok: false, error: st.blocked };", start);
    const spawn = src.indexOf('spawn("bash"', start);
    expect(refuse).toBeGreaterThan(start);
    expect(spawn).toBeGreaterThan(refuse);
  });
});
