/**
 * The fields a Jira move's screen asks for, and the one check both sides run
 * on what was typed: the form disables its button with it, and the server
 * refuses with it before a request leaves. One rule, so the screen and the
 * door cannot disagree about what "filled in" means.
 *
 * A field has a kind, read from the site's own schema. The kinds here are the
 * ones a person can fill from a small form; anything else is `unsupported`
 * and is named, never dropped. Values travel as plain strings (a choice by its
 * id, several as a list of ids); the server turns them into the site's shape.
 *
 * Ceiling: no people, no cascading choices, no several-lines-of-markup
 * beyond Markdown, no date-times. A required field of one of those makes the
 * move unmakeable here, and the form says which field and why.
 */

export type JiraFieldKind = "comment" | "option" | "options" | "text" | "longtext" | "number" | "date" | "unsupported";

export interface JiraFieldChoice { id: string; name: string }

export interface JiraMoveField {
  key: string;
  name: string;
  required: boolean;
  kind: JiraFieldKind;
  /** The choices, for `option` and `options`: the site's own, by id. */
  choices?: JiraFieldChoice[];
  /** For `unsupported`: the site's word for the type, to say what this cannot fill in. */
  type?: string;
}

/** What one field holds in a request: text, a choice id, or several ids. */
export type JiraFieldValue = string | string[];

export const TEXT_MAX = 255;
export const LONGTEXT_MAX = 30_000;

/** Is this value as good as nothing? Only blank text and an empty list are. */
export function isBlank(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** Why this one value cannot be sent for this field, or null. A blank value is not a problem here: `required` is the other check. */
export function valueProblem(f: JiraMoveField, v: unknown): string | null {
  if (isBlank(v)) return null;
  switch (f.kind) {
    case "option": {
      if (typeof v !== "string") return `${f.name} takes one choice`;
      return f.choices?.some((c) => c.id === v) ? null : `${f.name} is not one of the choices`;
    }
    case "options": {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return `${f.name} takes a list of choices`;
      const ids = new Set(f.choices?.map((c) => c.id));
      return v.every((x) => ids.has(x)) && new Set(v).size === v.length ? null : `${f.name} is not one of the choices`;
    }
    case "text":
      if (typeof v !== "string") return `${f.name} takes text`;
      if (/[\u0000-\u001f\u007f]/.test(v)) return `${f.name} takes a single line`;
      return v.length > TEXT_MAX ? `${f.name} is too long` : null;
    case "comment":
    case "longtext":
      if (typeof v !== "string") return `${f.name} takes text`;
      return v.length > LONGTEXT_MAX ? `${f.name} is too long` : null;
    case "number":
      return typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? null : `${f.name} takes a number`;
    case "date": {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${f.name} takes a date`;
      const d = new Date(`${v}T00:00:00Z`);
      return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? `${f.name} takes a date` : null;
    }
    case "unsupported":
      return `${f.name} cannot be filled in here yet`;
  }
}

export type MoveFieldsCheck =
  | { ok: true; values: Record<string, JiraFieldValue> }
  | { ok: false; error: string; /** Keys still empty or wrong, for marking them. */ bad: string[] };

const list = (names: string[]): string => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * Is this enough to make the move? Every required field is filled with a value
 * its kind accepts; nothing is sent for a field the screen does not have, or
 * one this app cannot fill. Returns the values worth sending, blanks left out.
 */
export function checkMoveFields(screen: readonly JiraMoveField[], given: unknown): MoveFieldsCheck {
  const input: Record<string, unknown> = given && typeof given === "object" && !Array.isArray(given) ? (given as Record<string, unknown>) : {};
  const byKey = new Map(screen.map((f) => [f.key, f]));
  for (const k of Object.keys(input)) {
    const f = byKey.get(k);
    if (!f) return { ok: false, error: "That move does not ask for that field", bad: [k] };
    if (f.kind === "unsupported" && !isBlank(input[k])) return { ok: false, error: `${f.name} cannot be filled in here yet`, bad: [k] };
  }
  const stuck = screen.filter((f) => f.required && f.kind === "unsupported");
  if (stuck.length) return { ok: false, error: `That move needs ${list(stuck.map((f) => f.name))}, which cannot be filled in here yet`, bad: stuck.map((f) => f.key) };
  const missing = screen.filter((f) => f.required && isBlank(input[f.key]));
  if (missing.length) return { ok: false, error: `That move needs ${list(missing.map((f) => f.name))}`, bad: missing.map((f) => f.key) };
  const values: Record<string, JiraFieldValue> = {};
  for (const f of screen) {
    const v = input[f.key];
    if (isBlank(v)) continue;
    const why = valueProblem(f, v);
    if (why) return { ok: false, error: why, bad: [f.key] };
    values[f.key] = typeof v === "string" ? v.trim() : (v as string[]);
  }
  return { ok: true, values };
}

/** What a filled field does, as a sentence, for the confirmation: "Sets Resolution to Done", and once done, "Set Resolution to Done". */
export function effectOf(f: JiraMoveField, v: JiraFieldValue | undefined, past = false): string | null {
  if (v === undefined || isBlank(v)) return null;
  if (f.kind === "comment") return past ? "Added your comment" : "Adds your comment";
  const named = (id: string) => f.choices?.find((c) => c.id === id)?.name ?? id;
  const shown = Array.isArray(v) ? v.map(named).join(", ") : f.kind === "option" ? named(v) : v;
  return `${past ? "Set" : "Sets"} ${f.name} to ${shown}`;
}
