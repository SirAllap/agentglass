// A group of values applied together is an action, not a row save: one
// primary button named for what it does, Cancel beside it (reverts the local
// edits). Instant rows have no Cancel; Undo replaces it.
import { EDGE } from "../../workspace/Chrome.tsx";
import { HIT } from "../../../lib/iconSize.ts";
export function GroupActions({ primary, onPrimary, onCancel, dirty, busy }: {
  primary: string;
  onPrimary: () => void;
  onCancel: () => void;
  dirty: boolean;
  busy?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={!dirty || busy}
        onClick={onPrimary}
        className="text-[12px] font-medium px-3 rounded-md"
        style={{ height: HIT, color: "var(--on-primary)", background: "var(--primary)", opacity: !dirty || busy ? 0.5 : 1 }}
      >
        {primary}
      </button>
      <button
        type="button"
        disabled={!dirty || busy}
        onClick={onCancel}
        className="text-[12px] px-3 rounded-md"
        style={{ height: HIT, color: "var(--text2, var(--text))", border: EDGE, opacity: !dirty || busy ? 0.5 : 1 }}
      >
        Cancel
      </button>
    </div>
  );
}
