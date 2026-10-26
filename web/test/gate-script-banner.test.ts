/*
 * The gate's command lets a call through when its script has moved, rather than
 * deny every tool call in every session. That makes "the gate is wired but not
 * holding" a state nothing else shows, so the Lantern says it.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GateScriptView } from "../src/components/GateScriptBanner.tsx";

const lantern = await Bun.file(new URL("../src/components/agents/AgentsView.tsx", import.meta.url).pathname).text();
const banner = await Bun.file(new URL("../src/components/GateScriptBanner.tsx", import.meta.url).pathname).text();

describe("the gate-script warning", () => {
  test("says nothing is being held, and offers the fix", () => {
    const html = renderToStaticMarkup(React.createElement(GateScriptView, { busy: false, error: null, onFix: () => {} }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("not holding anything");
    expect(html).toContain("Install the gate again");
  });

  test("says it denies when the stored command has no guard", () => {
    const html = renderToStaticMarkup(React.createElement(GateScriptView, { busy: false, error: null, denies: true, onFix: () => {} }));
    expect(html).toContain("denying every tool call");
    expect(html).not.toContain("not holding anything");
  });

  test("shows why a re-install failed", () => {
    const html = renderToStaticMarkup(React.createElement(GateScriptView, { busy: false, error: "the gate hook is not bundled with this build", onFix: () => {} }));
    expect(html).toContain("not bundled with this build");
  });

  test("the Agents screen renders it, and it reads the status the server computes", () => {
    expect(lantern).toMatch(/<GateScriptBanner active=\{active\} \/>/);
    expect(banner).toContain("gateScriptMissing");
    expect(banner).toContain("api.hooksStatus()");
  });
});
