// Find a file from wherever you are.
//
// Files is a view, so reaching it costs leaving whatever you were doing —
// usually a terminal, which is precisely where you were when you needed the
// path. The trip back is the expensive part: the view keeps its state, but you
// do not keep your place.
//
// So this has no place in the layout at all. It opens over everything, centred,
// on a chord; nothing beneath it moves, which is the one property a side panel
// cannot have — a drawer that pushes reflows tmux, and a drawer that covers
// covers the terminal you were about to paste into.
//
// Three tabs rather than one box that guesses: "where is the file called X",
// "where does the code say X" and "what was I just reading" are three different
// questions with three different answers, and a single field would have to pick
// one of them for you.
//
// Opening a result raises the viewer that already exists — markdown, the editor
// toggle, the reading width — and this stays on top of it, so the next result
// is one keystroke away rather than another search.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";
import { api } from "../lib/api.ts";
import { iconFor } from "../lib/fileIcons.ts";
import { requestFilesReveal } from "../lib/filesReveal.ts";
import { recents, remember, forget, subscribeRecents, ago } from "../lib/fileRecents.ts";
import { completion, looksLikePath, parseQuery, passesFilters, readPath, scoreMatch } from "../lib/finderQuery.ts";
import { Preview } from "./finder/Preview.tsx";
import type { BrowseReport } from "../../../shared/types.ts";
import { appChordFor, chordLabel } from "../lib/keybindings.ts";
import { LAYER } from "../lib/layers.ts";
import { shortPath } from "../lib/shortPath.ts";
import type { DiskPlace, FsEntry, GitRepoRef, GrepHit } from "../../../shared/types.ts";

export type PaletteTab = "names" | "contents" | "recent" | "machine";

/*
 * The fourth question is not about the checkout at all.
 *
 * "Where is that document" — the evidence folder for a ticket, the note in
 * ~/Documents, the export somebody left in ~/Downloads — is asked as often as
 * the other three and none of them could answer it, because all three are
 * bounded by the repository. Reading one meant leaving the app for a file
 * manager, which is the trip this palette exists to remove.
 *
 * Last in the row, deliberately: the three that were here keep the order your
 * hands already know, so ⇥⇥ still lands where it used to.
 */
const TABS: { id: PaletteTab; label: string; placeholder: string }[] = [
  { id: "names", label: "Name", placeholder: "Find a file or folder by name…" },
  { id: "contents", label: "Contents", placeholder: "Search the code of this checkout…" },
  { id: "recent", label: "Recent", placeholder: "Filter what you have opened…" },
  { id: "machine", label: "Machine", placeholder: "Find a document anywhere in your home folder…" },
];

/** One row of the result list, whatever produced it. Kept as data rather than
 *  as JSX so the keyboard can index into it without asking the DOM. */
type Row =
  | { kind: "dir"; rel: string; abs?: string; items?: number | null; mtime?: number }
  | { kind: "file"; rel: string; hits?: GrepHit[]; abs?: string; bytes?: number | null; mtime?: number }
  /* A recent carries its own checkout. It is a memory of somewhere you have
     been, and the palette may be pointed somewhere else by the time you come
     back to it — opening it against the current chip would build a path in the
     wrong tree. */
  | { kind: "recent"; rel: string; at: number; root: string; gone?: boolean; abs?: string };

const edge = (pct: number) => `1px solid color-mix(in srgb, var(--text) ${pct}%, transparent)`;

/**
 * A path as the pieces it is made of, each one somewhere to jump to.
 *
 * Home is folded back into `~` because that is what it is called on screen
 * everywhere else in this app, and the first crumb of every path being
 * `/home/<somebody>` is four wasted characters and a name nobody needs to read.
 */
/** Bytes as a listing says them. Rounded hard: a file list is scanned. */
export function humanBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1000;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/** A path with home written as `~`, which is how the box shows one and how
 *  anybody types one. */
export function shortenHome(abs: string, home: string): string {
  if (home && (abs === home || abs.startsWith(`${home}/`))) return `~${abs.slice(home.length)}`;
  return abs;
}

export function crumbs(abs: string, home = ""): { label: string; path: string; last: boolean }[] {
  const parts = abs.replace(/\/+$/, "").split("/").filter(Boolean);
  const out: { label: string; path: string; last: boolean }[] = [];
  let at = "";
  for (const part of parts) {
    at += `/${part}`;
    out.push({ label: part, path: at, last: false });
    if (home && at === home) { out.length = 0; out.push({ label: "~", path: at, last: false }); }
  }
  if (out.length) out[out.length - 1]!.last = true;
  return out;
}

/*
 * A menu of this palette's lives in a Portal, and two things go wrong there.
 * Both were measured in the running app rather than reasoned about, and
 * neither shows up in a screenshot.
 *
 *   the keys    A React portal bubbles its events through the REACT tree, not
 *               the DOM one — so every key pressed inside an open menu ALSO
 *               reached the palette's own handler. Measured, with the checkout
 *               menu open: ⇥ switched the tab underneath and left the menu
 *               floating over a different question, ↑↓ walked a cursor nobody
 *               could see, and ⏎ opened the highlighted result — nvim came up
 *               on a file behind the menu that was supposed to have the keys.
 *   the focus   `autoFocus` does not take when the field mounts while another
 *               one holds focus, which is always the case here: the palette
 *               focuses its search box and keeps it. So "Filter 24 copies and
 *               928 branches…" never had the caret, and what you typed to
 *               narrow the list went into the search behind the menu, quietly
 *               rebuilding the results underneath.
 *
 * Hence: a menu takes its own keys, and its field takes its own focus.
 */

/** Every key pressed inside a menu belongs to the menu. Escape closes it —
 *  here rather than in each field, so it also works from a row. */
const menuKeys = (close: () => void) => (e: React.KeyboardEvent) => {
  e.stopPropagation();
  if (e.key === "Escape") { e.preventDefault(); close(); }
};

/** The caret goes in the menu's field, by hand. The delay is the palette's
 *  own: the panel around it may still be animating when this mounts. */
function useMenuField(open: boolean) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => ref.current?.focus(), 20);
    return () => clearTimeout(t);
  }, [open]);
  return ref;
}

/** Where the palette last searched, so opening it lands on the checkout you
 *  were working in rather than on whichever repository sorts first. */
const ROOT_KEY = "agentglass.files.paletteRoot";
/* Where the machine tab is pointed, and the folders it has been pointed at
   before. Kept apart from the checkout for the obvious reason — one is a
   repository and the other is a folder of documents — and remembered for the
   same reason the checkout is: you come back to the same few places. */
