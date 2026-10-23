/*
 * The watch and vote controls of a Jira card, in the action bar: the account's own mark and the count beside it.
 *
 * Decided in lib/jiraFollow.ts. Each is a house `Chip`, pressed when the mark is on, with a fixed label and its icon, so the
 * control keeps its place and its width through every state: not on, on, in flight (the icon turns), refused for this
 * account (dimmed, and the tooltip says why), and with writing to Jira off (a count only, nothing to press).
 */
import { Chip } from "../workspace/Chrome.tsx";
import { EyeIcon, ThumbUpIcon } from "../../lib/glyphIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { canPress, followControl, type FollowControl } from "../../lib/jiraFollow.ts";
import type { JiraFollowUi } from "./useJiraFollow.ts";

function Mark({ c }: { c: FollowControl }) {
  // The same box in every state: the turning ring takes the icon's place and size.
  if (c.busy) return <span className="inline-flex items-center justify-center shrink-0" style={{ width: ICON.xs, height: ICON.xs }}><span className="agx-spin" aria-hidden style={{ width: 9, height: 9, borderWidth: 1.5, borderColor: "currentColor", borderTopColor: "transparent" }} /></span>;
  return c.kind === "watch" ? <EyeIcon size={ICON.xs} /> : <ThumbUpIcon size={ICON.xs} />;
}

function One({ c, onPress }: { c: FollowControl; onPress: () => void }) {
  const body = (
    <>
      <Mark c={c} />
      <span>{c.label}</span>
      {c.count && <span className="tabular-nums" style={{ color: c.on ? "var(--primary-ink)" : "var(--text3)" }}>{c.count}</span>}
    </>
  );
  if (c.mode === "readonly") {
    return (
      <span className="agx-chip text-[11px] px-2.5 min-h-[28px] inline-flex items-center gap-1.5 rounded-lg whitespace-nowrap" title={c.title}
        style={{ color: c.on ? "var(--primary-ink)" : "var(--text3)" }}>{body}</span>
    );
  }
  return (
    <Chip on={c.on} resting pressed={c.on} disabled={!canPress(c)} title={c.title} ariaLabel={c.title} onClick={onPress}
      style={c.mode === "denied" ? { opacity: 0.5 } : c.on ? { color: "var(--primary-ink)" } : undefined}>
      {body}
    </Chip>
  );
}

/** Both controls, or nothing before the card is read; a site with voting off draws only the watch. */
export function JiraFollow({ ui, writes, cardKey }: { ui: JiraFollowUi; writes: boolean; cardKey: string }) {
  const at = (kind: "watch" | "vote") => followControl(kind, ui.follow, { writes, out: ui.busy, denied: ui.denied[kind] ?? null, key: cardKey });
  const watch = at("watch"), vote = at("vote");
  if (!watch && !vote) return null;
  return (
    <>
      {watch && <One c={watch} onPress={() => ui.press("watch", !watch.on)} />}
      {vote && <One c={vote} onPress={() => ui.press("vote", !vote.on)} />}
    </>
  );
}
