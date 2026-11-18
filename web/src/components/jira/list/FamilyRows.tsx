/*
 * A parent card's progress, shown once: a row of dots (one per sub-task, coloured by its status) and "N of M done". The row
 * opens in place to the sub-tasks (key, title, status in capitals); a row opens that card, and hovering it lights that
 * card on the board (the board reads data-jb-kid). Pure view: the board owns the highlight.
 */
import { useEffect, useId, useRef, useState } from "react";
import { kidLayout } from "./familyLayout.ts";
import type { ProviderTask } from "../../../../../shared/providers.ts";
import { CaretIcon } from "../../../lib/glyphIcons.tsx";
import { ICON } from "../../../lib/iconSize.ts";
import { tipAttr } from "../../../lib/tip.ts";

type Kid = NonNullable<ProviderTask["children"]>[number];

export const kidsWord = (kids: readonly Kid[]): string => `${kids.filter((k) => k.kind === "done").length} of ${kids.length} done`;

export function FamilyRows({ kids, titles, onOpenKey }: { kids: readonly Kid[]; titles: ReadonlyMap<string, string>; onOpenKey?: ((key: string) => void) | undefined }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const listRef = useRef<HTMLUListElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = listRef.current;
    if (!open || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [open]);
  const { statusText } = kidLayout(width);
  const by = (k: Kid["kind"]) => kids.filter((c) => c.kind === k).length;
  const label = `Sub-tasks: ${by("done")} done, ${by("progress")} in progress, ${by("blocked")} blocked, ${by("todo")} to do`;
  return (
    <div className="agx-jb-fam" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="agx-jb-famsum" aria-expanded={open} aria-controls={id}
        onPointerDown={(e) => e.stopPropagation()} onClick={() => setOpen((v) => !v)}>
        <span className="dots" role="img" aria-label={label}>{kids.map((k) => <i key={k.key} data-k={k.kind} />)}</span>
        <span>{kidsWord(kids)}</span>
        <CaretIcon size={ICON.xs} />
      </button>
      {open && (
        <ul id={id} ref={listRef} className="agx-jb-famlist">
          {kids.map((k) => {
            const title = k.title || titles.get(k.key) || "";
            return (
              <li key={k.key}>
                <button type="button" className="agx-jb-kid" data-jb-kid={k.key} aria-label={`Open ${k.key}${title ? `, ${title}` : ""}, ${k.status}`}
                  data-tip={tipAttr({ name: k.key, mono: true, text: title ? `${title} · ${k.status}` : k.status })}
                  onPointerDown={(e) => e.stopPropagation()} onClick={() => onOpenKey?.(k.key)}>
                  <span className="key">{k.key}</span>
                  <span className="t">{title}</span>
                  <span className="st" data-k={k.kind}><i />{statusText && <span className="stt">{k.status}</span>}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