const PLACE_KEY = "agentglass.files.palettePlace";
const PLACE_RECENTS_KEY = "agentglass.files.placeRecents";
const PLACE_RECENTS_MAX = 8;
const readPlace = (): string => { try { return localStorage.getItem(PLACE_KEY) ?? ""; } catch { return ""; } };
const savePlace = (p: string) => { try { localStorage.setItem(PLACE_KEY, p); } catch { /* non-fatal */ } };
const readPlaceRecents = (): string[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(PLACE_RECENTS_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
};
/** Reopening a place MOVES it to the top rather than adding a second row —
 *  same rule as the recent files, and for the same reason. */
const rememberPlace = (p: string): string[] => {
  const next = [p, ...readPlaceRecents().filter((x) => x !== p)].slice(0, PLACE_RECENTS_MAX);
  try { localStorage.setItem(PLACE_RECENTS_KEY, JSON.stringify(next)); } catch { /* non-fatal */ }
  return next;
};
const REF_KEY = "agentglass.files.paletteRef";
const readRoot = (): string => { try { return localStorage.getItem(ROOT_KEY) ?? ""; } catch { return ""; } };
const saveRoot = (r: string) => { try { localStorage.setItem(ROOT_KEY, r); } catch { /* non-fatal */ } };
/*
 * The branch survives closing, like the copy does.
 *
 * It used to be cleared on every close, on the theory that a ref is a question
 * you asked once. Wrong in use: "I pick the branch, leave the finder, come back
 * and the branch is gone — it's odd". It is odd, because you are in the middle
 * of something, and closing a search you reopen with a chord is not finishing.
 * The chip is tinted while a branch is set, so this can never be silent.
 *
 * Keyed by checkout, since a branch name belongs to one repository and would
 * not resolve in another.
 */
const readRef = (root: string): string => {
  try {
    const raw = JSON.parse(localStorage.getItem(REF_KEY) || "{}") as Record<string, string>;
    return (root && typeof raw?.[root] === "string" ? raw[root] : "") ?? "";
  } catch { return ""; }
};
const saveRef = (root: string, ref: string) => {
  if (!root) return;
  try {
    const raw = JSON.parse(localStorage.getItem(REF_KEY) || "{}") as Record<string, string>;
    if (ref) raw[root] = ref; else delete raw[root];
    localStorage.setItem(REF_KEY, JSON.stringify(raw));
  } catch { /* non-fatal */ }
};

export function FilePalette({
  open, onClose, onOpenFile, onRevealDir, docOpen, onHeight,
}: {
  open: boolean;
  onClose: () => void;
  /** Raise the viewer on this file. The palette stays put — see the note above. */
  onOpenFile: (root: string, rel: string, branch: string, ref?: string) => void | Promise<void>;
  /** A folder is a place: go to Files and walk the tree there. */
  onRevealDir: (root: string, dir: string) => void;
  /**
   * A document is open underneath.
   *
   * Staying open on top of it was the design and covering it was not: the
   * palette landed on the first lines of the file it had just opened, which is
   * the part you opened it to read. So when there is something to share the
   * screen with it moves to the top edge and stops at a few results — enough to
   * step to the next one, not enough to be a second window.
   */
  docOpen?: boolean;
  /** Its rendered height, so whatever is underneath can start below it rather
   *  than be covered by it. 0 when it is closed. */
  onHeight?: (px: number) => void;
}) {
  const [tab, setTab] = useState<PaletteTab>("names");
  const [q, setQ] = useState("");
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [root, setRoot] = useState(readRoot);
  const [pickOpen, setPickOpen] = useState(false);
  /*
   * Which branch is being searched — "" meaning this working tree.
   *
   * The question it answers: "which migration numbers already exist on
   * origin/master, so I know mine does not collide". The working tree cannot
   * answer that, and the alternatives are all worse — fetch and check out loses
   * your place, a second worktree puts a whole checkout on disk for a listing,
   * and the browser is the trip this app exists to avoid. `ls-tree` reads the
   * object store this repository already has.
   *
   * NOT remembered between openings, unlike the checkout. A checkout is where
   * you work; a ref is a question you asked once, and reopening the palette
   * still pointed at origin/master would quietly answer about a branch you had
   * forgotten you selected.
   */
  const [ref, setRef] = useState(() => readRef(readRoot()));
  /* The machine tab's half of "where": a folder rather than a checkout, with
     no branch to it — a document on disk has one version, the one on disk. */
  const [place, setPlace] = useState(readPlace);
  const [places, setPlaces] = useState<DiskPlace[]>([]);
  /** Where home is, as the engine says — the browser has no `process.env`, and
   *  a path drawn as `/home/somebody/Documents` wastes four crumbs on a name
   *  nobody needs to read. */
  const [homeDir, setHomeDir] = useState("");
  const [placeRecents, setPlaceRecents] = useState<string[]>(readPlaceRecents);
  const [placeErr, setPlaceErr] = useState<string | null>(null);
  const [refs, setRefs] = useState<{ local: string[]; remote: string[]; head?: string }>({ local: [], remote: [] });
  const [refOpen, setRefOpen] = useState(false);
  /*
   * Browsing, which is the half the finder never had.
   *
   * A folder used to "narrow the search", which is a different gesture: it left
   * you typing when what you wanted was to look. `browsePath` non-null means
   * the list is a FOLDER rather than a result set — for every tab, so the four
   * of them stop behaving differently depending on which backend answers.
   */
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const [browsed, setBrowsed] = useState<BrowseReport | null>(null);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /*
   * Its height, measured rather than assumed.
   *
   * It changes with the number of results, the tab and the window, so a
   * constant here would be wrong the moment anybody typed. A ResizeObserver on
   * the element is the only source that cannot drift from what is drawn.
   */
  useEffect(() => {
    if (!onHeight) return;
    if (!open) { onHeight(0); return; }
    const el = panelRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => onHeight(el.getBoundingClientRect().height));
    ro.observe(el);
    onHeight(el.getBoundingClientRect().height);
    return () => { ro.disconnect(); onHeight(0); };
  }, [open, onHeight]);

  const repo = repos.find((r) => r.root === root) ?? null;
  const branch = repo?.branch ?? "";

  // Loaded every time it opens, not once on mount: a worktree cut since the app
  // started must be searchable without a reload, and this is the one moment we
  // know the user is about to care.
  useEffect(() => {
    if (!open) return;
    api.gitRepos().then(({ repos: r }) => {
      setRepos(r);
      setRoot((cur) => (cur && r.some((x) => x.root === cur) ? cur : (r[0]?.root ?? "")));
    }).catch(() => { /* the picker stays empty and says so */ });
  }, [open]);

  useEffect(() => { if (root) saveRoot(root); }, [root]);

  /* Asked the server rather than assumed: which folders exist is a fact about
     this machine, and the boundary the search is held to is one too — a menu
     built here out of guesses would offer rows that come back refused. */
  useEffect(() => {
    if (!open || tab !== "machine") return;
    api.diskPlaces().then((r) => {
      setPlaces(r.places);
      setHomeDir(r.home || "");
      setPlaceErr(r.ok ? null : (r.error ?? "this machine cannot be searched"));
      setPlace((cur) => cur || r.home || "");
    }).catch(() => setPlaceErr("could not ask this machine where it keeps things"));
  }, [open, tab]);

  useEffect(() => { if (place) savePlace(place); }, [place]);

  /*
   * A branch belongs to a checkout, so moving to another one loads THAT
   * checkout's last branch rather than carrying a name across that may not
   * exist there.
   */
  useEffect(() => { setRef(readRef(root)); }, [root]);
  useEffect(() => { saveRef(root, ref); }, [root, ref]);

  useEffect(() => {
    if (!open || !root) return;
    api.filesRefs(root)
      .then((r) => setRefs(r.ok ? { local: r.local, remote: r.remote, head: r.head } : { local: [], remote: [] }))
      .catch(() => setRefs({ local: [], remote: [] }));
  }, [open, root]);

  // Focus the field on open, and select what is in it: reopening with the last
  // query still there is useful (you are refining), but only if the first thing
  // you type replaces it rather than appending to it.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 20);
    return () => clearTimeout(t);
  }, [open]);

  const found = useSearch(
    () => (tab === "names" ? api.filesFind(root, q, ref || undefined) : null),
    [tab === "names", root, q.trim(), ref],
    !!root && tab === "names" && q.trim().length > 0,
  );
  const grepped = useSearch(
    () => (tab === "contents" ? api.filesGrep(root, q, ref || undefined) : null),
    [tab === "contents", root, q.trim(), ref],
    !!root && tab === "contents" && q.trim().length >= 2,
  );

  /* Its own call, not `filesFind` with a flag: that one is bounded by the open
     project and includes hidden files, and both are right for a checkout and
     wrong for a home folder. See server/src/disk.ts. */
  const onDisk = useSearch(
    () => (tab === "machine" ? api.diskFind(place, q) : null),
    [tab === "machine", place, q.trim()],
    !!place && tab === "machine" && q.trim().length >= 2,
  );

  /* The third argument is the server snapshot, and without it this component
     cannot be rendered outside a browser at all — which is why nothing ever
     executed it in a test. `recents()` reads localStorage behind a try/catch
     and answers an empty list where there is none, so it is a correct answer
     in both places rather than a stub for one. */
  const recent = useSyncExternalStore(subscribeRecents, recents, recents);

  /*
   * Which of them the working tree still has.
   *
   * A recent is a memory, not a promise: check that checkout out on another
   * branch and half the list points at files that are no longer on disk.
   * Clicking one opened an empty viewer with "no such file" in the corner,
   * which reads as the viewer being broken rather than as a fact about the
   * branch you are on. Asked once when the tab is shown, for the whole list.
   */
  const [gone, setGone] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!open || tab !== "recent" || !root) return;
    const mine = recent.filter((r) => r.root === root).map((r) => r.rel);
    if (!mine.length) { setGone(new Set()); return; }
    let live = true;
    api.filesExist(root, mine).then((r) => {
      if (!live || !r.ok) return;
      const here = new Set(r.here);
      setGone(new Set(mine.filter((rel) => !here.has(rel)).map((rel) => `${root}\u0000${rel}`)));
    }).catch(() => { /* leave them all as present rather than greying the list on a blip */ });
    return () => { live = false; };
  }, [open, tab, root, recent]);

  /* What was typed, read as a question: the needle, and the filters taken out
     of it. Applied on the client to whatever the tab produced, which is what
     lets `ext:png mod:hoy` work identically on all four. */
  const asked = useMemo(() => parseQuery(q), [q]);

  /*
   * Where the list is looking, which is a folder whenever nothing was typed.
   *
   * Picking `Documents` used to answer "Two letters at least" — a chip that
   * names a place and then refuses to show it. A file browser with a folder
   * selected and an empty box has an obvious thing to draw: that folder. So an
   * empty query IS the browse, and typing turns it back into a search.
   *
   * `browsePath` still wins when it is set, because walking into a folder is a
   * deliberate move and must survive the box being empty.
   */
  /* A typed path is somewhere to go, not something to find. `~/Downloads` used
     to answer "Nothing under ~/Documents is called ~/Downloads", which is the
     literal truth and completely useless. */
  const typedPath = useMemo(
    () => readPath(q, homeDir, browsePath || place || root || homeDir),
    [q, homeDir, browsePath, place, root],
  );

  const at = useMemo(() => {
    if (typedPath) return typedPath.dir;
    if (browsePath) return browsePath;
    if (asked.text.trim()) return null;
    if (tab === "machine") return place || null;
    if (tab === "names") return root || null;
    return null;
  }, [typedPath, browsePath, asked.text, tab, place, root]);

  // The folder under the cursor, fetched when it changes. Errors land in the
  // report itself — "no permission to read this folder" is an answer, and the
  // list says it rather than showing an empty folder that looks like a bug.
  useEffect(() => {
    if (!open || !at) { setBrowsed(null); return; }
    let live = true;
    void api.browse(at).then((r) => { if (live) setBrowsed(r); }).catch(() => { if (live) setBrowsed(null); });
    return () => { live = false; };
  }, [open, at]);

  const rows: Row[] = useMemo(() => {
    if (at) {
      const d = browsed;
      if (!d?.ok) return [];
      const base = at.replace(/\/+$/, "");
      return d.entries.map((e): Row => e.kind === "dir"
        ? { kind: "dir", rel: e.name, abs: `${base}/${e.name}`, items: e.items, mtime: e.mtime }
        : { kind: "file", rel: e.name, abs: `${base}/${e.name}`, bytes: e.bytes, mtime: e.mtime });
    }
    if (tab === "machine") {
      const d = onDisk.data;
      if (!d?.ok) return [];
      // Folders first here too, and they matter more on this tab: naming a
      // folder is how you say "search in there", which is what picking one does.
      return [
        ...(d.dirs ?? []).map((rel): Row => ({ kind: "dir", rel })),
        ...d.files.map((rel): Row => ({ kind: "file", rel })),
      ];
    }
    if (tab === "names") {
      const d = found.data;
      if (!d?.ok) return [];
      // Folders first — typing `guest-checkout-v2` names a place, and forty
      // files from inside it are forty ways of not saying so.
      return [
        ...(d.dirs ?? []).map((rel): Row => ({ kind: "dir", rel })),
        ...d.files.map((rel): Row => ({ kind: "file", rel })),
      ];
    }
    if (tab === "contents") {
      const d = grepped.data;
      if (!d?.ok) return [];
      // Grouped by file: ten matches in one file is one place to go, not ten.
      const out: Row[] = [];
      for (const h of d.hits) {
        const last = out[out.length - 1];
        if (last && last.kind === "file" && last.rel === h.rel) last.hits!.push(h);
        else out.push({ kind: "file", rel: h.rel, hits: [h] });
      }
      return out;
    }
    const needle = q.trim().toLowerCase();
    return recent
      .filter((r) => (root ? r.root === root : true))
      .filter((r) => !needle || r.rel.toLowerCase().includes(needle))
      .map((r): Row => ({ kind: "recent", rel: r.rel, at: r.at, root: r.root, gone: gone.has(`${r.root}\u0000${r.rel}`), abs: `${r.root}/${r.rel}` }));
  }, [tab, at, browsed, found.data, grepped.data, onDisk.data, recent, q, root, gone]);

  /** Where a row IS, whichever tab produced it — the one thing every backend
   *  knew and none of them handed over, and what the preview pane needs. */
  const absOf = useCallback((row: Row): string | null => {
    if (row.abs) return row.abs;
    if (tab === "machine") return place ? `${place.replace(/\/+$/, "")}/${row.rel}` : null;
    if (row.kind === "recent") return `${row.root}/${row.rel}`;
    return root ? `${root.replace(/\/+$/, "")}/${row.rel}` : null;
  }, [tab, place, root]);

  /*
   * The filters, and the fuzzy match, over whatever the tab produced.
   *
   * On the client on purpose: `ext:png mod:hoy size:>1M` then works the same on
   * a repository search, a machine search, a folder listing and the recents,
   * without four backends learning the same syntax — and a row that cannot
   * answer a filter is kept rather than silently dropped (see finderQuery.ts).
   *
   * The needle is NOT re-applied to the tabs whose server already matched it:
   * doing that would throw away ripgrep's own matching. It is applied when
   * browsing, where nothing has filtered anything yet, and that is what makes
   * `/` inside a folder work.
   */
  const shown: Row[] = useMemo(() => {
    const { text, exact, filters } = asked;
    const filtered = rows.filter((r) => {
      const abs = absOf(r) ?? r.rel;
      return passesFilters({ path: abs, kind: r.kind === "recent" ? "file" : r.kind, bytes: r.kind === "file" ? r.bytes ?? null : null, mtime: r.kind === "recent" ? r.at : r.mtime ?? null }, filters);
    });
    const needle = typedPath ? typedPath.tail : text;
    if (!at || !needle) return filtered;
    return filtered
      .map((r) => ({ r, score: scoreMatch(r.rel, needle, exact) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.r);
  }, [rows, asked, at, typedPath, absOf]);

  // The cursor is an index into a list that changes under it on every keystroke.
  // Reset on anything that rebuilds the list, or ↑↓ starts from wherever the
  // previous, longer list had left it.
  useEffect(() => { setCursor(0); }, [tab, q, root, place, browsePath]);
  useEffect(() => { setCursor((c) => (c >= shown.length ? 0 : c)); }, [shown.length]);

  // Keep the cursor on screen. `block: "nearest"` rather than "center" so
  // holding ↓ walks the list instead of jumping it around under the eye.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor, shown.length]);

  /**
   * Three rows, and the rest on the scrollbar — only with a document open.
   *
   * Alone, this list is the thing you are looking at and it may have the screen.
   * Over a document it is a strip you glance at while reading something else,
   * and thirteen rows of it took most of the window to say what three rows say:
   * the top of the answer, and that there is more.
   *
   * Measured off a row rather than written down as a number, because the row's
   * height is its font's, and this app's reading size is a preference. It keeps
   * the last measurement it managed to take: while the list is showing a note —
   * "Searching…", "Type to search" — there is no row to measure, and falling
   * back to zero would uncap the list for exactly as long as it takes to type.
   */
  const [rowH, setRowH] = useState(0);
  useEffect(() => {
    if (!docOpen) return;
    const h = listRef.current?.querySelector<HTMLElement>('[data-row="0"]')?.offsetHeight;
    if (h) setRowH(h);
  }, [docOpen, rows, tab]);
  /** The list's own vertical padding (py-2), so three rows are three rows and
   *  not three rows minus the padding they sit in. It matches the row's own
   *  py-2: any less and the first row sits tighter to the edge than to its
   *  neighbour, which reads as the list being cut off. */
  const LIST_PAD = 16;
  const listCap = docOpen && rowH && rows.length > 3 ? rowH * 3 + LIST_PAD : undefined;

  /**
   * When the list shrinks to three rows, the row you chose has to be one of them.
   *
   * Opening a file caps this list, and the scroll position it had in the tall
   * box stays exactly where it was — so the row that produced the document you
   * are now reading ends up below the window, and the three rows on screen are
   * whichever ones happened to be at that offset. It reads as having lost your
   * place in a list you never scrolled.
   *
   * Put at the TOP rather than merely brought into view, because the two rows
   * worth seeing beside your choice are the ones after it.
   *
   * By hand rather than with `scrollIntoView`: that scrolls every scrollable
   * ancestor too, and this list lives inside a fixed panel over a document.
   * Measured from rectangles rather than `offsetTop`, which is relative to
   * whichever ancestor happens to be positioned.
   */
  useEffect(() => {
    const list = listRef.current;
    if (!listCap || !list) return;
    const row = list.querySelector<HTMLElement>(`[data-row="${cursor}"]`);
    if (!row) return;
    list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - LIST_PAD / 2;
    // `cursor` deliberately absent: this is for the moment the box changes size,
    // and re-running it per keystroke would fight the `block: "nearest"` walk
    // that lets ↓ move one row at a time instead of jumping the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listCap, docOpen]);

  /*
   * The formats that must never reach a text editor.
   *
   * Opening a `.png` from here sent it to the floating nvim modal — a modal
   * nobody asked for, showing a binary nobody can read. The preview pane draws
   * these; the editor is still one keystroke away for whoever really wants it
   * (⌘⏎), because refusing outright is its own kind of wrong.
   */
  const IMAGEY = /\.(png|jpe?g|jfif|gif|webp|avif|bmp|ico|cur|svg|apng|tiff?|heic|heif|psd|xcf|jp2|jxl|exr|hdr|tga|pcx|ppm|pgm|pbm|cr2|cr3|nef|arw|dng|orf|raf|rw2|sr2|pdf|mp4|webm|mkv|mov|m4v|mp3|wav|ogg|flac|m4a|opus)$/i;

  const openRow = useCallback((row: Row | undefined, secondary = false) => {
    if (!row) return;

    /* Browsing: a folder is somewhere to go, and a file is looked at where it
       is. This is the same on every tab, which is the point. */
    if (at) {
      const abs = row.abs ?? `${at.replace(/\/+$/, "")}/${row.rel}`;
      if (row.kind === "dir") {
        // The box follows you when you were typing a path, the way a shell's
        // line does — so the next `../` or `foo/` is typed onto what is there.
        setBrowsePath(abs);
        setQ(typedPath ? `${shortenHome(abs, homeDir)}/` : "");
        inputRef.current?.focus();
        return;
      }
      // An image, a video, a PDF: the pane beside the list is already showing
      // it. Pressing ⏎ on one should not throw it at an editor.
      if (IMAGEY.test(row.rel) && !secondary) return;
      const cut = abs.lastIndexOf("/");
      onOpenFile(abs.slice(0, cut), abs.slice(cut + 1), "");
      return;
    }
    /*
     * On the machine tab a folder is not somewhere to GO.
     *
     * Everywhere else a folder opens the Files view at that path, and the Files
     * view is bounded by the open project — pointing it at ~/Documents would
     * come back refused, which is a dead row wearing a name. So here a folder
     * narrows the search to itself, which is what picking one meant anyway:
     * "in there".
     */
    if (tab === "machine") {
      if (!place) return;
      if (row.kind === "dir") {
        /* It used to narrow the search to this folder, which left you typing.
           Now it OPENS it — the folder's own contents, with sizes and dates —
           and the place is still remembered, so the search box is still
           pointed here when you go back to searching. */
        const abs = `${place.replace(/\/+$/, "")}/${row.rel}`;
        setPlaceRecents(rememberPlace(abs));
        setPlace(abs);
        setBrowsePath(abs);
        setQ(""); inputRef.current?.focus();
        return;
      }
      // No branch and no ref: a document on disk has exactly one version.
      if (row.kind === "file") {
        if (IMAGEY.test(row.rel) && !secondary) return;   // the pane is showing it
        onOpenFile(place, row.rel, "");
      }
      return;
    }
    if (!root) return;
    if (row.kind === "dir") {
      // ⌘⏎ still hands it to the Files view, which is a different thing to
      // want: that one is a place to work, this is a look inside.
      if (secondary) { onRevealDir(root, row.rel); onClose(); return; }
      setBrowsePath(`${root.replace(/\/+$/, "")}/${row.rel}`);
      setQ(""); inputRef.current?.focus();
      return;
    }
    // A recent opens against the checkout it was opened FROM, and a recent that
    // is no longer on disk is dropped instead of opened into an empty viewer.
    if (row.kind === "recent") {
      if (row.gone) { forget(row.root, row.rel); return; }
      remember(row.root, row.rel);
      onOpenFile(row.root, row.rel, repos.find((r) => r.root === row.root)?.branch ?? "");
      return;
    }
    // A file found on a branch is opened AS THAT BRANCH HAS IT. Opening the
    // working tree's copy of the same path would be a different file wearing
    // the right name — or nothing at all, for one that only exists upstream.
    if (IMAGEY.test(row.rel) && !secondary && !ref) return;   // the pane is showing it
    if (!ref) remember(root, row.rel);
    onOpenFile(root, row.rel, branch, ref || undefined);
  }, [tab, at, place, root, branch, ref, repos, onOpenFile, onRevealDir, onClose]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault(); setCursor((c) => (shown.length ? (c + 1) % shown.length : 0)); return;
    }
    if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault(); setCursor((c) => (shown.length ? (c - 1 + shown.length) % shown.length : 0)); return;
    }
    /* ← goes up a folder and → goes into one: the two keys a file browser is
       driven with. Only while browsing, and only with the box empty, so they
       stay ordinary arrow keys inside a query somebody is editing. */
    if (at && (e.key === "ArrowLeft" || (e.key === "Backspace" && !q)) && !q) {
      e.preventDefault();
      if (browsed?.parent) setBrowsePath(browsed.parent);
      else setBrowsePath(null);
      return;
    }
    if (at && e.key === "ArrowRight" && !q) {
      const row = shown[cursor];
      if (row?.kind === "dir") { e.preventDefault(); openRow(row); return; }
    }
    if (e.key === "Tab" && typedPath) {
      /* In a path, Tab is completion — the thing every shell does with it, and
         what makes typing a path bearable. It only steals the key while the box
         holds a path; anywhere else it still switches tabs. */
      e.preventDefault();
      const names = rows.map((r) => r.rel);
      const done = completion(typedPath.tail, names);
      if (done) {
        const isDir = rows.find((r) => r.rel === done)?.kind === "dir";
        setQ(`${shortenHome(typedPath.dir, homeDir)}/${done}${isDir ? "/" : ""}`);
      }
      return;
    }
    if (e.key === "Tab") {
      // Tab cycles the three questions. It is free here — there is exactly one
      // field and one list, so there is nothing else for it to move between.
      e.preventDefault();
      const i = TABS.findIndex((t) => t.id === tab);
      setTab(TABS[(i + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length]!.id);
      return;
    }
    // ⌘⏎ / ctrl+⏎ is the second thing a row can do: the editor for a picture,
    // the Files view for a folder. One key, one meaning — "not the obvious one".
    if (e.key === "Enter") { e.preventDefault(); openRow(shown[cursor], e.metaKey || e.ctrlKey); return; }
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      /* One step back before the way out: leaving a folder you walked into is
         what esc means there, and closing the whole finder instead is how you
         lose the place you were looking at. */
      if (q) { setQ(""); return; }
      if (at) { setBrowsePath(browsed?.parent ?? null); return; }
      // Stops here rather than reaching App's global handler, which would close
      // the viewer underneath in the same keystroke. One Escape, one layer.
      onClose(); return;
    }
  };

  /* What the pane is looking at: the row under the cursor, wherever it came
     from. Null while nothing is selected, which the pane draws as such. */
  const preview = useMemo(() => {
    const row = shown[cursor];
    return row ? absOf(row) : null;
  }, [shown, cursor, absOf]);

  /*
   * Room for the pane, or not.
   *
   * A 300px column is worth having on a desk and is most of a phone. Measured
   * against the window rather than a media query so it also does the right
   * thing in a narrow desktop window, which is where somebody actually notices.
   */
  const [wide, setWide] = useState(() => (typeof window === "undefined" ? true : window.innerWidth >= 900));
  useEffect(() => {
    if (typeof window === "undefined") return;
    const on = () => setWide(window.innerWidth >= 900);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const showPreview = wide && open;

  const active = TABS.find((t) => t.id === tab)!;
  const status = tab === "names" ? found : tab === "contents" ? grepped : tab === "machine" ? onDisk : null;

  return (
    <AnimatePresence>
      {open && (
        // Above the viewer it raises — see layers.ts for why that number is
        // written down rather than chosen here.
        <Portal z={LAYER.palette}>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="fixed inset-0"
            /*
             * With a document open this is neither seen nor felt.
             *
             * Not dimmed, because the viewer draws its own backdrop and two
             * stacked made the file harder to read through the thing that had
             * just opened it. And not clickable, which is the bug that was
             * reported: an invisible full-screen catcher sat over the document,
             * so clicking anywhere in the markdown you had just opened closed
             * the search that opened it. The two are peers on screen; a click
             * on one is not a dismissal of the other.
             *
             * Click-to-dismiss stays for the case it is unambiguous in — no
             * document, nothing underneath but the app — and the × in the tab
             * row is the mouse's way out of the other case.
             */
            style={{
              zIndex: 1,
              background: docOpen ? "transparent" : "color-mix(in srgb, var(--bg) 55%, transparent)",
              pointerEvents: docOpen ? "none" : "auto",
            }}
            onClick={onClose} />
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.985 }}
            transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
            /* Centred by the layout, NOT by a transform.
             *
             * motion animates this element's `transform` (y and scale), so a
             * translateX(-50%) written in `style` is overwritten the moment the
             * open animation runs — measured: the palette sat with its left edge
             * on the centre line, a third of it off toward the right. A flex
             * parent has no such fight. */
            ref={panelRef}
            className={`fixed flex flex-col overflow-hidden rounded-xl${docOpen ? "" : " inset-x-0 mx-auto"}`}
            style={{
              zIndex: 2,
              // Up against the top edge once there is a document to leave room
              // for, and short enough that it is a way to the next result
              // rather than a second window over the first.
              top: docOpen ? 10 : "8vh",
              /*
               * Squared up with the viewer's own margins when one is open, so
               * the two read as one column of two panes rather than a small
               * window floating over a big one. 8vw is PeekFile's inset; a
               * narrower palette above a wider document looked like an
               * accident, because it was one.
               */
              ...(docOpen ? { left: "8vw", right: "8vw" } : { width: showPreview ? "min(1040px, 96vw)" : "min(720px, 92vw)" }),
              maxHeight: docOpen ? "38vh" : "72vh",
              background: "var(--bg2)",
              border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)",
              boxShadow: "0 30px 70px -20px #000",
            }}
            onKeyDown={onKey}
            role="dialog" aria-modal="true" aria-label="Find a file">

            {/* the three questions */}
            <div className="flex items-center gap-1 px-3 pt-2.5 shrink-0"
              style={{ background: "color-mix(in srgb, var(--text) 4%, var(--bg2))" }}>
              {TABS.map((t) => (
                <button key={t.id} onClick={() => { setTab(t.id); inputRef.current?.focus(); }}
                  className="text-[11px] px-3 py-1.5 rounded-t-md"
                  style={t.id === tab
                    ? { background: "var(--bg2)", border: edge(18), borderBottom: "none", color: "var(--primary)" }
                    : { border: "1px solid transparent", color: "var(--text3)" }}>
                  {t.label}
                </button>
              ))}
              <span className="ml-auto text-[10.5px] px-2 py-1 rounded" style={{ color: "var(--text4)" }}>⇥ switches</span>
              {/* The mouse's way out. Only with a document open, where clicking
                  away no longer closes this — without one the scrim is still
                  the obvious target and a second control would be clutter. */}
              {docOpen && (
                <button onClick={onClose} title="Close the search (esc)"
                  className="text-[13px] leading-none px-1.5 py-1 rounded"
                  style={{ color: "var(--text3)" }}>×</button>
              )}
            </div>

            {/* the field, and which place it is asking
             *
             * Two boxes, and the outer one is the whole reason for it. A field
             * that declares itself bare hands its focus ring to whatever wraps
             * it (index.css), and what wrapped it was a full-bleed row — so
             * focusing drew a violet rectangle a pixel inside the panel's own
             * violet border. Two lines that close, which reads as a rendering
             * fault rather than as focus. The frame is inset now and the ring
             * lands on a box with room around it.
             *
             * `rounded-md` and not `rounded-lg`: that same rule sets a 6px
             * radius on whatever it rings, and a box that rounds itself
             * differently would square up by 2px the moment you typed. */}
            <div className="px-2.5 py-2.5 shrink-0" style={{ borderTop: edge(18), borderBottom: edge(18) }}>
            <div className="flex items-center gap-2.5 px-2.5 py-2 rounded-md"
              style={{ background: "color-mix(in srgb, var(--bg3) 40%, transparent)", border: edge(14) }}>
              <span style={{ color: "var(--primary)" }}>⌕</span>
              <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
                spellCheck={false} autoComplete="off" placeholder={active.placeholder}
                className="flex-1 min-w-0 bg-transparent outline-none text-[12.5px]" style={{ color: "var(--text)" }} />
              {/* One control, not two.
                  Two chips meant two decisions for one question, and the
                  question does not divide that way: reading a branch is the
                  same answer from any checkout of the repository, because they
                  share the object store. What actually varies is a single
                  thing — what am I searching — so it is asked once. */}
              {tab === "machine" && (
                <PlaceChip
                  place={place} places={places} recents={placeRecents} error={placeErr}
                  openState={[pickOpen, setPickOpen]}
                  onPick={(p) => {
                    setPlaceRecents(rememberPlace(p));
                    setPlace(p); setPickOpen(false); inputRef.current?.focus();
                  }} />
              )}
              {tab !== "recent" && tab !== "machine" && (
                <ScopeChip
                  repo={repo} repos={repos} ref_={ref} refs={refs}
                  openState={[pickOpen, setPickOpen]}
                  onPickRoot={(r) => {
                    // Choosing a copy means "what is on that disk", so it also
                    // answers the version — which is what made the two-control
                    // version feel like it was asking twice.
                    setRoot(r); setRef(""); saveRef(r, "");
                    setPickOpen(false); inputRef.current?.focus();
                  }}
                  onPickRef={(r) => { setRef(r); setPickOpen(false); inputRef.current?.focus(); }} />
              )}
              {tab === "recent" && (
                <RepoChip repo={repo} repos={repos} openState={[pickOpen, setPickOpen]}
                  onPick={(r) => { setRoot(r); setPickOpen(false); inputRef.current?.focus(); }} />
              )}
            </div>
            </div>

            {/* Where you are, when you are somewhere rather than searching. Each
                crumb is a jump, which is the whole reason a path is drawn as
                pieces instead of as a string. */}
            {at && (
              <div className="flex items-center gap-1 px-3 py-1.5 shrink-0 flex-wrap text-[10.5px]"
                style={{ borderTop: edge(12), color: "var(--text4)" }}>
                {browsePath && (
                  <>
                    <button onClick={() => setBrowsePath(null)} title="Volver al sitio elegido"
                      className="px-1.5 py-0.5 rounded min-h-[20px]" style={{ color: "var(--primary-hover)" }}>↺ volver</button>
                    <span>·</span>
                  </>
                )}
                {crumbs(at, homeDir).map((c) => (
                  <button key={c.path} onClick={() => setBrowsePath(c.path)}
                    className="px-1 py-0.5 rounded min-h-[20px] truncate max-w-[180px]"
                    style={{ color: c.last ? "var(--text)" : "var(--text3)" }}>{c.label}</button>
                ))}
                {browsed?.hiddenSkipped ? (
                  /* Said, not hidden: a folder that shows less than it holds
                     without saying so is a browser you stop trusting. */
                  <span className="ml-auto" title="Hidden files and folders are out of the finder's reach">
                    {browsed.hiddenSkipped} hidden {browsed.hiddenSkipped === 1 ? "item" : "items"} left out
                  </span>
                ) : null}
              </div>
            )}

            {/* the answers, and what the one under the cursor is */}
            <div className="flex-1 min-h-0 flex">
              <div ref={listRef} className="flex-1 min-w-0 agx-scroll overflow-y-auto overflow-x-hidden py-2"
                /* A cap, not a height: three results stay three rows tall rather
                   than being stretched to a box sized for more. */
                style={listCap ? { maxHeight: listCap } : undefined}>
                <Answers tab={tab} q={q} root={root} place={place} placeErr={placeErr} rows={shown} cursor={cursor}
                  status={status} onHover={setCursor} onPick={openRow} browsing={!!at}
                  browseError={browsed && !browsed.ok ? browsed.error ?? null : null} />
              </div>
              {/* The pane that answers "is this the one I mean" without opening
                  anything. Hidden on a narrow window, where the list is already
                  the whole width. */}
              {showPreview && (
                <div className="shrink-0 border-l flex flex-col" style={{ width: 300, borderColor: "color-mix(in srgb, var(--border) 40%, transparent)" }}>
                  <Preview path={preview} compact={docOpen}
                    onOpen={(_p, facts) => openRow(shown[cursor], facts.kind !== "dir")}
                    onCopyPath={(p) => { void navigator.clipboard?.writeText(p); }} />
                </div>
              )}
            </div>

            <div className="flex items-center gap-4 px-3 py-2 shrink-0 text-[10.5px]"
              style={{ borderTop: edge(18), color: "var(--text4)" }}>
              <span>↑↓ move</span>
              <span>⏎ open</span>
              {/* What Enter does to a folder is not the same question on both
                  tabs, and saying the wrong one is worse than saying nothing. */}
              <span>{at ? "← up · → into · ⇥ completes a path" : "⏎ enters a folder · ⌘⏎ opens it in Files"}</span>
              {/* The gesture nobody discovers by looking: the box takes a path. */}
              <span className="hidden sm:inline">type ~/ or ../ to move around</span>
              <span className="ml-auto">esc closes this · {chordLabel(appChordFor("files.palette"))} reopens</span>
            </div>
          </motion.div>
        </Portal>
      )}
    </AnimatePresence>
  );
}

