import type { PtyClientFrame } from "../../../shared/types.ts";

/**
 * A tmux command, minus the discriminant the door supplies.
 *
 * Distributed over the union by hand, through the defaulted parameter:
 * `Omit<A | B, "t">` collapses to the keys A and B have in COMMON, which would
 * leave `{cmd:"issue"}` sendable with no `cwd` and put us back where
 * `(cmd: string, extra: Record<string, unknown>)` was.
 */
export type TmuxCmdBody<F = Extract<PtyClientFrame, { t: "tmux" }>> = F extends unknown ? Omit<F, "t"> : never;
