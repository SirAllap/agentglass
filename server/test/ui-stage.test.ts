/*
 * The level 3 doors of /control, as data: what each takes, what it refuses, and
 * that none of them can be anything but a stage. The live half (a process, a
 * window) is control-levels-live.test.ts; the window half is web/test/ui-stage-*.
 */
import { describe, expect, test } from "bun:test";
import {
  UI_ACTIONS, describeUiActions, levelRefusal, parseUi, plainText, presentOf, repoName,
  STAGE_BODY_MAX, STAGE_SUBJECT_MAX, type UiActionDef,
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

describe("the stage doors", () => {
  test("exactly these four, and pr.unstick (own file), are level 3, every one a stage, and nothing else is level 3", () => {
    const l3 = Object.entries(UI_ACTIONS).filter(([, d]) => d.level === 3).map(([id]) => id).sort();
    expect(l3).toEqual([...STAGES, UNSTICK].sort());
    for (const id of [...STAGES, UNSTICK]) expect((UI_ACTIONS[id] as UiActionDef).kind, id).toBe("stage");
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

  test("the listing at level 2 has no stage door and at level 3 has all four, and Unstick", () => {
    expect(describeUiActions(UI_ACTIONS, 2).filter((d) => d.kind === "stage")).toEqual([]);
    expect(describeUiActions(UI_ACTIONS, 3).filter((d) => d.kind === "stage").map((d) => d.id).sort()).toEqual([...STAGES, UNSTICK].sort());
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
