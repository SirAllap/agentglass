/**
 * What an agent started from the phone is allowed to do without asking.
 *
 * Both places the companion starts or resumes a turn hardcoded
 * `mode: "default"` and sent no allowed tools, while the desktop passes the
 * user's own choice (web/src/lib/chatStore.ts). Under `claude -p`, default mode
 * means any tool that would raise a permission dialog is simply refused — the
 * server says so itself in server/src/chat.ts.
 *
 * So an agent you resumed from your phone could answer you and could not edit a
 * file. The single most useful thing to do from away from the desk was the one
 * thing that could not work, and nothing said so: the refusal arrived as the
 * agent reporting that it was not permitted, which reads like the agent's
 * decision rather than the app's.
 *
 * Named for what they let it do rather than for the flag. "acceptEdits" is a
 * setting; "edit files without asking" is a consequence, and the consequence is
 * what somebody choosing on a phone is actually choosing between.
 *
 * Its own module, with no imports, so a test of it does not pull the whole
 * application graph in behind it.
 */

export type PermissionModeId = "default" | "acceptEdits" | "bypassPermissions";

export interface PermissionModeOption {
  id: PermissionModeId;
  /** The verb, in the second person. */
  label: string;
  /** What it actually permits, and what it still holds. */
  detail: string;
  /** Whether the operator has to have opted in on the machine. */
  guarded?: boolean;
}

export const PERMISSION_MODES: PermissionModeOption[] = [
  {
    id: "default",
    label: "Ask me every time",
    detail: "Every write, command and network call is held until you answer it here. Safest, and the slowest to leave alone.",
  },
  {
    id: "acceptEdits",
    label: "Edit files freely",
    detail: "It writes and edits inside the project without asking. Commands and anything leaving the machine are still held.",
  },
  {
    id: "bypassPermissions",
    label: "Do not ask at all",
    detail: "Nothing is held: it runs commands and changes files unattended. Off unless the machine's operator has turned it on.",
    guarded: true,
  },
];

/**
 * What a chat opens on.
 *
 * Not `default`. A phone is where you are when you cannot type a permission
 * answer for every edit, and an agent that must ask before each one is an agent
 * that will sit blocked until you get back — which is the failure the gate
 * queue exists to make visible, arrived at on purpose. Commands and egress are
 * still held, so the dangerous half is unchanged.
 */
export const DEFAULT_PERMISSION_MODE: PermissionModeId = "acceptEdits";

const IDS = new Set<string>(PERMISSION_MODES.map((m) => m.id));

/** A mode we recognise, or the default. Never trust a stored string. */
export function asPermissionMode(v: unknown): PermissionModeId {
  return typeof v === "string" && IDS.has(v) ? (v as PermissionModeId) : DEFAULT_PERMISSION_MODE;
}

export function permissionModeLabel(id: PermissionModeId): string {
  return PERMISSION_MODES.find((m) => m.id === id)?.label ?? id;
}
