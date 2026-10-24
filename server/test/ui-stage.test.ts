/*
 * The level 3 doors of /control, as data: what each takes, what it refuses, and
 * that none of them can be anything but a stage. The live half (a process, a
 * window) is control-levels-live.test.ts; the window half is web/test/ui-stage-*.
 */
import { describe, expect, test } from "bun:test";
import {
  UI_ACTIONS, describeUiActions, levelRefusal, parseUi, plainText, presentOf, repoName,
  STAGE_BODY_MAX, STAGE_SUBJECT_MAX, DISK_STAGE_MAX_IDS, DISK_STAGE_ID_MAX, diskStageIds, UI_REFUSED_FOR_AGENTS, READ_PANELS_LATE, type UiActionDef,
} from "../../shared/uiActions.ts";

const STAGES = ["pr.merge.stage", "pr.comment.stage", "pr.review.stage", "card.move.stage"] as const;
const ok = {
  "pr.merge.stage": { repo: "acme/orbit", number: 42, method: "squash", subject: "Add the thing", body: "Why it is needed." },
  "pr.comment.stage": { repo: "acme/orbit", number: 42, body: "Looks right." },
  "pr.review.stage": { repo: "acme/orbit", number: 42, verdict: "request_changes", body: "Please add a test." },
  "card.move.stage": { repo: "acme/orbit", number: 42, status: "Ready for QA" },
} as const;
const parse = (id: string, args: unknown, level: 1 | 2 | 3 = 3) => parseUi(UI_ACTIONS as unknown as Record<string, UiActionDef>, id, args, level);

/** The fifth level 3 door has its own arguments and its own tests (unstick-door.test.ts). */
const UNSTICK = "pr.unstick" as const;
/** The sixth is the Finder's own: no pull request in its arguments, so it has its own describe below. */
const FINDER = "finder.op.stage" as const;
/** The seventh is the machine panel's disk cleanup: one `ids` text, its own describe at the end. */
const DISK = "diskclean.stage" as const;
/** The eighth is the usage popover's account chip: a provider and an account id, its own describe at the end. */
const ACCOUNT = "usage.account.stage" as const;

