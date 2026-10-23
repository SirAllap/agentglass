// Customize…: the colour and icon a person gives one file or folder, Strata's box
// (its shot 48): a preview, the colour row, sixteen icons, an emoji, Clear and Done.
// Each choice is applied as it is made, so Done only closes. The look is the finder's
// own (lib/finderStyles); the file is never touched.
import { useRef, useState } from "react";
import { HIT, ICON } from "../../../lib/iconSize.ts";
import { STYLE_COLORS, STYLE_ICONS, pick, type ItemStyle } from "../../../lib/finderStyles.ts";
import { itemStyleOf, setItemStyle } from "../../../lib/finderStyleStore.ts";
import { EDGE, LINE } from "../../workspace/Chrome.tsx";
import { EmojiPicker } from "../../tasks/EmojiPicker.tsx";
import { DialogHead, Sheet } from "./FinderOpsUI.tsx";
import { StrataIcon, StyledIcon } from "./StrataIcon.tsx";

export function CustomizeDialog({ paths, names, isDir, onClose }: { paths: readonly string[]; names: readonly string[]; isDir: boolean; onClose: () => void }) {
  const [style, setStyle] = useState<ItemStyle>(() => (paths.length === 1 ? itemStyleOf(paths[0]!) : undefined) ?? {});
  const [emojiAt, setEmojiAt] = useState<HTMLElement | null>(null);
  const hex = useRef<HTMLInputElement>(null);
  const apply = (next: ItemStyle) => { setStyle(next); setItemStyle(paths, next); };
  const kind = paths.length > 1 ? "Items" : isDir ? "Folder" : "File";
  const one = names.length === 1 ? names[0]! : `${names.length} items`;
  const none = !style.color && !style.icon && !style.emoji;
  const swatch = (on: boolean) => ({ width: 26, height: 26, border: EDGE, boxShadow: on ? "0 0 0 2px var(--primary)" : undefined });
  return (
    <Sheet label={`Customize ${kind}`} onClose={onClose} width={480}>
      <DialogHead icon={<StrataIcon set="act" name="palette" size={ICON.md} />} title={`Customize ${kind}`} sub={one} onClose={onClose} />
      <div className="grid place-items-center gap-1.5 py-4">
        <StyledIcon style={style} name={names[0] ?? ""} isDir={isDir} size={44} />
        <span className="max-w-full truncate text-[12px] font-mono">{one}</span>
      </div>
      <div className="text-[10px] uppercase tracking-[0.1em] mb-1.5" style={{ color: "var(--text3)" }}>Color</div>
      <div className="flex flex-wrap items-center gap-2 pb-3" style={{ borderBottom: LINE }}>
        <button aria-label="No color" aria-pressed={!style.color} className="agx-btn rounded-full grid place-items-center" style={{ ...swatch(!style.color), color: "var(--primary-ink)" }} onClick={() => apply(pick(style, { clearColor: true }))}><StrataIcon set="act" name="palette" size={ICON.sm} /></button>
        {STYLE_COLORS.map((c) => (
          <button key={c.id} aria-label={c.id} aria-pressed={style.color === c.hex} className="agx-btn rounded-full" style={{ ...swatch(style.color === c.hex), background: c.hex }} onClick={() => apply(pick(style, { color: c.hex }))} />
        ))}
        <button aria-label="Another color" className="agx-btn rounded-full grid place-items-center" style={{ ...swatch(false), color: "var(--text3)" }} onClick={() => hex.current?.click()}><StrataIcon set="act" name="plus" size={ICON.sm} /></button>
        <input ref={hex} type="color" aria-label="Pick a color" className="sr-only" value={style.color ?? STYLE_COLORS.find((c) => c.id === "blue")!.hex} onChange={(e) => apply(pick(style, { color: e.target.value }))} />
      </div>
      <div className="text-[10px] uppercase tracking-[0.1em] mt-3 mb-1.5" style={{ color: "var(--text3)" }}>Icon</div>
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(8, minmax(0, 1fr))" }}>
        {STYLE_ICONS.map((n) => (
          <button key={n} aria-label={n} aria-pressed={style.icon === n} className="agx-btn rounded-lg grid place-items-center" style={{ minHeight: HIT + 6, border: EDGE, boxShadow: style.icon === n ? "0 0 0 2px var(--primary)" : undefined, color: "var(--text3)" }}
            onClick={() => apply(pick(style, { icon: n }))}><StrataIcon set="act" name={n} size={ICON.md} /></button>
        ))}
      </div>
      <button className="agx-btn rounded-lg w-full mt-2" aria-haspopup="dialog" aria-expanded={!!emojiAt} style={{ minHeight: HIT, border: EDGE, background: "color-mix(in srgb, var(--primary) 14%, transparent)" }} onClick={(e) => setEmojiAt(emojiAt ? null : e.currentTarget)}>Choose Emoji…</button>
      {emojiAt && <EmojiPicker anchor={emojiAt} recent={[]} below onClose={() => setEmojiAt(null)} onPick={(ch, keep) => { apply(pick(style, { emoji: ch })); if (!keep) setEmojiAt(null); }} />}
      <div className="flex justify-end gap-2 mt-4 pt-3" style={{ borderTop: LINE }}>
        <button className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE }} disabled={none} onClick={() => apply({})}>Clear</button>
        <button autoFocus className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE, borderColor: "var(--primary)", color: "var(--primary-ink)" }} onClick={onClose}>Done</button>
      </div>
    </Sheet>
  );
}
