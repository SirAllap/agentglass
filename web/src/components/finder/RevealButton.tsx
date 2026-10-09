// "Show this in the file manager", for a file or a folder.
//
// The server judges the path with the same gate every other read here goes
// through, so this only ever asks for something the palette could already list.
import { useState } from "react";
import { api } from "../../lib/api.ts";
import { HIT, ICON } from "../../lib/iconSize.ts";
import { FolderIcon } from "../../lib/glyphIcons.tsx";
import { EDGE } from "../workspace/Chrome.tsx";

export function RevealButton({ path, what, label = "Open in Files", block }: { path: string; what: "file" | "folder"; label?: string; block?: boolean }) {
  /* `block` is the rail's stacked action, and matches the height of the others there. */
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <button
        onClick={() => { setErr(null); void api.previewReveal(path).then((r) => { if (!r.ok) setErr(r.error ?? "could not open"); }).catch(() => setErr("could not open")); }}
        className={`${block ? "flex w-full" : "inline-flex"} items-center gap-1.5 px-2 rounded-md text-[11px] shrink-0`}
        style={{ minHeight: block ? HIT + 6 : HIT, color: "var(--text2)", border: EDGE }}
        title={what === "folder" ? "Show this folder in the system file manager" : "Show this file's folder in the system file manager"}>
        <FolderIcon size={ICON.sm} />{label}
      </button>
      {err && <span className="text-[10.5px]" style={{ color: "var(--warning-ink)" }}>{err}</span>}
    </>
  );
}
