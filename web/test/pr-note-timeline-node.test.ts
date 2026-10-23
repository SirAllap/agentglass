/*
 * A plugin's note card in the Conversation timeline: the timeline draws its
 * node at the left edge of the entry, so a card that starts at that edge sits
 * under it — the node covered the card's "local" chip, two padlocks on top of
 * each other. The card is indented past the node like a small event's text,
 * the node is a neutral icon, and the padlock is drawn once, in the chip.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunCard, type LocalNote, type LocalRun } from "../src/components/plugins/LocalReview.tsx";

const LOCK = 'd="M8 11V8a4 4 0 0 1 8 0v3"';
const run: LocalRun = {
  id: "r1", plugin: "acme-review", repo: "acme/orbit", number: 7, state: "done",
  title: "Review with a header that runs on and on and on and on and on and on and on", startedAt: 1_700_000_000_000,
};
const note = (id: string, severity: LocalNote["severity"]): LocalNote => ({
  id, runId: "r1", plugin: "acme-review", repo: "acme/orbit", number: 7, severity,
  title: "Lorem ipsum", status: "open", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
});
const sev: LocalNote["severity"][] = ["critical", "high", "medium", "low", "idea", "info"];

const html = (notes: LocalNote[]) =>
  renderToStaticMarkup(React.createElement(RunCard, { run, notes, onStatus() {} }));

const pr = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const chrome = await Bun.file(new URL("../src/components/workspace/Chrome.tsx", import.meta.url)).text();
const lines = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");

describe("a plugin note in the timeline", () => {
  test("the card draws one padlock and no node of its own, whatever the notes", () => {
    for (const notes of [[], sev.map((s, i) => note(`n${i}`, s))]) {
      const h = html(notes);
      expect(h.split(LOCK).length - 1).toBe(1);
      expect(h).not.toContain("agx-node");
    }
  });

  test("the timeline entry indents the card past the node and does not use the padlock as its node", () => {
    const at = pr.indexOf('lane: "local"');
    expect(at).toBeGreaterThan(0);
    const entry = lines(pr.slice(at, pr.indexOf("});", at)));
    expect(entry).toContain('className="agx-note"');
    expect(entry).not.toContain("LocalGlyph");
    expect(chrome).toMatch(/\.agx-note\{margin-left:\$\{TL_INDENT\}px/);
  });
});
