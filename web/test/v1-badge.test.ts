/*
 * "v1.0 is here" is a note on the version row, not a banner: it appears only on
 * a build whose version really is 1.0 or newer, and clicking it puts it away for
 * good. Both halves are source assertions because web/ has no DOM harness; the
 * decision itself is a pure function and is exercised directly below.
 *
 * What would make this note wrong rather than merely absent: showing on 0.27.0
 * (the version this app builds today), comparing the version by hand so "0.30"
 * outranks "1.0", and a dismissal that is never written — the badge would come
 * back on the next launch and read as a nag.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { showsV1Badge } from "../src/components/V1Badge.tsx";

const component = readFileSync(new URL("../src/components/V1Badge.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url), "utf8");
const about = settings.slice(settings.indexOf("function AboutPane"), settings.indexOf("function CookieImport"));

describe("where it sits", () => {
  test("beside the running version, on the row that answers what this build is", () => {
    expect(about).toContain("<V1Badge version={st.info.version} />");
    const row = about.slice(about.indexOf('label="Version"'), about.indexOf('label="Version"') + 900);
    expect(row).toContain("V1Badge");
    expect(row).toContain("{st.info.version}");
  });

  test("its hint is a data-tip, not a title", () => {
    const code = component.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
    expect(code).toContain("data-tip=");
    expect(code).not.toMatch(/\btitle=/);
  });
});

describe("when it shows", () => {
  test("the comparison is the shared one, against 1.0.0", () => {
    expect(component).toContain('versionAtLeast(version, "1.0.0")');
    expect(component).not.toContain("parseInt");
  });

  test("not on a build below 1.0, and not once it is put away", () => {
    expect(showsV1Badge("0.27.0", false)).toBe(false);
    expect(showsV1Badge("0.30.0", false)).toBe(false);
    expect(showsV1Badge("", false)).toBe(false);
    expect(showsV1Badge(null, false)).toBe(false);
    expect(showsV1Badge("1.0.0", false)).toBe(true);
    expect(showsV1Badge("1.2.3", false)).toBe(true);
    expect(showsV1Badge("1.0.0", true)).toBe(false);
  });
});

describe("putting it away", () => {
  test("the click writes the dismissal, and reading it back is guarded", () => {
    // Both halves of localStorage sit in a try: a private-mode window throws on
    // access, and an exception in render would take the whole About page down.
    expect(component).toMatch(/try\s*{[^}]*localStorage\.getItem\(/s);
    expect(component).toMatch(/try\s*{[^}]*localStorage\.setItem\(/s);
    expect(component.match(/catch/g)?.length).toBeGreaterThanOrEqual(2);
    expect(component).toContain("setDismissed(true)");
  });
});
