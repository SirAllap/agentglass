/*
 * What the form for a move's fields decides, away from the screen: which
 * fields are still empty, what each filled one will do, whether the button may
 * be pressed, and the one sentence under it. The check itself is the server's
 * (`shared/jiraMoveFields.ts`), so what enables the button is what the server
 * will accept.
 *
 * Ceiling: one sentence at a time. Several problems at once name the first.
 */
import { effectOf, isBlank, valueProblem, type JiraFieldValue, type JiraMoveField } from "../../../shared/jiraMoveFields.ts";

export type FormPhase = "idle" | "running" | "failed" | "done";
export type FormValues = Record<string, JiraFieldValue>;

const list = (names: string[]): string => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

export interface FormView {
  /** Required fields still empty, by key. */
  missing: string[];
  /** A filled field's own problem, by key. */
  problems: Record<string, string>;
  /** Set when a required field is of a kind that cannot be filled here: the move cannot be made from this form at all. */
  blocked: string | null;
  /** Optional fields this cannot fill, said once so none is dropped in silence. */
  notOffered: string | null;
  /** What each filled field will do, in the order of the screen. */
  effects: string[];
  canSubmit: boolean;
  /** The sentence under the form before the press. */
  hint: string;
}

export function formView(screen: readonly JiraMoveField[], values: FormValues, o: { phase: FormPhase }): FormView {
  const stuck = screen.filter((f) => f.required && f.kind === "unsupported");
  const loose = screen.filter((f) => !f.required && f.kind === "unsupported");
  const fillable = screen.filter((f) => f.kind !== "unsupported");
  const missing = fillable.filter((f) => f.required && isBlank(values[f.key])).map((f) => f.key);
  const problems: Record<string, string> = {};
  for (const f of fillable) {
    const why = valueProblem(f, values[f.key]);
    if (why) problems[f.key] = why;
  }
  const blocked = stuck.length ? `${list(stuck.map((f) => f.name))} cannot be filled in here yet. Make this move in Jira.` : null;
  const notOffered = loose.length ? `Not offered here: ${list(loose.map((f) => f.name))}.` : null;
  const effects = fillable.map((f) => effectOf(f, values[f.key], o.phase === "done")).filter((x): x is string => x !== null);
  const names = missing.map((k) => screen.find((f) => f.key === k)!.name);
  const first = Object.values(problems)[0];
  const canSubmit = (o.phase === "idle" || o.phase === "failed") && !blocked && !missing.length && !first;
  const hint = blocked ?? (missing.length ? `${list(names)} ${names.length > 1 ? "are" : "is"} required.` : first ?? "Nothing in Jira has changed yet.");
  return { missing, problems, blocked, notOffered, effects, canSubmit, hint };
}

/** The line under the form once the press has started: what is true now, in the words of the answer. */
export function footerOf(o: { phase: FormPhase; hint: string; blocked?: boolean; error?: string | undefined; key: string; now?: string | undefined }): { text: string; tone: "plain" | "bad" | "good" } {
  switch (o.phase) {
    case "idle": return { text: o.hint, tone: o.blocked ? "bad" : "plain" };
    case "running": return { text: "Writing to Jira…", tone: "plain" };
    case "failed": return { text: o.error || "Jira would not take that move. Nothing was changed.", tone: "bad" };
    case "done": return { text: o.now ? `Done. ${o.key} is now ${o.now}.` : "Done.", tone: "good" };
  }
}

/** The values to send: what is filled, as the server's check will read it. */
export function toSend(screen: readonly JiraMoveField[], values: FormValues): FormValues {
  const out: FormValues = {};
  for (const f of screen) if (f.kind !== "unsupported" && !isBlank(values[f.key])) out[f.key] = values[f.key]!;
  return out;
}

/** What the status list says beside a move that asks first: the field's name when it is one, a count when it is several. */
export function askHint(screen: readonly JiraMoveField[] | undefined, needs: readonly string[]): string {
  const asked = (screen ?? []).filter((f) => f.required);
  const n = asked.length || needs.length;
  return n === 1 ? `asks for ${asked[0]?.name ?? needs[0]}` : `asks for ${n} fields`;
}
