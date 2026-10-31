/*
 * FLIGHT PLAN, PILOT SETTINGS — what the Settings tab decides, as plain functions.
 *
 * The tab is a form over `PilotSettings`; everything it has to decide (which
 * setting id a field is, how a value goes over the wire, whether a refusal is a
 * lock or an error, what the track says per mode) lives here so a test can hold
 * it. The component only lays it out.
 */
import type { Actor, Pilot, PilotSettings } from "./flightPilot.ts";

export type Field = keyof PilotSettings;

/**
 * Setting id and scope per field, as the engine holds them (server/src/serverSettings.ts).
 * "project" is read and written at the project the person is in; "app" is one value for
 * the machine, sent with no root. The budget caps and the flying cap are
 * the machine's: the spend they are measured against is every project's together.
 */
export const PILOT_KEYS: Record<Field, { id: string; scope: "project" | "app" }> = {
  pilot: { id: "flightPlan.pilot", scope: "project" },
  reviews: { id: "flightPlan.preflight.reviews", scope: "project" },
  sizes: { id: "flightPlan.preflight.sizes", scope: "app" },
  secondLooks: { id: "flightPlan.preflight.secondLooks", scope: "app" },
  model: { id: "flightPlan.preflight.model", scope: "project" },
  costCapUsd: { id: "flightPlan.preflight.costCapUsd", scope: "project" },
  dailyUsd: { id: "flightPlan.budget.dailyUsd", scope: "app" },
  weeklyUsd: { id: "flightPlan.budget.weeklyUsd", scope: "app" },
  maxFlying: { id: "flightPlan.maxFlying", scope: "app" },
  askOnLarge: { id: "flightPlan.autopilot.askOnLarge", scope: "project" },
  askOnSensitive: { id: "flightPlan.autopilot.askOnSensitive", scope: "project" },
  permissions: { id: "flightPlan.builder.permissions", scope: "app" },
  builderBase: { id: "flightPlan.builderBase", scope: "app" },
};
export const FIELDS = Object.keys(PILOT_KEYS) as Field[];

/** The engine's defaults (design doc, section 6): what a row shows until its read comes back. */
export const DEFAULT_PILOT_SETTINGS: PilotSettings = {
  pilot: "copilot",
  reviews: { plan: true, taskDone: false, pr: false },
  sizes: "ML",
  secondLooks: 1,
  model: "sonnet",
  costCapUsd: 0.5,
  dailyUsd: 5, weeklyUsd: 20,
  maxFlying: 2,
  askOnLarge: true, askOnSensitive: true,
  permissions: "auto",
  builderBase: "local",
};

const REVIEW_KEYS = ["plan", "taskDone", "pr"] as const;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A value off the wire to a typed one, or undefined when it is not one the field takes (the default stays). */
export function decode<F extends Field>(field: F, raw: unknown): PilotSettings[F] | undefined {
  const out = ((): unknown => {
    switch (field) {
      case "pilot": return raw === "manual" || raw === "copilot" || raw === "autopilot" ? raw : undefined;
      case "reviews":
        return Array.isArray(raw)
          ? { plan: raw.includes("plan"), taskDone: raw.includes("taskDone"), pr: raw.includes("pr") }
          : undefined;
      case "sizes": return raw === "L" || raw === "ML" ? raw : undefined;
      case "secondLooks": return raw === 0 || raw === 1 || raw === 2 ? raw : undefined;
      case "model": return typeof raw === "string" && raw.length <= 120 && /^[A-Za-z0-9][\w.[\]-]*$/.test(raw) ? raw : undefined;
      case "costCapUsd": case "dailyUsd": case "weeklyUsd": return num(raw) !== null && (raw as number) >= 0 ? raw : undefined;
      case "maxFlying": return raw === 1 || raw === 2 || raw === 3 ? raw : undefined;
      case "askOnLarge": case "askOnSensitive": return typeof raw === "boolean" ? raw : undefined;
      case "builderBase": return raw === "local" || raw === "remote" ? raw : undefined;
      case "permissions": return raw === "default" || raw === "auto" || raw === "bypassPermissions" ? raw : undefined;
    }
  })();
  return out as PilotSettings[F] | undefined;
}

/** A typed value to what the door stores: the reviews are a list of the places that are ticked. */
export function encode<F extends Field>(field: F, value: PilotSettings[F]): unknown {
  if (field !== "reviews") return value;
  const r = value as PilotSettings["reviews"];
  return REVIEW_KEYS.filter((k) => r[k]);
}

