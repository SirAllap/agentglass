import { describe, expect, test } from "bun:test";
import { askView, dropLast, stepRow, togglePick, type AskInput } from "../src/lib/prAskWho.ts";

// The people of acme/orbit. The author is the one who opened the pull request.
const people = [
  { login: "ines-b", name: "Ines Bauer" },
  { login: "mara-k", name: "Mara Kline" },
  { login: "theo-w", name: "Theo Walsh" },
  { login: "kofi-o" },
  { login: "dana-r", name: "Dana Reyes" },
];
const teams = [{ slug: "acme/relay-core", members: 4 }, { slug: "acme/qa", members: 1 }];

const input = (o: Partial<AskInput> = {}): AskInput => ({
  mode: "reviewers", author: "dana-r", repo: "acme/orbit", people, teams, picked: [], query: "", ...o,
});
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("sections with an empty search", () => {
  test("already asked, suggested, teams, everyone, in that order, each person once", () => {
    const v = askView(input({
      asked: [{ login: "mara-k", state: "approved" }, { login: "kofi-o", state: "awaiting" }],
      suggested: [{ login: "theo-w", reason: "Touched server/relay.ts" }, { login: "mara-k", reason: "Code owner of server/" }],
    }));
    expect(v.sections.map((s) => s.id)).toEqual(["asked", "suggested", "teams", "everyone"]);
    expect(ids(v.sections[0].rows)).toEqual(["mara-k", "kofi-o"]);
    expect(ids(v.sections[1].rows)).toEqual(["theo-w"]);
    expect(v.sections[1].rows[0].sub).toBe("Touched server/relay.ts");
    expect(ids(v.sections[3].rows)).toEqual(["ines-b", "dana-r"]);
    expect(new Set(ids(v.rows)).size).toBe(v.rows.length);
  });
  test("no suggestions: the last section says so and the section is not left out", () => {
    const v = askView(input());
    expect(v.sections.map((s) => [s.id, s.title])).toEqual([["teams", "Teams"], ["everyone", "Nobody to suggest here. Everyone"]]);
  });
  test("teams show their size; a team of one is one person", () => {
    const t = askView(input()).sections[0].rows;
    expect(t.map((r) => [r.id, r.sub])).toEqual([["@acme/relay-core", "4 people"], ["@acme/qa", "1 person"]]);
  });
  test("no teams, no Teams section", () => {
    expect(askView(input({ teams: [] })).sections.map((s) => s.id)).toEqual(["everyone"]);
  });
});

describe("already asked", () => {
  const asked = [{ login: "mara-k", state: "approved" as const }, { login: "theo-w", state: "changes" as const }, { login: "kofi-o", state: "awaiting" as const }];
  test("each row carries where it stands; only a reviewer who has answered can be asked again", () => {
    const rows = askView(input({ asked })).sections[0].rows;
    expect(rows.map((r) => [r.id, r.state, r.canRerequest, r.sub])).toEqual([
      ["mara-k", "approved", true, "approved"],
      ["theo-w", "changes", true, "changes requested"],
      ["kofi-o", "awaiting", false, "awaiting"],
    ]);
  });
  test("assignees have no asked section: that state is a review's", () => {
    expect(askView(input({ mode: "assignees", asked })).sections.map((s) => s.id)).toEqual(["everyone"]);
  });
  test("a search still shows the state on the row", () => {
    expect(askView(input({ asked, query: "mara" })).rows[0]).toMatchObject({ id: "mara-k", state: "approved", canRerequest: true });
  });
});

describe("the author", () => {
  test("is listed, greyed, with a reason about the viewer when the viewer opened it", () => {
    const row = askView(input({ viewerDidAuthor: true })).rows.find((r) => r.id === "dana-r")!;
    expect(row.disabled).toBe("You opened this pull request, so you cannot ask yourself.");
  });
  test("names the author when somebody else opened it", () => {
    const row = askView(input()).rows.find((r) => r.id === "dana-r")!;
    expect(row.disabled).toBe("dana-r opened this pull request, so they cannot be asked.");
  });
  test("the comparison ignores case and spaces, like reviewerPick", () => {
    expect(askView(input({ author: " Dana-R " })).rows.find((r) => r.id === "dana-r")!.disabled).toBeTruthy();
  });
  test("is never suggested", () => {
    const v = askView(input({ suggested: [{ login: "dana-r", reason: "Code owner of server/" }] }));
    expect(v.sections.map((s) => s.id)).not.toContain("suggested");
  });
  test("can be an assignee", () => {
    expect(askView(input({ mode: "assignees" })).rows.find((r) => r.id === "dana-r")!.disabled).toBeUndefined();
  });
  test("picking the author does nothing", () => {
    const row = askView(input()).rows.find((r) => r.id === "dana-r")!;
    expect(togglePick(["mara-k"], row)).toEqual(["mara-k"]);
  });
});

