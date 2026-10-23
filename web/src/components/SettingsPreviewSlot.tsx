import { SettingsCard } from "./SettingsKit.tsx";

/**
 * Where a page's live preview goes (slice 4 builds it). The card exists now so
 * the page already has the mockup's shape: settings on one side, the thing they
 * change on the other. `data-preview-slot` is what slice 4 looks for.
 */
export function PreviewSlot({ id, title, note }: { id: string; title: string; note?: string }) {
  return (
    <SettingsCard title={title}>
      <div data-preview-slot={id} className="px-[18px] py-3 text-[12px]" style={{ color: "var(--text3)" }}>{note ?? ""}</div>
    </SettingsCard>
  );
}
