import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEPS, depSpec, usedOn, type DepStatus } from "../../shared/deps.ts";
import { dependencyReport, resetDependencyCache } from "../src/deps.ts";

/**
 * The requirements catalog, and the report built from it.
 *
 * Two things are worth pinning here. The first is that the list stays a list:
 * duplicated ids or a required tool marked Linux-only would put a wrong answer
 * in front of someone trying to work out why the app is half dead.
 *
 * The second is the rule this whole feature exists under, and the one most
 * likely to be broken by a well-meaning edit: the guidance must stay GENERIC.
 * There is one macOS, one Windows and an unbounded number of Linux
 * distributions, so `apt install git` is wrong for most readers and stale for
 * the rest. The test greps the catalog and the panels that quote it, because
 * "we agreed to keep it generic" is not something a reviewer reliably catches.
 */
const PKG_MANAGER_CMD =
  /\b(apt|apt-get|brew|dnf|yum|pacman|zypper|apk|winget|choco|scoop|snap|port|emerge|nix-env|pkg)\s+(install|add|-S\b)/i;

const ROOT = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("dependency catalog", () => {
  it("has no duplicate ids, and every id resolves", () => {
    const ids = DEPS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(depSpec(id)?.id).toBe(id);
  });

  it("gives every tool a name, a consequence and an official page", () => {
    for (const d of DEPS) {
      expect(d.bin.length).toBeGreaterThan(0);
      expect(d.title.length).toBeGreaterThan(0);
      // The "what" is the whole point of the row: a category name would leave
      // the reader deciding whether they care, which is the question we set out
      // to answer for them.
      expect(d.what.length).toBeGreaterThan(20);
      expect(d.url.startsWith("https://")).toBe(true);
    }
  });

  it("keeps required tools platform-agnostic", () => {
    // A tool the app cannot work without has to be one every platform can get.
    // Anything narrower is an optional feature wearing the wrong label.
    for (const d of DEPS.filter((x) => x.required)) expect(d.platforms).toBeUndefined();
  });

  it("names no package manager in prose, only in the one table built for it", () => {
    /**
     * This used to forbid package managers outright, everywhere. That rule was
     * right for what it was protecting and is now too wide by exactly one
     * table: `PKG_INSTALL` exists precisely to name them, because the panel
     * types the line into a shell and waits rather than running it — see the
     * note at the top of shared/deps.ts.
     *
     * What it was protecting is still protected, and that is the narrower rule
     * kept here: an install line hard-coded into PROSE — a `what`, a `note`, a
     * banner, a panel's copy — is stale the day a distribution renames a
     * package, and nothing tells you. The generated one is resolved per machine
     * from a structured record, so it is either right or absent.
     */
    const prose = [
      "web/src/components/GitMissingBanner.tsx",
      "web/src/components/DockerPanel.tsx",
      "web/src/components/PrPanel.tsx",
      "web/src/components/SettingsModal.tsx",
    ];
    for (const rel of prose) {
      const hit = PKG_MANAGER_CMD.exec(read(rel));
      // The message names the file and the offending line, because the fix is
      // to replace it with the project's own page, not to loosen the rule.
      expect(hit ? `${rel}: ${hit[0]}` : null).toBeNull();
    }
    // And in the catalogue, the managers may appear only inside PKG_INSTALL.
    // Anywhere else — a `what`, a `note`, a `url` — is prose that will rot.
    const cat = read("shared/deps.ts");
    const table = cat.slice(cat.indexOf("export const PKG_INSTALL"), cat.indexOf("/** The catalog."));
    const outside = cat.replace(table, "");
    const stray = PKG_MANAGER_CMD.exec(outside);
    expect(stray ? `shared/deps.ts (outside PKG_INSTALL): ${stray[0]}` : null).toBeNull();
    // A url that is a package-manager page is the same mistake wearing a link.
    for (const d of DEPS) expect(d.url).not.toMatch(/\b(apt|dnf|pacman|brew|apk|yum|zypper)\b/);
  });

  it("knows which platforms a tool is used on", () => {
    expect(usedOn({ ...DEPS[0]!, platforms: undefined }, "win32")).toBe(true);
    expect(usedOn({ ...DEPS[0]!, platforms: ["linux"] }, "darwin")).toBe(false);
    expect(usedOn({ ...DEPS[0]!, platforms: ["linux", "darwin"] }, "darwin")).toBe(true);
  });
});

describe("dependency report", () => {
  const STATUSES: DepStatus[] = ["ok", "attention", "missing", "unsupported"];

  it("answers for every tool in the catalog, once each", async () => {
    resetDependencyCache();
    const r = await dependencyReport(true);
    expect(r.platform).toBe(process.platform);
    expect(r.deps.map((d) => d.id).sort()).toEqual(DEPS.map((d) => d.id).sort());
    for (const d of r.deps) expect(STATUSES).toContain(d.status);
  });

  it("says 'not used here' for a tool this platform never reaches for, and only for those", async () => {
    resetDependencyCache();
    const r = await dependencyReport(true);
    for (const d of r.deps) {
      const spec = depSpec(d.id)!;
      // The two must agree in both directions: an unsupported row on a platform
      // that does use the tool would hide a real problem, and a probed row on a
      // platform that never uses it invents one.
      expect(d.status === "unsupported").toBe(!usedOn(spec, process.platform));
    }
  });

  it("mirrors the panels rather than probing a second time: git is found here because the panels find it", async () => {
    resetDependencyCache();
    const r = await dependencyReport(true);
    const git = r.deps.find((d) => d.id === "git")!;
    // CI and any dev machine running this suite has git; the interesting part
    // is that this row is the same answer /git/capability gives, not a new one.
    expect(git.status).toBe("ok");
    expect(git.required).toBe(true);
  });

  it("serves a repeated ask from cache, and re-probes when asked to", async () => {
    resetDependencyCache();
    const a = await dependencyReport();
    const b = await dependencyReport();
    expect(a).toBe(b); // same object: the pane reopening costs nothing
    const c = await dependencyReport(true);
    expect(c).not.toBe(a); // Recheck means recheck
  });
});
