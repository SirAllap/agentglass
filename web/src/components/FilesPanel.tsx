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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import type { FileEntry, GitRepoRef, GrepHit } from "../../../shared/types.ts";
import { ViewHeader } from "./workspace/ViewHeader.tsx";
import { PeekFile, type Peek } from "./PeekFile.tsx";
import { useDismiss } from "../lib/useDismiss.ts";

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
  const [repoOpen, setRepoOpen] = useState(false);
  const [repoQuery, setRepoQuery] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);
  useDismiss(repoOpen, pickerRef, () => { setRepoOpen(false); setRepoQuery(""); });

  const repo = repos.find((r) => r.root === root) ?? null;

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
      <ViewHeader title="Files">
        <div className="relative" ref={pickerRef}>
          <button onClick={() => setRepoOpen((o) => !o)}
            className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg max-w-[280px] shrink-0 whitespace-nowrap"
            style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: edge(20), color: "var(--text)" }}
            title={repo ? `${repo.name}\n${repo.branch}\n${repo.root}` : "Pick a checkout"}>
            <span className="font-medium truncate min-w-0">{repo ? (repo.worktreeOf ? repo.branch : repo.name) : "Pick a checkout"}</span>
            {repo?.worktreeOf && <span className="shrink-0 text-[8.5px] px-1 py-[1px] rounded" style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 32%, transparent)" }}>WT</span>}
            <span className="shrink-0" style={{ color: "var(--text3)" }}>▾</span>
          </button>
          {repoOpen && (
            <div className="absolute left-0 mt-1 rounded-lg text-[11px] shadow-2xl flex flex-col"
              style={{ zIndex: 30, background: "var(--bg2)", border: edge(30), minWidth: 340, maxHeight: 420, overflow: "hidden" }}>
              <input autoFocus value={repoQuery} onChange={(e) => setRepoQuery(e.target.value)} placeholder="Filter checkouts…"
                className="m-1.5 px-2.5 py-1.5 rounded-md text-[11px] outline-none shrink-0"
                style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: edge(20), color: "var(--text)" }} />
              <div className="agx-scroll overflow-y-auto pb-1" style={{ minHeight: 0 }}>
                {repos.filter((r) => {
                  const q = repoQuery.trim().toLowerCase();
                  return !q || `${r.name} ${r.branch} ${r.root}`.toLowerCase().includes(q);
                }).map((r) => (
                  <button key={r.root} onClick={() => { setRoot(r.root); setRepoOpen(false); setRepoQuery(""); }}
                    className="w-full text-left px-2.5 py-1.5 flex items-center gap-2"
                    style={{ background: r.root === root ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent" }}>
                    <span className="shrink-0 text-[8.5px] leading-none px-1 py-[2px] rounded"
                      title={r.worktreeOf ? `worktree of ${r.worktreeOf}` : "main checkout"}
                      style={r.worktreeOf
                        ? { color: "var(--primary)", background: "color-mix(in srgb, var(--primary) 16%, transparent)", border: "1px solid color-mix(in srgb, var(--primary) 32%, transparent)" }
                        : { color: "var(--text3)", border: edge(25) }}>{r.worktreeOf ? "WT" : "REPO"}</span>
                    <span className="min-w-0 flex-1 truncate font-medium" style={{ color: "var(--text)" }} title={r.root}>
                      {r.worktreeOf ? r.branch : r.name}
                    </span>
                    {!r.worktreeOf && <span className="shrink-0 truncate text-[9.5px]" style={{ maxWidth: 150, color: "var(--text3)" }} title={r.branch}>{r.branch}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
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

      <div className="flex-1 min-h-0 agx-scroll overflow-y-auto">
        {q.trim() ? (
          mode === "names" ? <NameHits root={root} q={q} onOpen={open} />
            : <ContentHits root={root} q={q} onOpen={open} />
        ) : (
          <Tree root={root} active={active} onOpen={open} />
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
function Tree({ root, active, onOpen }: { root: string; active: boolean; onOpen: (rel: string) => void }) {
  const [levels, setLevels] = useState<Record<string, FileEntry[]>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  const toggle = (rel: string) => {
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(rel)) next.delete(rel);
      else { next.add(rel); if (!levels[rel]) void load(rel); }
      return next;
    });
  };

  if (error) return <div className="p-5 text-[11.5px]" style={{ color: "var(--error)" }}>{error}</div>;
  if (loading && !levels[""]) return <div className="p-5 text-[11.5px]" style={{ color: "var(--text3)" }}>Reading the checkout…</div>;

  const rows = (rel: string, depth: number): React.ReactNode[] =>
    (levels[rel] ?? []).flatMap((e) => {
      const isOpen = open.has(e.rel);
      const row = (
        <button key={e.rel} onClick={() => (e.dir ? toggle(e.rel) : onOpen(e.rel))}
          className="w-full text-left flex items-center gap-2 py-[3px] text-[11.5px] hover:bg-white/5"
          style={{ paddingLeft: 20 + depth * 14, paddingRight: 20 }}
          title={e.dir ? e.rel : `${e.rel}${e.size != null ? ` · ${bytes(e.size)}` : ""}`}>
          <span className="shrink-0 w-3 text-center" style={{ color: "var(--text3)" }}>{e.dir ? (isOpen ? "▾" : "▸") : ""}</span>
          <span className="truncate" style={{ color: e.dir ? "var(--text)" : "var(--text2)" }}>{e.name}</span>
          {e.status && (
            <span className="ml-auto shrink-0 text-[9.5px]" style={{ color: MARK_TINT[e.status] ?? "var(--text4)" }}
              title={e.status === "·" ? "something below this has changed" : `git status: ${e.status}`}>{e.status}</span>
          )}
        </button>
      );
      return isOpen ? [row, ...rows(e.rel, depth + 1)] : [row];
    });

  return <div className="py-1">{rows("", 0)}</div>;
}

// ---------------------------------------------------------------- search ----

/** The tail of a path, which is what you are scanning for, with the directory
 *  kept but quieted — twelve rows all called `models.py` are told apart by the
 *  part in front, so it cannot be dropped. */
function PathRow({ rel, onOpen, children }: { rel: string; onOpen: (rel: string) => void; children?: React.ReactNode }) {
  const cut = rel.lastIndexOf("/");
  return (
    <button onClick={() => onOpen(rel)} className="w-full text-left px-5 py-1.5 hover:bg-white/5" title={rel}
      style={{ borderBottom: edge(7) }}>
      <div className="text-[11px] truncate">
        {cut >= 0 && <span style={{ color: "var(--text3)" }}>{rel.slice(0, cut + 1)}</span>}
        <span style={{ color: "var(--text)" }}>{rel.slice(cut + 1)}</span>
      </div>
      {children}
    </button>
  );
}

function NameHits({ root, q, onOpen }: { root: string; q: string; onOpen: (rel: string) => void }) {
  const r = useSearch(() => api.filesFind(root, q), [root, q]);
  if (r.pending) return <Note>Looking…</Note>;
  if (!r.data) return <Note tint="var(--error)">{r.error ?? "the search failed"}</Note>;
  if (r.data.error) return <Note tint="var(--error)">{r.data.error}</Note>;
  if (!r.data.files.length) return <Note>Nothing here is called “{q.trim()}”.</Note>;
  return (
    <div>
      <Count>{r.data.files.length} file{r.data.files.length === 1 ? "" : "s"} · via {r.data.via}{r.data.truncated ? " · first 300" : ""}</Count>
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
          <div className="mt-1 flex flex-col gap-[1px]">
            {g.hits.map((h, i) => (
              <div key={i} className="flex items-baseline gap-2 text-[10.5px]">
                <span className="shrink-0 tabular-nums w-[46px] text-right" style={{ color: "var(--text4)" }}>{h.line}</span>
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
