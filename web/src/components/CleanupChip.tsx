import { useSyncExternalStore } from "react";
import { housekeeping } from "../lib/housekeepingStore.ts";
import { cleanupChip } from "../lib/cleanupChip.ts";
import { tipAttr } from "../lib/tip.ts";
import { ICON } from "../lib/iconSize.ts";
import { SparkleIcon } from "../lib/glyphIcons.tsx";

/**
 * Automatic cleanup is working. Present only while a merged pull request is
 * being cleaned or waits behind it; idle, there is no element at all. Pressing
 * it opens the Lantern, where the Housekeeping entries live.
 */
export function CleanupChip({ noDrag, onOpen }: { noDrag: React.CSSProperties; onOpen: () => void }) {
  const entries = useSyncExternalStore(housekeeping.subscribe, housekeeping.list, housekeeping.list);
  const queued = useSyncExternalStore(housekeeping.subscribe, housekeeping.queued, housekeeping.queued);
  const chip = cleanupChip(entries, queued);
  if (!chip) return null;
  return (
    <button type="button" onClick={onOpen} data-cleanup-chip data-tip={tipAttr(chip.tip)}
      aria-label={`${chip.tip.name}. ${chip.tip.text}`}
      className="agx-topbar-clean flex items-center gap-1.5 shrink-0 rounded"
      style={{ height: 20, paddingInline: 6, ...noDrag }}>
      <span className="flex" style={{ color: "var(--primary-ink)" }}><SparkleIcon size={ICON.xs} /></span>
      <span className="text-[10px] whitespace-nowrap leading-none tabular-nums" style={{ color: "var(--text3)" }}>{chip.label}</span>
      {chip.more && <span className="text-[10px] whitespace-nowrap leading-none tabular-nums" style={{ color: "var(--text3)" }}>{chip.more}</span>}
      {chip.fraction !== null && <i style={{ width: `${Math.round(chip.fraction * 100)}%` }} />}
    </button>
  );
}