describe("the stage doors", () => {
  test("exactly these four, pr.unstick (own file), finder.op.stage, diskclean.stage and usage.account.stage (below), are level 3, every one a stage, and nothing else is level 3", () => {
    const l3 = Object.entries(UI_ACTIONS).filter(([, d]) => d.level === 3).map(([id]) => id).sort();
    expect(l3).toEqual([...STAGES, UNSTICK, FINDER, DISK, ACCOUNT].sort());
    for (const id of [...STAGES, UNSTICK, FINDER, DISK, ACCOUNT]) expect((UI_ACTIONS[id] as UiActionDef).kind, id).toBe("stage");
  });

  for (const id of STAGES) {
    test(`${id}: refused at level 1 and 2, runs at 3 with valid arguments`, () => {
      expect(parse(id, ok[id], 1)).toBeNull();
      expect(parse(id, ok[id], 2)).toBeNull();
      expect(parse(id, ok[id], 3)).toMatchObject({ cmd: "ui", do: id, args: ok[id] });
    });
    test(`${id}: the refusal below level 3 says it is a level 3 door and whose setting that is`, () => {
      const s = levelRefusal(id, UI_ACTIONS[id] as UiActionDef, 2);
      expect(s).toContain("level 3");
      expect(s).toContain("owner");
      expect(s).not.toMatch(/AGENTGLASS_|=\d/);
    });
    test(`${id}: a missing or foreign argument is refused, and an extra one is dropped`, () => {
      for (const k of Object.keys(ok[id])) {
        const { [k]: _gone, ...rest } = ok[id] as Record<string, unknown>;
        const d = UI_ACTIONS[id] as UiActionDef;
        const optional = "optional" in d.args[k]! && d.args[k]!.optional;
        const got = parse(id, rest);
        // review: body optional only for an approval, so dropping it from a request for changes is a refusal
        if (optional && !(id === "pr.review.stage")) expect(got, `${id} without ${k}`).not.toBeNull();
        else if (!optional) expect(got, `${id} without ${k}`).toBeNull();
      }
      expect(parse(id, { ...ok[id], token: "x" })?.args).not.toHaveProperty("token");
    });
    test(`${id}: pull request number 0, a fraction, a string and a negative are refused`, () => {
      for (const number of [0, 1.5, "42", -1, null, Number.MAX_SAFE_INTEGER]) expect(parse(id, { ...ok[id], number }), String(number)).toBeNull();
    });
    test(`${id}: a repository must be owner/name`, () => {
      for (const repo of ["orbit", "../orbit", "acme/..", "acme/orbit/x", "acme/ orbit", "", "a/b\nc", 42]) expect(parse(id, { ...ok[id], repo }), String(repo)).toBeNull();
    });
  }

  test("the listing at level 2 has no stage door and at level 3 has all four, Unstick, the Finder's and the disk's", () => {
    expect(describeUiActions(UI_ACTIONS, 2).filter((d) => d.kind === "stage")).toEqual([]);
    expect(describeUiActions(UI_ACTIONS, 3).filter((d) => d.kind === "stage").map((d) => d.id).sort()).toEqual([...STAGES, UNSTICK, FINDER, DISK, ACCOUNT].sort());
  });

  test("merge: only the three methods; subject is one line", () => {
    for (const method of ["squash", "merge", "rebase"]) expect(parse("pr.merge.stage", { ...ok["pr.merge.stage"], method })).not.toBeNull();
    for (const method of ["force", "Squash", "", 1]) expect(parse("pr.merge.stage", { ...ok["pr.merge.stage"], method })).toBeNull();
    expect(parse("pr.merge.stage", { ...ok["pr.merge.stage"], subject: "two\nlines" })).toBeNull();
    expect(parse("pr.merge.stage", { ...ok["pr.merge.stage"], subject: "x".repeat(STAGE_SUBJECT_MAX + 1) })).toBeNull();
    expect(parse("pr.merge.stage", { repo: "acme/orbit", number: 1, method: "rebase" })).not.toBeNull();
  });

  test("review: a bare approval is fine; a request for changes or a comment must say something", () => {
    expect(parse("pr.review.stage", { repo: "acme/orbit", number: 1, verdict: "approve" })).not.toBeNull();
    for (const verdict of ["request_changes", "comment"]) {
      expect(parse("pr.review.stage", { repo: "acme/orbit", number: 1, verdict }), verdict).toBeNull();
      expect(parse("pr.review.stage", { repo: "acme/orbit", number: 1, verdict, body: "Because." }), verdict).not.toBeNull();
    }
    expect(parse("pr.review.stage", { repo: "acme/orbit", number: 1, verdict: "dismiss", body: "x" })).toBeNull();
  });
});

