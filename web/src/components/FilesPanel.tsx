// The file tree this app never had.
//
// Everything else here is about what CHANGED — the diff, the working tree, the
// pull request. That is the right default, and it leaves one hole: the file
// nobody touched. "What does this helper actually do?", asked about code that
// is not in any diff, meant leaving for an editor and then finding your place
// again on the way back.
//
// The worktree picker at the top is not a label, it is the root. With five
// checkouts of one repository open at once — which is the normal state of this
// machine — "open src/models.py" is ambiguous until you have said *whose*, and
// opening the wrong branch's copy is a mistake you only notice after editing
// it. Everything below the picker is that checkout and nothing else.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api.ts";
import type { FileEntry, GitRepoRef, GrepHit } from "../../../shared/types.ts";
import { CheckoutPicker } from "./CheckoutPicker.tsx";
import { ViewHeader } from "./workspace/ViewHeader.tsx";
import { PeekFile, type Peek } from "./PeekFile.tsx";
import { subscribeFilesReveal, filesReveal } from "../lib/filesReveal.ts";
import { FOLDER, FOLDER_OPEN, guides, iconFor, isNoise } from "../lib/fileIcons.ts";

/** How a row is drawn depends only on this, so the tree and the search results
 *  cannot drift apart. */
const MARK_TINT: Record<string, string> = {
  M: "var(--warning)", A: "var(--success)", D: "var(--error)",
  R: "var(--primary)", "?": "var(--text4)", "·": "var(--text4)",
};

const edge = (pct: number) => `1px solid color-mix(in srgb, var(--text) ${pct}%, transparent)`;

export function FilesView({ active }: { active: boolean }) {
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [root, setRoot] = useState("");

  const repo = repos.find((r) => r.root === root) ?? null;

  /*
   * A folder chosen in the file palette, which may name a checkout this view is
   * not showing. The root has to move first — FilesBody is keyed on it, so a
   * reveal handed to the wrong tree would expand nothing and read as the search
   * having lied.
   */
  const jump = useSyncExternalStore(subscribeFilesReveal, filesReveal);
  useEffect(() => { if (jump?.root) setRoot(jump.root); }, [jump]);

  // Every time the view becomes active, not once on mount: a worktree cut after
  // this panel first loaded would otherwise never appear in the picker.
  useEffect(() => {
    if (!active) return;
    api.gitRepos().then(({ repos: r }) => {
      setRepos(r);
      setRoot((cur) => (cur && r.some((x) => x.root === cur) ? cur : (r[0]?.root ?? "")));
    }).catch(() => {});
  }, [active]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <ViewHeader label="Files">
        <CheckoutPicker repos={repos} value={root} onPick={setRoot}
          placeholder="Pick a checkout" triggerMaxWidth={280} emptyLabel="no checkouts seen yet" />
        {repo && <span className="text-[10px] truncate min-w-0" style={{ color: "var(--text3)" }} title={repo.root}>{repo.root}</span>}
      </ViewHeader>
      {root ? <FilesBody root={root} branch={repo?.branch ?? ""} active={active} />
        : <div className="p-5 text-[11.5px]" style={{ color: "var(--text3)" }}>No checkout to browse — open a project first.</div>}
    </div>
  );
}

/** Keyed on the root by its parent, so switching checkouts starts clean rather
 *  than showing one repository's expanded folders under another's name. */