/* --------------------------------------------------------------- the list */

function Answers({ tab, q, root, place, placeErr, rows, cursor, status, onHover, onPick, browsing, browseError }: {
  tab: PaletteTab; q: string; root: string; place: string; placeErr: string | null; rows: Row[]; cursor: number;
  status: { pending: boolean; error: string | null; data: { ok: boolean; error?: string; via?: string; truncated?: boolean } | null } | null;
  onHover: (i: number) => void; onPick: (row: Row, secondary?: boolean) => void;
  /** Looking at a folder rather than at results: the empty state, the floors
   *  and the "no checkout" note are all different questions there. */
  browsing?: boolean;
  browseError?: string | null;
}) {
  if (browsing) {
    if (browseError) return <Note tint="var(--warning)">{browseError}</Note>;
    if (!rows.length) {
      return <Note>{q.trim() ? `Nothing in here matches “${q.trim()}”.` : "This folder is empty."}</Note>;
    }
    return (
      <>
        {rows.map((row, i) => (
          <RowView key={`${row.kind}:${row.rel}:${i}`} row={row} i={i} on={i === cursor}
            onHover={onHover} onPick={onPick} />
        ))}
      </>
    );
  }
  /* The machine tab has no checkout to be missing, and its floor is its own:
     one letter matches most of a home folder, which is not a search result. */
  if (tab === "machine") {
    if (placeErr) return <Note tint="var(--error)">{placeErr}</Note>;
    if (!place) return <Note>Nowhere to search yet — pick a folder with the chip on the right.</Note>;
    if (q.trim().length < 2) return <Note>Two letters at least — one matches most of a home folder.</Note>;
  } else if (!root) return <Note>No checkout to search. Open a repository first.</Note>;
  if (tab === "contents" && q.trim().length < 2) return <Note>Two letters at least — one matches every file there is.</Note>;
  if (tab !== "recent" && !q.trim()) return <Note>Type to search {tab === "names" ? "for a file or a folder" : "the code"}.</Note>;
  if (status?.pending) return <Note>Searching…</Note>;
  if (status && !status.data) return <Note tint="var(--error)">{status.error ?? "the search failed"}</Note>;
  if (status?.data?.error) return <Note tint="var(--error)">{status.data.error}</Note>;

  if (!rows.length) {
    return <Note>{
      tab === "recent"
        ? (q.trim() ? `Nothing you opened matches “${q.trim()}”.` : "Nothing opened here yet — the files you read will collect in this tab.")
        : tab === "machine" ? `Nothing under ${shortPath(place)} is called “${q.trim()}”. Hidden folders are not searched.`
          : tab === "names" ? `Nothing here is called “${q.trim()}”.`
          : `No code in this checkout says “${q.trim()}”.`
    }</Note>;
  }

  return (
    <>
      {status?.data?.via && (
        <div className="px-3 py-1.5 text-[10.5px]" style={{ color: "var(--text4)" }}>
          {rows.length} result{rows.length === 1 ? "" : "s"} · via {status.data.via}{status.data.truncated ? " · truncated" : ""}
        </div>
      )}
      {rows.map((row, i) => (
        <RowView key={`${row.kind}:${row.rel}:${i}`} row={row} i={i} on={i === cursor}
          onHover={onHover} onPick={onPick} />
      ))}
    </>
  );
}

