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
// It is a workspace, not a menu: a drawer of results on the left, the selected
// file read in the middle whatever it is (markdown as a document, code with
// its numbers and colour, a picture, a PDF), and its facts, git state and
// outline on the right. Selecting a result IS looking at it, so the next result
// is one arrow key away, and the bench is a button rather than the destination.
//
// It keeps where it was. Closing it with the chord is not leaving it: the tab,
// query, selected result, open file, scroll and drawer come back exactly, also
// after a restart (finderState.ts).
import { HIT, ICON } from "../lib/iconSize.ts";
import { ClockIcon, CodeFileIcon, FileIcon, FolderIcon, HomeIcon, ImageFileIcon, NoteIcon, SearchIcon } from "../lib/glyphIcons.tsx";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "./Portal.tsx";
import { api, SERVER, withToken } from "../lib/api.ts";
import { requestFilesReveal } from "../lib/filesReveal.ts";
import { recents, remember, forget, subscribeRecents, ago } from "../lib/fileRecents.ts";
import { reduceSelection } from "../lib/finderSelection.ts";
import { completion, looksLikePath, parseQuery, passesFilters, readPath, scoreMatch } from "../lib/finderQuery.ts";
import { FileView, type Jump } from "./finder/FileView.tsx";
import { InfoRail } from "./finder/InfoRail.tsx";
import { useFileSource, type FileSource } from "./finder/useFileSource.ts";
import { extChips, chipLabel, hasGlob, matchGlob, passesExts, toggleExt } from "../lib/finderFilters.ts";
import { outline as outlineOf, viewerActions, type OutlineItem } from "../lib/finderViewer.ts";
import { benchOpen, type BenchOpen } from "../lib/finderFolder.ts";
import { DRAWER_MAX, DRAWER_MIN, RAIL_W, clampDrawer, indexOfSel, restore, resumeLine, scrollFor, type FinderSnapshot, type TabView } from "../lib/finderState.ts";
import type { FileGitFacts } from "../../../shared/types.ts";
import { RevealButton } from "./finder/RevealButton.tsx";
import type { BrowseReport } from "../../../shared/types.ts";
import { appChordFor, chordLabel } from "../lib/keybindings.ts";
import { LAYER } from "../lib/layers.ts";
import { shortPath } from "../lib/shortPath.ts";
import { afterJump, dirsFirst, humanBytes, pageUrl, fileKind, focusSelection, pathBar, pathInputText, placeSections, shortenHome, switchTab, type BrowseState, type PlaceRow } from "../lib/paletteModel.ts";
import type { DiskPlace, FsEntry, GitRepoRef, GrepHit } from "../../../shared/types.ts";
import { CloseButton } from "./CloseButton.tsx";
import { FileViewer } from "./CardFiles.tsx";
import type { CardAttachment } from "../../../shared/providers.ts";
import type { FinderTarget } from "../lib/finderTarget.ts";
import { INPUT, INPUT_STYLE, EDGE, LINE } from "./workspace/Chrome.tsx";

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
  | { kind: "dir"; rel: string; abs?: string; items?: number | null; mtime?: number; locked?: boolean; why?: string }
  | { kind: "file"; rel: string; hits?: GrepHit[]; abs?: string; bytes?: number | null; mtime?: number; locked?: boolean; why?: string }
  /* A recent carries its own checkout. It is a memory of somewhere you have
     been, and the palette may be pointed somewhere else by the time you come
     back to it — opening it against the current chip would build a path in the
     wrong tree. */
  | { kind: "recent"; rel: string; at: number; root: string; gone?: boolean; abs?: string };

const edge = (pct: number) => `1px solid color-mix(in srgb, var(--text) ${pct}%, transparent)`;

export { humanBytes };

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
/* Whether dotted entries are listed. Off by default: `~` is mostly dotfiles and
   they bury the folder you meant. A typed leading dot asks for them anyway. */
const HIDDEN_KEY = "agentglass.files.paletteHidden";
const readHidden = (): boolean => { try { return localStorage.getItem(HIDDEN_KEY) === "1"; } catch { return false; } };
const saveHidden = (on: boolean) => { try { localStorage.setItem(HIDDEN_KEY, on ? "1" : "0"); } catch { /* non-fatal */ } };
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
/** Pictures a browser draws itself; everything else picture-like keeps the pane and ⌘⏎. */
const VIEWABLE = /\.(png|jpe?g|webp|gif|svg)$/i;

