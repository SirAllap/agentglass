/*
 * Which clicked links the app opens itself.
 *
 * A pull request URL printed in a terminal, a card linked from a card, `#1042`
 * in a review: each opened the system browser for something the app has a view
 * of. The router answers "is this ours" once, for the terminal and both
 * markdown renderers — and the half of that answer worth the most tests is the
 * "no", because an in-app view fetches what the URL names with the owner's own
 * credentials.
 */
import { describe, expect, it } from "bun:test";
import { classifyLink, isShortRef, openInApp, wantsExternal, type RouteDeps } from "../src/lib/linkRouter.ts";
import { renderInline } from "../src/lib/prBody.ts";
import { Markdown } from "../src/lib/markdown.tsx";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

describe("a GitHub pull request", () => {
  it("is the repository and the number", () => {
    expect(classifyLink("https://github.com/acme/orbit/pull/1042"))
      .toEqual({ kind: "pr", repo: "acme/orbit", number: 1042, url: "https://github.com/acme/orbit/pull/1042" });
  });

  it("survives what a real link carries after the number", () => {
    for (const tail of ["/", "/files", "/commits/abc1234", "#discussion_r1", "?w=1", "/files?diff=split#r2"]) {
      expect(classifyLink(`https://github.com/acme/orbit/pull/1042${tail}`), tail)
        .toMatchObject({ kind: "pr", repo: "acme/orbit", number: 1042 });
    }
  });

  it("drops the punctuation of the sentence it was printed in", () => {
    for (const tail of [")", ").", ",", ".", ";", ":", "!", "?", "]", "'", '"', ")."]) {
      expect(classifyLink(`https://github.com/acme/orbit/pull/1042${tail}`), tail)
        .toMatchObject({ kind: "pr", number: 1042 });
    }
  });

  it("an issue, a commit, a repository page and the pull request list stay GitHub's", () => {
    for (const url of [
      "https://github.com/acme/orbit/issues/1042",
      "https://github.com/acme/orbit/commit/abc1234",
      "https://github.com/acme/orbit",
      "https://github.com/acme/orbit/pulls",
      "https://github.com/acme/orbit/pull/new",
      "https://github.com/acme/orbit/pull/0",
    ]) expect(classifyLink(url)?.kind, url).toBe("external");
  });
});

describe("a ClickUp card", () => {
  it("by its own id, and by a workspace's custom id — the task is the last segment", () => {
    expect(classifyLink("https://app.clickup.com/t/86abc1xyz"))
      .toMatchObject({ kind: "card", query: "86abc1xyz" });
    expect(classifyLink("https://app.clickup.com/t/9012345/ORBIT-1042"))
      .toMatchObject({ kind: "card", query: "ORBIT-1042" });
  });

  it("inside parentheses, in a line that is not all ASCII", () => {
    // What the terminal hands over for "asígnate ORBIT-1042 (https://…/t/86abc1xyz)":
    // the addon may or may not have stopped before the paren.
    for (const raw of ["https://app.clickup.com/t/86abc1xyz)", "https://app.clickup.com/t/86abc1xyz).", "https://app.clickup.com/t/86abc1xyz,"]) {
      expect(classifyLink(raw), raw).toMatchObject({ kind: "card", query: "86abc1xyz" });
    }
  });

  it("with a query or a fragment", () => {
    expect(classifyLink("https://app.clickup.com/t/86abc1xyz?comment=90120000")).toMatchObject({ kind: "card", query: "86abc1xyz" });
    expect(classifyLink("https://app.clickup.com/t/86abc1xyz#activity")).toMatchObject({ kind: "card", query: "86abc1xyz" });
  });

  it("anything else on ClickUp — a list, a doc, the API — is not a card", () => {
    for (const url of [
      "https://app.clickup.com/9012345/v/li/901200",
      "https://app.clickup.com/t/",
      "https://app.clickup.com/t/a/b/c",
      "https://api.clickup.com/api/v2/task/86abc1xyz",
    ]) expect(classifyLink(url)?.kind, url).toBe("external");
  });
});