export type UsdField = "costCapUsd" | "dailyUsd" | "weeklyUsd";
const USD_RANGE: Record<UsdField, { max: number; say: string }> = {
  costCapUsd: { max: 5, say: "The cap is above $0 and at most $5." },
  dailyUsd: { max: 1000, say: "A day is above $0 and at most $1000." },
  weeklyUsd: { max: 1000, say: "A week is above $0 and at most $1000." },
};

/** What was typed into a dollar box: a positive amount in range, to the cent, or the sentence that says why not. */
export function parseUsd(field: UsdField, text: string): { ok: true; value: number } | { ok: false; error: string } {
  const n = Number(text.trim().replace(/^\$/, ""));
  const { max, say } = USD_RANGE[field];
  if (!text.trim() || !Number.isFinite(n) || n <= 0 || n > max) return { ok: false, error: say };
  return { ok: true, value: Math.round(n * 100) / 100 };
}
export const fmtUsd = (n: number): string => n.toFixed(2);

export type RowNote = { kind: "error" | "lock" | "wait"; text: string };

/**
 * How a write came back, as the note its row shows (null = saved).
 * A person-only setting refused is a lock, not a fault: the row says who may.
 * `applied: false` is a change that waits for approval, so the control goes back
 * to what is in force and says so.
 */
export function noteFor(r: { ok: boolean; applied?: boolean; error?: string }): RowNote | null {
  /* The web client reads the door's 202 (a change that waits for approval) as ok:false with applied:false: that is a wait, not a fault. */
  if (r.applied === false) return { kind: "wait", text: "Waits for your approval, because it raises what may run or spend." };
  if (r.ok) return null;
  if (/person|only you|agent cannot/i.test(r.error ?? "")) return { kind: "lock", text: "Only you can change this, from the Settings window." };
  return { kind: "error", text: r.error ? `Not saved: ${r.error}` : "Not saved." };
}

/** A budget meter: the share spent, and whether the row should warn. */
export function meter(spent: number, cap: number): { pct: number; tone: "ok" | "warn" | "full" } {
  const pct = cap > 0 ? Math.min(1, Math.max(0, spent / cap)) : 0;
  return { pct, tone: pct >= 1 ? "full" : pct >= 0.8 ? "warn" : "ok" };
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The line under a mode card: what would be asked of the person right now, or why it cannot be said. */
export function nowLine(pilot: Pilot, waiting: number | undefined, flying: number | undefined, seated: boolean | undefined): { bold: string; tail: string } | null {
  if (seated === false && pilot !== "manual") return { bold: "", tail: "No seat: acts as Manual" };
  if (waiting === undefined) return null;
  if (pilot === "manual") return { bold: plural(waiting, "plan"), tail: " would wait for you" };
  if (pilot === "copilot") return { bold: plural(waiting, "Go card"), tail: ", nothing else" };
  return { bold: plural(waiting, "question"), tail: ` for you${flying === undefined ? "" : ` · ${flying} flying`}` };
}

export type StationKey = "create" | "write" | "review" | "answer" | "go" | "launch" | "build" | "integrate";
export interface Step { key: StationKey; label: string; actor: Actor; by: string; gate?: true }

/** Who does each of the eight steps in a mode (design doc, section 1). Go is the gate. */
export function track(pilot: Pilot): Step[] {
  const you = pilot === "manual";
  const goYou = pilot !== "autopilot";
  return [
    { key: "create", label: "Create", actor: "person", by: "you or coord." },
    { key: "write", label: "Write", actor: "coordinator", by: you ? "author agent" : "orchestrator" },
    { key: "review", label: "Review", actor: "reviewer", by: "Preflight" },
    you ? { key: "answer", label: "Answer", actor: "person", by: "you" } : { key: "answer", label: "Answer", actor: "coordinator", by: "orchestrator" },
    goYou ? { key: "go", label: "Go", actor: "person", by: "you", gate: true } : { key: "go", label: "Go", actor: "coordinator", by: "orchestrator", gate: true },
    you ? { key: "launch", label: "Launch", actor: "person", by: "you" } : { key: "launch", label: "Launch", actor: "coordinator", by: "orchestrator" },
    { key: "build", label: "Build", actor: "builder", by: "builder" },
    you ? { key: "integrate", label: "Integrate", actor: "person", by: "you" } : { key: "integrate", label: "Integrate", actor: "coordinator", by: "orchestrator" },
  ];
}
