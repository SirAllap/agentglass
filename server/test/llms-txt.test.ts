/*
 * The two files written for a model rather than a person: `landing/llms.txt`,
 * served at the site root, and `AGENTS.md` at the repository root. Both are an
 * index, and an index whose links point at files that moved is worse than no
 * index — a model follows the link, gets a 404, and reads the silence as "no
 * documentation". So every repository path either one names is held to a file
 * that exists, and the shape llms.txt promises (a title, a summary, sections
 * of links) is held too.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const LLMS = readFileSync(join(ROOT, "landing/llms.txt"), "utf8");
const AGENTS = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
const RAW = "https://raw.githubusercontent.com/SirAllap/agentglass/main/";

describe("llms.txt", () => {
  test("has the shape the convention asks for: an H1, a blockquote summary, then link lists", () => {
    const lines = LLMS.split("\n");
    expect(lines[0]).toBe("# agentglass");
    expect(lines.find((l) => l.startsWith("> "))).toBeDefined();
    expect(LLMS).toContain("\n## Docs\n");
    expect(LLMS).toContain("\n## Optional\n");
  });

  test("every link into the repository names a file that exists on main", () => {
    const links = [...LLMS.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(8);
    const inRepo = links.filter((u) => u.startsWith(RAW)).map((u) => u.slice(RAW.length));
    expect(inRepo.length).toBeGreaterThan(6);
    for (const path of inRepo) expect(existsSync(join(ROOT, path)), path).toBe(true);
    // The front door and the agent's page are both reachable from it.
    expect(inRepo).toContain("README.md");
    expect(inRepo).toContain("AGENTS.md");
    expect(inRepo).toContain("skills/browser-use/SKILL.md");
  });

  test("is shipped with the landing page, which is what lands at the site root", () => {
    const pages = readFileSync(join(ROOT, ".github/workflows/pages.yml"), "utf8");
    expect(pages).toContain("cp -r landing/. site/");
  });
});

describe("AGENTS.md", () => {
  test("every relative link names a file that exists", () => {
    const links = [...AGENTS.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]!).filter((u) => !/^https?:/.test(u));
    expect(links.length).toBeGreaterThan(4);
    for (const path of links) expect(existsSync(join(ROOT, path)), path).toBe(true);
  });

  test("names the bar and the two ways to drive the browser", () => {
    expect(AGENTS).toContain("make check");
    expect(AGENTS).toContain("agentglass-browser ");
    expect(AGENTS).toContain("agentglass-browser-mcp");
    expect(AGENTS).toContain("CLAUDE.md");
  });
});
