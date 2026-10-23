// The three boxes of the file operations that ask for more than a name: Compress,
// Properties and the folder picker behind Move to… and Copy to…. Strata's, field
// for field (its shots 46 and 49). The decisions are in lib/finderOps.ts; the
// doing is /fs/op, so a box only collects and hands back.
import { useEffect, useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import { HIT, ICON } from "../../../lib/iconSize.ts";
import { FileTypeIcon, StrataIcon } from "./StrataIcon.tsx";
import { archiveName, compressSub, destProblem, trashDeleteWords, formatTakesPassword, canExec, kindWords, toggleExec, modeBits, modeSymbolic, filterApps, nameProblem, shortPath, toggleMode, type Who } from "../../../lib/finderOps.ts";
import type { FsProps, FsTrashRow, OpenWithApp, OpenWithList } from "../../../../../shared/types.ts";
import { EDGE, INPUT, INPUT_STYLE, LINE } from "../../workspace/Chrome.tsx";
import { DialogHead, Sheet } from "./FinderOpsUI.tsx";

type Fmt = "zip" | "7z" | "tar.gz" | "tar";
const FORMATS: Fmt[] = ["zip", "7z", "tar.gz", "tar"];

function Seg<T extends string>({ label, value, options, onPick, show }: { label: string; value: T; options: readonly T[]; onPick: (v: T) => void; show: (v: T) => string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-md p-0.5 gap-0.5" style={{ border: EDGE }}>
      {options.map((o) => (
        <button key={o} role="radio" aria-checked={o === value} onClick={() => onPick(o)} className="agx-btn flex-1 rounded px-2"
          style={{ minHeight: HIT - 6, background: o === value ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "transparent", color: o === value ? "var(--primary-ink)" : "var(--text3)" }}>{show(o)}</button>
      ))}
    </div>
  );
}

/** Compress…: the archive's name, its format, and whether it is locked. */
export function CompressDialog({ names, dirs, onSubmit, onClose }: {
  names: readonly string[]; dirs: readonly boolean[]; onSubmit: (o: { name: string; format: Fmt; password?: string }) => void; onClose: () => void;
}) {
  const [name, setName] = useState(archiveName(names));
  const [format, setFormat] = useState<Fmt>("zip");
  const [locked, setLocked] = useState(false);
  const [pw, setPw] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const canLock = formatTakesPassword(format);
  const using = locked && canLock;
  const problem = nameProblem(name, []) ?? (using && !pw ? "A password is needed" : using && pw.startsWith("-") ? "A password cannot start with a dash" : null);
  const go = () => { if (!problem) onSubmit({ name: name.trim(), format, password: using ? pw : undefined }); };
  return (
    <Sheet label="Compress" onClose={onClose}>
      <DialogHead icon={<StrataIcon set="act" name="package-plus" size={ICON.md} />} title={`Compress ${names.length === 1 ? "1 item" : `${names.length} items`}`} sub={compressSub(dirs.map((d) => ({ dir: d })))} onClose={onClose} />
      <label className="block text-[11px] mb-1" style={{ color: "var(--text3)" }}>Archive name</label>
      <input ref={input} value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} aria-label="Archive name" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); go(); } }} className={`${INPUT} w-full mb-3`} style={INPUT_STYLE} />
      <label className="block text-[11px] mb-1" style={{ color: "var(--text3)" }}>Format</label>
      <div className="mb-3"><Seg label="Format" value={format} options={FORMATS} onPick={(f) => { setFormat(f); if (!formatTakesPassword(f)) setLocked(false); }} show={(f) => f.toUpperCase()} /></div>
      <label className="block text-[11px] mb-1" style={{ color: "var(--text3)" }}>Protection</label>
      <Seg label="Protection" value={using ? "pw" : "none"} options={["none", "pw"] as const} onPick={(v) => { if (canLock) setLocked(v === "pw"); }} show={(v) => (v === "none" ? "No password" : "Password protected")} />
      {!canLock && <p className="m-0 mt-1" style={{ color: "var(--text3)" }}>{format.toUpperCase()} has no password protection.</p>}
      {using && <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} aria-label="Password" autoComplete="off" placeholder="Password" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); go(); } }} className={`${INPUT} w-full mt-2`} style={INPUT_STYLE} />}
      <p role="alert" className="m-0 mt-1.5 min-h-[16px]" style={{ color: "var(--error-ink)" }}>{problem && name.trim() ? problem : null}</p>
      <div className="flex justify-end gap-2 mt-2">
        <button className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE }} onClick={onClose}>Cancel</button>
        <button className="agx-btn rounded-md px-3" disabled={!!problem} style={{ minHeight: HIT, background: "var(--text)", color: "var(--bg)" }} onClick={go}>Compress</button>
      </div>
    </Sheet>
  );
}