function FilesBody({ root, branch, active }: { root: string; branch: string; active: boolean }) {
  const [mode, setMode] = useState<"names" | "contents">("names");
  const [q, setQ] = useState("");
  const [peek, setPeek] = useState<Peek | null>(null);
  const open = useCallback((rel: string) => {
    // Editable, and it says so. This is the user's own checkout on the branch
    // named in the header — the case the read-only viewer was never for.
    setPeek({ root, path: `${root}/${rel}`, label: rel, edit: true, branch });
  }, [root, branch]);

  /*
   * A folder chosen from the results is a PLACE, not a document.
   *
   * So it clears the query and walks the tree there, which is the only thing
   * you can do with a directory — and the thing typing its name was asking for.
   */
  const [reveal, setReveal] = useState<string | null>(null);
  const openDir = useCallback((rel: string) => { setQ(""); setReveal(rel); }, []);

  /*
   * The same thing, asked from outside — the file palette, which can be open
   * over any view at all.
   *
   * `n` is compared against the last one served rather than the path, because
   * asking for the same folder twice is two requests: walk away in the tree,
   * search for it again, and a path-keyed effect would decide nothing had
   * changed and leave you where you were.
   */
  const jump = useSyncExternalStore(subscribeFilesReveal, filesReveal);
  const served = useRef(0);
  useEffect(() => {
    if (!jump || jump.n === served.current || jump.root !== root) return;
    served.current = jump.n;
    setQ("");
    setReveal(jump.dir);
  }, [jump, root]);

  return (
    <div className="flex-1 min-h-0 flex flex-col" key={root}>
      <div className="flex items-center gap-2 px-5 py-2 shrink-0" style={{ borderBottom: edge(12) }}>
        <span className="flex items-center gap-1.5 flex-1 min-w-0 px-2 py-1 rounded-md"
          style={{ background: "var(--bg)", border: edge(20) }}>
          <span style={{ color: "var(--text3)" }}>⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} autoComplete="off"
            placeholder={mode === "names" ? "Find a file by name…" : "Search the code of this checkout…"}
            className="flex-1 min-w-0 bg-transparent outline-none text-[11px]" style={{ color: "var(--text)" }} />
          {q && <button onClick={() => setQ("")} title="Clear" style={{ color: "var(--text3)" }}>×</button>}
        </span>
        {/* Two different questions — where is the file called X, and where is
            the code that says X — so two modes rather than one box that guesses
            which you meant. */}
        <span className="inline-flex rounded-md overflow-hidden shrink-0" style={{ border: edge(20) }}>
          {(["names", "contents"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)}
              className="text-[10.5px] px-3 py-1"
              style={m === mode
                ? { background: "color-mix(in srgb, var(--primary) 20%, transparent)", color: "var(--text)" }
                : { color: "var(--text3)" }}>{m === "names" ? "Names" : "Contents"}</button>
          ))}
        </span>
      </div>

      <div className="flex-1 min-h-0 agx-scroll overflow-y-auto overflow-x-hidden">
        {q.trim() ? (
          mode === "names" ? <NameHits root={root} q={q} onOpen={open} onOpenDir={openDir} />
            : <ContentHits root={root} q={q} onOpen={open} />
        ) : (
          <Tree root={root} active={active} onOpen={open} reveal={reveal} />
        )}
      </div>
      {peek && <PeekFile peek={peek} onClose={() => setPeek(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------ tree ----

/**
 * One level at a time.
 *
 * A recursive fetch of a checkout with a node_modules in it is hundreds of
 * thousands of entries, so a folder is listed when it is opened and cached
 * after — which is also what makes a deep tree cheap to walk back through.
 */
function Tree({ root, active, onOpen, reveal }: {
  root: string; active: boolean; onOpen: (rel: string) => void;
  /** A folder to walk to, set when one is chosen from the search results.
   *  Every ancestor opens with it, because a folder shown with its parents
   *  collapsed is a folder you cannot see. */
  reveal?: string | null;
}) {
  const rootName = root.split("/").filter(Boolean).pop() ?? root;
  const [levels, setLevels] = useState<Record<string, FileEntry[]>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** The row the keyboard is on, by path. A path rather than an index: opening
   *  a folder inserts rows above the cursor, and an index would slide out from
   *  under it. */
  const [cursor, setCursor] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (rel: string) => {
    const r = await api.filesTree(root, rel);
    if (!r.ok) { setError(r.error ?? "could not read that folder"); return; }
    setError(null);
    setLevels((cur) => ({ ...cur, [rel]: r.entries }));
  }, [root]);

  useEffect(() => {
    if (!active) return;
    setLoading(true);
    load("").finally(() => setLoading(false));
  }, [active, load]);

  const expand = useCallback((rel: string) => {
    setOpen((cur) => {
      if (cur.has(rel)) return cur;
      if (!levels[rel]) void load(rel);
      return new Set(cur).add(rel);
    });
  }, [levels, load]);
  /*
   * Walk to a folder somebody picked out of the search.
   *
   * Its ancestors open too — `docs`, then `docs/projects`, then
   * `docs/projects/guest-checkout-v2` — because opening the last one alone
   * leaves it inside two collapsed parents where nothing is on screen. Each
   * level loads as it opens; `expand` already handles that.
   */
  useEffect(() => {
    if (!reveal) return;
    const parts = reveal.split("/").filter(Boolean);
    for (let n = 1; n <= parts.length; n++) expand(parts.slice(0, n).join("/"));
    setCursor(reveal);
  }, [reveal, expand]);

  const collapse = (rel: string) => setOpen((cur) => { const n = new Set(cur); n.delete(rel); return n; });
  const toggle = (rel: string) => (open.has(rel) ? collapse(rel) : expand(rel));

  /**
   * Every row that is currently on screen, flattened in reading order.
   *
   * The tree is drawn from this rather than by recursing during render, which
   * is what makes j/k possible at all: "the next row" is a question about the
   * flattened list, and a recursive render never has one.
   *
   * `last` is one flag per ancestor — whether that ancestor was the final child
   * of its own parent — and it is what decides between a pipe that keeps going
   * and blank space. See fileIcons.guides.
   */
  const rows = useMemo(() => {
    const out: { e: FileEntry; last: boolean[] }[] = [];
    const walk = (rel: string, last: boolean[]) => {
      const list = levels[rel] ?? [];
      list.forEach((e, i) => {
        const mine = [...last, i === list.length - 1];
        out.push({ e, last: mine });
        if (e.dir && open.has(e.rel)) walk(e.rel, mine);
      });
    };
    walk("", []);
    return out;
  }, [levels, open]);

  const at = rows.findIndex((r) => r.e.rel === cursor);
  const cur = at >= 0 ? rows[at] : null;

  /** Move the cursor and keep it on screen. `block: "nearest"` so walking down
   *  a long tree scrolls a row at a time rather than jumping the view. */
  const go = (i: number) => {
    const next = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (!next) return;
    setCursor(next.e.rel);
    requestAnimationFrame(() => {
      boxRef.current?.querySelector(`[data-row="${CSS.escape(next.e.rel)}"]`)?.scrollIntoView({ block: "nearest" });
    });
  };

  /**
   * The four keys everybody already has in their fingers.
   *
   * j/k down and up. `h` closes the folder you are in, and when you are already
   * on something closed it goes to the PARENT — which is what makes h the way
   * out of a deep tree rather than a key that does nothing half the time. `l`
   * opens a folder, steps into an open one, and opens a file. Enter does what
   * clicking does.
   */
  const onKey = (e: React.KeyboardEvent) => {
    if (/input|textarea/i.test((e.target as HTMLElement)?.tagName ?? "")) return;
    const k = e.key;
    if (!rows.length) return;
    if (k === "j" || k === "ArrowDown") { e.preventDefault(); go(at < 0 ? 0 : at + 1); return; }
    if (k === "k" || k === "ArrowUp") { e.preventDefault(); go(at < 0 ? 0 : at - 1); return; }
    if (k === "g") { e.preventDefault(); go(0); return; }
    if (k === "G") { e.preventDefault(); go(rows.length - 1); return; }
    if (!cur) { if (k === "l" || k === "h" || k === "Enter") { e.preventDefault(); go(0); } return; }

    if (k === "h" || k === "ArrowLeft") {
      e.preventDefault();
      if (cur.e.dir && open.has(cur.e.rel)) { collapse(cur.e.rel); return; }
      // Out to the parent. The parent is the last row above this one that is
      // shallower — the flattened list already knows, so no path arithmetic.
      for (let i = at - 1; i >= 0; i--) {
        if (rows[i]!.last.length < cur.last.length) { go(i); return; }
      }
      return;
    }
    if (k === "l" || k === "ArrowRight") {
      e.preventDefault();
      if (!cur.e.dir) { onOpen(cur.e.rel); return; }
      if (!open.has(cur.e.rel)) { expand(cur.e.rel); return; }
      go(at + 1); // already open — step into it
      return;
    }
    if (k === "Enter" || k === "o") {
      e.preventDefault();
      if (cur.e.dir) toggle(cur.e.rel); else onOpen(cur.e.rel);
    }
  };

  // Focus the tree when this view comes up, so the keys work without a click.
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => boxRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [active]);

  if (error) return <div className="p-5 text-[11.5px]" style={{ color: "var(--error)" }}>{error}</div>;
  if (loading && !levels[""]) return <div className="p-5 text-[11.5px]" style={{ color: "var(--text3)" }}>Reading the checkout…</div>;

  const top = levels[""] ?? [];
  return (
    <div ref={boxRef} tabIndex={-1} onKeyDown={onKey} className="py-1 outline-none">
      {/* The checkout's own name at the head of the tree, the way an editor
          roots its explorer — so a screenshot of this says which repository it
          is without the header being in frame. */}
      <div className="flex items-center gap-2 px-3 py-1 text-[12px]" style={{ color: "var(--text)" }}>
        <span style={{ color: FOLDER_OPEN.tint }}>{FOLDER_OPEN.glyph}</span>
        <span className="font-medium truncate">{rootName}</span>
        <span className="ml-auto text-[10px] tabular-nums" style={{ color: "var(--text4)" }}>
          {top.filter((e) => e.dir).length} dirs · {top.filter((e) => !e.dir).length} files
          <span className="ml-3" style={{ color: "var(--text4)" }}><b>j/k</b> move · <b>h/l</b> fold · <b>↵</b> open</span>
        </span>
      </div>

      {rows.map(({ e, last }) => {
        const isOpen = open.has(e.rel);
        const icon = iconFor(e.name, e.dir, isOpen);
        const quiet = isNoise(e.name, e.dir);
        const on = cursor === e.rel;
        return (
          <button key={e.rel} data-row={e.rel}
            onClick={() => { setCursor(e.rel); if (e.dir) toggle(e.rel); else onOpen(e.rel); }}
            className="w-full text-left flex items-center py-0.5 text-[12px] leading-[1.5] hover:bg-white/5"
            style={{
              paddingLeft: 14, paddingRight: 16,
              background: on ? "color-mix(in srgb, var(--primary) 15%, transparent)" : undefined,
              boxShadow: on ? "inset 2px 0 0 0 var(--primary)" : undefined,
            }}
            title={e.dir ? e.rel : `${e.rel}${e.size != null ? ` · ${bytes(e.size)}` : ""}`}>
            {/* One pre-formatted string rather than a span per level: the guides
                are drawn with box characters in a monospaced face, so they line
                up by construction and cost one text node instead of six. */}
            <span className="shrink-0 whitespace-pre select-none" style={{ color: "color-mix(in srgb, var(--text) 22%, transparent)" }}>
              {guides(last)}
            </span>
            <span className="shrink-0 w-[1.6em] text-center" style={{ color: quiet ? "var(--text4)" : icon.tint }}>{icon.glyph}</span>
            <span className="truncate" style={{
              color: quiet ? "var(--text4)" : e.dir ? "var(--primary)" : "var(--text2)",
              fontWeight: e.dir && !quiet ? 500 : 400,
            }}>{e.name}</span>
            {/* The right edge earns its keep: what changed, and how big it is.
                A row of nothing but a filename in a 1900px window is what made
                this look like a list somebody forgot to finish. */}
            <span className="ml-auto shrink-0 flex items-center gap-3 pl-4">
              {e.status && (
                <span className="text-[10px] tabular-nums" style={{ color: MARK_TINT[e.status] ?? "var(--text4)" }}
                  title={e.status === "·" ? "something below this has changed" : `git status: ${e.status}`}>
                  {e.status === "·" ? "•" : e.status}
                </span>
              )}
              {e.size != null && <span className="text-[10px] tabular-nums w-[62px] text-right" style={{ color: "var(--text4)" }}>{bytes(e.size)}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- search ----

/**
 * One result: the file it is in, and whatever the caller wants under it.
 *
 * The whole path is kept — twelve results all called `models.py` are told apart
 * only by what is in front — but quieted, and the name carries its own icon and
 * its language's colour. A hundred grey rows is a wall you read linearly; the
 * same hundred with a yellow Python glyph every few lines is a list you scan.
 */
function PathRow({ rel, dir, onOpen, children }: { rel: string; dir?: boolean; onOpen: (rel: string) => void; children?: React.ReactNode }) {
  const cut = rel.lastIndexOf("/");
  const name = rel.slice(cut + 1);
  const icon = iconFor(name, !!dir);
  return (
    <button onClick={() => onOpen(rel)} className="w-full text-left px-4 py-1.5 hover:bg-white/5" title={rel}
      style={{ borderBottom: edge(7) }}>
      <div className="text-[11.5px] truncate flex items-baseline gap-1.5">
        <span className="shrink-0" style={{ color: icon.tint }}>{icon.glyph}</span>
        {cut >= 0 && <span style={{ color: "var(--text4)" }}>{rel.slice(0, cut + 1)}</span>}
        <span style={{ color: icon.tint, fontWeight: 500 }}>{name}</span>
      </div>
      {children}
    </button>
  );
}

function NameHits({ root, q, onOpen, onOpenDir }: {
  root: string; q: string; onOpen: (rel: string) => void; onOpenDir: (rel: string) => void;
}) {
  const r = useSearch(() => api.filesFind(root, q), [root, q]);
  if (r.pending) return <Note>Looking…</Note>;
  if (!r.data) return <Note tint="var(--error)">{r.error ?? "the search failed"}</Note>;
  if (r.data.error) return <Note tint="var(--error)">{r.data.error}</Note>;
  const dirs = r.data.dirs ?? [];
  if (!r.data.files.length && !dirs.length) return <Note>Nothing here is called “{q.trim()}”.</Note>;
  return (
    <div>
      <Count>
        {dirs.length > 0 && <>{dirs.length} folder{dirs.length === 1 ? "" : "s"} · </>}
        {r.data.files.length} file{r.data.files.length === 1 ? "" : "s"} · via {r.data.via}{r.data.truncated ? " · first 300" : ""}
      </Count>
      {/* Folders first, and they are the answer far more often than their
          length suggests: typing `guest-checkout-v2` names a place, and forty
          files from inside it are forty ways of not saying so. Opening one
          moves the tree there rather than opening a viewer, which is the only
          thing you can do with a directory. */}
      {dirs.map((d) => <PathRow key={`d:${d}`} rel={d} dir onOpen={onOpenDir} />)}
      {r.data.files.map((f) => <PathRow key={f} rel={f} onOpen={onOpen} />)}
    </div>
  );
}

function ContentHits({ root, q, onOpen }: { root: string; q: string; onOpen: (rel: string) => void }) {
  const r = useSearch(() => api.filesGrep(root, q), [root, q]);
  const groups = useMemo(() => {
    const out: { rel: string; hits: GrepHit[] }[] = [];
    for (const h of r.data?.hits ?? []) {
      const last = out[out.length - 1];
      if (last && last.rel === h.rel) last.hits.push(h);
      else out.push({ rel: h.rel, hits: [h] });
    }
    return out;
  }, [r.data]);

  if (q.trim().length < 2) return <Note>Two letters at least — one matches every file there is.</Note>;
  if (r.pending) return <Note>Searching…</Note>;
  if (!r.data) return <Note tint="var(--error)">{r.error ?? "the search failed"}</Note>;
  if (r.data.error) return <Note tint="var(--error)">{r.data.error}</Note>;
  if (!r.data.hits.length) return <Note>No code in this checkout says “{q.trim()}”.</Note>;

  return (
    <div>
      <Count>
        {r.data.hits.length} match{r.data.hits.length === 1 ? "" : "es"} in {r.data.files} file{r.data.files === 1 ? "" : "s"} · via {r.data.via}
        {/* A list that quietly stopped early is how you conclude a symbol is
            used nowhere else. */}
        {r.data.truncated ? " · first 200, narrow the search for the rest" : ""}
      </Count>
      {groups.map((g) => (
        <PathRow key={g.rel} rel={g.rel} onOpen={onOpen}>
          <div className="mt-1 flex flex-col gap-px">
            {g.hits.map((h, i) => (
              <div key={i} className="flex items-baseline gap-2 text-[11px]">
                {/* The line number is a coordinate, not prose — its own tint,
                    so the eye can run down the column without reading it. */}
                <span className="shrink-0 tabular-nums w-[46px] text-right" style={{ color: "var(--info)", opacity: .75 }}>{h.line}</span>
                <span className="flex-1 min-w-0 truncate" style={{ color: "var(--text2)" }}>
                  {h.len > 0 ? (
                    <>
                      {h.text.slice(0, h.at)}
                      <span style={{ background: "color-mix(in srgb, var(--primary) 38%, transparent)", color: "var(--text)", borderRadius: 2, padding: "0 1px" }}>
                        {h.text.slice(h.at, h.at + h.len)}
                      </span>
                      {h.text.slice(h.at + h.len)}
                    </>
                  ) : h.text}
                </span>
              </div>
            ))}
          </div>
        </PathRow>
      ))}
    </div>
  );
}

const Note = ({ children, tint }: { children: React.ReactNode; tint?: string }) =>
  <div className="p-5 text-[11.5px]" style={{ color: tint ?? "var(--text3)" }}>{children}</div>;

const Count = ({ children }: { children: React.ReactNode }) =>
  <div className="px-5 py-1.5 text-[10px] sticky top-0 z-[1]"
    style={{ color: "var(--text3)", background: "color-mix(in srgb, var(--text) 6%, var(--bg2))", borderBottom: edge(12) }}>{children}</div>;

/**
 * A search that debounces and cannot be overtaken by its own older self.
 *
 * Typing "models" fires six searches; without the sequence guard, the one for
 * "mo" can land after the one for "models" and put the wrong answer on screen —
 * a bug that only shows up on a slow query, which is exactly the query where it
 * matters.
 */
function useSearch<T>(run: () => Promise<T>, deps: unknown[]): { data: T | null; pending: boolean; error: string | null } {
  const [state, setState] = useState<{ data: T | null; pending: boolean; error: string | null }>({ data: null, pending: true, error: null });
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, pending: true }));
    const t = setTimeout(() => {
      run().then((data) => { if (seq.current === mine) setState({ data, pending: false, error: null }); })
        .catch((e) => { if (seq.current === mine) setState({ data: null, pending: false, error: String(e) }); });
    }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
