/*
 * The board's key hints along its bottom edge, as the mockup has them. Only keys that work are listed: each one is
 * handled in JiraListView (b, d, Shift+F, v, [, /, x in list mode, ?), JiraBoard (j, k, Enter) or the sidebar (g then 1-9).
 */
import { Kbd } from "../../projects/ui.tsx";
import { LINE } from "../../workspace/Chrome.tsx";

export const BOARD_KEYS: readonly { keys: readonly string[]; does: string }[] = [
  { keys: ["j", "k"], does: "move" },
  { keys: ["Enter"], does: "open" },
  { keys: ["b"], does: "board/list" },
  { keys: ["d"], does: "density" },
  { keys: ["a"], does: "by agent" },
  { keys: ["n"], does: "needs you" },
  { keys: ["/"], does: "search" },
  { keys: ["⇧", "F"], does: "filters" },
  { keys: ["v"], does: "new view" },
  { keys: ["["], does: "sidebar" },
  { keys: ["g", "1-9"], does: "saved view" },
  { keys: ["?"], does: "every key" },
];

export const LIST_KEYS: readonly { keys: readonly string[]; does: string }[] = [
  { keys: ["↑", "↓"], does: "move" },
  { keys: ["Enter"], does: "open" },
  { keys: ["x"], does: "select" },
  { keys: ["b"], does: "board/list" },
  { keys: ["d"], does: "density" },
  { keys: ["a"], does: "by agent" },
  { keys: ["n"], does: "needs you" },
  { keys: ["/"], does: "search" },
  { keys: ["⇧", "F"], does: "filters" },
  { keys: ["v"], does: "new view" },
  { keys: ["g", "1-9"], does: "saved view" },
  { keys: ["["], does: "sidebar" },
  { keys: ["?"], does: "every key" },
];

/** The legend `?` opens: every key this board answers to, board/list ones first, then the open card's own. */
export const CARD_KEYS: readonly { keys: readonly string[]; does: string }[] = [
  { keys: ["r"], does: "reader mode" },
  { keys: ["e"], does: "edit the description" },
  { keys: ["c"], does: "write a comment" },
  { keys: ["w"], does: "the Work tab" },
  { keys: ["o"], does: "open it in Jira" },
  { keys: ["t"], does: "its agent's tab" },
  { keys: ["y"], does: "copy the link" },
  { keys: ["⇧", "Y"], does: "copy it as a Markdown link" },
  { keys: ["Space"], does: "mark a sub-task done" },
  { keys: ["Alt", "↑", "↓"], does: "move a sub-task" },
  { keys: ["Esc"], does: "close" },
];

/* The bar in three groups, most used first, so a narrow board drops the tail of the last group and never "?": that one
   sits at the right edge as a button, and it is the way to every key the bar had no room for. */
const GROUP_OF: Record<string, 0 | 1 | 2> = { move: 0, open: 0, select: 0, "board/list": 1, density: 1, sidebar: 1, search: 2, filters: 2, "new view": 2, "saved view": 2 };

export function JiraKeyBar({ mode = "board", onLegend }: { mode?: "list" | "board"; onLegend?: () => void }) {
  const keys = (mode === "board" ? BOARD_KEYS : LIST_KEYS).filter((k) => k.does !== "every key");
  const groups = [0, 1, 2].map((g) => keys.filter((k) => (GROUP_OF[k.does] ?? 2) === g)).filter((g) => g.length);
  return (
    <div className="agx-jb-keys agx-jm-hints" role="note" aria-label={mode === "board" ? "Board keys" : "List keys"}>
      <div className="agx-jb-keys-g">
        {groups.map((g, i) => (
          <span key={i} className="agx-jb-keys-grp">
            {g.map((k) => (
              <span key={k.does} className="agx-jb-keys-i">
                {k.keys.map((x) => <Kbd key={x}>{x}</Kbd>)}
                <span>{k.does}</span>
              </span>
            ))}
          </span>
        ))}
      </div>
      <button type="button" className="agx-jb-keys-all" onClick={onLegend} disabled={!onLegend} aria-label="Every key">
        <Kbd>?</Kbd><span>every key</span>
      </button>
    </div>
  );
}

/** `?`'s own popover: the board/list keys this bar already shows, then what the open card answers to. Esc, or `?` again, closes it. */
export function KeyLegend({ mode, onClose }: { mode: "list" | "board"; onClose: () => void }) {
  const groups: readonly { title: string; keys: readonly { keys: readonly string[]; does: string }[] }[] = [
    { title: mode === "board" ? "Board" : "List", keys: mode === "board" ? BOARD_KEYS : LIST_KEYS },
    { title: "Open card", keys: CARD_KEYS },
  ];
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center" data-testid="jira-key-legend"
      style={{ background: "color-mix(in srgb, var(--bg) 62%, transparent)" }} onClick={onClose}>
      <div role="dialog" aria-label="Every key" onClick={(e) => e.stopPropagation()}
        className="flex flex-col rounded-xl overflow-hidden" style={{ width: 320, background: "var(--bg)", border: LINE, boxShadow: "var(--surface-lift)" }}>
        <div className="flex items-center justify-between" style={{ padding: "12px 16px", borderBottom: LINE }}>
          <span className="text-[13px] font-medium">Every key</span>
          <button type="button" aria-label="Close" onClick={onClose} className="agx-btn rounded-md px-2 py-1 text-[11px]" style={{ color: "var(--text2)" }}>Esc</button>
        </div>
        <div className="flex flex-col" style={{ padding: "12px 16px", gap: 12 }}>
          {groups.map((g) => (
            <div key={g.title} className="flex flex-col" style={{ gap: 6 }}>
              <div className="text-[11px] font-semibold" style={{ color: "var(--text3)" }}>{g.title}</div>
              {g.keys.map((k) => (
                <div key={k.does} className="flex items-center justify-between text-[12px]">
                  <span className="flex items-center" style={{ gap: 4 }}>{k.keys.map((x) => <Kbd key={x}>{x}</Kbd>)}</span>
                  <span style={{ color: "var(--text3)" }}>{k.does}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