const WHO: { who: Who; label: string; of: (p: FsProps) => string }[] = [
  { who: "owner", label: "Owner", of: (p) => p.owner }, { who: "group", label: "Group", of: (p) => p.group }, { who: "others", label: "Others", of: () => "" },
];

function when(ms: number) { return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); }
function size(b: number | null) { return b == null ? "—" : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(1)} GB`; }

/** Properties: what the server knows about one entry, and the nine permission bits when it is the owner's. */
export function PropsDialog({ path, home, pinned, onChmod, onOpen, onRename, onCopyPath, onClose }: {
  path: string; home: string; pinned: boolean; onChmod: (mode: number) => Promise<boolean>; onOpen: () => void; onRename: () => void; onCopyPath: () => void; onClose: () => void;
}) {
  const [p, setP] = useState<FsProps | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { let live = true; void api.fsProps(path).then((r) => { if (!live) return; if (r.ok && r.props) setP(r.props); else setErr(r.error ?? "Could not read it"); }); return () => { live = false; }; }, [path]);
  const flip = async (who: Who, bit: 0 | 1 | 2) => { if (!p || !p.mine) return; const mode = toggleMode(p.mode, who, bit); if (await onChmod(mode)) setP({ ...p, mode }); };
  const row = (k: string, v: string) => <div key={k} className="flex gap-3 py-1.5" style={{ borderBottom: LINE }}><span className="w-24 shrink-0 text-[10.5px] uppercase" style={{ color: "var(--text3)" }}>{k}</span><span className="min-w-0 truncate" title={v}>{v}</span></div>;
  return (
    <Sheet label="Properties" onClose={onClose}>
      {err && <p role="alert" className="m-0" style={{ color: "var(--error-ink)" }}>{err}</p>}
      {p && (
        <>
          <DialogHead icon={<FileTypeIcon name={p.name} isDir={p.kind === "dir"} size={ICON.md} />} title={p.name} sub={kindWords(p.name, p.kind)} onClose={onClose} />
          {row("Location", shortPath(p.path, home, 44))}
          {row("Size", size(p.bytes))}
          {row("Modified", when(p.mtime))}
          {p.link && row("Points to", p.link)}
          {row("Hidden", p.hidden ? "Yes" : "No")}
          {row("Pinned", pinned ? "Yes" : "No")}
          <div className="flex items-baseline justify-between mt-3 mb-1 text-[10.5px] uppercase" style={{ color: "var(--text3)" }}><span>Permissions</span><span className="normal-case">{modeSymbolic(p.mode, p.kind)} {(p.mode & 0o777).toString(8).padStart(3, "0")}</span></div>
          {WHO.map(({ who, label, of }) => (
            <div key={who} className="flex items-center gap-2 py-0.5">
              <span className="w-14">{label}</span><span className="flex-1 truncate text-[10.5px]" style={{ color: "var(--text3)" }}>{of(p)}</span>
              {(["r", "w", "x"] as const).map((l, i) => {
                const on = modeBits(p.mode)[who][i]!;
                return <button key={l} aria-pressed={on} aria-label={`${label} ${l === "r" ? "read" : l === "w" ? "write" : "execute"}`} disabled={!p.mine || p.kind === "link"} onClick={() => void flip(who, i as 0 | 1 | 2)}
                  className="agx-btn rounded" style={{ width: HIT, minHeight: HIT - 8, border: EDGE, background: on ? "color-mix(in srgb, var(--primary) 22%, transparent)" : "transparent", color: on ? "var(--primary-ink)" : "var(--text3)" }}>{on ? l : "–"}</button>;
              })}
            </div>
          ))}
          {p.kind === "file" && <label className="flex items-center gap-2 mt-2 cursor-pointer"><input type="checkbox" checked={canExec(p.mode)} disabled={!p.mine} onChange={() => void (async () => { const mode = toggleExec(p.mode); if (await onChmod(mode)) setP({ ...p, mode }); })()} />Allow executing file as a program (+x)</label>}
          {!p.mine && <p className="m-0 mt-1" style={{ color: "var(--text3)" }}>Only the owner can change these.</p>}
        </>
      )}
      <div className="grid grid-cols-3 gap-2 mt-3 pt-3" style={{ borderTop: LINE }}>
        {([["Open", "external-link", onOpen], ["Rename", "pencil", onRename], ["Copy path", "copy", onCopyPath]] as const).map(([label, ic, fn]) => (
          <button key={label} autoFocus={label === "Open"} className="agx-btn rounded-md px-3 flex items-center justify-center gap-1.5" style={{ minHeight: HIT, border: EDGE }} onClick={fn} disabled={!p}><StrataIcon set="act" name={ic} size={ICON.xs} />{label}</button>
        ))}
      </div>
    </Sheet>
  );
}

/** Move to… / Copy to…: walk the folders and pick one. Only folders are listed; the server judges the rest. */
export function FolderPicker({ op, paths, start, home, onPick, onClose }: { op: "move" | "copy"; paths: readonly string[]; start: string; home: string; onPick: (dest: string) => void; onClose: () => void }) {
  const [at, setAt] = useState(start);
  const [dirs, setDirs] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true; setDirs(null); setErr(null);
    void api.browseList(at, 0, false, undefined, 500).then((r) => { if (!live) return; if (r.ok) setDirs(r.entries.filter((e) => e.kind === "dir" && !e.locked).map((e) => e.name).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }))); else setErr(r.error ?? "Could not open it"); });
    return () => { live = false; };
  }, [at]);
  const join = (n: string) => `${at.replace(/\/$/, "")}/${n}`;
  const up = at.slice(0, at.lastIndexOf("/")) || "/";
  const problem = destProblem(paths, at, op);
  const verb = op === "move" ? "Move" : "Copy";
  return (
    <Sheet label={`${verb} to`} onClose={onClose}>
      <DialogHead icon={<StrataIcon set="act" name={op === "move" ? "folder-input" : "copy-plus"} size={ICON.md} />} title={`${verb} ${paths.length === 1 ? "1 item" : `${paths.length} items`} to…`} sub={shortPath(at, home, 44)} onClose={onClose} />
      <div role="listbox" aria-label="Folders" className="rounded-md overflow-y-auto" style={{ border: EDGE, height: 220 }}>
        {at !== "/" && <button role="option" aria-selected={false} className="agx-btn w-full text-left px-3" style={{ minHeight: HIT - 4, color: "var(--text3)" }} onClick={() => setAt(up)}>..</button>}
        {dirs?.map((n) => <button key={n} role="option" aria-selected={false} className="agx-btn w-full text-left px-3 truncate" style={{ minHeight: HIT - 4 }} onClick={() => setAt(join(n))}><span className="flex items-center gap-2"><FileTypeIcon name={n} isDir broken={false} size={ICON.sm} /><span className="truncate">{n}</span></span></button>)}
        {dirs && !dirs.length && <p className="m-0 p-3" style={{ color: "var(--text3)" }}>No folders here</p>}
        {err && <p role="alert" className="m-0 p-3" style={{ color: "var(--error-ink)" }}>{err}</p>}
      </div>
      <p role="alert" className="m-0 mt-1.5 min-h-[16px]" style={{ color: "var(--error-ink)" }}>{problem}</p>
      <div className="flex justify-end gap-2 mt-2">
        <button className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE }} onClick={onClose}>Cancel</button>
        <button className="agx-btn rounded-md px-3" disabled={!!problem || !!err} style={{ minHeight: HIT, background: "var(--text)", color: "var(--bg)" }} onClick={() => onPick(at)}>{verb} here</button>
      </div>
    </Sheet>
  );
}

/** The Trash entry of the sidebar: what is in the freedesktop trash, each with Restore and Delete, and Empty trash for all. Deleting here is for good, so it asks, and the server wants the desktop app for it. */
export function TrashPanel({ home, onRestored, onClose }: { home: string; onRestored: (dirs: string[], said: string) => void; onClose: () => void }) {
  const [rows, setRows] = useState<FsTrashRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sure, setSure] = useState<{ ids: string[]; words: { title: string; body: string; confirm: string } } | null>(null);
  const load = () => { void api.fsTrash().then((r) => { if (r.ok) setRows(r.entries); else setErr("Could not read the trash"); }); };
  useEffect(load, []);
  const restore = async (r: FsTrashRow) => {
    const a = await api.fsOp({ op: "restore", ids: [r.id] });
    if (!a.ok) { setErr(a.error ?? "That did not work"); return; }
    setErr(null); load(); onRestored([r.from.slice(0, r.from.lastIndexOf("/")) || "/"], `Restored ${r.name}`);
  };
  const remove = async (ids: string[]) => {
    const a = await api.fsOp({ op: "empty-trash", ids, confirm: ids.length });
    setSure(null);
    if (!a.ok) { setErr(a.error ?? "That did not work"); return; }
    setErr(null); load();
  };
  const ask = (ids: string[], names: string[], all = false) => setSure({ ids, words: trashDeleteWords(names, all) });
  return (
    <Sheet label="Trash" onClose={onClose} width={460}>
      <div>
        <DialogHead icon={<StrataIcon set="act" name="trash" size={ICON.md} />} title="Trash" sub={rows ? `${rows.length} ${rows.length === 1 ? "item" : "items"}` : undefined} onClose={onClose} />
        <div role="list" aria-label="Trashed items" className="rounded-md overflow-y-auto" style={{ border: EDGE, maxHeight: 280, minHeight: 60 }}>
          {rows?.map((r) => (
            <div key={r.id} role="listitem" className="flex items-center gap-2 px-3 py-1.5" style={{ borderBottom: LINE }}>
              <div className="flex-1 min-w-0">
                <div className="truncate">{r.name}</div>
                <div className="truncate text-[10.5px]" style={{ color: "var(--text3)" }} title={r.from}>{shortPath(r.from, home, 44)} · {r.deleted.replace("T", " ")}</div>
              </div>
              <button className="agx-btn rounded-md px-2" style={{ minHeight: HIT - 6, border: EDGE }} onClick={() => void restore(r)}>Restore</button>
              <button className="agx-btn rounded-md px-2" aria-label={`Delete ${r.name} for good`} style={{ minHeight: HIT - 6, border: EDGE, color: "var(--error-ink)" }} onClick={() => ask([r.id], [r.name])}>Delete</button>
            </div>
          ))}
          {rows && !rows.length && <p className="m-0 p-3" style={{ color: "var(--text3)" }}>The trash is empty</p>}
          {!rows && !err && <p className="m-0 p-3" style={{ color: "var(--text3)" }}>Reading the trash…</p>}
        </div>
        <p role="alert" className="m-0 mt-1.5 min-h-[16px]" style={{ color: "var(--error-ink)" }}>{err}</p>
        <div className="flex justify-end gap-2 mt-2">
          <button className="agx-btn rounded-md px-3" disabled={!rows?.length} style={{ minHeight: HIT, border: EDGE, color: "var(--error-ink)" }} onClick={() => rows && ask(rows.map((r) => r.id), rows.map((r) => r.name), true)}>Empty Trash</button>
          <button autoFocus className="agx-btn rounded-md px-3" style={{ minHeight: HIT, background: "var(--text)", color: "var(--bg)" }} onClick={onClose}>Close</button>
        </div>
      </div>
      {sure && <Sheet label={sure.words.title} onClose={() => setSure(null)}>
        <b className="block text-[13px] mb-1">{sure.words.title}</b>
        <p className="m-0 mb-3" style={{ color: "var(--text3)" }}>{sure.words.body}</p>
        <div className="flex justify-end gap-2">
          <button autoFocus className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE }} onClick={() => setSure(null)}>Cancel</button>
          <button className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE, color: "var(--error-ink)" }} onClick={() => void remove(sure.ids)}>{sure.words.confirm}</button>
        </div>
      </Sheet>}
    </Sheet>
  );
}

/** Open With…: Strata's box (its shot 50): a search, "Recommended Applications" then "Other Applications", and "Always use for this file type". */
export function OpenWithDialog({ paths, onLaunch, onClose }: {
  paths: readonly string[]; onLaunch: (id: string, always: { mime: string } | null) => void; onClose: () => void;
}) {
  const [list, setList] = useState<OpenWithList | null>(null);
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const [always, setAlways] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { let live = true; void api.openWithList([...paths]).then((r) => { if (live) setList(r); }); return () => { live = false; }; }, [paths]);
  useEffect(() => { input.current?.focus(); }, [list]);
  const rec = filterApps(list?.recommended ?? [], q), other = filterApps(list?.other ?? [], q);
  const rows: { app: OpenWithApp; head?: string }[] = [...rec.map((app, i) => ({ app, head: i === 0 ? "Recommended Applications" : undefined })), ...other.map((app, i) => ({ app, head: i === 0 ? "Other Applications" : undefined }))];
  const pick = Math.min(at, Math.max(0, rows.length - 1));
  const mime = list?.mimes?.length === 1 ? list.mimes[0]! : null;
  const go = () => { const r = rows[pick]; if (r) onLaunch(r.app.id, always && mime ? { mime } : null); };
  const empty = list && !rows.length ? (q ? "No applications match" : list.error ?? list.empty ?? "No compatible applications were found") : null;
  return (
    <Sheet label="Open With" onClose={onClose} width={420}>
      <DialogHead icon={<StrataIcon set="act" name="external-link" size={ICON.md} />} title="Open With" sub={`Choose an application to open ${paths.length === 1 ? "this item" : "these items"}`} onClose={onClose} />
      <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setAt(0); }} spellCheck={false} placeholder="Search applications…" aria-label="Search applications"
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); go(); }
          else if (e.key === "ArrowDown") { e.preventDefault(); setAt(Math.min(rows.length - 1, pick + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setAt(Math.max(0, pick - 1)); }
        }} className={`${INPUT} w-full mb-2`} style={INPUT_STYLE} />
      <div role="listbox" aria-label="Applications" className="overflow-y-auto rounded-md" style={{ border: EDGE, maxHeight: 260 }}>
        {!list && <p className="m-0 p-3" style={{ color: "var(--text3)" }}>Looking for applications…</p>}
        {empty && <p role="status" className="m-0 p-3" style={{ color: "var(--text3)" }}>{empty}</p>}
        {rows.map((r, i) => (
          <div key={r.app.id}>
            {r.head && <div className="px-2 pt-2 pb-1 text-[11px]" style={{ color: "var(--text3)" }}>{r.head}</div>}
            <button role="option" aria-selected={i === pick} onClick={() => setAt(i)} onDoubleClick={go} className="agx-btn w-full text-left px-2 rounded-md block"
              style={{ minHeight: HIT, background: i === pick ? "color-mix(in srgb, var(--primary) 18%, transparent)" : "transparent" }}>
              <span className="block truncate">{r.app.name}</span>
              {r.app.comment && <span className="block truncate text-[11px]" style={{ color: "var(--text3)" }}>{r.app.comment}</span>}
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 mt-3">
        <label className="flex items-center gap-1.5" style={{ opacity: mime ? 1 : 0.5 }}>
          <input type="checkbox" checked={always && !!mime} disabled={!mime} onChange={(e) => setAlways(e.target.checked)} />
          {paths.length > 1 ? "Always use for these file types" : "Always use for this file type"}
        </label>
        <div className="flex gap-2">
          <button className="agx-btn rounded-md px-3" style={{ minHeight: HIT, border: EDGE }} onClick={onClose}>Cancel</button>
          <button className="agx-btn rounded-md px-3" disabled={!rows.length} style={{ minHeight: HIT, background: "var(--text)", color: "var(--bg)" }} onClick={go}>Open</button>
        </div>
      </div>
    </Sheet>
  );
}
