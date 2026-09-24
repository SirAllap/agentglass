// What the diff panel and the fleet card say about a change's risk flags. The
// flags themselves are decided on the server (shared/riskFlags.ts); this is only
// how they read — which kinds come first, which colour, what the tooltip says.
import { test, expect } from "bun:test";
import { riskChip, riskTitle } from "../src/lib/riskView.ts";
import { deriveAgents, buildRollups } from "../src/lib/derive.ts";
import type { SessionRisk, SessionRollup, WatchEvent } from "../../shared/types.ts";

const r = (kind: SessionRisk["kind"], file = "/w/orbit/src/x.ts", reason = "why"): SessionRisk => ({ kind, reason, file });

test("nothing flagged draws nothing — never a reassuring 'clean' chip", () => {
  expect(riskChip([])).toBeNull();
  expect(riskChip(undefined)).toBeNull();
});

test("the worst kind leads, each kind once, and a secret turns it red", () => {
  const chip = riskChip([r("deps"), r("secret"), r("deps", "/w/orbit/bun.lock")])!;
  expect(chip.text).toBe("secret · deps");
  expect(chip.tone).toBe("var(--error)");
  expect(riskChip([r("ci")])!.tone).toBe("var(--warning)");
});

test("past three kinds the rest are counted, so the chip stays one short line", () => {
  const chip = riskChip([r("deletion"), r("deps"), r("migration"), r("auth"), r("ci")])!;
  expect(chip.text).toBe("CI · auth · migration +2");
});

test("the tooltip names each file and its reason, and the line when there is one", () => {
  const t = riskTitle([{ kind: "secret", reason: "an AWS access key was added", file: "/w/orbit/config/settings.yml", line: 12 }, r("auth", "/w/orbit/src/auth.ts", "auth or permission code changed (auth)")]);
  expect(t).toContain("settings.yml:12 — an AWS access key was added");
  expect(t).toContain("auth.ts — auth or permission code changed (auth)");
});

test("the fleet card takes the session row's flags", () => {
  const now = Date.now();
  const ev = { id: 1, source_app: "orbit", session_id: "s1", hook_event_type: "PostToolUse", tool_name: "Edit",
    tool_use_id: null, agent_id: null, agent_type: null, model_name: "claude-opus-5", is_error: 0, error_text: null,
    input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 0,
    summary: "x", timestamp: now - 1000, payload: {} } as unknown as WatchEvent;
  const row = { session_id: "s1", source_app: "orbit", model_name: null, started_at: now - 5000, ended_at: null,
    last_seen: now, event_count: 1, tool_count: 1, error_count: 0, input_tokens: 0, output_tokens: 0,
    cache_creation_tokens: 0, cache_read_tokens: 0, cost_usd: 0, risks: [r("ci")] } as unknown as SessionRollup;
  expect(deriveAgents([ev], [], undefined, buildRollups([row]))[0].risks).toEqual([r("ci")]);
  expect(deriveAgents([ev])[0].risks).toEqual([]);
});

// There is no renderer here, so the wiring is asserted against source: the two
// screens the flags were built for have to actually read them.
const fleet = await Bun.file(new URL("../src/components/Fleet.tsx", import.meta.url)).text();
const preset = await Bun.file(new URL("../src/components/diff/PresetDiff.tsx", import.meta.url)).text();
const code = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l)).join("\n");

test("the fleet card draws the session's chip, with the reasons in its tooltip", () => {
  const card = code(fleet.slice(fleet.indexOf("function SessionCard("), fleet.indexOf("\n}\n", fleet.indexOf("function SessionCard("))));
  expect(card).toContain("riskChip(a.risks)");
  expect(card).toContain("riskTitle(a.risks)");
});

test("the diff panel marks each flagged file and spells the reasons out above its diff", () => {
  const src = code(preset);
  expect(src).toContain("riskTitle(c.risks)");
  expect(src).toContain("selected.risks?.map(");
});
