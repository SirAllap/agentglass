/*
 * "Mark viewed" must tell GitHub the answer it just gave locally.
 *
 * The flag was once set inside the setSeen updater, which React runs after the
 * call that reads it, so every press sent viewed:false. A rule about source is
 * asserted against source: there is no renderer here.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const start = src.indexOf("const toggleSeen = (");
const body = src.slice(start, src.indexOf("\n  };", start));

describe("toggleSeen", () => {
  it("decides the new state before the updater, from what the panel shows", () => {
    expect(start).toBeGreaterThan(0);
    expect(body).toContain("const nowViewed = !seenFiles.includes(path)");
  });
  it("never assigns the flag inside the updater", () => {
    expect(body).not.toMatch(/nowViewed = true/);
    expect(body).toContain("prFileViewed(root, id, path, nowViewed)");
  });
});
