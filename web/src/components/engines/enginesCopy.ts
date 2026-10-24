/*
 * Every sentence the Agent engines page says, as pure functions of what the
 * server measured (`EngineReadiness`). There is no renderer in this project, so
 * the words are held here and a table-driven test pins them; the component
 * only places them.
 *
 * One rule for every line: say what is true, then the next thing to do, with
 * the command. No "unavailable", no "error", no badge without words.
 */
import type { EngineReadiness } from "../../../../shared/types.ts";
import type { StatusTone } from "../SettingsKit.tsx";

export type EngineState =
  | "checking" | "missing" | "old" | "broken" | "signin" | "ready" | "failed" | "testing";

/** Where an engine stands. `null` is the answer that has not arrived. */
export function engineState(e: EngineReadiness | null): EngineState {
  if (!e) return "checking";
  if (!e.found) return "missing";
  if (e.versionOk === false) return "old";
  // Found, but its version could not be told: it timed out, exited, or printed
  // something that is not a version. Never "not installed".
  // A timeout is a question not yet answered, not a broken engine.
  if (e.versionOk === null) return e.slow ? "checking" : "broken";
  if (e.missing[0]?.kind === "login") return "signin";
  if (e.answers.state === "running") return "testing";
  if (e.answers.state === "failed") return "failed";
  return "ready";
}

const BADGE: Record<EngineState, { tone: StatusTone; text: string }> = {
  checking: { tone: "checking", text: "Checking" },
  missing: { tone: "off", text: "Not installed" },
  old: { tone: "warn", text: "Needs update" },
  broken: { tone: "err", text: "Not working" },
  signin: { tone: "warn", text: "Needs sign-in" },
  ready: { tone: "ok", text: "Ready" },
  failed: { tone: "err", text: "Not answering" },
  testing: { tone: "checking", text: "Testing" },
};
export const badgeOf = (e: EngineReadiness | null) => BADGE[engineState(e)];

/** The one action in the card header. It is always there and always in the same
 *  place; what it is called, and whether it can be pressed, is all that moves. */
export function actionOf(e: EngineReadiness | null): { label: "Recheck" | "Test"; disabled: boolean } {
  const s = engineState(e);
  if (s === "ready" || s === "failed") return { label: "Test", disabled: false };
  if (s === "testing") return { label: "Test", disabled: true };
  return { label: "Recheck", disabled: s === "checking" && !e?.slow };
}

/** "3 minutes ago", in words; `now` is a parameter so a test can hold it. */
export function agoWords(at: number, now: number): string {
  const d = Math.max(0, now - at);
  if (d < 60_000) return "just now";
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"} ago`;
  if (d < 3_600_000) return unit(Math.floor(d / 60_000), "minute");
  if (d < 86_400_000) return unit(Math.floor(d / 3_600_000), "hour");
  return unit(Math.floor(d / 86_400_000), "day");
}

/** The first row under the header: the sentence, and the command it points at. */
export interface FirstRow { text: string; command?: string; hint?: string }

export function firstRow(e: EngineReadiness | null, now: number): FirstRow {
  const s = engineState(e);
  const fix = e?.missing[0];
  switch (s) {
    case "checking": return { text: e?.slow ? "Still checking: the version is slow to answer." : "Looking for it on this machine." };
    case "missing":
      return fix?.kind === "command"
        ? { text: "Not on this machine.", command: fix.command }
        : { text: `Not on this machine. ${fix?.what ?? ""}`.trim() };
    case "old": return { text: fix?.what ?? "", command: fix?.command };
    case "broken": return { text: fix?.what ?? "" };
    case "signin":
      return { text: "Not signed in.", command: fix?.command, hint: "Run it in a terminal; agentglass does not see the password." };
    case "failed": return { text: e?.answers.error ?? "It did not answer." };
    case "testing": return { text: "Sending one word. This takes a few seconds." };
    case "ready": {
      const a = e!.answers;
      return a.state === "ok" && a.at
        ? { text: `Answered in ${Math.max(1, Math.round((a.ms ?? 0) / 1000))} s, ${agoWords(a.at, now)}.` }
        : { text: "Not tested yet. Test sends one word and costs one small turn." };
    }
  }
}

export function versionText(e: EngineReadiness): string {
  if (e.version && e.versionOk === false && e.min) return `${e.version} · needs ${e.min}`;
  if (e.version) return e.version;
  return e.found ? (e.slow ? "Checking…" : "Could not be read") : "Not installed";
}

export function accountText(e: EngineReadiness): string {
  const a = e.account;
  if (a.signedIn === false) return "Not signed in";
  if (a.signedIn === null) return e.found ? "Sign-in is not checked" : "Not installed";
  if (a.account) return `Signed in with ${a.account}${a.model ? ` · ${a.model}` : ""}`;
  const names = [a.provider, a.model].filter(Boolean).join(" · ");
  return names || "Signed in";
}