describe("assignees mode", () => {
  test("no teams: GitHub assigns people", () => {
    const v = askView(input({ mode: "assignees", query: "acme" }));
    expect(v.rows).toEqual([]);
    expect(askView(input({ mode: "assignees" })).rows.some((r) => r.kind === "team")).toBe(false);
  });
});

describe("a search", () => {
  test("one flat list, best match first: login start, name start, then inside", () => {
    const v = askView(input({
      people: [{ login: "x-mar", name: "Someone" }, { login: "maria-q", name: "Q" }, { login: "kit", name: "Mar Lee" }, { login: "zed" }],
      query: "mar",
    }));
    expect(v.sections.map((s) => s.id)).toEqual(["results"]);
    expect(ids(v.rows)).toEqual(["maria-q", "kit", "x-mar"]);
  });
  test("matches the name or the login, ignoring case and a leading @", () => {
    expect(ids(askView(input({ query: "@MARA" })).rows)).toEqual(["mara-k"]);
    expect(ids(askView(input({ query: "walsh" })).rows)).toEqual(["theo-w"]);
  });
  test("marks the match in the first line", () => {
    expect(askView(input({ query: "kli" })).rows[0]).toMatchObject({ label: "Mara Kline", mark: [5, 8] });
  });
  test("teams that match join the list", () => {
    expect(ids(askView(input({ query: "relay" })).rows)).toEqual(["@acme/relay-core"]);
  });
  test("nothing matches: the sentence names the query and the repository", () => {
    const v = askView(input({ query: "  zzz " }));
    expect(v.rows).toEqual([]);
    expect(v.empty).toEqual({
      title: "No one matches “zzz”", hint: "Try a name or @login. People outside acme/orbit cannot be asked.",
    });
  });
  test("a whitespace-only query is no query", () => {
    expect(askView(input({ query: "   " })).sections.length).toBeGreaterThan(1);
  });
});

describe("picked chips", () => {
  test("come in the order they were picked, with the name where there is one", () => {
    const v = askView(input({ picked: ["theo-w", "kofi-o", "@acme/qa"] }));
    expect(v.chips).toEqual([
      { id: "theo-w", label: "Theo Walsh", team: false, remove: "Remove theo-w" },
      { id: "kofi-o", label: "kofi-o", team: false, remove: "Remove kofi-o" },
      { id: "@acme/qa", label: "@acme/qa", team: true, remove: "Remove @acme/qa" },
    ]);
  });
  test("a picked row is marked, and the empty strip has its hint", () => {
    const v = askView(input({ picked: ["mara-k"] }));
    expect(v.rows.find((r) => r.id === "mara-k")!.picked).toBe(true);
    expect(v.rows.find((r) => r.id === "ines-b")!.picked).toBe(false);
    expect(askView(input()).chipsHint).toBe("Nobody picked yet");
  });
  test("toggle adds at the end and removes from the middle", () => {
    const row = { id: "kofi-o" };
    expect(togglePick(["mara-k"], row)).toEqual(["mara-k", "kofi-o"]);
    expect(togglePick(["kofi-o", "mara-k"], row)).toEqual(["mara-k"]);
  });
  test("Backspace takes the last chip only when the box is empty", () => {
    expect(dropLast(["a", "b"], "")).toEqual(["a"]);
    expect(dropLast(["a", "b"], "x")).toEqual(["a", "b"]);
    expect(dropLast([], "")).toEqual([]);
  });
});

describe("arrow keys", () => {
  const rows = [{}, { disabled: "no" }, {}, {}] as { disabled?: string }[];
  test("skip the rows that cannot be chosen, and wrap", () => {
    expect(stepRow(rows, 0, 1)).toBe(2);
    expect(stepRow(rows, 3, 1)).toBe(0);
    expect(stepRow(rows, 0, -1)).toBe(3);
    expect(stepRow(rows, 2, -1)).toBe(0);
  });
  test("from no current row: down is the first, up is the last", () => {
    expect(stepRow(rows, -1, 1)).toBe(0);
    expect(stepRow(rows, -1, -1)).toBe(3);
  });
  test("nothing to land on", () => {
    expect(stepRow([], -1, 1)).toBe(-1);
    expect(stepRow([{ disabled: "x" }], 0, 1)).toBe(-1);
  });
});
