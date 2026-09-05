/*
 * A view lives in four files, and this is the one that says so.
 *
 * docs/EXTENDING.md spells the four out — the id in `ViewId`, the entry in
 * `VIEWS`, the arm in Workspace's `Body`, and the id in the server's
 * `VIEW_IDS` — and the fourth is duplicated at the trust boundary ON PURPOSE:
 * a POST /control body is untrusted input, so it is matched against a closed
 * set rather than against whatever the UI happens to export. Duplication that
 * is deliberate still drifts, and the way it drifts is silent: the rail grows
 * a tab, the keyboard reaches it, and `POST /control {cmd:"view"}` answers 400
 * for a view that plainly exists. Nothing throws and no type complains, because
 * every other ViewId consumer is a Partial<Record<…>> or a cast.
 *
 * Read as source and parsed, rather than imported and rendered. That is the
 * house idiom for this shape of check (see view-chrome.test.ts and
 * view-header-titles.test.ts, which read the panels as text for the same
 * reason): importing Workspace.tsx would want a DOM, a socket and nine panels
 * to answer a question about a switch statement, and the server file cannot be
 * imported from a web test at all without dragging in the engine.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const typesSrc = read("shared/types.ts");
const viewsSrc = read("web/src/components/workspace/views.ts");
const workspaceSrc = read("web/src/components/workspace/Workspace.tsx");
const controlSrc = read("server/src/control.ts");
const iconsSrc = read("web/src/components/workspace/icons.tsx");

/** The `ViewId` union, in the order it is written. */
const unionIds = (() => {
  const m = /export type ViewId =([^;]+);/.exec(typesSrc);
  expect(m).not.toBeNull();
  return [...m![1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]!);
})();

/** The `VIEWS` list, up to the export that follows it. `browser` is spelled
 *  `id: "browser" as const` because it ships behind a conditional, so this
 *  matches the id and not the whole property. */
const railIds = (() => {
  const from = viewsSrc.indexOf("export const VIEWS");
  const to = viewsSrc.indexOf("export const VIEW_IDS");
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return [...viewsSrc.slice(from, to).matchAll(/\bid:\s*"([a-z]+)"/g)].map((x) => x[1]!);
})();

/** The arms of `BodyImpl`'s switch — what Workspace actually renders. */
const bodyIds = (() => {
  const at = workspaceSrc.indexOf("function BodyImpl");
  expect(at).toBeGreaterThan(-1);
  return [...workspaceSrc.slice(at).matchAll(/case "([a-z]+)":/g)].map((x) => x[1]!);
})();

/** The server's allowlist. */
const controlIds = (() => {
  const m = /const VIEW_IDS: readonly ViewId\[\] = \[([^\]]*)\]/.exec(controlSrc);
  expect(m).not.toBeNull();
  return [...m![1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]!);
})();

/**
 * The dashboard is not in Workspace's switch and is not meant to be.
 *
 * Its data lives at the root — the live socket feeds the chat store from the
 * same frames — so it arrives already built as a prop and is rendered by the
 * map above `Body`, not inside it. Exempt by name with the reason attached,
 * the way view-chrome.test.ts handles its own exceptions, so that "off the
 * list" stays something somebody decided rather than something that happened.
 */
const BODY_EXEMPT: Record<string, string> = {
  dash: "rendered from the `dashboard` prop in the map above Body, because its data is built at the root",
};

describe("the understudy view is registered in all four places", () => {
  it("is in the ViewId union", () => {
    expect(unionIds).toContain("understudy");
  });

  it("is in VIEWS, in the utility drawer, on the key the rail was given", () => {
    const m = /\{\s*id:\s*"understudy",([^}]*)\}/.exec(viewsSrc);
    expect(m).not.toBeNull();
    const entry = m![1];
    /* The LABEL is "Clone" and the id is still "understudy". He renamed what
       he reads — "the name does the idea no justice, it is more of a clone" —
       and the id is a key in the view registry, in the control bus and in his
       saved layout, so renaming that would silently drop whatever pane
       arrangement he already has. */
    expect(entry).toContain('label: "Clone"');
    expect(entry).toContain('key: "u"');
    expect(entry).toContain("icon: UnderstudyIcon");
    expect(entry).toContain('group: "utility"');
    // A hint with something in it: the rail's tooltip and the shortcuts sheet
    // both read it, and an empty one leaves a tab nobody can identify.
    const hint = /hint:\s*"([^"]+)"/.exec(entry);
    expect(hint).not.toBeNull();
    expect(hint![1].length).toBeGreaterThan(20);
    // And the icon it names is imported from where the icons live, rather than
    // drawn in the list.
    /* The import line grows as views are added — it is a list, and pinning its
       last element made adding a view fail here rather than where it matters.
       What this checks is that the icon comes from the icon module at all. */
    expect(viewsSrc).toMatch(/import \{[^}]*UnderstudyIcon[^}]*\} from "\.\/icons\.tsx"/);
  });

  it("has a body for Workspace to render", () => {
    expect(bodyIds).toContain("understudy");
    expect(workspaceSrc).toContain("UnderstudyView");
    expect(workspaceSrc).toContain("understudy/UnderstudyPanel.tsx");
  });

  it("is on the server's allowlist, or POST /control answers 400 for it", () => {
    expect(controlIds).toContain("understudy");
  });
});

describe("the four lists agree", () => {
  it("every view id in the union has a rail entry", () => {
    expect(unionIds.filter((id) => !railIds.includes(id))).toEqual([]);
  });

  it("every rail entry is a real view id", () => {
    expect(railIds.filter((id) => !unionIds.includes(id))).toEqual([]);
  });

  it("every view has a body, except the one that is rendered elsewhere", () => {
    const missing = unionIds.filter((id) => !bodyIds.includes(id) && !BODY_EXEMPT[id]);
    expect(missing).toEqual([]);
    // The exemption is only true while the map still does it — a `dash` that
    // quietly stopped being rendered would otherwise pass this file forever.
    expect(workspaceSrc).toContain('v.id === "dash"');
  });

  it("every view is reachable through POST /control", () => {
    expect(unionIds.filter((id) => !controlIds.includes(id))).toEqual([]);
  });

  it("the server allowlist holds nothing the UI does not have", () => {
    expect(controlIds.filter((id) => !unionIds.includes(id))).toEqual([]);
  });

  it("no two views claim the same bare letter", () => {
    const keys = [...viewsSrc.matchAll(/\bkey:\s*"([^"]+)"/g)].map((x) => x[1]!);
    expect(keys.length).toBe(railIds.length);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("the understudy glyph", () => {
  it("is drawn in the shared icon file, at the shared size", () => {
    expect(iconsSrc).toContain("export function UnderstudyIcon({ size = ICON.md }: P)");
    // The shared attribute bag, not a private one: it carries viewBox 24,
    // stroke=currentColor and strokeWidth 2, which is what keeps the rail one
    // set of glyphs rather than eleven drawings.
    const at = iconsSrc.indexOf("export function UnderstudyIcon");
    const body = iconsSrc.slice(at, at + 900);
    expect(body).toContain("<svg {...svg} width={size} height={size}>");
    // Two figures, and the second one dashed — the whole meaning of the icon.
    // A solid pair is the `users` glyph every app has, and it promises a team
    // that acts; nothing in v1 acts.
    expect((body.match(/<circle/g) ?? []).length).toBe(2);
    expect(body).toContain("strokeDasharray");
  });
});
