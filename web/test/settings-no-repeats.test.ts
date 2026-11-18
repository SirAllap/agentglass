import { expect, test } from "bun:test";
import { Glob } from "bun";
import { repeatsTitle } from "../src/components/settings/shell/shellRules.ts";
import { installedFact, readyGroup, servicesCoveredByTools } from "../src/lib/toolsView.ts";
import { stickyReference } from "../src/components/settings/shell/PageRail.tsx";

// Settings ▸ Tasks showed "Services" then "SERVICES" in its card, an unpadded eyebrow,
// "Installed — not on your PATH", GitLab under Tools and Services, two counts for one
// group, and its rail pinned to the bottom of the window. These keep each one fixed.

const dir = new URL("../src/components/", import.meta.url).pathname;
const files = ["SettingsModal.tsx", ...[...new Glob("settings/pages/*.tsx").scanSync(dir)],
  ...[...new Glob("orchestration/*.tsx").scanSync(dir)], ...[...new Glob("flightPlan/*.tsx").scanSync(dir)]];
const src = new Map(files.map((f) => [f, require("fs").readFileSync(dir + f, "utf8") as string]));

/** The body of a component, by name, from any of the scanned files. */
function componentBody(name: string): string | null {
  for (const s of src.values()) {
    const at = s.search(new RegExp(`\\n(export )?function ${name}\\b`));
    if (at < 0) continue;
    const next = s.slice(at + 1).search(/\n(export )?(function|const) [A-Z]/);
    return s.slice(at, next < 0 ? undefined : at + 1 + next);
  }
  return null;
}

/*
 * Small label components that draw an <h3>–<h6> from their children: the old "SERVICES" line was
 * <FlowLabel>Services</FlowLabel>, so a heading written through one counts like a literal <h3>.
 */
const everyTsx = [...new Glob("**/*.tsx").scanSync(dir)].map((f) => require("fs").readFileSync(dir + f, "utf8") as string);
const wrappers = new Set<string>(["Group"]);
for (const s of everyTsx) {
  for (const m of s.matchAll(/\n(?:export )?function ([A-Z]\w*)\b/g)) {
    const rest = s.slice(m.index! + 1);
    const next = rest.slice(1).search(/\n(export )?(function|const) [A-Z]/);
    const body = next < 0 ? rest : rest.slice(0, next + 1);
    if (/<h([3-6])\b[^>]*>\s*\{(?:props\.)?children\}\s*<\/h\1>/.test(body)) wrappers.add(m[1]!);
  }
}
const W = [...wrappers].join("|");
const HEADINGS = new RegExp(`<SettingsCard\\b[^>]*?\\btitle="([^"]+)"|<(?:${W})\\b[^>]*>([^<{]+)<\\/(?:${W})>|<h[3-6][^>]*>([^<{]+)<\\/h[3-6]>`, "g");

test("a heading drawn through a label component is read like a literal one", () => {
  const probe = (jsx: string) => [...jsx.matchAll(HEADINGS)].map((h) => (h[1] ?? h[2] ?? h[3] ?? "").trim());
  expect(probe("<Group>Services</Group>")).toEqual(["Services"]);
  expect(probe('<h3 className="x">Services</h3>')).toEqual(["Services"]);
  expect(probe('<SettingsCard title="Services">')).toEqual(["Services"]);
});

test("repeatsTitle reads case and containment", () => {
  expect(repeatsTitle("Services", "SERVICES")).toBe(true);
  expect(repeatsTitle("Tools on this machine", "On this machine")).toBe(true);
  expect(repeatsTitle("Card tracker", "Card tracker")).toBe(true);
  expect(repeatsTitle("Sources", "Writes")).toBe(false);
  expect(repeatsTitle("Review", "Merge readiness")).toBe(false);
});

test("no heading inside a Section repeats the Section's title, in its own body or one component down", () => {
  const found: string[] = [];
  for (const [f, s] of src) {
    for (const m of s.matchAll(/<Section\b[^>]*?\btitle="([^"]+)"[^>]*>([\s\S]*?)<\/Section>/g)) {
      const title = m[1]!, body = m[2]!;
      const bodies = [body, ...[...body.matchAll(/<([A-Z]\w+)\b/g)].map((x) => componentBody(x[1]!) ?? "")];
      for (const b of bodies) for (const h of b.matchAll(HEADINGS)) {
        const inner = (h[1] ?? h[2] ?? h[3] ?? "").trim();
        if (repeatsTitle(title, inner)) found.push(`${f}: Section "${title}" holds "${inner}"`);
      }
    }
  }
  expect(found).toEqual([]);
});

test("a small-caps label in a settings page is never flush to its card edge", () => {
  const flush: string[] = [];
  for (const [f, s] of src) {
    if (!f.startsWith("settings/") && f !== "SettingsModal.tsx") continue;
    for (const m of s.matchAll(/className="([^"]*\buppercase\b[^"]*)"/g)) {
      // Padded itself, or the label inside a padded wrapper (Group's span sits in a px-3 div).
      const before = s.slice(Math.max(0, m.index! - 160), m.index);
      if (!/\bp[xl]?-\d/.test(m[1]!) && !/className="[^"]*\bpx-\d[^"]*">\s*<span\s*$/.test(before)) flush.push(`${f}: ${m[1]}`);
    }
  }
  expect(flush).toEqual([]);
});

test("a tool tile's install line never says Installed for a tool that is not there", () => {
  expect(installedFact("missing").label).toBe("Not installed");
  expect(installedFact("unsupported").label).toBe("Not used here");
  expect(installedFact("ok").label).toBe("Installed");
  expect(installedFact("attention").label).toBe("Installed");
});

test("the ready group says its count once", () => {
  const g = readyGroup(23, 1);
  const all = [g.title, g.badge, g.fold].join(" ");
  expect(all.match(/\d+/g)).toEqual(["23"]);
  expect(readyGroup(1, 0).badge).toBe("1 tool");
});

test("a service whose only problem is its missing tool is left to the tool tile", () => {
  const covered = servicesCoveredByTools([{ id: "gitlab", state: "missing-tool" }, { id: "github", state: "connected" }, { id: "clickup", state: "needs-auth" }]);
  expect([...covered]).toEqual(["gitlab"]);
  expect(servicesCoveredByTools(null).size).toBe(0);
});

test("the rail of a folded-in page measures from its own page, the first page from the content", () => {
  type Fake = { closest: (s: string) => Fake | null; querySelector: (s: string) => Fake | null };
  const content = {} as Fake, first = {} as Fake, second = {} as Fake;
  content.querySelector = () => first;
  const rail = (page: Fake) => ({ closest: () => page, querySelector: () => null }) as Fake;
  expect(stickyReference(rail(first) as never, content as never)).toBe(content as never);
  expect(stickyReference(rail(second) as never, content as never)).toBe(second as never);
  expect(stickyReference(rail(null as never) as never, content as never)).toBe(content as never);
});
