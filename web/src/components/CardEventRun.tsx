/*
 * A run of things that happened to a card, drawn as the margin of its
 * conversation. One component for every tracker: ClickUp's creations and
 * moves, the notifications seen here, and Jira's history and work log rows.
 */
import { avatarSrc } from "../lib/avatarSrc.ts";
import { chipInk } from "../lib/contrast.ts";
import { eventLine, foldLabel, folds, spanLabel, seenActor, NO_AUTHOR_NOTE } from "../lib/cardActivity.ts";
import type { CardEvent, ProviderTask } from "../../../shared/providers.ts";
import { EDGE } from "./workspace/Chrome.tsx";

/**
 * A run of things that happened to the card, with nothing said in between.
 *
 * Folded past three, which is ClickUp's own behaviour and not decoration: a bug
 * card opens with a dozen automation rows in front of the first sentence a person
 * wrote, and unfolded they push the conversation off the screen — "that way the
 * scroll doesn't get huge and you go to what matters, which is the comments". Under
 * three there is nothing to hide and a press to read one line is a press wasted.
 *
 * Dim, small, and not in a card of its own: these are the margin of the
 * conversation. A status change drawn with the weight of a comment is a timeline
 * where you cannot find what somebody said. Each line is an `agx-tiny` sitting
 * on the timeline's rail, its face or bullet in the rail's node — see TL_CSS.
 */
export function EventRun({ events, open, onToggle, faceFor, flat }: {
  events: CardEvent[]; open: boolean; onToggle: () => void;
  /** Never folded: a tab that is nothing but these (a card's History) has no conversation to protect from them. */
  flat?: boolean;
  /** A face for the person a line names, when the board knows one. The API
   *  never says who did anything; these sentences do, and a name deserves the
   *  same face the creation row gets. */
  faceFor?: (name: string) => NonNullable<ProviderTask["people"]>[number] | null;
}) {
  const foldable = !flat && folds({ kind: "events", at: events[0]?.at ?? 0, events, id: "" });
  const rows = foldable && !open ? [] : events;
  return (
    <div className="agx-ev">
      {rows.map((e, i) => (
        <div key={`${e.at}-${i}`} className="agx-tiny"
          /* Why the moves have no name on them, on the row itself rather than
             in a footnote nobody reads. */
          title={e.kind === "status" ? NO_AUTHOR_NOTE : undefined}>
          {/* The face, where ClickUp gives one — the creation does, a move does
              not. Same round 14px as everywhere else, and the bullet keeps the
              rows that have no face aligned with the ones that do. */}
          <span className="agx-node">{(() => {
            const seenWho = e.kind === "seen" ? seenActor(e.text ?? "").who : "";
            const person = seenWho ? faceFor?.(seenWho) : null;
            if (e.avatar) {
              return (
                <img src={avatarSrc(e.avatar)} alt="" loading="lazy" referrerPolicy="no-referrer" title={e.who}
                  onError={(ev) => { ev.currentTarget.style.display = "none"; }}
                  className="shrink-0 self-center rounded-full"
                  style={{ width: 14, height: 14, objectFit: "cover" }} />
              );
            }
            /* The face for a name the sentence carries. Initials in the
               workspace's own colour when there is no picture — the same
               fallback every other face in this panel uses. */
            if (person) {
              return person.avatar
                ? <img src={avatarSrc(person.avatar)} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = "none"; }} title={person.name}
                    className="shrink-0 self-center rounded-full"
                    style={{ width: 14, height: 14, objectFit: "cover" }} />
                : <span className="shrink-0 self-center rounded-full inline-flex items-center justify-center"
                    title={person.name}
                    style={{ width: 14, height: 14, fontSize: 8, background: person.color || "var(--bg4)", color: chipInk(person.color) }}>
                    {person.initials}
                  </span>;
            }
            return <span aria-hidden className="shrink-0 text-center" style={{ width: 14, color: "var(--text4)" }}>·</span>;
          })()}</span>
          <span className="min-w-0 flex-1">
            {e.kind === "change" || e.kind === "worklog"
              ? (<><b>{e.who || "Somebody"}</b> {e.text}</>)
              : e.kind === "seen" && seenActor(e.text ?? "").who
              ? (() => {
                  const { who, rest } = seenActor(e.text ?? "");
                  return (<><span style={{ color: "var(--text2)", fontWeight: 600 }}>{who}</span> {rest}</>);
                })()
              : eventLine(e)}
            {/* The status in its own colour, the way every other pill in this app
                shows one — the words alone made a move to "Ready for QA" and a move
                to "Won't fix" read the same. */}
            {e.status && (
              <span className="ml-1.5 px-1 rounded"
                style={{ color: e.color || "var(--text2)", border: `1px solid color-mix(in srgb, ${e.color || "var(--text)"} 40%, transparent)` }}>
                {e.status}
              </span>
            )}
            {/* How long it sat where it was. The public API's one addition over
                the payload, and it is what makes a move readable: "moved to qa
                complete" after two hours is a different story from the same
                move after four days. */}
            {/* Where it came from, said once and quietly: this line was read
                off a notification on this machine, not from the API. */}
            {e.kind === "seen" && (
              <span className="ml-1.5 px-1 rounded text-[9.5px]"
                style={{ color: "var(--text4)", border: EDGE }}>seen here</span>
            )}
            {e.kind === "status" && e.from && e.mins ? (
              <span className="ml-1.5" style={{ color: "var(--text4)" }}>
                after {spanLabel(e.mins)}
              </span>
            ) : null}
          </span>
          <span className="shrink-0 tabular-nums" style={{ color: "var(--text4)" }}
            title={new Date(e.at).toLocaleString()}>
            {new Date(e.at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
      ))}
      {foldable && (
        <button onClick={onToggle}
          className="agx-btn agx-tiny w-full text-left"
          style={{ color: "var(--text4)" }}>
          <span aria-hidden className="agx-node"><span style={{ display: "inline-block", transform: open ? "none" : "rotate(-90deg)" }}>▾</span></span>
          {open ? "Hide" : `Show ${foldLabel(events.length)}`}
        </button>
      )}
    </div>
  );
}
