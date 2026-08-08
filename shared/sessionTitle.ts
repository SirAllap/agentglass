/**
 * What to call a session on screen. One implementation, every surface.
 *
 * A uuid is a correct identifier and a useless label: five agents on one repo
 * render as five near-identical hex strings, and picking the right one means
 * comparing characters. Claude Code already knows the answer — it writes an
 * `ai-title` for every session and a `custom-title` when you rename one — so
 * the fix is to use it.
 *
 * Precedence is the point: a rename is an explicit statement about what this
 * session is, so it beats the generated one even when the generated one is
 * newer. Falls back to `app:12345678` when there's no title at all, which is
 * every hook-only session (titles live in the transcript).
 *
 * This lived in `web/src/lib/format.ts` until the browser companion was
 * deleted. `nowQueue` was the one thing the native app imported that reached
 * into a web module, and it reached for exactly this — so the choice was
 * between copying the rule into the phone or lifting it to where both sides can
 * take it. Copying is what produced four disagreeing versions of the *project*
 * naming rule (see projectKey.ts); a session titled one way in the cockpit and
 * another way in the phone's queue is the same bug with a smaller blast radius.
 *
 * Kept free of imports, like its sibling, so a test of it does not pull an
 * application graph in behind it and React Native's bundler never sees a DOM.
 * `format.ts` re-exports both names, the way it already re-exports
 * `modelLabelOf` from shared/models.ts, so no cockpit call site changed.
 */

/** The fields a title can be built from. Structural on purpose: the cockpit
 *  passes a `SessionDetail`, the queue passes a `SessionRollup`, and neither
 *  needs to know the other exists. */
export interface Titled {
  source_app?: string;
  session_id: string;
  custom_title?: string | null;
  ai_title?: string | null;
  first_prompt?: string | null;
}

export const sessionTitle = (s: Titled, max = 60): string => {
  const t = (s.custom_title || s.ai_title || "").trim();
  if (t) return clipTitle(t, max);
  // What you first asked for, when nobody ever named it. A uuid identifies a
  // session and describes nothing, and on a real machine most rows have no
  // title at all — a list of thirty reading `agentglass:cd3fa401` cannot be
  // scanned by eye, which is the same as not having a list.
  const p = promptTitle(s.first_prompt);
  if (p) return clipTitle(p, max);
  return s.source_app ? `${s.source_app}:${s.session_id.slice(0, 8)}` : s.session_id.slice(0, 8);
};

/**
 * A prompt, reduced to something that reads as a name.
 *
 * The first line is almost always the ask; what follows is context, pasted
 * output or a checklist, and none of it belongs in a row 300px wide. Fenced
 * blocks and quoted material are skipped for the same reason — a prompt that
 * opens with a stack trace would otherwise be titled with one.
 */
export function promptTitle(prompt: string | null | undefined): string {
  if (!prompt) return "";
  let inFence = false;
  for (const raw of prompt.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence || !line) continue;
    // Slash commands, quotes and markup are not what the session is about.
    if (line.startsWith(">") || line.startsWith("#") || line.startsWith("<")) continue;
    return line.replace(/\s+/g, " ");
  }
  return "";
}

const clipTitle = (t: string, max: number): string =>
  t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
