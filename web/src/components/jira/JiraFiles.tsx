/*
 * A Jira card's files: thumbnails and a viewer (CardFiles, the one every tracker
 * uses), a file dragged in or picked with the "+", one of your own taken off.
 *
 * The bytes are the server's to fetch and serve (server/src/jiraFiles.ts): the
 * pane holds only the routes it named, so no address of the site's and no
 * credential is ever in the page. A picture and a video are shown in place; any
 * other file downloads when pressed, and the viewer has no "Open ↗" because its
 * address carries this app's sign-in.
 *
 * Rules this keeps, the same as the other sections:
 *   - The "+" is the last thing in the header in every state; what a change says
 *     ("build.log added") takes the place of the count's neighbour, so nothing moves.
 *   - A drag over the section draws an outline and a line over the body and never
 *     changes its size. Only files are a drop (text and addresses are ignored).
 *   - A removal asks in place, saying what goes and that it is not put back (a
 *     file the site deletes is gone), and is offered on your own files only.
 *   - Every state is drawn: nothing yet, adding, refused (the sentence stays), drag.
 *
 * Ceiling: files go up one at a time, in the order dropped; a file over 25 MB is
 * refused here with the sentence, not sent.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CardAttachment } from "../../../../shared/providers.ts";
import { addedSaid, checkUpload, dragHasFiles, droppedFiles, withAddresses } from "../../lib/jiraFiles.ts";
import { CardFiles } from "../CardFiles.tsx";
import { Aside, Ask, type Said } from "./JiraJoins.tsx";
import { JiraSection } from "./JiraSections.tsx";

/** What the pane gives the files to change the card with; each says why it did not land, or null. */
export interface FileAct {
  add: (f: File) => Promise<string | null>;
  remove: (a: CardAttachment) => Promise<string | null>;
}

/** Press-to-download of a file the viewer cannot show: the app's own route, asked as a download. */
function download(a: CardAttachment): void {
  const el = document.createElement("a");
  el.href = `${a.url}${a.url.includes("?") ? "&" : "?"}download=1`;
  el.download = a.title;
  el.rel = "noreferrer";
  el.click();
}

export function AttachmentsBlock({ files, card, writable, act }: { files: CardAttachment[]; card: string; writable: boolean; act: FileAct }) {
  const [said, setSaid] = useState<Said | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const pick = useRef<HTMLInputElement | null>(null);
  const depth = useRef(0);
  useEffect(() => { setSaid(null); setErr(""); setAsking(null); setAdding(null); setOver(false); depth.current = 0; }, [card]);
  const shown = useMemo(() => withAddresses(files), [files]);
  if (!files.length && !writable) return null;

  const addAll = async (list: File[]) => {
    if (!list.length || adding) return;
    setErr(""); setSaid(null);
    const done: string[] = [];
    let failed = 0;
    for (const f of list) {
      const why = checkUpload(f) ?? (setAdding(f.name), await act.add(f));
      if (why) { failed++; setErr((e) => e || why); } else done.push(f.name);
    }
    setAdding(null);
    setSaid(addedSaid(done, failed));
  };
  const remove = async (a: CardAttachment) => {
    setBusy(true);
    const why = await act.remove(a);
    setBusy(false); setAsking(null);
    setSaid(why ? { text: why, warn: true } : { text: `${a.title} taken off` });
  };
  const target = asking ? shown.find((a) => a.id === asking) : undefined;

  return (
    <div className="relative min-w-0"
      onDragEnter={(e) => { if (!writable || !dragHasFiles(e.dataTransfer)) return; e.preventDefault(); depth.current++; setOver(true); }}
      onDragOver={(e) => { if (writable && dragHasFiles(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
      onDragLeave={() => { if (writable && --depth.current <= 0) { depth.current = 0; setOver(false); } }}
      onDrop={(e) => { if (!writable || !dragHasFiles(e.dataTransfer)) return; e.preventDefault(); depth.current = 0; setOver(false); void addAll(droppedFiles(e.dataTransfer)); }}
      style={{ outline: over ? "1.5px dashed var(--primary)" : "1.5px dashed transparent", outlineOffset: 4, borderRadius: 6 }}>
      <JiraSection id="attachments" title="Attachments" count={files.length || undefined}
        aside={<Aside plain={adding ? <span role="status" className="truncate min-w-0" title={adding}>Adding {adding}…</span> : null} said={said} onSaid={setSaid}
          open={false} onToggle={() => { if (!adding) pick.current?.click(); }} label="Add a file" canAdd={writable} />}>
        {writable && <input ref={pick} type="file" multiple hidden aria-label="Choose files to add" onChange={(e) => { const l = Array.from(e.target.files ?? []); e.target.value = ""; void addAll(l); }} />}
        {err && <div className="text-[10.5px] mb-1" role="alert" style={{ color: "var(--error-ink)" }}>{err}</div>}
        {!files.length
          ? <div className="text-[11px]" style={{ color: "var(--text4)" }}>No files. Drag one here, or press +.</div>
          : <CardFiles files={shown} openLink={false} showWhen openOther={download} onRemove={writable ? (a) => setAsking(a.id) : undefined} />}
        {target && (
          <div ref={(el) => el?.scrollIntoView({ block: "nearest" })}>
          <Ask yes="Take off" busy={busy} onYes={() => void remove(target)} onNo={() => setAsking(null)}>
            Take {target.title} off {card}? It is deleted on the site and cannot be put back.
          </Ask>
          </div>
        )}
      </JiraSection>
      {over && (
        <div className="absolute inset-0 grid place-items-center pointer-events-none rounded-md text-[11px]"
          style={{ background: "color-mix(in srgb, var(--bg) 78%, transparent)", color: "var(--text)" }} aria-hidden>
          Drop to add to {card}
        </div>
      )}
    </div>
  );
}
