/*
 * The links ClickUp's GitHub panel calls "Others", read out of the card's text.
 * Every guard here is a way a description can hold something that looks like a
 * link and is not one: a sentence's full stop, a markdown wrapper, a host that
 * merely contains "github.com", a pull request that has its own list.
 */
import { describe, expect, it } from "bun:test";
import { otherGithubLinks } from "../src/clickup.ts";

const urls = (...t: string[]) => otherGithubLinks(...t).map((l) => l.url);

describe("otherGithubLinks", () => {
  it("names a wiki page by its page, dashes as spaces", () => {
    const [l] = otherGithubLinks("Special step: https://github.com/acme/orbit/wiki/Deploy-notes");
    expect(l).toEqual({ url: "https://github.com/acme/orbit/wiki/Deploy-notes", path: "acme/orbit/wiki/Deploy-notes", title: "Deploy notes" });
  });
  it("titles an issue and a commit", () => {
    const r = otherGithubLinks("see github.com/acme/orbit/issues/12 and https://github.com/acme/orbit/commit/abc1234def5678");
    expect(r.map((l) => l.title)).toEqual(["Issue #12", "abc1234"]);
  });
  it("titles anything else by its path tail", () => {
    expect(otherGithubLinks("https://github.com/acme/orbit/blob/main/docs/setup.md")[0]!.title).toBe("setup.md");
    expect(otherGithubLinks("https://github.com/acme/orbit")[0]!.title).toBe("orbit");
  });
  it("leaves pull requests to the pull request list", () => {
    expect(urls("https://github.com/acme/orbit/pull/7 and https://github.com/acme/orbit/pull/7/files")).toEqual([]);
  });
  it("strips markdown, parentheses and sentence punctuation", () => {
    expect(urls("[Deploy](https://github.com/acme/orbit/wiki/Deploy-notes).")).toEqual(["https://github.com/acme/orbit/wiki/Deploy-notes"]);
    expect(urls("(https://github.com/acme/orbit/issues/12), then <https://github.com/acme/orbit/issues/13>;")).toEqual([
      "https://github.com/acme/orbit/issues/12", "https://github.com/acme/orbit/issues/13"]);
    expect(urls("**https://github.com/acme/orbit/wiki/A-b!**")).toEqual(["https://github.com/acme/orbit/wiki/A-b"]);
  });
  it("keeps order and drops duplicates, across texts", () => {
    expect(urls("github.com/acme/orbit/issues/2 https://github.com/acme/orbit/issues/1 https://github.com/Acme/Orbit/issues/2/", "https://github.com/acme/orbit/issues/1 https://github.com/acme/orbit/issues/3"))
      .toEqual(["https://github.com/acme/orbit/issues/2", "https://github.com/acme/orbit/issues/1", "https://github.com/acme/orbit/issues/3"]);
  });
  it("ignores other hosts and look-alikes", () => {
    expect(urls(
      "https://gitlab.com/acme/orbit/wiki/X https://notgithub.com/acme/orbit/wiki/X https://github.com.evil.io/acme/orbit/wiki/X",
      "https://evil.io/github.com/acme/orbit/wiki/X user@github.com/acme/orbit/wiki/X https://github.com/acme",
    )).toEqual([]);
  });
  it("accepts www and http, canonicalised", () => {
    expect(urls("http://www.github.com/acme/orbit/actions/runs/99")).toEqual(["https://github.com/acme/orbit/actions/runs/99"]);
  });
  it("caps at ten", () => {
    const t = Array.from({ length: 15 }, (_, i) => `https://github.com/acme/orbit/issues/${i + 1}`).join(" ");
    expect(otherGithubLinks(t)).toHaveLength(10);
  });
  it("copes with nothing", () => {
    expect(otherGithubLinks(undefined, null, "")).toEqual([]);
  });
});