const REF_KEY = "agentglass.files.paletteRef";
const SNAP_KEY = "agentglass.files.finderState";
const readSnap = (): unknown => { try { return JSON.parse(localStorage.getItem(SNAP_KEY) || "null"); } catch { return null; } };
const writeSnap = (s: FinderSnapshot) => { try { localStorage.setItem(SNAP_KEY, JSON.stringify(s)); } catch { /* non-fatal */ } };
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
  open, onClose, onOpenFile, onBench, onRevealDir, onOpenBrowser, target,
}: {
  open: boolean;
  /** Somewhere to be when it opens: a path clicked in a terminal. Each new `n`
   *  is a new request, so the same path asked for twice still goes there. */
  target?: FinderTarget | null;
  onClose: () => void;
  /** Put a file on the bench, which is now something you ask for: the finder
   *  shows every file itself. For a file found on another branch this is the
   *  old route, which writes that ref's copy out first. */
  onOpenFile: (root: string, rel: string, branch: string, ref?: string) => void | Promise<void>;
  /** A file on disk, on the bench. */
  onBench: (open: BenchOpen) => void;
  /** A folder is a place: go to Files and walk the tree there. */
  onRevealDir: (root: string, dir: string) => void;
  /** Show an address in the app's own browser. Absent where there is none, and
   *  the system's default opener takes the file instead. */
  onOpenBrowser?: (url: string) => void;
}) {
  /*
   * Where the finder was, read once. Closing it is not leaving it: the tab, each
   * tab's query and folder, the result you were on, its chips, the file's
   * scroll and the drawer come back — also after a restart, hence storage and
   * not only component state. See finderState.ts.
   */
  const [saved] = useState<FinderSnapshot>(() => restore(readSnap()));
  const [tab, setTab] = useState<PaletteTab>(saved.tab);
  const [q, setQ] = useState(saved.tabs[saved.tab]?.q ?? "");
  /* What the tabs that are not showing were looking at — see `switchTab`. */
  const stash = useRef<Partial<Record<PaletteTab, BrowseState>>>(
    Object.fromEntries((Object.entries(saved.tabs) as [PaletteTab, TabView][]).map(([t, v]) => [t, { q: v.q, browsePath: v.browsePath }])));
  /* The other half of what a tab remembers: its selection and chips. */
  const viewStash = useRef<Partial<Record<PaletteTab, { sel: string | null; exts: string[] }>>>(
    Object.fromEntries((Object.entries(saved.tabs) as [PaletteTab, TabView][]).map(([t, v]) => [t, { sel: v.sel, exts: v.exts }])));
  /** The saved selection, waiting for its results to arrive. */
  const pendingSel = useRef<string | null>(saved.tabs[saved.tab]?.sel ?? null);
  const [exts, setExts] = useState<string[]>(saved.tabs[saved.tab]?.exts ?? []);
  const [drawerW, setDrawerW] = useState(saved.drawerW);
  const [collapsed, setCollapsed] = useState(saved.collapsed);
  const [showInfo, setShowInfo] = useState(true);
  const snap = useRef<FinderSnapshot>(saved);
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
  const [browsePath, setBrowsePath] = useState<string | null>(saved.tabs[saved.tab]?.browsePath ?? null);
  const [browsed, setBrowsed] = useState<BrowseReport | null>(null);
  const [showHidden, setShowHidden] = useState(readHidden);
  const [cursor, setCursor] = useState(0);
  /** Change tab and take that tab's own folder and box with it. */
  const goTab = useCallback((to: PaletteTab) => {
    const r = switchTab(stash.current, tab, { q, browsePath }, to);
    stash.current = r.stash;
    viewStash.current = { ...viewStash.current, [tab]: { sel: selAbsRef.current, exts } };
    const v = viewStash.current[to];
    pendingSel.current = v?.sel ?? null;
    setExts(v?.exts ?? []);
    setTab(to); setQ(r.next.q); setBrowsePath(r.next.browsePath);
  }, [tab, q, browsePath, exts]);
  /** The selected file's path, for the places that must not depend on render order. */
  const selAbsRef = useRef<string | null>(null);
  /** Which picture the in-app viewer is on, by index into `viewFiles`. Null is closed. */
  const [viewAt, setViewAt] = useState<number | null>(null);
  /** A file to land the cursor on once its folder has loaded. */
  const [wantFile, setWantFile] = useState<{ dir: string; name: string } | null>(null);
  const handledTarget = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

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
   * A path somebody clicked in a terminal: the Machine tab, in that folder.
   *
   * A file has no listing of its own, so it opens the folder it is in and asks
   * the cursor to land on it once the listing arrives — see `wantFile`. `n` is
   * remembered so closing and reopening the finder by hand does not replay a
   * request that was already answered.
   */
  useEffect(() => {
    if (!open || !target || handledTarget.current === target.n) return;
    handledTarget.current = target.n;
    pendingSel.current = null;   // the link decides the selection, not the last session
    const cut = target.path.lastIndexOf("/");
    const dir = target.kind === "dir" ? target.path.replace(/\/+$/, "") || "/" : target.path.slice(0, cut) || "/";
    /* Machine gets the folder, and the tab it came from keeps what it had. The
       box says the path — an empty box under a placeholder left nothing on
       screen to say where this was. Home may not be known yet on a cold start,
       so the text is settled by the effect below once it is. */
    stash.current = switchTab(stash.current, tab, { q, browsePath }, "machine").stash;
    setTab("machine");
    setViewAt(null);
    setPlace(dir);
    setPlaceRecents(rememberPlace(dir));
    setBrowsePath(dir);
    setQ(pathInputText(dir, homeDir));
    setPathText(homeDir ? null : dir);
    setWantFile(target.kind === "file" ? { dir, name: target.path.slice(cut + 1) } : null);
    // Only a new request runs this; the tab, box and home it reads are the
    // moment's, and `handledTarget` keeps a re-render from replaying it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target]);
  const [pathText, setPathText] = useState<string | null>(null);
  useEffect(() => {
    if (pathText && homeDir) { keepSel.current = true; setQ(pathInputText(pathText, homeDir)); setPathText(null); }
  }, [pathText, homeDir]);

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
    const t = setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      if (focusSelection(el.value) === "end") el.setSelectionRange(el.value.length, el.value.length);
      else el.select();
    }, 20);
    return () => clearTimeout(t);
  }, [open]);

  /* A glob is not a name to search for: `*.png` finds nothing on a server that
     matches names, and the list is the folder's own, narrowed on this side. It
     is the last segment of what was typed, so a typed path counts too. */
  const globAsked = useMemo(() => {
    const t = q.trim();
    const tail = looksLikePath(t) ? t.slice(t.lastIndexOf("/") + 1) : t;
    return hasGlob(tail);
  }, [q]);
  const found = useSearch(
    () => (tab === "names" ? api.filesFind(root, q, ref || undefined) : null),
    [tab === "names", root, q.trim(), ref],
    !!root && tab === "names" && q.trim().length > 0 && !globAsked,
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
    !!place && tab === "machine" && q.trim().length >= 2 && !globAsked,
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
    if (asked.text.trim() && !(globAsked && tab !== "contents")) return null;
    if (tab === "machine") return place || null;
    if (tab === "names") return root || null;
    return null;
  }, [typedPath, browsePath, asked.text, tab, place, root, globAsked]);

  /** Go to a folder from the bar or a row. The box follows only when it was
   *  already holding a path (see `afterJump`). */
  const jump = useCallback((abs: string) => {
    const j = afterJump(abs, homeDir, !!typedPath);
    setBrowsePath(j.browsePath); setQ(j.q);
    inputRef.current?.focus();
  }, [homeDir, typedPath]);

  // The folder under the cursor, fetched when it changes. Errors land in the
  // report itself — "no permission to read this folder" is an answer, and the
  // list says it rather than showing an empty folder that looks like a bug.
  const wantHidden = showHidden || !!typedPath?.tail.startsWith(".");
  useEffect(() => {
    if (!open || !at) { setBrowsed(null); return; }
    let live = true;
    void api.browse(at, wantHidden).then((r) => { if (live) setBrowsed(r); }).catch(() => { if (live) setBrowsed(null); });
    return () => { live = false; };
  }, [open, at, wantHidden]);

  const rows: Row[] = useMemo(() => {
    if (at) {
      const d = browsed;
      if (!d?.ok) return [];
      const base = at.replace(/\/+$/, "");
      return dirsFirst(d.entries.map((e): Row => e.kind === "dir"
        ? { kind: "dir", rel: e.name, abs: `${base}/${e.name}`, items: e.items, mtime: e.mtime, locked: e.locked, why: e.why }
        : { kind: "file", rel: e.name, abs: `${base}/${e.name}`, bytes: e.bytes, mtime: e.mtime, locked: e.locked, why: e.why }));
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
      .filter((r) => !needle || (hasGlob(needle) ? matchGlob(needle, r.rel) : r.rel.toLowerCase().includes(needle)))
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
  const matched: Row[] = useMemo(() => {
    const { text, exact, filters } = asked;
    const filtered = rows.filter((r) => {
      const abs = absOf(r) ?? r.rel;
      return passesFilters({ path: abs, kind: r.kind === "recent" ? "file" : r.kind, bytes: r.kind === "file" ? r.bytes ?? null : null, mtime: r.kind === "recent" ? r.at : r.mtime ?? null }, filters);
    });
    const needle = typedPath ? typedPath.tail : text;
    if (!at || !needle) return filtered;
    /* A pattern keeps what it matches, in the order the folder had. Scoring it
       as a fuzzy name is what answered "Nothing in here matches" to `*.png`. */
    if (hasGlob(needle) && tab !== "contents") return filtered.filter((r) => matchGlob(needle, r.rel));
    return filtered
      .map((r) => ({ r, score: scoreMatch(r.rel, needle, exact) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.r);
  }, [rows, asked, at, typedPath, absOf, tab]);

  /* The kinds present, counted BEFORE the chips are applied — so turning one on
     does not make the others vanish and a second one cannot be added. */
  const chips = useMemo(() => extChips(matched.filter((r) => r.kind !== "dir").map((r) => r.rel)), [matched]);
  /* A chip that is not in this list filters nothing, so a selection carried from
     another folder cannot leave the list quietly emptied. */
  const activeExts = useMemo(() => exts.filter((e) => chips.some((c) => c.ext === e)), [exts, chips]);
  const shown: Row[] = useMemo(
    () => (activeExts.length ? matched.filter((r) => r.kind === "dir" || passesExts(r.rel, activeExts)) : matched),
    [matched, activeExts]);

  // The cursor is an index into a list that changes under it on every keystroke.
  // Reset on anything that rebuilds the list, or ↑↓ starts from wherever the
  // previous, longer list had left it.
  /* Keyed by the scope of the tab that is showing, not by both: the checkout
     list loading in the background (a repository picked for you on open) is not
     a new question for the Machine tab, and resetting there threw away the
     result you had been on. */
  /* Except the once the box was only rewritten to say the path a terminal link
     asked for: that is not a new question, and resetting here put the selection
     back on row 0 after the file had been found. */
  const keepSel = useRef(false);
  useEffect(() => {
    if (keepSel.current) { keepSel.current = false; return; }
    setCursor((c) => reduceSelection(c, { type: "reset" }, shown.length));
    // `shown.length` is the size of the list at this moment, not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, q, tab === "machine" ? place : root, browsePath]);
  useEffect(() => { setCursor((c) => reduceSelection(c, { type: "hover", index: c }, shown.length)); }, [shown.length]);

  // Keep the cursor on screen. `block: "nearest"` rather than "center" so
  // holding ↓ walks the list instead of jumping it around under the eye.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor, shown.length]);

  /*
   * The pictures in this list, as the viewer wants them.
   *
   * The viewer is the one the card attachments use, and it takes attachments:
   * an id, a title, a url. A file here has all three, the url being the engine's
   * read-file route — the same one the preview pane draws from, so it is held
   * to the same places (`browseReal`) and there is no second door.
   *
   * Only what a browser draws itself. Everything else that looks like a picture
   * (heic, tiff, raw) keeps the preview pane and ⌘⏎, as before.
   */
  const { viewFiles, viewRows } = useMemo(() => {
    const files: CardAttachment[] = [];
    const rowsOf: Row[] = [];
    // A file found on a branch is not on disk, so it has nothing to draw.
    const onBranch = !!ref && tab === "names" && !at;
    if (!onBranch) {
      for (const r of shown) {
        if (r.kind === "dir" || (r.kind === "recent" && r.gone) || !VIEWABLE.test(r.rel)) continue;
        const abs = absOf(r);
        if (!abs) continue;
        const url = withToken(`${SERVER}/preview/raw?path=${encodeURIComponent(abs)}`);
        files.push({ id: abs, title: abs.slice(abs.lastIndexOf("/") + 1), ext: (/\.(\w+)$/.exec(abs)?.[1] ?? "").toLowerCase(), size: r.kind === "file" ? r.bytes ?? 0 : 0, url, thumb: url });
        rowsOf.push(r);
      }
    }
    return { viewFiles: files, viewRows: rowsOf };
  }, [shown, absOf, ref, tab, at]);
  const viewImage = useCallback((row: Row) => {
    const i = viewRows.indexOf(row);
    if (i >= 0) setViewAt(i);
  }, [viewRows]);

  /* The list follows the viewer: leaving it lands on the picture it was
     showing, not on the one it was opened from. */
  useEffect(() => {
    if (viewAt === null) return;
    const row = viewRows[viewAt];
    const i = row ? shown.indexOf(row) : -1;
    if (i >= 0) setCursor(i);
  }, [viewAt, viewRows, shown]);

  /* The file a terminal link pointed at, once its folder has been listed. */
  useEffect(() => {
    // `browsed` still holds the previous folder until the new listing lands, so
    // only a listing OF the wanted folder can answer.
    if (!wantFile || browsed?.path.replace(/\/+$/, "") !== wantFile.dir) return;
    const i = shown.findIndex((r) => r.rel === wantFile.name);
    if (i >= 0) {
      setCursor((c) => reduceSelection(c, { type: "focus", index: i }, shown.length));
      /* Centred, once the row is drawn: the file a link named is the reason the
         finder opened, and "nearest" left it at the bottom edge of a long folder. */
      requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-row="${i}"]`)?.scrollIntoView({ block: "center" }));
    }
    setWantFile(null);   // found, or listed and not there: stop waiting
  }, [wantFile, shown, browsed]);

  /* The viewer is an index into a list that a keystroke or a closing palette
     can change under it. */
  useEffect(() => { setViewAt(null); }, [q, tab, open]);
  useEffect(() => { if (viewAt !== null && !viewFiles[viewAt]) setViewAt(null); }, [viewAt, viewFiles]);

  /*
   * The formats that must never reach a text editor.
   *
   * Opening a `.png` from here sent it to the floating nvim modal — a modal
   * nobody asked for, showing a binary nobody can read. The preview pane draws
   * these; the editor is still one keystroke away for whoever really wants it
   * (⌘⏎), because refusing outright is its own kind of wrong.
   */
  const IMAGEY = /\.(png|jpe?g|jfif|gif|webp|avif|bmp|ico|cur|svg|apng|tiff?|heic|heif|psd|xcf|jp2|jxl|exr|hdr|tga|pcx|ppm|pgm|pbm|cr2|cr3|nef|arw|dng|orf|raf|rw2|sr2|pdf|mp4|webm|mkv|mov|m4v|mp3|wav|ogg|flac|m4a|opus)$/i;

  /* The finder shows every file itself, so the bench is something you ask for.
     A picture or a PDF has no editor to go to, and sending one there is the
     floating-nvim-on-a-binary report all over again. */
  const benchRow = useCallback((row: Row | undefined) => {
    if (!row || (row.kind === "recent" && row.gone)) return;
    const abs = absOf(row);
    if (!abs) return;
    const project = row.kind === "recent" ? row.root : root;
    /* A folder's bench action is a shell in it; a file's is the editor. */
    if (row.kind === "dir") { onBench(benchOpen("terminal", abs, project)); onClose(); return; }
    if (IMAGEY.test(row.rel)) return;
    if (ref && tab === "names" && !at && row.kind !== "recent") { void onOpenFile(root, row.rel, branch, ref); onClose(); return; }
    onBench(benchOpen("edit", abs, project));
    onClose();
  }, [absOf, ref, tab, at, root, branch, onOpenFile, onBench, onClose]);

  /** Enter on a file: the caret goes to the reader, so the arrows scroll it. */
  const focusViewer = useCallback(() => {
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>("[data-finder-viewer]")?.focus());
  }, []);

  const openRow = useCallback((row: Row | undefined, secondary = false, click = false) => {
    if (!row || (row.kind !== "recent" && row.locked)) return;

    /* A picture the browser can draw opens in the app, on ⏎ or a double-click.
       A single click only selects it, as it always did: the pane beside the
       list is already showing it. ⌘⏎ is still the editor. */
    if (!secondary && viewRows.includes(row)) { if (!click) viewImage(row); return; }

    /* Browsing: a folder is somewhere to go, and a file is looked at where it
       is. This is the same on every tab, which is the point. */
    if (at) {
      const abs = row.abs ?? `${at.replace(/\/+$/, "")}/${row.rel}`;
      if (row.kind === "dir") {
        // The box follows you when you were typing a path, the way a shell's
        // line does — so the next `../` or `foo/` is typed onto what is there.
        jump(abs);
        return;
      }
      if (secondary) { benchRow(row); return; }
      if (!click) focusViewer();
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
        if (secondary) { benchRow(row); return; }
        if (!click) focusViewer();
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
      if (secondary) { benchRow(row); return; }
      if (!click) focusViewer();
      return;
    }
    // A file found on a branch is opened AS THAT BRANCH HAS IT. Opening the
    // working tree's copy of the same path would be a different file wearing
    // the right name — or nothing at all, for one that only exists upstream.
    if (!ref) remember(root, row.rel);
    if (secondary) { benchRow(row); return; }
    if (!click) focusViewer();
  }, [tab, at, place, root, ref, onRevealDir, onClose, viewRows, viewImage, jump, benchRow, focusViewer]);

  const onKey = (e: React.KeyboardEvent) => {
    // The viewer owns the keys while it is up — it listens on window, first.
    if (viewAt !== null) return;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "f") { e.preventDefault(); e.stopPropagation(); setFindSignal((n) => n + 1); return; }
      if (k === "b") { e.preventDefault(); setCollapsed((c) => !c); return; }
      if (k === "i") { e.preventDefault(); setShowInfo((v) => !v); return; }
    }
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault(); setCursor((c) => reduceSelection(c, { type: "key", dir: 1 }, shown.length)); return;
    }
    if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault(); setCursor((c) => reduceSelection(c, { type: "key", dir: -1 }, shown.length)); return;
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
      goTab(TABS[(i + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length]!.id);
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

  /*
   * The centre and the right rail look at ONE thing: the row under the cursor,
   * wherever it came from. Null while nothing is selected, or while the finder
   * is closed — a closed finder holds no file and no picture in memory.
   */
  const selRow = shown[cursor];
  const selAbs = selRow ? absOf(selRow) : null;
  selAbsRef.current = selAbs;
  const source: FileSource | null = useMemo(() => {
    if (!open || !selRow || !selAbs) return null;
    if (selRow.kind === "recent" && selRow.gone) return null;
    const onRef = !!ref && tab === "names" && !at && selRow.kind !== "recent";
    if (onRef) return selRow.kind === "dir" ? null : { abs: null, root, rel: selRow.rel, ref };
    const rootOf = selRow.kind === "recent" ? selRow.root : at || tab === "machine" ? selAbs.slice(0, selAbs.lastIndexOf("/")) : root;
    return { abs: selAbs, root: rootOf, rel: selAbs.slice(selAbs.lastIndexOf("/") + 1) };
    // A row is a new object per render; its path is what identifies it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selAbs, selRow?.kind, ref, tab, at, root]);
  const file = useFileSource(source);

  /* What git says about it. Held back like the bytes are: holding ↓ through a
     folder must not start four git processes per row it passes. */
  const [git, setGit] = useState<FileGitFacts | null>(null);
  useEffect(() => {
    setGit(null);
    const abs = source?.abs;
    if (!abs || source?.ref) return;
    let live = true;
    const t = setTimeout(() => { void api.previewGit(abs).then((g) => { if (live) setGit(g); }).catch(() => { /* no git block, then */ }); }, 220);
    return () => { live = false; clearTimeout(t); };
  }, [source?.abs, source?.ref]);

  /* What it is made of, and where the reader last jumped to. */
  const outline: OutlineItem[] = useMemo(
    () => (file.text !== null && file.kind ? outlineOf(file.text, file.kind, file.name) : []),
    [file.text, file.kind, file.name]);
  const [viewJump, setViewJump] = useState<Jump | null>(null);
  const [outlineAt, setOutlineAt] = useState(-1);
  const jumps = useRef(0);
  useEffect(() => { setViewJump(null); setOutlineAt(-1); }, [selAbs]);
  const jumpTo = useCallback((item: OutlineItem, nth: number) => {
    const n = ++jumps.current;
    setViewJump(file.kind === "markdown" ? { kind: "heading", label: item.label, nth, n } : { kind: "line", line: item.line, n });
    setOutlineAt(outline.indexOf(item));
  }, [file.kind, outline]);
  const [findSignal, setFindSignal] = useState(0);

  /* Where the file was scrolled, kept for reopening — see finderState.scrollFor. */
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushSnap = useCallback(() => {
    saveTimer.current = null;
    const tabs: FinderSnapshot["tabs"] = {};
    for (const t of TABS) {
      const b = stash.current[t.id]; const v = viewStash.current[t.id];
      if (t.id !== tab && (b || v)) tabs[t.id] = { q: b?.q ?? "", browsePath: b?.browsePath ?? null, sel: v?.sel ?? null, exts: v?.exts ?? [] };
    }
    tabs[tab] = { q, browsePath, sel: selAbsRef.current, exts };
    snap.current = { ...snap.current, v: 1, tab, tabs, drawerW, collapsed };
    writeSnap(snap.current);
  }, [tab, q, browsePath, exts, drawerW, collapsed]);
  const schedule = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSnap, 250);
  }, [flushSnap]);
  useEffect(() => { schedule(); }, [schedule, selAbs]);
  const onTop = useCallback((top: number) => {
    if (!selAbsRef.current) return;
    snap.current = { ...snap.current, scroll: { path: selAbsRef.current, top: Math.round(top) } };
    schedule();
  }, [schedule]);
  /* Written out the moment it closes, not 250ms later: a restart right after
     Ctrl+Shift+P must not lose the last thing you did. */
  useEffect(() => { if (!open && saveTimer.current) { clearTimeout(saveTimer.current); flushSnap(); } }, [open, flushSnap]);

  /* The saved selection, once its results are here. */
  useEffect(() => {
    if (!pendingSel.current || !shown.length) return;
    const i = indexOfSel(shown.map((r) => absOf(r)), pendingSel.current);
    pendingSel.current = null;
    if (i >= 0) {
      setCursor((c) => reduceSelection(c, { type: "focus", index: i }, shown.length));
      requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-row="${i}"]`)?.scrollIntoView({ block: "center" }));
    }
  }, [shown, absOf]);

  /* The drawer's width, dragged. Held to its bounds while the pointer is still
     down, so what is drawn is what will be restored. */
  const dragDrawer = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const x0 = e.clientX; const w0 = drawerW;
    const move = (m: PointerEvent) => setDrawerW(clampDrawer(w0 + m.clientX - x0));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /* Room for the info rail, or not: 290px of it is most of a small window. */
  const [wide, setWide] = useState(() => (typeof window === "undefined" ? true : window.innerWidth >= 1100));
  useEffect(() => {
    if (typeof window === "undefined") return;
    const on = () => setWide(window.innerWidth >= 1100);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  /* Show it in the app's own browser, or hand it to the system's opener. */
  const openInBrowser = (p: string) => {
    /* The same allowlist as every other read: the page route
       judges the path, and the fallback is the opener that
       already does. */
    if (onOpenBrowser) { onOpenBrowser(withToken(pageUrl(SERVER, p))); onClose(); }
    else void api.previewOpen(p);
  };

  const active = TABS.find((t) => t.id === tab)!;
  const status = tab === "names" ? found : tab === "contents" ? grepped : tab === "machine" ? onDisk : null;

  const unit = at ? (shown.length === 1 ? "item" : "items") : (shown.length === 1 ? "result" : "results");
  const sectionAt = outlineAt >= 0 ? outline[outlineAt]?.label ?? null : null;
  const canStep = shown.length > 0;
  const step = (dir: 1 | -1) => setCursor((c) => reduceSelection(c, { type: "key", dir }, shown.length));

  return (
    <>
    <AnimatePresence>
      {open && (
        // Above the viewer it raises — see layers.ts for why that number is
        // written down rather than chosen here.
        <Portal z={LAYER.palette}>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="fixed inset-0"
            style={{ zIndex: 1, background: "color-mix(in srgb, var(--bg) 55%, transparent)" }}
            onClick={onClose} />
          {/* Centred by the layout, NOT by a transform.
              motion animates the panel's `transform` (y and scale), so a
              translateX(-50%) written on it is overwritten the moment the open
              animation runs — measured: the palette sat with its left edge on the
              centre line. A flex parent has no such fight, and it is also what
              lets the panel be as tall as its content and no taller: it centres
              at any height instead of being pinned to a top offset. */}
          <div className="fixed inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: 2, padding: 20 }}>
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.985 }}
            transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
            ref={panelRef}
            className="flex flex-col overflow-hidden rounded-xl pointer-events-auto"
            style={{
              width: "min(1480px, 100%)",
              maxHeight: "100%",
              minHeight: "min(440px, 100%)",
              background: "var(--surface-card)",
              border: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)",
              boxShadow: "0 30px 70px -20px #000",
            }}
            onKeyDown={onKey}
            role="dialog" aria-modal="true" aria-label="Find a file">

            {/* the top bar: the question, where it is asked, how many answers,
                which of the four questions, and the way through them.
             *
             * Two boxes for the field, and the outer one is the whole reason. A
             * field that declares itself bare hands its focus ring to whatever
             * wraps it (index.css), and what wrapped it was a full-bleed row — so
             * focusing drew a violet rectangle a pixel inside the panel's own
             * border. The frame is inset and the ring lands on a box with room
             * around it.
             *
             * `rounded-md` and not `rounded-lg`: that same rule sets a 6px
             * radius on whatever it rings, and a box that rounds itself
             * differently would square up by 2px the moment you typed. */}
            <div className="flex items-center gap-3 px-3.5 py-3 shrink-0" style={{ borderBottom: LINE }}>
              <div className="flex items-center gap-2.5 flex-1 min-w-0 px-3 py-2 rounded-md"
                style={{ background: "var(--bg)", border: "1.5px solid color-mix(in srgb, var(--text) 80%, transparent)" }}>
                <span className="flex" style={{ color: "var(--text3)" }}><SearchIcon size={ICON.xs} /></span>
                <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
                  spellCheck={false} autoComplete="off" placeholder={active.placeholder}
                  className="flex-1 min-w-0 bg-transparent outline-none text-[13px]" style={{ color: "var(--text)" }} />
                {/* One control, not two.
                    Two chips meant two decisions for one question, and the
                    question does not divide that way: reading a branch is the
                    same answer from any checkout of the repository, because they
                    share the object store. What actually varies is a single
                    thing — what am I searching — so it is asked once. */}
                {tab === "machine" && (
                  <PlaceChip
                    place={place} places={places} recents={placeRecents} error={placeErr} homeDir={homeDir}
                    openState={[pickOpen, setPickOpen]}
                    onPick={(p) => {
                      setPlaceRecents(rememberPlace(p));
                      setPlace(p); setBrowsePath(null); setQ("");
                      setPickOpen(false); inputRef.current?.focus();
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
                      setRoot(r); setRef(""); saveRef(r, ""); setBrowsePath(null);
                      setPickOpen(false); inputRef.current?.focus();
                    }}
                    onPickRef={(r) => { setRef(r); setPickOpen(false); inputRef.current?.focus(); }} />
                )}
                {tab === "recent" && (
                  <RepoChip repo={repo} repos={repos} openState={[pickOpen, setPickOpen]}
                    onPick={(r) => { setRoot(r); setPickOpen(false); inputRef.current?.focus(); }} />
                )}
                <span className="shrink-0 text-[10.5px] px-2 py-0.5 rounded-full tabular-nums" aria-live="polite"
                  style={{ background: "color-mix(in srgb, var(--text) 9%, transparent)", color: "var(--text2)", fontWeight: 600 }}>
                  {shown.length} {unit}
                </span>
              </div>

              <div className="flex items-center rounded-md overflow-hidden shrink-0" role="tablist" aria-label="What to search"
                style={{ border: EDGE, background: "var(--bg)" }}>
                {TABS.map((t) => (
                  <button key={t.id} role="tab" aria-selected={t.id === tab}
                    onClick={() => { goTab(t.id); inputRef.current?.focus(); }}
                    className="text-[11.5px] px-3 py-1.5"
                    style={t.id === tab ? { background: "var(--text)", color: "var(--bg)", fontWeight: 500 } : { color: "var(--text3)" }}>
                    {t.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-1.5 shrink-0 text-[11px]" style={{ color: "var(--text3)" }}>
                <span className="tabular-nums whitespace-nowrap">{canStep ? `${cursor + 1} of ${shown.length}` : "0 of 0"}</span>
                <button onClick={() => step(-1)} disabled={!canStep} title="Previous result (↑)" aria-label="Previous result"
                  className="agx-btn rounded-md grid place-items-center disabled:opacity-40" style={{ width: HIT, height: HIT, border: EDGE, color: "var(--text2)" }}>{"↑"}</button>
                <button onClick={() => step(1)} disabled={!canStep} title="Next result (↓)" aria-label="Next result"
                  className="agx-btn rounded-md grid place-items-center disabled:opacity-40" style={{ width: HIT, height: HIT, border: EDGE, color: "var(--text2)" }}>{"↓"}</button>
              </div>
              <CloseButton onClick={onClose} title="Close the finder (esc)" size={ICON.sm} />
            </div>

            {/* Where you are, when you are somewhere rather than searching: one
                rounded bar, Home first, every segment a button that goes there
                and the last one bold because it is where you are. The hidden
                switch and the file-manager button sit on the same line because
                both are about THIS folder. */}
            {at && (
              <div className="flex items-center gap-2 px-3 py-1.5 shrink-0" style={{ borderBottom: LINE }}>
                <PathBar at={at} home={homeDir} onGo={jump} />
                <span className="ml-auto flex items-center gap-1.5 shrink-0">
                  {browsed?.hiddenSkipped || showHidden ? (
                    /* Said, and one click from undone: a folder that shows less
                       than it holds without saying so is a browser you stop
                       trusting, and the count is the switch that fixes it. */
                    <button className="px-2 rounded-md text-[10.5px]" aria-pressed={showHidden}
                      style={{ minHeight: HIT, color: showHidden ? "var(--text)" : "var(--primary-ink)", border: EDGE }}
                      title={showHidden ? "Hidden files and folders are listed. Click to leave them out again" : "Click to list hidden files and folders"}
                      onClick={() => { const on = !showHidden; setShowHidden(on); saveHidden(on); inputRef.current?.focus(); }}>
                      {showHidden
                        ? "Showing hidden · hide"
                        : `${browsed!.hiddenSkipped} hidden ${browsed!.hiddenSkipped === 1 ? "item" : "items"} left out · show`}
                    </button>
                  ) : null}
                  <RevealButton path={at} what="folder" />
                </span>
              </div>
            )}

            {/* the drawer, the reader and the rail */}
            <div className="flex-1 min-h-0 flex">
              <div className="shrink-0 flex flex-col min-h-0 relative"
                style={{ width: collapsed ? RAIL_W : drawerW, borderRight: LINE, background: "var(--surface-card)" }}>
                <div className={`flex items-center shrink-0 ${collapsed ? "justify-center py-2.5" : "justify-between px-4 pt-3.5 pb-2"}`}>
                  {!collapsed && (
                    <span className="text-[9.5px] uppercase tracking-[0.14em]" style={{ color: "var(--text4)", fontWeight: 600 }}>
                      {at ? "Folder" : "Results"} · {shown.length}
                    </span>
                  )}
                  <button onClick={() => setCollapsed((c) => !c)} title={collapsed ? "Show the results drawer (Ctrl+B)" : "Collapse to an icon rail (Ctrl+B)"}
                    aria-expanded={!collapsed} aria-label={collapsed ? "Show the results drawer" : "Collapse the results drawer"}
                    className="agx-btn rounded-md text-[10px] uppercase tracking-wider px-1.5" style={{ minHeight: HIT, color: "var(--text3)" }}>
                    {collapsed ? "»" : "« Icon rail"}
                  </button>
                </div>

                {/* The kinds in this list, with how many. Clicking one narrows to
                    it; several are an OR. Counted before they are applied. */}
                {!collapsed && chips.length > 1 && (
                  <div className="flex flex-wrap gap-1.5 px-4 pb-2.5 shrink-0" role="group" aria-label="File types">
                    {chips.slice(0, 10).map((c) => {
                      const on = activeExts.includes(c.ext);
                      return (
                        <button key={c.ext || "none"} aria-pressed={on} onClick={() => { setExts((x) => toggleExt(x, c.ext)); inputRef.current?.focus(); }}
                          title={on ? `Stop showing only ${chipLabel(c)}` : `Show only ${chipLabel(c)}`}
                          className="agx-btn text-[10.5px] px-2 py-0.5 rounded-full tabular-nums"
                          style={on
                            ? { background: "var(--text)", color: "var(--bg)", border: "1px solid var(--text)" }
                            : { color: "var(--text2)", border: EDGE }}>
                          {chipLabel(c)} <span style={{ opacity: on ? 0.75 : 0.6 }}>{c.count}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                <div ref={listRef} className="flex-1 min-h-0 agx-scroll overflow-y-auto overflow-x-hidden pb-2">
                  {collapsed ? (
                    <div className="flex flex-col items-center gap-1 py-1">
                      {shown.slice(0, 200).map((row, i) => {
                        const name = row.rel.slice(row.rel.lastIndexOf("/") + 1);
                        const kind = fileKind(name, row.kind === "dir");
                        const on = i === cursor;
                        return (
                          <button key={`${row.kind}:${row.rel}:${i}`} data-row={i} title={row.rel} aria-current={on ? "true" : undefined}
                            onClick={() => { setCursor((c) => reduceSelection(c, { type: "click", index: i }, shown.length)); openRow(row, false, true); }}
                            className="agx-pal-hit grid place-items-center rounded-lg"
                            style={{ width: 34, height: 34, color: KIND_INK[kind],
                              ...(on ? { background: "color-mix(in srgb, var(--text) 12%, transparent)", boxShadow: `inset 0 0 0 1px ${"color-mix(in srgb, var(--text) 22%, transparent)"}` } : null) }}>
                            <KindIcon kind={kind} />
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <Answers tab={tab} q={q} root={root} place={place} placeErr={placeErr} rows={shown} cursor={cursor}
                      status={status} onPick={(r, i) => { setCursor((c) => reduceSelection(c, { type: "click", index: i }, shown.length)); openRow(r, false, true); }}
                      onDouble={(r) => { if (viewRows.includes(r)) viewImage(r); else openRow(r); }} browsing={!!at}
                      browseError={browsed && !browsed.ok ? browsed.error ?? null : null}
                      needle={globAsked ? "" : (typedPath ? typedPath.tail : asked.text).trim()} />
                  )}
                </div>

                {!collapsed && (
                  <div role="separator" aria-orientation="vertical" aria-label="Resize the results drawer" aria-valuemin={DRAWER_MIN} aria-valuemax={DRAWER_MAX} aria-valuenow={drawerW}
                    tabIndex={0} onPointerDown={dragDrawer}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); setDrawerW((w) => clampDrawer(w - 16)); }
                      if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); setDrawerW((w) => clampDrawer(w + 16)); }
                    }}
                    className="absolute top-0 bottom-0 cursor-col-resize"
                    style={{ right: -3, width: 6, zIndex: 3 }}
                    title="Drag to resize" />
                )}
              </div>

              {/* Escape from the reader goes back to the box, and every other key
                  stays in the reader: an arrow there scrolls, and must not also
                  walk the list behind it. */}
              <div className="flex-1 min-w-0 min-h-0 flex"
                onKeyDown={(e) => {
                  if (e.target instanceof HTMLInputElement) return;
                  e.stopPropagation();
                  if (e.key === "Escape") { e.preventDefault(); inputRef.current?.focus(); return; }
                  if (e.key === "/" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setFindSignal((n) => n + 1); return; }
                  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "f") { e.preventDefault(); setFindSignal((n) => n + 1); return; }
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); benchRow(selRow); }
                }}>
                <FileView file={file} branch={git?.repo ? git.branch : undefined} jump={viewJump}
                  initialTop={scrollFor(snap.current, selAbs)} onTop={onTop}
                  onBench={() => benchRow(selRow)} canBrowser={!!file.kind && viewerActions(file.kind).browser && !!source?.abs}
                  onOpenBrowser={() => { if (source?.abs) openInBrowser(source.abs); }} findSignal={findSignal} />
              </div>

              {wide && showInfo && (
                <InfoRail file={file} git={git} outline={outline} current={outlineAt} home={homeDir}
                  onJump={jumpTo} onBench={() => benchRow(selRow)}
                  onCopyPath={(p) => { void navigator.clipboard?.writeText(p); }}
                  onOpenBrowser={openInBrowser} />
              )}
            </div>

            <div className="flex items-center gap-4 px-4 py-2 shrink-0 text-[10.5px]"
              style={{ borderTop: LINE, color: "var(--text4)" }}>
              <span>↑↓ next result</span>
              <span>⏎ {at ? "enter a folder" : "focus viewer"}</span>
              <span className="hidden md:inline">Ctrl+B drawer</span>
              <span className="hidden md:inline">Ctrl+I info</span>
              <span className="hidden lg:inline">{at ? "← up · ⇥ completes a path" : "type ~/ or ../ to move around"}</span>
              <span className="ml-auto truncate" aria-live="off">
                {chordLabel(appChordFor("files.palette"))} hides · {resumeLine({ file: file.name || null, section: sectionAt, tab: active.label, q })}
              </span>
            </div>
          </motion.div>
          </div>
        </Portal>
      )}
    </AnimatePresence>
    {open && viewAt !== null && viewFiles.length > 0 && (
      // Over the finder, which stays where it is underneath: Esc comes back to it.
      <Portal z={LAYER.paletteImage}>
        <FileViewer files={viewFiles} at={viewAt} setAt={setViewAt} openLink={false} />
      </Portal>
    )}
    </>
  );
}

/* --------------------------------------------------------------- the list */

function Answers({ tab, q, root, place, placeErr, rows, cursor, status, onPick, onDouble, browsing, browseError, needle }: {
  tab: PaletteTab; q: string; root: string; place: string; placeErr: string | null; rows: Row[]; cursor: number;
  status: { pending: boolean; error: string | null; data: { ok: boolean; error?: string; via?: string; truncated?: boolean } | null } | null;
  onPick: (row: Row, i: number) => void;
  /** A picture opens in the viewer on a double-click; nothing else does. */
  onDouble: (row: Row) => void;
  /** Looking at a folder rather than at results: the empty state, the floors
   *  and the "no checkout" note are all different questions there. */
  browsing?: boolean;
  browseError?: string | null;
  /** What the name is being matched against, drawn as a highlight in each row. */
  needle?: string;
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
            onPick={onPick} onDouble={onDouble} needle={needle} />
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
      {/* The count is in the drawer's header; what is worth a line here is the
          answer being incomplete. */}
      {status?.data?.truncated && (
        <div className="px-4 py-1.5 text-[10.5px]" style={{ color: "var(--warning-ink)" }}>
          Truncated — more matches than are listed. Narrow the search.
        </div>
      )}
      {rows.map((row, i) => (
        <RowView key={`${row.kind}:${row.rel}:${i}`} row={row} i={i} on={i === cursor}
          onPick={onPick} onDouble={onDouble} needle={needle} />
      ))}
    </>
  );
}

/** The three inks of a list row. Only size and age recede; the name is the
 *  text colour, whatever the file's icon says. */
/** The colour of each kind's icon: the state inks the app already guarantees
 *  against every theme, so a picture is warm and a note is cool on both grounds. */
const KIND_INK: Record<ReturnType<typeof fileKind>, string> = {
  dir: "var(--primary-ink)", markdown: "var(--info-ink)", code: "var(--success-ink)",
  image: "var(--warning-ink)", data: "var(--text2)", file: "var(--text3)",
};
function KindIcon({ kind }: { kind: ReturnType<typeof fileKind> }) {
  const size = ICON.md;
  return kind === "dir" ? <FolderIcon size={size} /> : kind === "markdown" ? <NoteIcon size={size} />
    : kind === "code" ? <CodeFileIcon size={size} /> : kind === "image" ? <ImageFileIcon size={size} /> : <FileIcon size={size} />;
}

export const NAME_INK = { name: "var(--text)", prefix: "var(--text3)", meta: "var(--text3)", metaOnCursor: "var(--text2)" } as const;

/** Where you are, as one bar: Home, then each folder a button, the last bold. */
function PathBar({ at, home, onGo }: { at: string; home: string; onGo: (abs: string) => void }) {
  const segs = pathBar(at, home);
  return (
    <nav aria-label="Folder path" className="flex items-center min-w-0 flex-1 rounded-md px-1 overflow-hidden"
      style={{ minHeight: HIT, background: "var(--surface-inset)", border: EDGE }}>
      {segs.map((c, i) => (
        <span key={c.path} className={`flex items-center ${c.last || c.home ? "shrink-0" : "min-w-0 shrink"}`}>
          {i > 0 && <span aria-hidden="true" className="px-0.5 text-[11px]" style={{ color: "var(--text3)" }}>/</span>}
          <button onClick={() => onGo(c.path)} aria-current={c.last ? "location" : undefined}
            className="agx-pal-hit inline-flex items-center gap-1 px-1.5 rounded min-w-0 text-[11px]"
            style={{ minHeight: HIT - 6, color: c.last ? "var(--text)" : "var(--text2)", fontWeight: c.last ? 650 : 400 }}
            title={c.path}>
            {c.home && <HomeIcon size={ICON.sm} />}
            <span className="truncate">{c.label}</span>
          </button>
        </span>
      ))}
    </nav>
  );
}

function RowView({ row, i, on, onPick, onDouble, needle }: {
  row: Row; i: number; on: boolean; onPick: (row: Row, i: number) => void; onDouble: (row: Row) => void; needle?: string;
}) {
  const cut = row.rel.lastIndexOf("/");
  const name = row.rel.slice(cut + 1);
  const dir = cut >= 0 ? row.rel.slice(0, cut + 1) : "";
  const kind = fileKind(name, row.kind === "dir");
  /* The second line, in the order a file is told apart by: where it is, how big,
     how old. What a row does not know is left out rather than drawn as a dash. */
  const facts: string[] = [];
  if (dir) facts.push(dir);
  if (row.kind === "file" && row.bytes != null) facts.push(humanBytes(row.bytes));
  if (row.kind === "dir" && row.items != null) facts.push(`${row.items} item${row.items === 1 ? "" : "s"}`);
  if (row.kind === "dir" && row.items == null && !dir) facts.push("folder");
  const when = row.kind === "recent" ? row.at : row.mtime;
  if (when) facts.push(ago(when));
  /* The part of the name that matched, marked — the highlight is how a list of
     near-identical names says why each one is here. */
  const at = needle ? name.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  /* No onMouseEnter: a pointer resting on a row is not a choice, so hover is
     only the CSS tint of agx-pal-hit and the selection is the click or the
     keys. See finderSelection.ts. */
  return (
    <button data-row={i} onClick={() => onPick(row, i)} onDoubleClick={() => onDouble(row)}
      className="agx-pal-hit text-left px-3 py-2 rounded-lg block" title={row.kind !== "recent" && row.locked ? `${row.rel} — ${row.why ?? "listed, but kept closed: it holds credentials or is off-limits from here"}` : row.rel}
      aria-current={on ? "true" : undefined}
      style={{
        /* Inset from the list's edges so the selection is a pill, not a band. */
        width: "calc(100% - 16px)", margin: "0 8px 2px", minHeight: 48,
        ...(on ? { background: "color-mix(in srgb, var(--text) 10%, transparent)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--text) 16%, transparent)" } : null),
        ...((row.kind === "recent" && row.gone) || (row.kind !== "recent" && row.locked) ? { opacity: 0.55 } : null),
      }}>
      <div className="flex items-center gap-3 text-[12.5px]">
        {/* The icon may carry a kind's colour; the NAME never does. A language
            tint chosen for a dark editor is close to invisible on a light
            theme (measured: the markdown grey came to 1.2:1), and a list of
            names nobody can read is a list of nothing. */}
        <span className="shrink-0 flex" style={{ color: KIND_INK[kind] }}><KindIcon kind={kind} /></span>
        <span className="min-w-0 truncate" style={{ color: NAME_INK.name, fontWeight: 500 }}>
          {at >= 0 ? (
            <>
              {name.slice(0, at)}
              <mark style={{ background: "color-mix(in srgb, var(--warning) 34%, transparent)", color: "inherit", borderRadius: 2, padding: "0 1px" }}>{name.slice(at, at + needle!.length)}</mark>
              {name.slice(at + needle!.length)}
            </>
          ) : name}{row.kind === "dir" ? "/" : ""}
        </span>
        {row.kind === "recent" && row.gone && (
          /* Named, not merely greyed: "not on this branch" is the fact, and
             it is the difference between a broken app and a checkout that
             moved under you. Pressing it forgets the entry. */
          <span className="ml-auto shrink-0 text-[9px] px-1.5 rounded" style={{ color: "var(--warning-ink)", border: "1px solid color-mix(in srgb, var(--warning) 32%, transparent)" }}>
            not here now · ⏎ forgets
          </span>
        )}
      </div>
      {facts.length > 0 && (
        <div className="mt-0.5 pl-7 truncate text-[10.5px] tabular-nums" style={{ color: on ? NAME_INK.metaOnCursor : NAME_INK.meta }}>
          {facts.join(" · ")}
        </div>
      )}
      {row.kind === "file" && row.hits && (
        <div className="mt-1 flex flex-col gap-px">
          {row.hits.slice(0, 4).map((h, n) => (
            <div key={n} className="flex items-baseline gap-2 text-[11px]">
              <span className="shrink-0 tabular-nums w-8 text-right" style={{ color: "var(--info-ink)", opacity: 0.75 }}>{h.line}</span>
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
            <div className="text-[9.5px] pl-10" style={{ color: "var(--text4)" }}>
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
        style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: EDGE, color: "var(--text2)" }}
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
              background: "var(--surface-card)", border: edge(30),
            }}
            onKeyDown={menuKeys(() => setOpen(false))}>
            {/* Said once, at the top: the pair of chips is only unambiguous
                if each menu also says which question it answers. */}
            {/* Label and explanation are two different kinds of text, so they
                get 6px: touching, the caption read as the first line of the
                sentence under it. */}
            <div className="px-3 pt-2 pb-1.5 shrink-0 flex flex-col gap-1" style={{ borderBottom: LINE }}>
              <div className="text-[9px] uppercase tracking-wider" style={{ color: "var(--text2)" }}>Where</div>
              <div className="text-[10px]" style={{ color: "var(--text4)" }}>a copy on disk — each has its own branch and its own uncommitted work</div>
            </div>
            {repos.length > 6 && (
              <input ref={field} value={filter} onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter checkouts…" spellCheck={false}
                className={`m-1.5 shrink-0 ${INPUT}`}
                style={INPUT_STYLE} />
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
                        style={{ color: "var(--primary-ink)", border: "1px solid color-mix(in srgb, var(--primary) 32%, transparent)" }}>WT</span>
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
function PlaceChip({ place, places, recents, error, homeDir, openState, onPick }: {
  place: string; places: DiskPlace[]; recents: string[]; error: string | null; homeDir: string;
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

  const typedIsPath = isPath(typed.trim());
  /* Two sections like a file manager's sidebar — see `placeSections`. A typed
     path replaces them with what the disk completes it to. */
  const sections = placeSections(typedIsPath ? [] : places, typedIsPath ? [] : recents, place, typed, homeDir);
  const completions: PlaceRow[] = sugg.map((e) => ({ path: e.path, name: e.name, sub: shortenHome(e.path, homeDir), home: false, recent: false }));
  const flat = typedIsPath ? completions : sections.flat;
  /* One cursor over both sections. A typed path starts with none, so ⏎ means
     "go where I typed" until an arrow key picks a row. */
  const [cur, setCur] = useState(0);
  useEffect(() => { setCur(typedIsPath ? -1 : 0); }, [typed, typedIsPath, open]);
  useEffect(() => {
    listEl.current?.querySelector<HTMLElement>(`[data-place="${cur}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cur]);
  const listEl = useRef<HTMLDivElement>(null);

  const Item = ({ r, i }: { r: PlaceRow; i: number }) => (
    <button key={`${r.recent ? "r" : "p"}:${r.path}`} data-place={i} onClick={() => onPick(r.path)} onMouseEnter={() => setCur(i)}
      role="option" aria-selected={i === cur}
      className="agx-pal-hit text-left px-2.5 flex items-center gap-2 rounded-md"
      style={{
        width: "calc(100% - 12px)", margin: "0 6px", minHeight: HIT,
        ...(i === cur ? { background: "color-mix(in srgb, var(--primary) 16%, transparent)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--primary) 40%, transparent)" }
          : r.path === place ? { background: "color-mix(in srgb, var(--text) 6%, transparent)" } : null),
      }}>
      <span className="shrink-0 flex" style={{ color: "var(--text2)" }}>
        {r.home ? <HomeIcon size={ICON.md} /> : r.recent ? <ClockIcon size={ICON.md} /> : <FolderIcon size={ICON.md} />}
      </span>
      <span className="shrink-0 max-w-[45%] truncate" style={{ color: "var(--text)", fontWeight: r.recent ? 600 : 500 }}>{r.name}</span>
      <span className="ml-auto min-w-0 truncate text-[10.5px]" style={{ color: "var(--text3)" }} title={r.path}>{r.sub}</span>
    </button>
  );
  const onFieldKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Escape is the menu's, one level up — see menuKeys.
    // Tab takes the first completion, Enter takes what you typed —
    // the two things those keys mean in a shell.
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) { e.preventDefault(); setCur((c) => (flat.length ? (c + 1) % flat.length : -1)); return; }
    if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) { e.preventDefault(); setCur((c) => (flat.length ? (c <= 0 ? flat.length - 1 : c - 1) : -1)); return; }
    if (e.key === "Tab") { e.preventDefault(); if (sugg.length) setTyped(`${sugg[0]!.path}/`); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = flat[cur];
      if (row) onPick(row.path);
      else if (typedIsPath) onPick(typed.trim().replace(/\/+$/, ""));
    }
  };

  const heading = (text: string) => (
    <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider" style={{ color: "var(--text2)" }}>{text}</div>
  );

  return (
    <>
      <button ref={btn} onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[10.5px] px-2 py-1 rounded-md max-w-[220px] shrink-0"
        style={{ background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: EDGE, color: "var(--text2)" }}
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
              background: "var(--surface-card)", border: edge(30),
            }}
            onKeyDown={menuKeys(() => setOpen(false))}>
            <div className="px-3 pt-2 pb-1.5 shrink-0 flex flex-col gap-1" style={{ borderBottom: LINE }}>
              <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text2)" }}>Where on this machine</div>
              <div className="text-[10.5px]" style={{ color: "var(--text3)" }}>your home folder and what is under it — hidden folders are never searched</div>
            </div>
            <input ref={field} value={typed} onChange={(e) => setTyped(e.target.value)}
              placeholder="Filter, or type a path like ~/Documents…" spellCheck={false} autoComplete="off"
              onKeyDown={onFieldKey}
              className={`m-1.5 shrink-0 ${INPUT}`}
              style={INPUT_STYLE} />
            <div ref={listEl} role="listbox" aria-label="Places on this machine" className="agx-scroll overflow-y-auto overflow-x-hidden pb-1.5" style={{ minHeight: 0 }}>
              {error && <div className="px-3 py-2" style={{ color: "var(--error-ink)" }}>{error}</div>}
              {typedIsPath && completions.map((r, i) => <Item key={r.path} r={r} i={i} />)}
              {typedIsPath && !sugg.length && (
                <div className="px-3 py-2" style={{ color: "var(--text3)" }}>Nothing under that path yet — ⏎ searches it anyway.</div>
              )}
              {!typedIsPath && sections.places.length > 0 && heading("Places")}
              {!typedIsPath && sections.places.map((r, i) => <Item key={r.path} r={r} i={i} />)}
              {!typedIsPath && sections.recent.length > 0 && heading("Recent")}
              {!typedIsPath && sections.recent.map((r, i) => <Item key={r.path} r={r} i={sections.places.length + i} />)}
              {!error && !flat.length && !typedIsPath && (
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
          ? { background: "color-mix(in srgb, var(--info) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--info) 45%, transparent)", color: "var(--info-ink)" }
          : { background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: EDGE, color: "var(--text2)" }}>
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
              maxHeight: "min(460px, 66vh)", background: "var(--surface-card)", border: edge(30),
            }}
            onKeyDown={menuKeys(() => setOpen(false))}>
            <div className="px-3 pt-2 pb-1.5 shrink-0 flex flex-col gap-1" style={{ borderBottom: LINE }}>
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
              className={`m-1.5 shrink-0 ${INPUT}`}
              style={INPUT_STYLE} />
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
                        style={{ color: "var(--primary-ink)", border: "1px solid color-mix(in srgb, var(--primary) 32%, transparent)" }}>WT</span>
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
          ? { background: "color-mix(in srgb, var(--info) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--info) 45%, transparent)", color: "var(--info-ink)" }
          : { background: "color-mix(in srgb, var(--bg3) 50%, transparent)", border: EDGE, color: "var(--text3)" }}>
        <span className="truncate min-w-0">{on ? value : "working tree"}</span>
        <span className="shrink-0" style={{ color: on ? "var(--info)" : "var(--text3)" }}>▾</span>
      </button>
      {open && box && (
        <Portal z={LAYER.menu}>
          <div className="fixed inset-0" onClick={() => setOpen(false)} />
          <div className="fixed rounded-lg text-[11px] shadow-2xl flex flex-col overflow-hidden"
            style={{
              top: box.top, right: box.right, width: "min(420px, calc(100vw - 16px))",
              maxHeight: "min(360px, 55vh)", background: "var(--surface-card)", border: edge(30),
            }}
            onKeyDown={menuKeys(() => setOpen(false))}>
            {/* Only once there are enough to hunt through. Below that the list
                IS the answer and a field in front of it is one more thing to
                get past. */}
            <div className="px-3 pt-2 pb-1.5 shrink-0 flex flex-col gap-1" style={{ borderBottom: LINE }}>
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
                className={`m-1.5 shrink-0 ${INPUT}`}
                style={INPUT_STYLE} />
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
              style={{ borderTop: LINE, color: "var(--text4)" }}>
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
      borderTop: first ? "none" : LINE,
      borderBottom: LINE,
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
          ? { color: "var(--info-ink)", border: "1px solid color-mix(in srgb, var(--info) 30%, transparent)" }
          : { color: "var(--text3)", border: EDGE }}>
        {remote ? "RM" : "LO"}
      </span>
      <span className="truncate min-w-0" style={{ color: "var(--text)" }}>{name}</span>
      {/* The one this worktree is already on. Searching it is the same answer
          as the working tree minus anything uncommitted, and saying so stops
          that being a surprise. */}
      {head && (
        <span className="ml-auto shrink-0 text-[8.5px] px-1 rounded"
          style={{ color: "var(--text3)", border: EDGE }}>
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