describe("what must never be routed in-app", () => {
  it("a host that only starts or ends like the real one", () => {
    for (const url of [
      "https://github.com.evil.example/acme/orbit/pull/1042",
      "https://evil-github.com/acme/orbit/pull/1042",
      "https://github.com@evil.example/acme/orbit/pull/1042",
      "https://user:pw@github.com/acme/orbit/pull/1042",
      "https://gist.github.com/acme/orbit/pull/1042",
      "https://app.clickup.com.evil.example/t/86abc1xyz",
      "https://evil.example/app.clickup.com/t/86abc1xyz",
      "https://evil.example/?u=https://github.com/acme/orbit/pull/1",
      "https://app-clickup.com/t/86abc1xyz",
      "https://www.clickup.com.evil.example/t/86abc1xyz",
      "https://github.com%2eevil.example/acme/orbit/pull/1",
      "https://evil.example\\@github.com/acme/orbit/pull/1",
      "https://github.com/acme%2Forbit/x/pull/1",
      "https://github.com/acme/orbit/pull/1%2F..%2F2",
      "https://github.com/acme/orbit/pull/1e3",
      "https://github.com/acme/orbit/pull/99999999999999999999",
    ]) expect(classifyLink(url)?.kind, url).toBe("external");
  });

  it("the real host spelled differently is still the real host", () => {
    // The parser normalises case, a trailing-dot-free host and backslashes;
    // what comes out the other side is github.com, so routing it is right.
    expect(classifyLink("https://GITHUB.COM/acme/orbit/pull/7")).toMatchObject({ kind: "pr", number: 7 });
    expect(classifyLink("https:\\\\github.com\\acme\\orbit\\pull\\7")).toMatchObject({ kind: "pr", number: 7 });
  });

  it("a scheme that is not http(s), or no URL at all", () => {
    for (const raw of [
      "javascript:alert(1)//https://github.com/acme/orbit/pull/1",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<a href=https://github.com/acme/orbit/pull/1>",
      "file:///github.com/acme/orbit/pull/1",
      "/acme/orbit/pull/1",
      "github.com/acme/orbit/pull/1",
      "",
      null,
    ]) expect(classifyLink(raw), String(raw)).toBeNull();
  });
});

describe("a `#123` in a pull request body", () => {
  /* The autolinker writes both kinds of reference as an /issues/ URL, as GitHub
     does. Only an anchor that READS like one is tried as a pull request. */
  const anchor = (html: string) => {
    const m = /<a href="([^"]+)"[^>]*>([^<]*)<\/a>/.exec(html);
    expect(m).not.toBeNull();
    return { href: m![1]!, shortRef: isShortRef(m![2]) };
  };

  it("resolves against the repository the body belongs to", () => {
    const a = anchor(renderInline("fixes #1042", "acme/orbit"));
    expect(a.shortRef).toBe(true);
    expect(classifyLink(a.href, a)).toEqual({ kind: "ref", repo: "acme/orbit", number: 1042, url: "https://github.com/acme/orbit/issues/1042" });
  });

  it("and against the one it names, when it names one", () => {
    const a = anchor(renderInline("see acme/billing#7.", "acme/orbit"));
    expect(classifyLink(a.href, a)).toMatchObject({ kind: "ref", repo: "acme/billing", number: 7 });
  });

  it("an /issues/ URL written out by a person is an issue, and leaves", () => {
    const a = anchor(renderInline("[the tracking issue](https://github.com/acme/orbit/issues/1042)", "acme/orbit"));
    expect(a.shortRef).toBe(false);
    expect(classifyLink(a.href, a)?.kind).toBe("external");
    expect(isShortRef("see #12")).toBe(false);
    expect(isShortRef("#12a")).toBe(false);
  });
});

