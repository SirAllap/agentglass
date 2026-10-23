import { describe, expect, test } from "bun:test";
import { pathToCopy } from "../src/components/finder/machine/FinderPathBar.tsx";

const src = await Bun.file(new URL("../src/components/finder/machine/FinderPathBar.tsx", import.meta.url)).text();

describe("Copy path", () => {
  test("a local folder copies its path, a remote one its address", () => {
    expect(pathToCopy("/home/ann/orbit", null)).toBe("/home/ann/orbit");
    expect(pathToCopy("/run/user/1/gvfs/x/home", { uri: "sftp://ann@10.0.0.7/home" })).toBe("sftp://ann@10.0.0.7/home");
  });
  test("the bar has the button after the crumbs, not inside the editing field", () => {
    const label = src.indexOf('aria-label="Copy path"');
    expect(label).toBeGreaterThan(src.indexOf("{parts.map("));
    expect(label).toBeGreaterThan(src.indexOf("if (text !== null) {"));
  });
});

test("the last segment is bold in the accent and the slashes breathe, as in Strata", () => {
  const at = src.indexOf("{parts.map(");
  const crumb = src.slice(at, src.indexOf("</span>\n      ))}", at));
  expect(crumb).toContain('i === parts.length - 1 ? "var(--primary-ink)"');
  expect(crumb).toContain("fontWeight: i === parts.length - 1 ? 700 : 400");
  expect(crumb).toContain('className="px-1.5"');
});
