// The decisions behind the Git dialogs and pickers, pulled out of the screens
// so they can be tested: there is no renderer in this project.

/** The colour a dialog's icon tile and primary action take. */
export type GitTone = "primary" | "danger" | "warn" | "merge" | "neutral";

export interface ConfirmVariantInput {
  danger?: boolean;
  /** Set by a caller whose easy answer is the wrong one. */
  cancelFocus?: boolean;
  /** The name an agent gave itself when it opened the dialog. */
  preparedBy?: string;
  /** A prompt: there is a field to type in. */
  hasInput?: boolean;
  /** The server does not keep the thing: no reflog, no trash. */
  irreversible?: boolean;
  command?: string;
}

export interface ConfirmVariant {
  tone: GitTone;
  /** Which control takes the focus when the dialog opens. */
  focus: "cancel" | "confirm" | "input";
  /** Whether Enter anywhere in the dialog confirms. */
  enterConfirms: boolean;
  /** The command is drawn in a preview block. */
  showCommand: boolean;
  /** "This cannot be undone." is drawn. */
  cannotUndo: boolean;
}

/** How a question is drawn and answered. One rule for every Git dialog: a
 *  destructive question starts on Cancel and Enter does not say yes to it. */
export function confirmVariant(i: ConfirmVariantInput): ConfirmVariant {
  const careful = !!i.danger || !!i.cancelFocus || !!i.preparedBy;
  return {
    tone: i.danger ? "danger" : "primary",
    focus: careful ? "cancel" : i.hasInput ? "input" : "confirm",
    enterConfirms: !careful,
    showCommand: !!i.command,
    cannotUndo: !!i.danger && !!i.irreversible,
  };
}

/** What Enter does: confirm, or nothing. Enter on Cancel never confirms, and a
 *  disabled primary action cannot be reached by it either. */
export function enterAction(o: { enterConfirms: boolean; focusOnCancel: boolean; confirmDisabled: boolean; inTextarea?: boolean }): "confirm" | "none" {
  if (o.focusOnCancel || o.confirmDisabled || o.inTextarea) return "none";
  return o.enterConfirms ? "confirm" : "none";
}

export interface TagPlan {
  ok: boolean;
  /** Why Create is off, in the footer's words. Empty when it is on. */
  reason: string;
  opts: { annotated: boolean; signed: boolean; message: string };
}

/**
 * What the New tag dialog may send. An annotated or signed tag needs a message
 * (git refuses without one). Otherwise the message is optional: empty or only
 * whitespace means a lightweight tag, and anything else is annotated, as it
 * always was.
 */
export function tagPlan(name: string, annotated: boolean, signed: boolean, message: string): TagPlan {
  const msg = message.trim();
  const needsMessage = annotated || signed;
  const withMessage = needsMessage || msg.length > 0;
  const base = { annotated: withMessage && !signed, signed, message: withMessage ? msg : "" };
  if (!name.trim()) return { ok: false, reason: "name the tag first", opts: base };
  if (needsMessage && !msg) return { ok: false, reason: "an annotated tag needs a message", opts: base };
  return { ok: true, reason: "", opts: base };
}

export type PickerBody = "loading" | "error" | "empty" | "no-match" | "rows";

/** Which body a picker draws. An error beats loading (a failed load is not
 *  still loading); a typed query with nothing left is a different sentence
 *  from a list that was empty to begin with. */
export function pickerBody(o: { loading: boolean; error?: string | null; total: number; shown: number; query: string }): PickerBody {
  if (o.error) return "error";
  if (o.loading && o.total === 0) return "loading";
  if (o.total === 0) return "empty";
  if (o.shown === 0) return o.query.trim() ? "no-match" : "empty";
  return "rows";
}

/** What a dialog says when the request itself failed (not when git said no). */
export const UNREACHABLE = "Could not reach the server.";

/**
 * Which dialog a key belongs to. Every GitDialog listens on window in the
 * capture phase, so two stacked dialogs, or a menu over a dialog, would all
 * answer one keypress. Only the top dialog answers; Escape goes to a menu or
 * another dialog when that is where it was pressed; Enter only counts with the
 * focus inside this dialog's own box.
 */
export function dialogKeyScope(o: { key: string; inOwn: boolean; inMenu: boolean; inOtherDialog: boolean; isTop: boolean }): "handle" | "ignore" {
  if (!o.isTop) return "ignore";
  if (o.key === "Escape") return o.inMenu || o.inOtherDialog ? "ignore" : "handle";
  return o.inOwn ? "handle" : "ignore";
}