describe("opening it", () => {
  function harness(opts: { checkout?: boolean; clickup?: boolean; known?: boolean } = {}) {
    const calls: string[] = [];
    const answer = (v: boolean) => (opts.known ? v : Promise.resolve(v));
    const deps: RouteDeps = {
      hasCheckout: (repo) => { calls.push(`locate ${repo}`); return answer(opts.checkout ?? true); },
      hasClickup: () => answer(opts.clickup ?? true),
      openPr: (repo, n, o) => { calls.push(`pr ${repo}#${n}${o?.fallback ? ` else ${o.fallback}` : ""}`); },
      openCard: (q) => { calls.push(`card ${q}`); },
      openExternal: (u) => { calls.push(`out ${u}`); return true; },
    };
    return { calls, deps };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("a pull request with a checkout here opens the view", async () => {
    const h = harness();
    expect(openInApp("https://github.com/acme/orbit/pull/1042", undefined, {}, h.deps)).toBe(true);
    await settle();
    expect(h.calls).toEqual(["locate acme/orbit", "pr acme/orbit#1042"]);
  });

  it("a pull request from a repository nobody cloned goes to the browser, not to an empty view", async () => {
    const h = harness({ checkout: false });
    expect(openInApp("https://github.com/acme/orbit/pull/1042", undefined, {}, h.deps)).toBe(true);
    await settle();
    expect(h.calls).toEqual(["locate acme/orbit", "out https://github.com/acme/orbit/pull/1042"]);
  });

  it("a short ref carries its way out, for when it turns out to be an issue", async () => {
    const h = harness();
    openInApp("https://github.com/acme/orbit/issues/7", undefined, { shortRef: true }, h.deps);
    await settle();
    expect(h.calls).toEqual(["locate acme/orbit", "pr acme/orbit#7 else https://github.com/acme/orbit/issues/7"]);
  });

  it("a card opens the board, or the browser when there is no board", async () => {
    const h = harness();
    openInApp("https://app.clickup.com/t/86abc1xyz", undefined, {}, h.deps);
    const g = harness({ clickup: false });
    openInApp("https://app.clickup.com/t/86abc1xyz", undefined, {}, g.deps);
    await settle();
    expect(h.calls).toEqual(["card 86abc1xyz"]);
    expect(g.calls).toEqual(["out https://app.clickup.com/t/86abc1xyz"]);
  });

  it("an answer already known is acted on inside the click, and a no is handed back to the caller", () => {
    /* Handing it back is what lets the browser open it from the click itself,
       which a popup blocker allows and a window.open after a round trip is not. */
    const yes = harness({ known: true });
    expect(openInApp("https://github.com/acme/orbit/pull/1042", undefined, {}, yes.deps)).toBe(true);
    expect(yes.calls).toEqual(["locate acme/orbit", "pr acme/orbit#1042"]);
    const no = harness({ known: true, checkout: false, clickup: false });
    expect(openInApp("https://github.com/acme/orbit/pull/1042", undefined, {}, no.deps)).toBe(false);
    expect(openInApp("https://app.clickup.com/t/86abc1xyz", undefined, {}, no.deps)).toBe(false);
    expect(no.calls).toEqual(["locate acme/orbit"]);
  });

  it("everything else is left to the caller, which does what it always did", () => {
    const h = harness();
    for (const url of ["https://example.com/", "https://github.com.evil.example/acme/orbit/pull/1", "javascript:alert(1)"]) {
      expect(openInApp(url, undefined, {}, h.deps), url).toBe(false);
    }
    expect(h.calls).toEqual([]);
  });

  it("Ctrl or Cmd is the way out, everywhere; Shift and Alt only in rendered markdown", () => {
    const h = harness();
    const pr = "https://github.com/acme/orbit/pull/1042";
    expect(openInApp(pr, { ctrlKey: true }, {}, h.deps)).toBe(false);
    expect(openInApp(pr, { metaKey: true }, {}, h.deps)).toBe(false);
    expect(openInApp(pr, { shiftKey: true }, { strict: true }, h.deps)).toBe(false);
    expect(wantsExternal({ shiftKey: true })).toBe(false);
    expect(wantsExternal({ altKey: true }, true)).toBe(true);
    expect(wantsExternal({ button: 1 }, true)).toBe(true);
    expect(wantsExternal({ button: 0 }, true)).toBe(false);
  });
});

/* Read at module level, and with comment lines stripped: a comment naming the
   call is not the call. Asserted as booleans so a failure does not print the
   whole of a twelve-thousand-line file. */
const strip = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const [TERMINAL, MARKDOWN, PR_PANEL] = (await Promise.all(
  ["../src/components/TerminalPanel.tsx", "../src/lib/markdown.tsx", "../src/components/PrPanel.tsx"]
    .map((p) => Bun.file(new URL(p, import.meta.url)).text()),
)).map(strip);

describe("the three places that draw links all ask the router", () => {
  it("the terminal's URL addon, the shared markdown and the pull request body", () => {
    expect(/new WebLinksAddon\(\(e, uri\) => \{ followLink\(uri, e\); \}\)/.test(TERMINAL)).toBe(true);
    expect(MARKDOWN.includes("openInApp(href, e, { strict: true })")).toBe(true);
    expect(PR_PANEL.includes("openInApp(href, e, { shortRef: isShortRef(a!.textContent) })")).toBe(true);
  });
});

describe("a bare URL in shared markdown is a link", () => {
  /* A card description pastes a pull request's address as it is; printed as
     text it was the one link on the card nothing could follow. */
  const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));
  const hrefs = (h: string) => [...h.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);

  it("without the sentence's punctuation", () => {
    const h = html("Fix landed in https://github.com/acme/orbit/pull/1042. Thanks");
    expect(hrefs(h)).toEqual(["https://github.com/acme/orbit/pull/1042"]);
    expect(h).toContain("</a>. Thanks");
  });

  it("and inside parentheses", () => {
    expect(hrefs(html("asígnate ORBIT-1042 (https://app.clickup.com/t/86abc1xyz) y dime"))).toEqual(["https://app.clickup.com/t/86abc1xyz"]);
  });

  it("but not inside a code span, and not twice inside a written link", () => {
    expect(hrefs(html("run `curl https://acme.example/x` first"))).toEqual([]);
    expect(hrefs(html("[the PR](https://github.com/acme/orbit/pull/7)"))).toEqual(["https://github.com/acme/orbit/pull/7"]);
  });

  it("and never for a scheme that is not http(s)", () => {
    expect(hrefs(html("javascript:alert(1) and data:text/html,x"))).toEqual([]);
  });
});
