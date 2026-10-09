import { describe, expect, it } from "bun:test";
import { commentResolvedPatch } from "../src/lib/taskOptimistic.ts";

/*
 * A tracker card's comments, held to the design system.
 *
 * Three decisions with no seam a test could render: the conversation is the
 * `agx-tl` timeline the pull request panel draws (face outside the card, not
 * in its header), a comment's actions sit on the compact control height, and
 * Resolve — only Resolve — draws on the press through an Optimistic layer.
 * They are rules about source, so they are asserted against source.
 */
const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
const chrome = await Bun.file(new URL("../src/components/workspace/Chrome.tsx", import.meta.url)).text();
const pr = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

/** Comments out, so a word a comment mentions is not mistaken for code. */
const naked = (s: string) => s
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/** A function from its signature to its own closing brace: past the
 *  parameter list by paren depth, then to the brace that closes the body. */
function fnBody(text: string, sig: string): string {
  const at = text.indexOf(sig);
  if (at < 0) return "";
  let i = at + sig.length - 1;
  let depth = 0;
  for (; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) break;
  }
  const open = text.indexOf("{", i);
  depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}" && --depth === 0) return text.slice(at, j + 1);
  }
  return "";
}

const card = naked(fnBody(src, "function CardDetail("));
const events = naked(fnBody(src, "function EventRun("));
const action = naked(fnBody(src, "function CommentAction("));

describe("a card's activity is the pull request's timeline", () => {
  it("found the pieces it reads", () => {
    for (const piece of [card, events, action]) expect(piece.length).toBeGreaterThan(200);
  });

  it("hangs the speaker's face beside the card, not inside its header", () => {
    expect(card).toContain('<div className="agx-tl">');
    expect(card).toMatch(/<span className="agx-av">\s*<Face n=\{0\} size=\{TL_AVATAR\}/);
    expect(card).toContain('className="agx-card');
    // The old card drew the author's face inside the sticky header. The
    // faces of whoever replied stay there, on the replies button.
    const header = card.match(/sticky z-\[5\][\s\S]*?More for this comment/);
    expect(header).not.toBeNull();
    expect(header![0]).not.toMatch(/<Face[^>]*name: c\.who/);
  });

  it("brings its own timeline rules rather than borrowing the pull request panel's", () => {
    expect(card).toContain("<style>{TL_CSS}</style>");
    expect(src).toMatch(/import \{[^}]*\bTL_CSS\b[^}]*\} from "\.\/workspace\/Chrome\.tsx"/);
  });

  it("puts the card's moves on the rail as small events", () => {
    expect(events).toContain('className="agx-tiny"');
    expect(events).toContain('className="agx-node"');
  });

  it("nests replies past the rail", () => {
    expect(card.match(/className="agx-nest/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("the timeline's geometry lives in Chrome.tsx, once", () => {
  it("exports the numbers and every rule the timeline uses", () => {
    for (const n of ["TL_AVATAR", "TL_GAP", "TL_RAIL", "TL_SPACE", "TL_INDENT", "TL_CSS"]) {
      expect(chrome).toMatch(new RegExp(`^export const ${n} =`, "m"));
    }
    const css = chrome.slice(chrome.indexOf("export const TL_CSS = `"));
    for (const c of [".agx-tl{", ".agx-ev{", ".agx-av{", ".agx-card{", ".agx-nest{", ".agx-node{", ".agx-tiny{"]) {
      expect(css).toContain(c);
    }
  });

  it("is not a second copy in the pull request panel", () => {
    expect(pr).not.toMatch(/^const TL_[A-Z]+ =/m);
    expect(pr).not.toContain(".agx-tl{");
    expect(pr).toContain("${TL_CSS}");
  });
});

describe("a comment's actions are compact controls", () => {
  it("take their height from CTRL_H.compact, not a typed number", () => {
    expect(action).toContain("height: CTRL_H.compact");
    expect(action).not.toMatch(/height:\s*\d/);
  });
});

describe("Resolve draws on the press; nothing else about a comment does", () => {
  it("keeps one Optimistic layer over the open card", () => {
    expect(card).toContain("new Optimistic<CardRead>(");
    expect(card).toContain("layers.view(serverFull)");
  });

  it("sends Resolve through the layer", () => {
    const resolve = card.match(/label=\{c\.resolved \? "Resolved" : "Resolve"\}[\s\S]*?\}\} \/>/);
    expect(resolve).not.toBeNull();
    expect(resolve![0]).toContain("layers.run(");
    expect(resolve![0]).toContain("commentResolvedPatch(");
    expect(resolve![0]).not.toContain("setBusyComment");
  });

  it("leaves delete, edit and reply waiting for the answer", () => {
    // One write goes through the layer, and it is the one above.
    expect(card.match(/layers\.run\(/g)?.length).toBe(1);
    for (const call of ["clickupCommentDelete(", "clickupCommentEdit(", "clickupCommentReply("]) {
      const at = card.indexOf(call);
      expect(at).toBeGreaterThan(0);
      // The handler that makes the call still marks the comment busy first.
      expect(card.slice(Math.max(0, at - 200), at)).toContain("setBusyComment(");
    }
  });

  it("reads every card through the layer's ticket", () => {
    const reads = card.match(/api\.clickupTask\(t\.id\)/g)?.length ?? 0;
    expect(reads).toBeGreaterThan(0);
    expect(card.match(/layers\.readStarted\(\)/g)?.length).toBe(reads);
  });
});

describe("the resolve patch", () => {
  const detail = {
    comments: [
      { id: "c1", who: "Sam Rivera", text: "Looks right on staging.", at: 1 },
      { id: "c2", who: "Kai Moreno", text: "Shipped with ORBIT-1042.", at: 2, resolved: true },
    ],
  };

  it("sets rather than flips, so applying it twice changes nothing more", () => {
    const once = commentResolvedPatch("c1", true)(detail);
    expect(once.comments[0]!.resolved).toBe(true);
    expect(commentResolvedPatch("c1", true)(once).comments[0]!.resolved).toBe(true);
    expect(commentResolvedPatch("c2", false)(detail).comments[1]!.resolved).toBe(false);
  });

  it("leaves a card without that comment untouched", () => {
    expect(commentResolvedPatch("nope", true)(detail)).toBe(detail);
    // A failed read carries no comments; the annotation says the key can be absent.
    const partial: { ok: boolean; error: string; comments?: [] } = { ok: false, error: "Could not read the card" };
    expect(commentResolvedPatch("c1", true)(partial)).toBe(partial);
  });
});