export const roleBadge = (v: { ok: boolean }) => (v.ok ? { tone: "ok" as const, text: "Yes" } : { tone: "off" as const, text: "No" });

/** The disclosure on the account row: where the credential lives. */
export const credentialNote = (title: string, bin: string, statusArgs: string[] | undefined): string =>
  statusArgs
    ? `In ${title}'s own files. agentglass never reads them; it asks \`${bin} ${statusArgs.join(" ")}\`.`
    : `In ${title}'s own files. agentglass never reads them, and has no read-only command to ask ${title} with.`;

/** What a row under "reporting" says. The words are the old Agents list's. */
export type ReportState = "live" | "waiting" | "ready" | "missing";
export const REPORT_BADGE: Record<ReportState, { tone: StatusTone; text: string }> = {
  live: { tone: "ok", text: "Reporting" },
  waiting: { tone: "warn", text: "Waiting for events" },
  ready: { tone: "off", text: "Not connected" },
  missing: { tone: "off", text: "Not found" },
};

/* ── the tiles ── */

/** One line of a tile's checklist: an icon state, what it is, what it says. */
export interface TileCheck { state: "ok" | "warn" | "no"; label: string; value: string }

/** A logo square's colour, per engine. A mark of the engine, not a theme colour: it stays the same in every theme. */
const LOGO: Record<string, string> = {
  claude: "#d98a6c", codex: "#3f9a93", gemini: "#5c8fc4", opencode: "#6b7bb8", hermes: "#8a6bb8",
  antigravity: "#c4982f", qwen: "#4f7fb0",
};
export const logoOf = (id: string): string => LOGO[id] ?? "#8a8497";

/** The line under an engine's name: its version, or why there is none. */
export function versionLine(e: EngineReadiness | null): string {
  if (!e) return "Checking…";
  if (!e.found) return "Not on this machine";
  if (e.version && e.versionOk === false && e.min) return `${e.version} · needs ${e.min}`;
  return e.version ?? (e.slow ? "Checking…" : "Version unknown");
}

/** What the reporting probe says, in the tile's words. `null` is the roster not having answered. */
export function reportingCheck(p: { found: boolean; connected: boolean; seenAt: number | null } | null, loaded: boolean, now: number): TileCheck {
  const label = "Reports here";
  if (!p) return { state: "no", label, value: loaded ? "No hook to wire" : "…" };
  if (p.seenAt) return { state: "ok", label, value: `Last event ${agoWords(p.seenAt, now)}` };
  if (p.connected) return { state: "warn", label, value: "Wired, no event yet" };
  return { state: p.found ? "warn" : "no", label, value: p.found ? "Not connected" : "—" };
}

/** The checklist of an engine that is on this machine; the placeholders keep the row count while it is read. */
export function tileChecks(e: EngineReadiness | null, now: number, report: TileCheck): TileCheck[] {
  if (!e) return [
    { state: "no", label: "Installed", value: "…" }, { state: "no", label: "Signed in", value: "…" },
    report, { state: "no", label: "Can be used as", value: "…" }, { state: "no", label: "Last test", value: "…" },
  ];
  const a = e.account;
  const roles = [e.roles.orchestrator.ok && "orchestrator", e.roles.worker.ok && "worker"].filter(Boolean).join(" and ");
  const t = e.answers;
  return [
    { state: e.found ? "ok" : "no", label: "Installed", value: e.path ?? "Not on this machine" },
    // A warning only where the card itself says Needs sign-in: an engine that answers without an account is "Ready", and a triangle inside a Ready card asks the owner which of the two is true.
    { state: a.signedIn === true ? "ok" : a.signedIn === false && engineState(e) === "signin" ? "warn" : "no", label: "Signed in", value: accountText(e).replace(/^Signed in with /, "") },
    report,
    { state: roles ? "ok" : "no", label: "Can be used as", value: roles || "Not yet" },
    t.state === "ok" && t.at ? { state: "ok", label: "Last test", value: `${Math.max(1, Math.round((t.ms ?? 0) / 1000))} s, ${agoWords(t.at, now)}` }
      : t.state === "failed" ? { state: "warn", label: "Last test", value: t.error ?? "Did not answer" }
      : { state: "no", label: "Last test", value: t.state === "running" ? "Testing…" : "Not tested yet" },
  ];
}

/** Ready, need you, not installed: the three numbers the page header and the filter share. */
export function engineCounts(states: readonly EngineState[]): { all: number; ready: number; needs: number; absent: number } {
  return {
    all: states.length,
    ready: states.filter((s) => s === "ready").length,
    needs: states.filter((s) => s !== "ready" && s !== "checking" && s !== "missing").length,
    absent: states.filter((s) => s === "missing").length,
  };
}
