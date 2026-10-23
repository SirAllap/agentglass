/*
 * The engine tile: one engine as the page draws it. A word and a dot say the
 * state (never colour alone), the hover carries the reason, a tile that cannot
 * be picked says why once on itself, and the letter is neutral: no engine has
 * an icon in the tree, and no brand colour is typed into the page.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { agentProvider } from "../../shared/agentKinds.ts";
import type { EngineReadiness } from "../../shared/types.ts";
import { EngineTile } from "../src/components/orchestration/EngineTile.tsx";
import { engineLetter, engineTileState } from "../src/components/orchestration/orchestrationCopy.ts";

const title = (id: string) => agentProvider(id)!.title;
const engine = (id: string, over: Partial<EngineReadiness> = {}): EngineReadiness => ({
  id, title: title(id), found: true, path: `/usr/bin/${id}`, version: "1.0.0", min: null, versionOk: true,
  account: { signedIn: true }, answers: { state: "never" },
  roles: { worker: { ok: true }, orchestrator: { ok: true } },
  missing: [], envelope: { via: null, enforced: "yes", note: "" },
  ...over,
});
const GONE = engine("hermes", { found: false, roles: { worker: { ok: false, why: "Hermes is not installed." }, orchestrator: { ok: false, why: "Hermes is not installed." } } });
const READY = [engine("claude"), GONE];

const tile = (o: Partial<React.ComponentProps<typeof EngineTile>> = {}) =>
  renderToStaticMarkup(React.createElement(EngineTile, { engine: "claude", role: "worker", readiness: READY, ...o }));
const count = (html: string, s: string) => html.split(s).length - 1;

const src = readFileSync(join(import.meta.dir, "..", "src", "components", "orchestration", "EngineTile.tsx"), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the engine tile", () => {
  test("the letter is the first one of the provider's title, never typed", () => {
    expect(engineLetter("claude")).toBe(title("claude").charAt(0).toUpperCase());
    expect(engineLetter("not-an-engine")).toBe("N");
    expect(tile()).toContain(`>${engineLetter("claude")}<`);
  });
  test("it says the engine, the model, and the state in a word", () => {
    const html = tile({ model: "sonnet" });
    expect(html).toContain(title("claude"));
    expect(html).toContain("sonnet");
    expect(html).toContain("Ready");
    expect(tile()).toContain("default model");
  });
  test("a state the person must fix is a word too, with the reason on hover", () => {
    const html = tile({ engine: "hermes" });
    expect(html).toContain("Not installed");
    expect(html).toContain('title="Hermes is not installed."');
  });
  test("before the probe answers every tile reads Checking", () => {
    expect(tile({ readiness: null })).toContain("Checking");
  });
  test("a limit hit reads as a warning word", () => {
    expect(tile({ limitHit: true })).toContain("Limit hit");
  });
  test("a position number shows only in a chain", () => {
    expect(tile({ position: 2 })).toContain(">2<");
    expect(tile()).not.toContain('data-position');
  });
  test("a tile that cannot be picked says why once, on the tile, and is not a live button", () => {
    const html = tile({ engine: "hermes", disabled: true, onPick() {} });
    expect(count(html, "Hermes is not installed.")).toBe(1);
    expect(html).toContain("disabled");
  });
  test("a tile with a pick handler is one button; without, it is not a control", () => {
    expect(tile({ onPick() {} })).toContain("<button");
    expect(tile()).not.toContain("<button");
    expect(tile({ onPick() {}, selected: true })).toContain('aria-pressed="true"');
  });
});

describe("the tile's source", () => {
  test("no brand colour and no engine name is typed into it", () => {
    expect(/#[0-9a-fA-F]{3,8}\b/.test(code)).toBe(false);
    for (const p of ["Claude", "OpenCode", "Hermes", "Codex", "Gemini"]) expect(code.includes(p), p).toBe(false);
  });
  test("the dot's colour is an ink or hue token of the house, and the state is read from the helper", () => {
    expect(code).toContain("engineTileState(");
    expect(code).toContain("var(--success");
    expect(code).toContain("var(--error");
  });
});

describe("a worker tile names the model it will really run", () => {
  const OC = [engine("opencode")];
  test("an OpenCode entry on its default shows the engine's default, not 'default model'", () => {
    const html = tile({ engine: "opencode", model: "", readiness: OC });
    expect(html).toContain("opencode/big-pickle");
    expect(html).not.toContain("default model");
    expect(html).toContain("Ready");
  });
  test("an explicit model is shown as typed, and an engine that picks its own still says so", () => {
    expect(tile({ engine: "opencode", model: "acme/orbit-1", readiness: OC })).toContain("acme/orbit-1");
    expect(tile({ engine: "claude", model: "" })).toContain("default model");
    expect(tile({ engine: "opencode", model: "", role: "orchestrator", readiness: OC })).toContain("default model");
  });
  test("an engine that needs a model and has none to fall back on says so instead of Ready", () => {
    const bare = { ...agentProvider("opencode")!, seatModel: undefined };
    const s = engineTileState("opencode", "worker", OC, false, "", bare);
    expect(s.word).toBe("Needs a model");
    expect(s.reason).toContain("pick one");
    expect(engineTileState("opencode", "worker", OC, false, "acme/orbit-1", bare).word).toBe("Ready");
  });
});
