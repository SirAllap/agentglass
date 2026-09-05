/*
 * THE BLACK WINDOW, AND THE TWO THINGS THAT KEEP IT SHUT.
 *
 * A render throw in any view used to unmount the whole tree — rail, top bar,
 * every other view, and the terminal's pty sockets with them. Twice in a month
 * that produced a running app with nothing on screen, and the second time
 * nothing said which view had done it.
 *
 * What React does with a boundary is React's business and not worth
 * re-testing. What is OURS, and what this pins, is three things: the class
 * declares the hook that makes it a boundary; every arm of the view switch is
 * inside one; and the fallback shows the error's own message rather than
 * "something went wrong".
 *
 * The wrapping check reads source, so it says HOW MUCH it read. A lint that
 * silently matched nothing would be green forever — this file's own subject is
 * a failure that stayed invisible, and a guard that can go blind is how it
 * would come back.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ViewBoundary } from "../src/components/workspace/ViewBoundary.tsx";

const workspace = readFileSync(new URL("../src/components/workspace/Workspace.tsx", import.meta.url), "utf8");

describe("a view that throws does not take the app with it", () => {
  test("the boundary declares the hook that makes it one", () => {
    /* Without this static method the class renders its children and catches
       nothing — it would look like a boundary in the tree and be scenery. */
    const derived = (ViewBoundary as unknown as { getDerivedStateFromError?: (e: unknown) => unknown }).getDerivedStateFromError;
    expect(typeof derived).toBe("function");
    expect(derived!(new Error("undefined is not a function"))).toEqual({
      failed: true,
      message: "undefined is not a function",
    });
    /* A throw that is not an Error still has to produce a readable line. */
    expect(derived!("just a string")).toEqual({ failed: true, message: "just a string" });
  });

  test("what it draws names the view, the error, and the way out", () => {
    const el = React.createElement(ViewBoundary, { label: "Git", children: null }) as unknown as {
      type: { prototype: { render: () => unknown; state: unknown; props: unknown; setState: () => void } };
    };
    /* Rendered by hand with the failed state, because `renderToStaticMarkup`
       does not run boundaries: on the server a throw propagates. This is the
       fallback branch, which is the part with words in it. */
    const inst = Object.create(el.type.prototype) as {
      state: unknown; props: unknown; setState: () => void; render: () => unknown;
    };
    inst.props = { label: "Git", children: null };
    inst.state = { failed: true, message: "cannot read length of undefined", attempt: 0 };
    inst.setState = () => {};
    const html = renderToStaticMarkup(inst.render() as React.ReactElement);
    expect(html).toContain("Git");
    expect(html, "the message is the whole point — a black window taught nobody anything")
      .toContain("cannot read length of undefined");
    expect(html).toContain("Reload this view");
    expect(html, "the promise the boundary makes").toContain("untouched");
  });

  test("every view in the workspace is inside one, and this counted them", () => {
    const at = workspace.indexOf("mounted.map(");
    expect(at, "the view map moved — this check is reading the wrong place").toBeGreaterThan(0);
    const map = workspace.slice(at, workspace.indexOf("</div>", workspace.indexOf("</ViewBox>", at)));

    /* The two arms the map can render: the dashboard, and everything else. */
    /* No leading `\b`: it applies to the whole alternation, and `<` is not a
       word character, so `\b<Body` never matches. This check found its own
       blindness only because it counts what it found — which is the whole
       argument for saying how much you read. */
    const arms = [...map.matchAll(/(dashboard\(active\)|<Body\b)/g)].map((m) => m[1]);
    expect(arms.length, `expected both arms, found: ${arms.join(", ")}`).toBe(2);

    const open = map.indexOf("<ViewBoundary");
    const close = map.indexOf("</ViewBoundary>");
    expect(open, "no boundary in the view map at all").toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    for (const arm of arms) {
      const where = map.indexOf(arm === "<Body" ? "<Body" : arm);
      expect(where, `${arm} is rendered outside the boundary`).toBeGreaterThan(open);
      expect(where, `${arm} is rendered after the boundary closes`).toBeLessThan(close);
    }
  });

  test("the boundary is per view, not one around the whole map", () => {
    /* One boundary above every view would catch the throw and still blank the
       rail and the terminal, which is the failure being fixed. It has to sit
       inside the keyed box so React remounts that view alone. */
    const at = workspace.indexOf("mounted.map(");
    const box = workspace.indexOf("<ViewBox", at);
    const bound = workspace.indexOf("<ViewBoundary", at);
    expect(box).toBeGreaterThan(-1);
    expect(bound, "the boundary is outside the per-view box").toBeGreaterThan(box);
  });
});