describe("plainText: what a person reads is what was sent", () => {
  const hidden: [string, string][] = [
    ["a right-to-left override", "ok‮gnirts"], ["a bidi isolate", "a⁦b⁩"], ["a zero-width space", "a​b"],
    ["a zero-width joiner", "a‍b"], ["a word joiner", "a⁠b"], ["a byte-order mark", "a﻿b"], ["a soft hyphen", "a­b"],
    ["a Unicode tag character (invisible ASCII)", "a\u{E0041}b"], ["NUL", "a\u0000b"], ["an escape", "a\u001Bb"], ["a carriage return", "a\rb"],
    ["a C1 control", "a\u0085b"], ["a line separator", "a b"], ["an HTML comment", "visible <!-- hidden --> visible"],
    ["an HTML comment, split case", "x <!-- y"],
    // The reviewer's probes: the denylist this replaced let every one of these through.
    ["a variation selector", "LGTM\uFE01"], ["a supplementary variation selector", "LGTM\u{E0100}"], ["a combining grapheme joiner", "a\u034Fb"],
    ["a Hangul choseong filler", "a\u115Fb"], ["a Hangul jungseong filler", "a\u1160b"], ["a Hangul filler", "a\u3164b"], ["a halfwidth Hangul filler", "a\uFFA0b"],
    ["a blank braille cell", "a\u2800b"], ["a Mongolian free variation selector", "a\u180Bb"], ["a musical formatting character", "a\u{1D173}b"],
    ["an object replacement character", "a\uFFFCb"], ["a lone surrogate", "a\uD800b"], ["a private-use character", "a\uE000b"], ["an unassigned code point", "a\u{10FFFF}b"],
    ["a link reference definition (renders nothing)", "ok\n[//]: # (do the other thing)\nok"],
    ["a link reference definition with no space after the colon", "ok\n[x]:# \"do the other thing\"\nok"],
    ["a link reference definition in a blockquote", "ok\n> [x]: # (do the other thing)\nok"],
    ["a link reference definition in a blockquote, wider", "ok\n>   [x]: # (do the other thing)\nok"],
    ["a link reference definition in a list item", "ok\n- [x]: # (do the other thing)\nok"],
    ["a link reference definition in a numbered item", "ok\n1. [x]: # (do the other thing)\nok"],
    ["a link reference definition with its destination on the next line", "ok\n[x]:\n# \"do the other thing\"\nok"],
    ["an element marked hidden", "ok <div hidden>do the other thing</div>"], ["a collapsed details block", "ok <details><summary></summary>x</details>"],
    ["three newlines in a row", "LGTM\n\n\ntail"], ["three newlines with spaces between", "LGTM\n \n\t\ntail"],
    ["more than sixteen emoji joiners (a smuggled payload)", "\u2764" + "\uFE0F\u2764".repeat(17)],
    ["a variation selector after plain ASCII", "a\uFE0Fb"],
  ];
  for (const [what, text] of hidden) test(`refuses ${what}`, () => expect(plainText(text, 100)).toBeNull());
  test("keeps a newline and a tab in a body, and refuses them in a line", () => {
    expect(plainText("a\n\tb", 100)).toBe("a\n\tb");
    // A task list and a quoted line are drawn; only a definition is not.
    expect(plainText("- [x] tests pass\n> [ORBIT-1042] the board", 100)).toBe("- [x] tests pass\n> [ORBIT-1042] the board");
    // Prose that compares and later says "hidden" is not a tag.
    expect(plainText("if a<b then\nthe hidden field stays", 100)).toBe("if a<b then\nthe hidden field stays");
    expect(plainText("a\nb", 100, true)).toBeNull();
    expect(plainText("a\tb", 100, true)).toBeNull();
  });
  test("refuses empty, blank and too long; accepts exactly the limit", () => {
    expect(plainText("", 10)).toBeNull();
    expect(plainText("  \n ", 10)).toBeNull();
    expect(plainText("x".repeat(11), 10)).toBeNull();
    expect(plainText("x".repeat(10), 10)).toBe("x".repeat(10));
    expect(plainText("x".repeat(STAGE_BODY_MAX + 1), STAGE_BODY_MAX)).toBeNull();
    expect(plainText(7, 10)).toBeNull();
  });
  test("a heart, a flag and a family still go through, and so do code and two blank lines", () => {
    for (const t of ["thanks \u2764\uFE0F", "ship it \u26A0\uFE0F", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", "a\n\nb", "    indented code\n    more"]) expect(plainText(t, 200), JSON.stringify(t)).toBe(t);
  });
  test("a line refuses runs of spaces (text hidden off the right edge) and an owner/name cannot start with a dash or dots", () => {
    expect(plainText("a  b", 50, true)).toBeNull();
    expect(plainText("a b", 50, true)).toBe("a b");
    for (const bad of ["-a/b", ".a/b", "..a/b", "a/.."]) expect(repoName(bad), bad).toBeNull();
  });
  test("ordinary text survives: markdown, links, code, accents, emoji", () => {
    const t = "## Plan\n- [ ] one\n[docs](https://example.com/a?b=1)\n`code` — café 🎉";
    expect(plainText(t, 500)).toBe(t);
  });
  test("repoName", () => {
    expect(repoName("acme/orbit")).toBe("acme/orbit");
    expect(repoName("Acme-Co/orbit_v2.js")).toBe("Acme-Co/orbit_v2.js");
    for (const bad of ["acme", "acme/", "/orbit", "./orbit", "acme/.", "acme/..", "a/b/c", "a b/c", "a/b;c", null]) expect(repoName(bad), String(bad)).toBeNull();
  });
});

describe("how a stage is shown", () => {
  test("a stage is quiet by default, named caller or not; an open from an unnamed caller is still now", () => {
    expect(presentOf(undefined, null, "stage")).toBe("quiet");
    expect(presentOf(undefined, "bot", "stage")).toBe("quiet");
    expect(presentOf(undefined, null, "open")).toBe("now");
    expect(presentOf(undefined, null)).toBe("now");
    expect(presentOf("now", null, "stage")).toBe("now");
    expect(presentOf("soon", "bot", "stage")).toBeNull();
  });
});

describe("finder.op.stage", () => {
  const f = (args: unknown, level: 1 | 2 | 3 = 3) => parse(FINDER, args, level);
  const good = { op: "trash", path: "/home/acme/notes.txt" };

  test("is level 3 and refused below it", () => {
    expect(f(good, 1)).toBeNull();
    expect(f(good, 2)).toBeNull();
    expect(f(good)).toMatchObject({ cmd: "ui", do: FINDER, args: good });
    expect(levelRefusal(FINDER, UI_ACTIONS[FINDER] as UiActionDef, 2)).toContain("level 3");
  });
  test("the enum holds the reversible operations and neither irreversible one", () => {
    const d = UI_ACTIONS[FINDER] as UiActionDef;
    const values = (d.args.op as { values: readonly string[] }).values;
    expect([...values].sort()).toEqual(["copy", "duplicate", "move", "new-folder", "rename", "trash"]);
    // server/src/fsroute.ts FS_IRREVERSIBLE, spelled out: shared cannot import it.
    for (const op of ["delete", "empty-trash"]) {
      expect(values, op).not.toContain(op);
      expect(f({ op, path: "/home/acme/notes.txt" }), op).toBeNull();
    }
  });
  test("move and copy need a destination, rename and new-folder need a name", () => {
    for (const op of ["move", "copy"]) {
      expect(f({ op, path: "/a/b" }), op).toBeNull();
      expect(f({ op, path: "/a/b", dest: "/a/c" }), op).toMatchObject({ args: { op, path: "/a/b", dest: "/a/c" } });
    }
    for (const op of ["rename", "new-folder"]) {
      expect(f({ op, path: "/a/b" }), op).toBeNull();
      expect(f({ op, path: "/a/b", name: "x" }), op).toMatchObject({ args: { op, path: "/a/b", name: "x" } });
    }
    for (const op of ["trash", "duplicate"]) expect(f({ op, path: "/a/b" }), op).not.toBeNull();
  });
  test("a name with a slash, a long one, and a multi-line one are refused", () => {
    expect(f({ op: "rename", path: "/a/b", name: "x/y" })).toBeNull();
    expect(f({ op: "rename", path: "/a/b", name: "x".repeat(256) })).toBeNull();
    expect(f({ op: "rename", path: "/a/b", name: "x".repeat(255) })).not.toBeNull();
    expect(f({ op: "rename", path: "/a/b", name: "a\nb" })).toBeNull();
  });
  test("paths are absolute spellings without dot segments, and what the operation does not use is dropped", () => {
    expect(f({ op: "trash", path: "notes.txt" })).toBeNull();
    expect(f({ op: "trash", path: "/a/../b" })).toBeNull();
    expect(f({ op: "move", path: "/a/b", dest: "rel" })).toBeNull();
    expect(f({ op: "rename", path: "/a/b", name: "x", dest: "/a/c" })?.args).not.toHaveProperty("dest");
    expect(f({ ...good, token: "x" })?.args).not.toHaveProperty("token");
  });
  test("describes itself as a stage that runs nothing", () => {
    const row = describeUiActions(UI_ACTIONS, 3).find((x) => x.id === FINDER)!;
    expect(row.kind).toBe("stage");
    expect(row.surface).toContain("nothing runs until the person presses");
  });
});

describe("diskclean.stage", () => {
  const f = (args: unknown, level: 1 | 2 | 3 = 3) => parse(DISK, args, level);
  const good = { ids: "docker:cache\nworktree:/home/acme/code/orbit-fix\ncache:uv" };

  test("is refused below level 3 and runs at 3, with the ids kept one per line", () => {
    expect(f(good, 1)).toBeNull();
    expect(f(good, 2)).toBeNull();
    expect(f(good)).toMatchObject({ cmd: "ui", do: DISK, args: good });
  });

  test("a stray blank line, a trailing newline and spaces around an id are tidied, not carried", () => {
    expect(f({ ids: "  docker:cache \n\ncache:uv\n" })?.args).toEqual({ ids: "docker:cache\ncache:uv" });
  });

  test("nothing, only blanks, a repeated id, too many ids and a too long id are refused", () => {
    expect(f({})).toBeNull();
    for (const ids of ["", "  \n \n", "docker:cache\ndocker:cache", 7, null]) expect(f({ ids }), JSON.stringify(ids)).toBeNull();
    const many = (n: number) => Array.from({ length: n }, (_, i) => `cache:c${i}`).join("\n");
    expect(f({ ids: many(DISK_STAGE_MAX_IDS) })).not.toBeNull();
    expect(f({ ids: many(DISK_STAGE_MAX_IDS + 1) })).toBeNull();
    expect(f({ ids: "x".repeat(DISK_STAGE_ID_MAX) })).not.toBeNull();
    expect(f({ ids: "x".repeat(DISK_STAGE_ID_MAX + 1) })).toBeNull();
  });

  test("hidden characters and a comment that hides are refused like any staged text", () => {
    for (const ids of ["docker:cache\u202Ehidden", "docker:cache <!-- x -->", "docker:cache\n\n\ncache:uv", "docker:cache\u0000"]) expect(f({ ids }), JSON.stringify(ids)).toBeNull();
  });

  test("an argument the door does not name is dropped", () => {
    expect(f({ ...good, run: true, dryRun: false })?.args).toEqual(good);
  });

  test("diskStageIds is the one reader of the text", () => {
    expect(diskStageIds(good.ids)).toEqual(["docker:cache", "worktree:/home/acme/code/orbit-fix", "cache:uv"]);
    expect(diskStageIds("")).toBeNull();
    expect(diskStageIds(undefined)).toBeNull();
  });

  test("describes itself as a stage that removes nothing", () => {
    const row = describeUiActions(UI_ACTIONS, 3).find((x) => x.id === DISK)!;
    expect(row.kind).toBe("stage");
    expect(row.level).toBe(3);
    expect(row.surface).toContain("nothing is removed until the person presses");
  });

  test("running the clean is not a door: it is listed as refused for agents, and is no registry entry", () => {
    expect(UI_REFUSED_FOR_AGENTS["diskclean.run"]).toContain("403");
    expect(Object.keys(UI_ACTIONS)).not.toContain("diskclean.run");
    expect(Object.keys(UI_ACTIONS).filter((id) => id.startsWith("diskclean."))).toEqual([DISK]);
  });

  test("the scan and plan are read through ui.read machine.disk, a pane the server holds", () => {
    expect(READ_PANELS_LATE).toContain("machine.disk");
  });
});

describe("usage.account.stage", () => {
  const f = (args: unknown, level: 1 | 2 | 3 = 3) => parse(ACCOUNT, args, level);
  const good = { provider: "anthropic", id: "acme-b" };

  test("is refused below level 3 and runs at 3", () => {
    expect(f(good, 1)).toBeNull();
    expect(f(good, 2)).toBeNull();
    expect(f(good)).toMatchObject({ cmd: "ui", do: ACCOUNT, args: good });
  });

  test("a provider the app does not know, an id that is not an account spelling, and a missing argument are refused", () => {
    for (const provider of ["gemini", "", 1, null]) expect(f({ ...good, provider }), String(provider)).toBeNull();
    for (const id of ["Acme", "-acme", "a b", "a".repeat(33), "acme/b", "..", "", 1]) expect(f({ ...good, id }), String(id)).toBeNull();
    expect(f({ provider: "anthropic" })).toBeNull();
    expect(f({ id: "acme-b" })).toBeNull();
  });

  test("an argument the door does not name is dropped", () => {
    expect(f({ ...good, token: "x", storage: "file" })?.args).toEqual(good);
  });

  test("describes itself as a stage that switches nothing", () => {
    const row = describeUiActions(UI_ACTIONS, 3).find((x) => x.id === ACCOUNT)!;
    expect(row.kind).toBe("stage");
    expect(row.surface).toContain("nothing switches until the person presses");
  });

  test("the switch itself is not a door: it is listed as refused for agents, and the accounts are read through ui.read usage.accounts", () => {
    expect(UI_REFUSED_FOR_AGENTS["usage.account.switch"]).toContain("403");
    expect(Object.keys(UI_ACTIONS).filter((id) => id.startsWith("usage.account."))).toEqual([ACCOUNT]);
    expect(READ_PANELS_LATE).toContain("usage.accounts");
  });
});
