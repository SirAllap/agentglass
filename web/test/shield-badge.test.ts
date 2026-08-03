// shields.io badges are read out of their URL rather than fetched — the asset
// proxy does not allow that host, so a fetched one is a broken image where a CI
// comment's headline number should be. What matters here: the escaping rules
// are shields' own (`--` is a dash, `_` a space, `__` an underscore), a
// two-field badge has no label, and nothing that is not a badge is claimed as
// one.
import { describe, expect, test } from "bun:test";
import { parseShieldBadge } from "../src/lib/prBody.ts";

describe("parseShieldBadge", () => {
  test("label, value and colour off a plain badge", () => {
    expect(parseShieldBadge("https://img.shields.io/badge/Coverage-75%25-yellow.svg"))
      .toEqual({ label: "Coverage", value: "75%", color: "yellow" });
  });

  test("the .svg suffix is optional", () => {
    expect(parseShieldBadge("https://img.shields.io/badge/build-passing-brightgreen"))
      .toEqual({ label: "build", value: "passing", color: "brightgreen" });
  });

  test("two fields mean there is no label", () => {
    expect(parseShieldBadge("https://img.shields.io/badge/passing-green"))
      .toEqual({ label: "", value: "passing", color: "green" });
  });

  test("an underscore is a space", () => {
    expect(parseShieldBadge("https://img.shields.io/badge/code_style-black-000000"))
      .toEqual({ label: "code style", value: "black", color: "000000" });
  });

  test("a doubled underscore is a literal one, not two spaces", () => {
    expect(parseShieldBadge("https://img.shields.io/badge/py__ver-3.12-blue"))
      .toEqual({ label: "py_ver", value: "3.12", color: "blue" });
  });

  test("a doubled dash is a literal dash rather than a field break", () => {
    expect(parseShieldBadge("https://img.shields.io/badge/pre--commit-enabled-yellow"))
      .toEqual({ label: "pre-commit", value: "enabled", color: "yellow" });
  });

  test("query parameters are not part of the value", () => {
    expect(parseShieldBadge("https://img.shields.io/badge/Coverage-93%25-green.svg?style=flat"))
      .toEqual({ label: "Coverage", value: "93%", color: "green" });
  });

  test("a stray percent does not lose the badge", () => {
    // decodeURIComponent throws on a lone `%`; the badge is still drawable.
    const b = parseShieldBadge("https://img.shields.io/badge/odd%-ok-green");
    expect(b?.value).toBe("ok");
    expect(b?.color).toBe("green");
  });

  test("anything that is not a shields badge is not one", () => {
    expect(parseShieldBadge("https://example.com/badge/a-b-c.svg")).toBeNull();
    expect(parseShieldBadge("https://img.shields.io/github/stars/acme/orbit")).toBeNull();
    // One field cannot carry both a value and a colour.
    expect(parseShieldBadge("https://img.shields.io/badge/lonely")).toBeNull();
    expect(parseShieldBadge("")).toBeNull();
  });
});
