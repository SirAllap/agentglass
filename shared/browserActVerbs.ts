/*
 * The verbs that change a page (plan F9), in one list. Guide mode's lock on
 * the server, the panel's second door, the person's log and the agent pill all
 * read this; a verb that acts and is missing here is a click on the person's
 * page while they are being guided. A verb nobody listed is still refused by
 * the server lock (it is not on the handoff's open list), so this list is the
 * named floor, not the whole rule.
 */
export const ACT_VERBS: readonly string[] = [
  "click", "dblclick", "rightclick", "hover", "focus", "blur", "type", "fill", "select", "check", "press",
  "scroll", "drag", "upload", "resize", "zoom", "open", "navigate", "back", "forward", "reload", "eval",
];
export const ACT_VERB_SET: ReadonlySet<string> = new Set(ACT_VERBS);
/** The acts a person wants written down and the pill counts: the list minus the
 *  verbs that only move the eye or the pane. Twenty scrolls must not push the
 *  real clicks out of the log. The lock still refuses these (ACT_VERBS). */
const EYE_VERBS: ReadonlySet<string> = new Set(["hover", "focus", "blur", "scroll", "resize", "zoom"]);
export const LOG_ACT_VERBS: readonly string[] = ACT_VERBS.filter((v) => !EYE_VERBS.has(v));
export const LOG_ACT_VERB_SET: ReadonlySet<string> = new Set(LOG_ACT_VERBS);