function RowView({ row, i, on, onHover, onPick }: {
  row: Row; i: number; on: boolean; onHover: (i: number) => void; onPick: (row: Row) => void;
}) {
  const cut = row.rel.lastIndexOf("/");
  const name = row.rel.slice(cut + 1);
  const icon = iconFor(name, row.kind === "dir");
  return (
    <button data-row={i} onMouseEnter={() => onHover(i)} onClick={() => onPick(row)}
      className="w-full text-left px-3 py-2" title={row.rel}
      style={{
        ...(on ? { background: "color-mix(in srgb, var(--primary) 16%, transparent)" } : null),
        ...(row.kind === "recent" && row.gone ? { opacity: 0.55 } : null),
      }}>
      <div className="flex items-baseline gap-1.5 text-[12px]">
        <span className="shrink-0" style={{ color: icon.tint }}>{icon.glyph}</span>
        {cut >= 0 && <span className="truncate" style={{ color: "var(--text4)" }}>{row.rel.slice(0, cut + 1)}</span>}
        <span className="shrink-0" style={{ color: icon.tint, fontWeight: 500 }}>{name}{row.kind === "dir" ? "/" : ""}</span>
        {/* Size and date, when the row knows them — a listing does, a search
            result does not, and inventing a dash for the ones that do not is
            noise in a column people scan. */}
        {(row.kind === "file" && row.bytes != null) || (row.kind === "dir" && row.items != null) ? (
          <span className="ml-auto shrink-0 flex items-baseline gap-3 text-[9.5px] tabular-nums" style={{ color: "var(--text4)" }}>
            <span>{row.kind === "dir" ? `${row.items} elemento${row.items === 1 ? "" : "s"}` : humanBytes(row.bytes!)}</span>
            {row.mtime ? <span>{ago(row.mtime)}</span> : null}
          </span>
        ) : row.kind === "dir" ? (
          <span className="ml-auto shrink-0 text-[9px] px-1.5 rounded"
            style={{ color: "var(--info)", border: "1px solid color-mix(in srgb, var(--info) 30%, transparent)" }}>folder</span>
        ) : null}
        {row.kind === "recent" && (
          <span className="ml-auto shrink-0 flex items-baseline gap-2">
            {/* Named, not merely greyed: "not on this branch" is the fact, and
                it is the difference between a broken app and a checkout that
                moved under you. Pressing it forgets the entry. */}
            {row.gone && (
              <span className="text-[9px] px-1.5 rounded" style={{ color: "var(--warning)", border: "1px solid color-mix(in srgb, var(--warning) 32%, transparent)" }}>
                not here now · ⏎ forgets
              </span>
            )}
            <span className="text-[9.5px] tabular-nums" style={{ color: "var(--text4)" }}>{ago(row.at)}</span>
          </span>
        )}
      </div>
      {row.kind === "file" && row.hits && (
        <div className="mt-1 flex flex-col gap-px">
          {row.hits.slice(0, 4).map((h, n) => (
            <div key={n} className="flex items-baseline gap-2 text-[11px]">
              <span className="shrink-0 tabular-nums w-[42px] text-right" style={{ color: "var(--info)", opacity: 0.75 }}>{h.line}</span>
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
          {row.hits.length > 4 && (
            <div className="text-[9.5px] pl-[50px]" style={{ color: "var(--text4)" }}>
              +{row.hits.length - 4} more in this file
            </div>
          )}
        </div>
      )}
    </button>
  );
}

/* ------------------------------------------------------------ the checkout */

/**
 * Which checkout the search is asking.
 *
 * The list is in a PORTAL, and that is the fix rather than the design: the
 * palette clips its children so its rounded corners hold, so a dropdown
 * rendered inside it was cut off at the panel's edge — rows running off the
 * left with their names gone, which is what "it stays contained inside the
 * finder" looks like from the outside. Drawn against the viewport now, at its
 * own layer above the palette.
 *
 * Two lines per row, not two things fighting for one. A worktree's branch name
 * and its path are both long, and side by side each truncated the other into
 * uselessness — the branch is what you pick by, the path is how you tell two
 * checkouts of the same branch apart, and you need to read both.
 */
function RepoChip({ repo, repos, openState, onPick }: {
  repo: GitRepoRef | null; repos: GitRepoRef[];
  openState: [boolean, (v: boolean) => void]; onPick: (root: string) => void;
}) {
  const [open, setOpen] = openState;
  const btn = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState<{ top: number; right: number } | null>(null);
  const [filter, setFilter] = useState("");
  const field = useMenuField(open);

  // Measured when it opens, and again if the window moves under it. A position
  // computed once at mount would be wrong the moment anything resized.
  useEffect(() => {
    if (!open) { setFilter(""); return; }
    const place = () => {
      const r = btn.current?.getBoundingClientRect();
      if (r) setBox({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  const shown = repos.filter((r) => {
    const q = filter.trim().toLowerCase();
    return !q || `${r.name} ${r.branch} ${r.root}`.toLowerCase().includes(q);
  });

  return (
    <>
      <button ref={btn} onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[10.5px] px-2 py-1 rounded-md max-w-[220px] shrink-0"
        style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: edge(20), color: "var(--text2)" }}
        title={repo ? `${repo.name}\n${repo.branch}\n${repo.root}` : "Pick a checkout"}>
        <span className="truncate min-w-0">{repo ? (repo.worktreeOf ? repo.branch : repo.name) : "Pick a checkout"}</span>
        <span className="shrink-0" style={{ color: "var(--text3)" }}>▾</span>
      </button>
      {open && box && (
        <Portal z={LAYER.menu}>
          {/* A backdrop rather than a document-level listener: one element that
              closes on a click anywhere else, and cannot be outrun by a click
              that lands on something which stops propagation. */}
          <div className="fixed inset-0" onClick={() => setOpen(false)} />
          <div className="fixed rounded-lg text-[11px] shadow-2xl flex flex-col overflow-hidden"
            style={{
              top: box.top, right: box.right,
              // Wide enough for a branch name, and never wider than the window.
              width: "min(520px, calc(100vw - 16px))", maxHeight: "min(420px, 60vh)",
              background: "var(--bg2)", border: edge(30),
            }}
            onKeyDown={menuKeys(() => setOpen(false))}>
            {/* Said once, at the top: the pair of chips is only unambiguous
                if each menu also says which question it answers. */}
            {/* Label and explanation are two different kinds of text, so they
                get 6px: touching, the caption read as the first line of the
                sentence under it. */}
            <div className="px-3 pt-2 pb-1.5 shrink-0 flex flex-col gap-1" style={{ borderBottom: edge(12) }}>
              <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text2)" }}>Where</div>
              <div className="text-[10px]" style={{ color: "var(--text4)" }}>a copy on disk — each has its own branch and its own uncommitted work</div>
            </div>
            {repos.length > 6 && (
              <input ref={field} value={filter} onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter checkouts…" spellCheck={false}
                className="m-1.5 px-2.5 py-1.5 rounded-md text-[11px] outline-none shrink-0"
                style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: edge(20), color: "var(--text)" }} />
            )}
            {/* Padded on both ends: bottom-only put the first row against the
                filter field, where it read as part of it. */}
            <div className="agx-scroll overflow-y-auto overflow-x-hidden py-1.5" style={{ minHeight: 0 }}>
              {repos.length === 0 && <div className="px-3 py-2" style={{ color: "var(--text3)" }}>No checkouts found.</div>}
              {repos.length > 0 && shown.length === 0 && (
                <div className="px-3 py-2" style={{ color: "var(--text3)" }}>No checkout matches “{filter.trim()}”.</div>
              )}
              {shown.map((r) => (
                <button key={r.root} onClick={() => onPick(r.root)}
                  className="w-full text-left px-3 py-1.5 flex flex-col gap-1"
                  style={{ background: r.root === repo?.root ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent" }}>
                  {/*
                    * The FOLDER leads, not the branch.
                    *
                    * This picks a place on disk, and leading with the branch
                    * made it look like a second branch picker sitting next to
                    * the real one. The branch is still here — it is how you
                    * recognise which worktree is which — but as what that place
                    * currently holds, which is what it is.
                    */}
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="truncate" style={{ color: "var(--text)" }}>{shortPath(r.root)}</span>
                    {r.worktreeOf && (
                      <span className="shrink-0 text-[8.5px] px-1 rounded"
                        style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 32%, transparent)" }}>WT</span>
                    )}
                  </span>
                  <span className="text-[9.5px] truncate" style={{ color: "var(--text4)" }}>on {r.branch}</span>
                </button>
              ))}
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}

/* ------------------------------------------------------------- the place */

/**
 * Which folder of the machine the search is asking.
 *
 * The checkout chip's sibling, and deliberately not the same control: a
 * checkout has a branch and a repository behind it, and this has neither — a
 * document on disk is one folder and one version. What it needs instead is a
 * way in for a path nobody put in a menu, which is most of them: the field at
 * the top filters the list until you type something that looks like a path,
 * and then it completes directories the way the project picker does, because
 * that is the habit those keys already have.
 *
 * The list is in a Portal for the same reason RepoChip's is — the palette
 * clips its children, so a menu drawn inside it loses its left half.
 */
function PlaceChip({ place, places, recents, error, openState, onPick }: {
  place: string; places: DiskPlace[]; recents: string[]; error: string | null;
  openState: [boolean, (v: boolean) => void]; onPick: (path: string) => void;
}) {
  const [open, setOpen] = openState;
  const btn = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState<{ top: number; right: number } | null>(null);
  const [typed, setTyped] = useState("");
  const [sugg, setSugg] = useState<FsEntry[]>([]);
  const field = useMenuField(open);

  useEffect(() => {
    if (!open) { setTyped(""); setSugg([]); return; }
    const put = () => {
      const r = btn.current?.getBoundingClientRect();
      if (r) setBox({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    };
    put();
    window.addEventListener("resize", put);
    return () => window.removeEventListener("resize", put);
  }, [open]);

  /** A path, as opposed to a filter — the same test the project picker uses,
   *  so the same input means the same thing in both. */
  const isPath = (v: string) => v.startsWith("/") || v.startsWith("~");

  useEffect(() => {
    const v = typed.trim();
    if (!open || !isPath(v)) { setSugg([]); return; }
    let live = true;
    const t = setTimeout(() => {
      api.fsComplete(v).then((r) => { if (live) setSugg(r.entries.slice(0, 12)); })
        .catch(() => { if (live) setSugg([]); });
    }, 140);
    return () => { live = false; clearTimeout(t); };
  }, [typed, open]);

  const label = places.find((p) => p.path === place)?.label
    ?? (place ? place.split("/").filter(Boolean).pop() ?? place : "Pick a folder");

  const needle = typed.trim().toLowerCase();
  const listed = isPath(typed.trim()) ? [] : places.filter((p) => !needle || `${p.label} ${p.path}`.toLowerCase().includes(needle));
  const past = isPath(typed.trim())
    ? []
    : recents.filter((r) => r !== place && !places.some((p) => p.path === r) && (!needle || r.toLowerCase().includes(needle)));

  const Row = ({ path, primary, secondary }: { path: string; primary: string; secondary?: string }) => (
    <button key={path} onClick={() => onPick(path)}
      className="w-full text-left px-3 py-1.5 flex flex-col gap-0.5"
      style={{ background: path === place ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent" }}>
      <span className="truncate" style={{ color: "var(--text)" }}>{primary}</span>
      {secondary && <span className="text-[9.5px] truncate" style={{ color: "var(--text4)" }}>{secondary}</span>}
    </button>
  );

  return (
    <>
      <button ref={btn} onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[10.5px] px-2 py-1 rounded-md max-w-[220px] shrink-0"
        style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: edge(20), color: "var(--text2)" }}
        title={place ? `Searching ${place}` : "Pick a folder on this machine"}>
        <span className="truncate min-w-0">{label}</span>
        <span className="shrink-0" style={{ color: "var(--text3)" }}>▾</span>
      </button>
      {open && box && (
        <Portal z={LAYER.menu}>
          <div className="fixed inset-0" onClick={() => setOpen(false)} />
          <div className="fixed rounded-lg text-[11px] shadow-2xl flex flex-col overflow-hidden"
            style={{
              top: box.top, right: box.right,
              width: "min(520px, calc(100vw - 16px))", maxHeight: "min(420px, 60vh)",
              background: "var(--bg2)", border: edge(30),
            }}
            onKeyDown={menuKeys(() => setOpen(false))}>
            <div className="px-3 pt-2 pb-1.5 shrink-0 flex flex-col gap-1" style={{ borderBottom: edge(12) }}>
              <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text2)" }}>Where on this machine</div>
              <div className="text-[10px]" style={{ color: "var(--text4)" }}>your home folder and what is under it — hidden folders are never searched</div>
            </div>
            <input ref={field} value={typed} onChange={(e) => setTyped(e.target.value)}
              placeholder="Filter, or type a path like ~/Documents…" spellCheck={false} autoComplete="off"
              onKeyDown={(e) => {
                // Escape is the menu's, one level up — see menuKeys.
                // Tab takes the first completion, Enter takes what you typed —
                // the two things those keys mean in a shell.
                if (e.key === "Tab") { e.preventDefault(); if (sugg.length) setTyped(`${sugg[0]!.path}/`); return; }
                if (e.key === "Enter" && isPath(typed.trim())) { e.preventDefault(); onPick(typed.trim().replace(/\/+$/, "")); }
              }}
              className="m-1.5 px-2.5 py-1.5 rounded-md text-[11px] outline-none shrink-0"
              style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: edge(20), color: "var(--text)" }} />
            <div className="agx-scroll overflow-y-auto overflow-x-hidden py-1.5" style={{ minHeight: 0 }}>
              {error && <div className="px-3 py-2" style={{ color: "var(--error)" }}>{error}</div>}
              {sugg.map((e) => <Row key={e.path} path={e.path} primary={e.name} secondary={e.path} />)}
              {isPath(typed.trim()) && !sugg.length && (
                <div className="px-3 py-2" style={{ color: "var(--text3)" }}>Nothing under that path yet — ⏎ searches it anyway.</div>
              )}
              {listed.map((p) => <Row key={p.path} path={p.path} primary={p.label} secondary={shortPath(p.path)} />)}
              {past.length > 0 && (
                <div className="px-3 pt-2 pb-1 text-[9px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>Lately</div>
              )}
              {past.map((r) => <Row key={r} path={r} primary={shortPath(r)} />)}
              {!error && !sugg.length && !listed.length && !past.length && !isPath(typed.trim()) && (
                <div className="px-3 py-2" style={{ color: "var(--text3)" }}>No folder matches “{typed.trim()}”. Type a path to go straight there.</div>
              )}
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}

/**
 * What the search is looking at — one control for one question.
 *
 * There were two: a checkout picker and a branch picker, side by side. That was
 * two decisions for a question that does not divide, and it was reported as
 * exactly that — "the first picks the directory and the second the branch, I
 * don't really understand either".
 *
 * It does not divide because worktrees of one repository SHARE the object
 * store: `origin/master` is the same answer whichever of them you ask. The only
 * thing a particular checkout can answer that the others cannot is what is on
 * ITS disk right now, uncommitted work included. So there is one list, and
 * every row in it is a complete answer:
 *
 *   working copies   a folder, with what it currently holds — and your edits
 *   branches         a version, read without checking anything out
 *
 * Picking a working copy also decides the repository, which is why the branch
 * list below is the one belonging to it.
 */
function ScopeChip({ repo, repos, ref_, refs, openState, onPickRoot, onPickRef }: {
  repo: GitRepoRef | null; repos: GitRepoRef[];
  ref_: string; refs: { local: string[]; remote: string[]; head?: string };
  openState: [boolean, (v: boolean) => void];
  onPickRoot: (root: string) => void;
  onPickRef: (ref: string) => void;
}) {
  const [open, setOpen] = openState;
  const btn = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState<{ top: number; right: number } | null>(null);
  const [filter, setFilter] = useState("");
  const field = useMenuField(open);

  useEffect(() => {
    if (!open) { setFilter(""); return; }
    const place = () => {
      const r = btn.current?.getBoundingClientRect();
      if (r) setBox({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  const q = filter.trim().toLowerCase();
  const hit = (x: string) => !q || x.toLowerCase().includes(q);
  const copies = repos.filter((r) => hit(`${r.root} ${r.branch} ${r.name}`));
  const local = refs.local.filter(hit);
  const remote = refs.remote.filter(hit);
  const nRefs = refs.local.length + refs.remote.length;

  const here = repo ? (repo.root.split("/").pop() || repo.name) : "no checkout";
  return (
    <>
      <button ref={btn} onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[10.5px] px-2 py-1 rounded-md max-w-[320px] shrink-0"
        title={repo
          ? `Searching ${repo.root}${ref_ ? ` at ${ref_}` : " — what is on disk now"}`
          : "Pick something to search"}
        style={ref_
          ? { background: "color-mix(in srgb, var(--info) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--info) 45%, transparent)", color: "var(--info)" }
          : { background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: edge(20), color: "var(--text2)" }}>
        {/* The folder always, and the version only when it is not the disk —
            a bare folder name is the ordinary case and needs no second word. */}
        <span className="truncate min-w-0">{here}{ref_ ? ` · ${ref_}` : ""}</span>
        <span className="shrink-0" style={{ color: ref_ ? "var(--info)" : "var(--text3)" }}>▾</span>
      </button>
      {open && box && (
        <Portal z={LAYER.menu}>
          <div className="fixed inset-0" onClick={() => setOpen(false)} />
          <div className="fixed rounded-lg text-[11px] shadow-2xl flex flex-col overflow-hidden"
            style={{
              top: box.top, right: box.right, width: "min(560px, calc(100vw - 16px))",
              maxHeight: "min(460px, 66vh)", background: "var(--bg2)", border: edge(30),
            }}
            onKeyDown={menuKeys(() => setOpen(false))}>
            <div className="px-3 pt-2 pb-1.5 shrink-0 flex flex-col gap-1" style={{ borderBottom: edge(12) }}>
              <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text2)" }}>What to search</div>
              <div className="text-[10px]" style={{ color: "var(--text4)" }}>
                a copy on disk, or any branch — reading a branch checks nothing out
              </div>
            </div>
            <input ref={field} value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder={`Filter ${repos.length} copies and ${nRefs} branches…`} spellCheck={false}
              onKeyDown={(e) => {
                // Escape is the menu's, one level up — see menuKeys.
                // Enter takes the only thing left, which is what you typed towards.
                if (e.key !== "Enter") return;
                const only = copies.length + local.length + remote.length;
                if (only !== 1) return;
                e.preventDefault();
                if (copies[0]) onPickRoot(copies[0].root);
                else onPickRef(local[0] ?? remote[0]!);
              }}
              className="m-1.5 px-2.5 py-1.5 rounded-md text-[11px] outline-none shrink-0"
              style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: edge(20), color: "var(--text)" }} />
            <div className="agx-scroll overflow-y-auto overflow-x-hidden py-1.5" style={{ minHeight: 0 }}>
              {copies.length + local.length + remote.length === 0 && (
                <div className="px-3 py-2" style={{ color: "var(--text3)" }}>Nothing matches “{filter.trim()}”.</div>
              )}
              {copies.length > 0 && <Group first hint="what is on disk now, your uncommitted work included">Working copies</Group>}
              {copies.map((r) => (
                <button key={r.root} onClick={() => onPickRoot(r.root)}
                  className="w-full text-left px-3 py-1.5 flex flex-col gap-1"
                  style={{ background: r.root === repo?.root && !ref_ ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent" }}>
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="truncate" style={{ color: "var(--text)" }}>{shortPath(r.root)}</span>
                    {r.worktreeOf && (
                      <span className="shrink-0 text-[8.5px] px-1 rounded"
                        style={{ color: "var(--primary)", border: "1px solid color-mix(in srgb, var(--primary) 32%, transparent)" }}>WT</span>
                    )}
                  </span>
                  <span className="text-[9.5px] truncate" style={{ color: "var(--text4)" }}>on {r.branch}</span>
                </button>
              ))}
              {/* Named after the repository they belong to, because the list
                  above can span several and the branches below cannot. */}
              {local.length > 0 && <Group hint={`in ${repo?.name ?? "this repository"} — nothing is checked out`}>Branches</Group>}
              {local.map((r) => (
                <RefRow key={`l:${r}`} name={r} on={r === ref_} head={r === refs.head} onPick={onPickRef} />
              ))}
              {remote.length > 0 && <Group hint="as of the last fetch">Remote branches</Group>}
              {remote.map((r) => (
                <RefRow key={`r:${r}`} name={r} on={r === ref_} remote onPick={onPickRef} />
              ))}
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}

/**
 * Which branch the search is asking, when it is not this working tree.
 *
 * Its own control beside the checkout rather than a mode on it, because they
 * are two different narrowings and you set them independently: the checkout is
 * WHERE the repository is, the ref is WHEN. Defaults to the working tree —
 * what is on disk now, including the things you have not committed — and says
 * so in words, since "no ref" would read as "no filter" rather than as an
 * answer.
 */
function RefChip({ value, refs, openState, onPick }: {
  value: string;
  refs: { local: string[]; remote: string[]; head?: string };
  openState: [boolean, (v: boolean) => void]; onPick: (ref: string) => void;
}) {
  const [open, setOpen] = openState;
  const btn = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState<{ top: number; right: number } | null>(null);
  const [filter, setFilter] = useState("");
  const field = useMenuField(open);

  useEffect(() => {
    if (!open) { setFilter(""); return; }
    const place = () => {
      const r = btn.current?.getBoundingClientRect();
      if (r) setBox({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  const on = !!value;
  /*
   * A filter, because a real repository has dozens of branches.
   *
   * Fifty-four of them here, so the list is a scroll rather than a choice — and
   * you already know the name you want, which is the case a filter answers and
   * a list does not. Matched on the whole name so `1042` finds
   * `feat/WEB-1042-something` from the middle, the way you actually remember a
   * branch.
   */
  const q = filter.trim().toLowerCase();
  const keep = (xs: string[]) => (q ? xs.filter((x) => x.toLowerCase().includes(q)) : xs);
  const local = keep(refs.local);
  const remote = keep(refs.remote);
  const total = refs.local.length + refs.remote.length;
  const shown = local.length + remote.length;
  return (
    <>
      <button ref={btn} onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[10.5px] px-2 py-1 rounded-md max-w-[200px] shrink-0"
        title={on
          ? `Searching ${value} — read from the object store, nothing is checked out`
          : "Searching this working tree. Pick a branch to search one you are not on."}
        style={on
          ? { background: "color-mix(in srgb, var(--info) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--info) 45%, transparent)", color: "var(--info)" }
          : { background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: edge(20), color: "var(--text3)" }}>
        <span className="truncate min-w-0">{on ? value : "working tree"}</span>
        <span className="shrink-0" style={{ color: on ? "var(--info)" : "var(--text3)" }}>▾</span>
      </button>
      {open && box && (
        <Portal z={LAYER.menu}>
          <div className="fixed inset-0" onClick={() => setOpen(false)} />
          <div className="fixed rounded-lg text-[11px] shadow-2xl flex flex-col overflow-hidden"
            style={{
              top: box.top, right: box.right, width: "min(420px, calc(100vw - 16px))",
              maxHeight: "min(360px, 55vh)", background: "var(--bg2)", border: edge(30),
            }}
            onKeyDown={menuKeys(() => setOpen(false))}>
            {/* Only once there are enough to hunt through. Below that the list
                IS the answer and a field in front of it is one more thing to
                get past. */}
            <div className="px-3 pt-2 pb-1.5 shrink-0 flex flex-col gap-1" style={{ borderBottom: edge(12) }}>
              <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text2)" }}>Which version</div>
              <div className="text-[10px]" style={{ color: "var(--text4)" }}>of the checkout on the left — nothing is checked out to look</div>
            </div>
            {total > 8 && (
              <input ref={field} value={filter} onChange={(e) => setFilter(e.target.value)}
                placeholder={`Filter ${total} branches…`} spellCheck={false}
                onKeyDown={(e) => {
                  // Enter takes the only one left, which is what you were
                  // typing towards. Escape is the menu's — see menuKeys.
                  if (e.key === "Enter" && shown === 1) { e.preventDefault(); onPick(local[0] ?? remote[0]!); }
                }}
                className="m-1.5 px-2.5 py-1.5 rounded-md text-[11px] outline-none shrink-0"
                style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: edge(20), color: "var(--text)" }} />
            )}
            <div className="agx-scroll overflow-y-auto overflow-x-hidden py-1.5" style={{ minHeight: 0 }}>
              {/* The working tree stays reachable whatever is typed: it is not
                  a branch, so filtering it out with the branch names would take
                  away the way back. */}
              <button onClick={() => onPick("")}
                className="w-full text-left px-3 py-1.5 flex flex-col gap-0.5"
                style={{ background: !on ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent" }}>
                <span style={{ color: "var(--text)" }}>working tree</span>
                <span className="text-[9.5px]" style={{ color: "var(--text4)" }}>what is on disk now, uncommitted changes included</span>
              </button>
              {total === 0 && (
                <div className="px-3 py-2 text-[10.5px]" style={{ color: "var(--text3)" }}>
                  No branches here yet.
                </div>
              )}
              {total > 0 && shown === 0 && (
                <div className="px-3 py-2 text-[10.5px]" style={{ color: "var(--text3)" }}>
                  No branch matches “{filter.trim()}”.
                </div>
              )}
              {/* Local first: a branch in this repository that this worktree is
                  not on is the one you could not look at any other way without
                  checking it out. */}
              {local.length > 0 && <Group first hint="in this repository, not checked out">Local</Group>}
              {local.map((r) => (
                <RefRow key={`l:${r}`} name={r} on={r === value} head={r === refs.head} onPick={onPick} />
              ))}
              {remote.length > 0 && <Group hint="last fetched — not what the server has right now">Remote</Group>}
              {remote.map((r) => (
                <RefRow key={`r:${r}`} name={r} on={r === value} remote onPick={onPick} />
              ))}
            </div>
            {/* Said once, at the bottom, because it is the thing people
                reasonably fear about a control that names another branch — and
                the whole reason it can offer a branch list safely at all. */}
            <div className="px-3 py-1.5 text-[9.5px] shrink-0"
              style={{ borderTop: edge(18), color: "var(--text4)" }}>
              Read from the object store. Nothing is checked out, fetched or moved — this
              only changes what the search answers.
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}

/**
 * A heading that holds its ground while the list scrolls under it.
 *
 * Local and remote branches share a naming convention and often a name — `main`
 * and `origin/main` sit four rows apart — so which group you are in has to be
 * readable at the moment you click, not only at the moment you scrolled past
 * the label. Sticky, tinted, and ruled off above, so the two never read as one
 * list.
 */
const Group = ({ children, hint, first }: { children: React.ReactNode; hint: string; first?: boolean }) => (
  <div className="sticky top-0 z-[1] px-3 pt-3 pb-1 flex items-baseline gap-2"
    style={{
      background: "color-mix(in srgb, var(--text) 7%, var(--bg2))",
      borderTop: first ? "none" : "1px solid color-mix(in srgb, var(--text) 22%, transparent)",
      borderBottom: edge(12),
    }}>
    <span className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text2)" }}>{children}</span>
    <span className="text-[9px]" style={{ color: "var(--text4)" }}>{hint}</span>
  </div>
);

function RefRow({ name, on, head, remote, onPick }: {
  name: string; on: boolean; head?: boolean; remote?: boolean; onPick: (r: string) => void;
}) {
  return (
    <button onClick={() => onPick(name)}
      className="w-full text-left px-3 py-1.5 flex items-center gap-2"
      style={{ background: on ? "color-mix(in srgb, var(--primary) 15%, transparent)" : "transparent" }}>
      {/* Two letters rather than a colour: `main` and `origin/main` are four
          rows apart and answer differently, and a filtered list can put them
          next to each other with no heading in between. */}
      <span className="shrink-0 text-[8px] w-[22px] text-center rounded"
        style={remote
          ? { color: "var(--info)", border: "1px solid color-mix(in srgb, var(--info) 30%, transparent)" }
          : { color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--text) 20%, transparent)" }}>
        {remote ? "RM" : "LO"}
      </span>
      <span className="truncate min-w-0" style={{ color: "var(--text)" }}>{name}</span>
      {/* The one this worktree is already on. Searching it is the same answer
          as the working tree minus anything uncommitted, and saying so stops
          that being a surprise. */}
      {head && (
        <span className="ml-auto shrink-0 text-[8.5px] px-1 rounded"
          style={{ color: "var(--text3)", border: "1px solid color-mix(in srgb, var(--text) 20%, transparent)" }}>
          checked out here
        </span>
      )}
    </button>
  );
}

const Note = ({ children, tint }: { children: React.ReactNode; tint?: string }) =>
  <div className="px-4 py-6 text-[11.5px]" style={{ color: tint ?? "var(--text3)" }}>{children}</div>;

/**
 * A debounced search that cannot be overtaken by its own older self, and that
 * does not run at all until there is something to ask.
 *
 * The sequence guard is the same one FilesPanel uses and for the same reason:
 * typing "models" fires six searches and the one for "mo" can land after the
 * one for "models", which only happens on a slow query — exactly the query
 * where a wrong answer costs the most.
 *
 * `enabled` is the addition. This component holds two of these at once, one per
 * search tab, and without it switching tabs would fire the other tab's query
 * against the server every time you typed a letter.
 */
function useSearch<T extends { ok: boolean; error?: string }>(
  run: () => Promise<T> | null, deps: unknown[], enabled: boolean,
): { data: T | null; pending: boolean; error: string | null } {
  const [state, setState] = useState<{ data: T | null; pending: boolean; error: string | null }>(
    { data: null, pending: false, error: null });
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    if (!enabled) { setState({ data: null, pending: false, error: null }); return; }
    setState((s) => ({ ...s, pending: true }));
    const t = setTimeout(() => {
      const p = run();
      if (!p) return;
      p.then((data) => { if (seq.current === mine) setState({ data, pending: false, error: null }); })
        .catch((e) => { if (seq.current === mine) setState({ data: null, pending: false, error: String(e) }); });
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);
  return state;
}
