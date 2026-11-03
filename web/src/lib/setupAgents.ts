/*
 * The five agent tiles of step 1, from one `/engines` report.
 *
 * The tiles are engine ids (shared/agentKinds.ts), so a new engine is a row in
 * that table and nothing here. Antigravity is deliberately absent: it stays in
 * Settings, and step 1 offers the five a person reaches for.
 */
import type { EngineReadiness, EnginesReport } from "../../../shared/types.ts";
import { agentProvider } from "../../../shared/agentKinds.ts";

/** The mark each tile draws. One per engine, so two tiles never look alike. */
export type AgentMark = "spark" | "term" | "agent" | "star" | "bolt";

export const SETUP_AGENTS: readonly { id: string; mark: AgentMark }[] = [
  { id: "claude", mark: "spark" },
  { id: "opencode", mark: "term" },
  { id: "codex", mark: "agent" },
  { id: "gemini", mark: "star" },
  { id: "hermes", mark: "bolt" },
];

export interface AgentTile {
  id: string;
  title: string;
  /** One line: what this CLI is. */
  what: string;
  mark: AgentMark;
  /** null: the report could not be read, so no state line is drawn. */
  state: string | null;
  tone: "ok" | "warn" | "off";
  /** It is the agent this machine will start. */
  picked: boolean;
  /** It can be installed, so the tile offers Install. */
  installable: boolean;
}

const engineOf = (report: EnginesReport | null, id: string): EngineReadiness | undefined =>
  report?.engines.find((e) => e.id === id);

/** Not installed: the probe did not find it, or it named the command as missing. */
function installed(engine: EngineReadiness | undefined): boolean {
  if (!engine) return false;
  if (engine.found) return true;
  return false;
}

export function agentTiles(report: EnginesReport | null, picked: string): AgentTile[] {
  return SETUP_AGENTS.map(({ id, mark }) => {
    const provider = agentProvider(id);
    const engine = engineOf(report, id);
    const here = installed(engine);
    const signed = engine?.account.signedIn === true;
    const state = report ? (here ? (signed ? "Detected · signed in" : "Detected · not signed in") : "Not installed") : null;
    return {
      id,
      title: provider?.title ?? id,
      what: provider?.what ?? "",
      mark,
      state,
      tone: !here ? "off" : signed ? "ok" : "warn",
      picked: picked === id,
      installable: !here,
    };
  });
}

/** The line above the tiles when this machine has none of the five. */
export function noneInstalled(tiles: readonly AgentTile[]): boolean {
  return tiles.every((t) => t.installable);
}

/** The step's own count, which says "none" rather than counting zero of them. */
export function detectedLine(tiles: readonly AgentTile[]): string {
  const here = tiles.filter((t) => !t.installable).length;
  return here === 0 ? "none detected on this machine yet" : `${here} detected on this machine, pick one`;
}

/** The install command a tile offers, from the catalogue rather than typed here. */
export function installLine(id: string): string | null {
  return agentProvider(id)?.probe?.install ?? null;
}
