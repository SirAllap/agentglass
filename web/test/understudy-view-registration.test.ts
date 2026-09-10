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
const settingsSrc = read("web/src/components/SettingsModal.tsx");

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

describe("the Clone view is retired, and left nothing dangling", () => {
  /*
   * It had a rail seat until 2026-09-08. What it existed for — the precedent
   * bank — became the orchestrator's memory (seatmemory.ts), and what it kept
   * beside that was a ledger of 145,807 rows of which 879 were ever scored and
   * a work loop that had not run in a week. So the view went and its data did
   * not: the tables are untouched and the consent list that fills the bank now
   * lives on the Knowledge settings page, which is the only place it was ever
   * a setting.
   *
   * Retiring a view means leaving all four registries agreeing, and the way
   * that goes wrong is one of them keeping the id: the rail draws a tab whose
   * body is `null`, or `POST /control {to:"understudy"}` opens nothing.
   */
  it("is out of the ViewId union", () => {
    /* The union LINE, not the file: `understudy` is still a socket frame type
       and an alarm kind, and neither is a view. A test that grepped the whole
       file would have failed on those and taught somebody to delete them. */
    const union = /export type ViewId =([^;]+);/.exec(typesSrc);
    expect(union).not.toBeNull();
    expect(union![1]).not.toContain("understudy");
  });

  it("is out of VIEWS, so the rail cannot draw it", () => {
    expect(viewsSrc).not.toMatch(/id:\s*"understudy"/);
  });

  it("is out of Workspace's body switch", () => {
    expect(workspaceSrc).not.toContain('case "understudy"');
  });

  it("is off the server's allowlist, so POST /control refuses it", () => {
    expect(controlSrc).not.toContain('"understudy"');
  });

  it("but its settings page and its art are still here", () => {
    /* The half that was worth keeping. A test that only checked the removal
       would pass just as happily if somebody deleted the consent list too. */
    expect(settingsSrc).toContain("What the orchestrator learns from");
    expect(settingsSrc).toContain("<Teach active={open} />");
    expect(iconsSrc).toContain("export function UnderstudyIcon");
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

describe("the Clone glyph, still drawn for the Knowledge settings page", () => {
  it("is in the shared icon file, at the shared size", () => {
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
