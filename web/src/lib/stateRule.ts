/*
 * The hide rule of the five state patterns (docs/design-system.md, "States"): what an empty field does.
 * One pure function, so no screen decides on its own whether to print "None".
 */

export type FieldFacts = {
  /** The field's value; empty, blank or null counts as no value. */
  value: string | null | undefined;
  /** The person can fill it from this screen. */
  canFill: boolean;
  /** Its emptiness is a verdict ("No reviewers" on a PR that needs one): it stays, as a warning. */
  verdict?: boolean;
};

export type FieldShow = "show" | "hide" | "action";

/** A value shows. No value: a verdict stays, a field the person can fill shows its prompt, the rest hides. Never "None". */
export function fieldRule(f: FieldFacts): FieldShow {
  if (f.value != null && f.value.trim() !== "") return "show";
  if (f.verdict) return "show";
  return f.canFill ? "action" : "hide";
}

/** The one line that stands for 3+ empty sections; fewer than 3 are not merged and give "". */
export function emptyLine(names: readonly string[]): string {
  return names.length >= 3 ? `Empty: ${names.join(", ")}` : "";
}

/** Which empty block the one fold line was asked to open; `n` changes on every ask so asking twice opens twice. */
export type AddAsk = { k: "description" | "subtask" | "link" | "web" | "file" | "estimate" | "parent" | "labels"; n: number } | null;
