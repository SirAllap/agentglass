// "Open projects" — which projects is this cockpit about?
//
// Shown on first open (when the instance isn't scoped yet) and reachable from
// the header afterwards. Picking projects hands the server their directories:
// the dashboard, git panel and terminal then work on exactly those. One project
// is a click on its row; several are ticked and opened together. The choice is
// persisted server-side (config.json), so the next launch opens the same ones.
//
// Two panes: a rail (where the list comes from, and the one Add… button) and a
// right side that is the list, or the step being done (add a folder, clone,
// create, a GitHub repo, where agents worked, the result of an open). The list is
// the projects under the folders the person added and nothing else; the sweep of
// every place an agent ran is its own rail item, never the default.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Portal } from "../Portal.tsx";
import { api, IS_DEMO } from "../../lib/api.ts";
import { CAN_BROWSE_FOLDER, chooseFolder } from "../../lib/desktop.ts";
import { SCROLLBAR_CSS } from "../diff/DiffLines.tsx";
import { CloseButton } from "../CloseButton.tsx";
import { ContextMenu, MenuItem } from "../ContextMenu.tsx";
import { EDGE, ListRow } from "../workspace/Chrome.tsx";
import { RemoteRepoPage } from "../RemoteRepoPage.tsx";
import { useRemoteList, useRemoteRefresh, useRemoteTicks } from "../remoteRepoRows.tsx";
import { RIcon } from "../remoteIcons.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { firstRun, initialTicks, nextScope } from "../../lib/projectPick.ts";
import { clearCloneRequest, cloneRequest, parseRepoInput, requestRemoteOpen, showFirstRunHero, subscribeSlots, tickRemote } from "../../lib/remoteRepos.ts";
import { openPr, openPrs } from "../../lib/openPrs.ts";
import { likelyParent } from "../../lib/projectsPaths.ts";
import { buildGroups, flatten, navRoots, queryTerms, railCounts, uniqueRoots, type Source } from "../../lib/projectsView.ts";
import { enterTargets, keyCommand, moveHot } from "../../lib/projectsKeys.ts";
import { useProjectsModal } from "./useProjectsModal.ts";
import { Rail } from "./Rail.tsx";
import { ProjectList, NoMatch } from "./ProjectList.tsx";
import { AddMenu } from "./AddMenu.tsx";
import { FolderPane } from "./FolderPane.tsx";
import { CreatePane } from "./CreatePane.tsx";
import { AgentsPane } from "./AgentsPane.tsx";
import { ResultPane } from "./ResultPane.tsx";
import { FirstRun, ForgotFolder, GithubShelf, KeysLegend, UndoToast } from "./SidePanes.tsx";
import { ADD_ROWS, folderRoute } from "../../lib/addRows.ts";
import { StateCard, Tile, wash } from "./ui.tsx";
import { BranchIcon } from "../../lib/glyphIcons.tsx";

/** `workspaces` is every open project, empty while none is — or while the server
 *  has not answered, in which case no row is marked open, which is the honest
 *  rendering: the picker does not know either. */
export function ProjectsModal({ open, workspaces, known, onClose }: { open: boolean; workspaces: readonly string[]; known: boolean; onClose: () => void }) {
  const m = useProjectsModal({ open, workspaces, known, onClose });
  const remotes = useRemoteList();
  const remoteTicks = useRemoteTicks();
  const remoteState = useRemoteRefresh(open && m.pane === "list");
  const wantClone = useSyncExternalStore(subscribeSlots, cloneRequest, () => null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [githubStart, setGithubStart] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addIndex, setAddIndex] = useState(0);
  const [legend, setLegend] = useState(false);
  const [rowMenu, setRowMenu] = useState<{ root: string; name: string; x: number; y: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const searchRef = useRef<HTMLInputElement>(null);
  const addBtn = useRef<HTMLButtonElement>(null);
  const { repos, roots, hidden, source, query, hot, ticked, pane } = m;
  const folders = roots;
  const terms = queryTerms(query);

  useEffect(() => { if (open) setNow(Date.now()); }, [open]);
  const suggestedParent = useMemo(() => likelyParent(repos, workspaces[0]), [repos, workspaces]);
  // Only ever a default: once somebody edits it, their answer stands.
  useEffect(() => { if (open && !parent) setParent(suggestedParent); }, [open, suggestedParent, parent]);
  // "Clone to work on it" from a read-only repository: this pane, with the repository filled in.
  useEffect(() => {
    if (!wantClone || !open) return;
    m.setPane("clone"); m.setError(""); setUrl(`https://github.com/${wantClone.repo}.git`);
    clearCloneRequest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantClone, open]);

  const groups = useMemo(
    () => buildGroups({ repos: repos ?? [], folders, workspaces, hidden, showHidden: m.showHidden, query, source }),
    [repos, folders, workspaces, hidden, m.showHidden, query, source],
  );
  const items = useMemo(() => flatten(groups), [groups]);
  const shown = useMemo(() => uniqueRoots(groups), [groups]);
  const counts = useMemo(() => railCounts(repos ?? [], folders, workspaces, hidden), [repos, folders, workspaces, hidden]);

  // The highlight follows what is on screen: a search puts it on the first match.
  useEffect(() => {
    const roots_ = navRoots(items);
    if (hot && roots_.includes(hot)) return;
    m.setHot(terms.length ? roots_[0] ?? null : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const isFirstRun = firstRun(repos, roots, false, known ? workspaces : null);
  const pending = nextScope(ticked, workspaces);
  const openRemote = (repo: string) => { requestRemoteOpen(repo); openPrs(""); m.close(); };
  const openTicked = () => { if (pending) void m.openScope(pending); else if (remoteTicks[0]) openRemote(remoteTicks[0]); else if (!ticked.length) return; else m.close(); };
  const back = () => { if (source.kind === "agents") m.setSource({ kind: "all" }); m.back(); };
  const copy = (text: string) => { try { void navigator.clipboard.writeText(text); m.say(`Copied ${text}`); } catch { /* no clipboard */ } };
  const browse = async () => { const picked = await chooseFolder(roots[0] || parent || undefined); if (picked) void m.addRoot(picked); };
  const addRoute = (k: (typeof ADD_ROWS)[number]["key"]) => {
    setAddOpen(false); m.setError("");
    if (k === "folder") { if (folderRoute(CAN_BROWSE_FOLDER) === "chooser") void browse(); else m.setPane("folder"); return; }
    if (k === "github") setGithubStart("");
    m.setPane(k);
  };
  const addMany = async (paths: string[]) => {
    m.setBusy(true);
    try { for (const p of paths) await api.setProjectRoot(p, true); await m.load(false); m.setSource({ kind: "all" }); m.say(`Added ${paths.length} project${paths.length === 1 ? "" : "s"} to your list`); }
    catch (e) { m.setError(String(e)); } finally { m.setBusy(false); }
  };

  // Every key goes through the one map in lib/projectsKeys.ts.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest?.(".xterm") || rowMenu || (e.key === "Escape" && el?.dataset?.suggestions === "1")) return;
      const inField = !!el?.matches?.("input, textarea, select, [contenteditable='true']");
      const form = pane !== "list" || source.kind === "agents";
      const cmd = keyCommand(e, { inField, inSearch: el === searchRef.current, query, pane: form ? "form" : "list", legendOpen: legend, menuOpen: addOpen, canUndo: !!m.toast?.undo, busy: m.busy });
      if (!cmd) return;
      if (source.kind === "gh" && pane === "list" && !["close", "legend", "closeLegend", "closeMenu", "menuMove", "menuPick", "undo", "add", "source"].includes(cmd.t)) return;
      e.preventDefault(); e.stopPropagation();
      switch (cmd.t) {
        case "closeLegend": setLegend(false); break;
        case "closeMenu": setAddOpen(false); break;
        case "clearQuery": m.setQuery(""); break;
        case "back": back(); break;
        case "close": m.close(); break;
        case "focusSearch": searchRef.current?.focus(); searchRef.current?.select(); break;
        case "move": m.setHot(moveHot(navRoots(items), hot, cmd.by)); break;
        case "tick": if (hot) m.toggleTick(hot); break;
        case "tickAll": m.setTicked(shown); break;
        case "open": { const t = enterTargets(hot, ticked); if (hot) m.choose(hot); else if (t.length || remoteTicks.length) openTicked(); break; }
        case "openTicked": openTicked(); break;
        case "undo": m.toast?.undo?.(); m.setToast(null); break;
        case "legend": setLegend(true); break;
        case "add": setAddIndex(0); setAddOpen(true); break;
        case "forget": { const r = hot && (repos ?? []).find((x) => x.root === hot); if (r) m.toggleHidden(r.root, r.name); break; }
        case "source": { const order: Source[] = [{ kind: "all" }, { kind: "open" }, ...folders.map((root): Source => ({ kind: "folder", root })), { kind: "gh" }, { kind: "agents" }]; const at = Math.max(0, order.findIndex((o) => JSON.stringify(o) === JSON.stringify(source))); m.setSource(order[(at + cmd.by + order.length) % order.length]!); if (pane !== "list") m.setPane("list"); m.setQuery(""); break; }
        case "menuMove": setAddIndex((i) => (i + cmd.by + ADD_ROWS.length) % ADD_ROWS.length); break;
        case "menuPick": addRoute(ADD_ROWS[(cmd.n ? cmd.n - 1 : addIndex)]!.key); break;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const headSub = pane === "list" && source.kind !== "gh" && source.kind !== "agents"
    ? (terms.length ? `${shown.length} of ${counts.all} match “${query.trim()}”` : "Tick several to open them together")
    : pane === "folder" ? "Add › Folder" : pane === "github" ? "Add › GitHub repo" : pane === "clone" ? "Add › Clone from URL" : pane === "new" ? "Add › New project" : pane === "result" ? "Opening" : source.kind === "agents" ? "Where agents worked" : "GitHub repos";

  const pasted = terms.length && !shown.length ? parseRepoInput(query) : null;
  const scopeMachine = known && !workspaces.length;
  const sourceNow: Source = source;

  let right: React.ReactNode;
  if (pane === "folder") right = <FolderPane roots={roots} listedRoots={(repos ?? []).map((r) => r.root)} busy={m.busy} error={m.error} onBack={back} onAdd={(d) => void m.addRoot(d)} onChooser={CAN_BROWSE_FOLDER ? () => void browse() : undefined} />;
  else if (pane === "github") right = <RemoteRepoPage initial={githubStart} onCancel={back} onShow={() => { m.setPane("list"); m.setSource({ kind: "gh" }); m.setQuery(""); }} onAdded={(repo, pr) => { m.setPane("list"); m.setSource({ kind: "gh" }); m.setError(""); if (pr) { openPr(repo, pr); m.close(); } else m.say(`Added ${repo} · read-only, nothing cloned`); }} />;
  else if (pane === "clone" || pane === "new") right = <CreatePane kind={pane} value={pane === "clone" ? url : name} setValue={pane === "clone" ? setUrl : setName} parent={parent} setParent={setParent} busyElsewhere={m.busy} onBack={back}
    onCreated={(path, par, note) => { if (note) console.warn(`[agentglass] ${note}`); void m.adopt(path, par); }} />;
  else if (pane === "result" && m.results) right = <ResultPane rows={m.results} opened={m.opened} busy={m.busy} onBack={() => { m.setResults(null); m.back(); }}
    onRetry={() => void m.openScope(m.results!.map((r) => r.path))} onOpenReady={(paths) => void m.openScope(paths)} />;
  else if (source.kind === "agents") right = <AgentsPane listed={(repos ?? []).map((r) => r.root)} busy={m.busy} onBack={back} onAdd={(paths) => void addMany(paths)} />;
  else if (source.kind === "gh") {
    const rows = remotes.filter((r) => terms.every((t) => r.repo.toLowerCase().includes(t)));
    right = <GithubShelf rows={rows} total={remotes.length} ticks={remoteTicks} busy={m.busy} state={remoteState} onOpen={openRemote} onAdd={() => addRoute("github")} />;
  } else if (m.forgotFolder && !roots.length) right = <ForgotFolder path={m.forgotFolder.path} count={m.forgotFolder.count} onUndo={() => m.toast?.undo?.()} onAdd={() => addRoute("folder")} />;
  else if (repos !== null && showFirstRunHero(isFirstRun, remotes.length)) right = <FirstRun busy={m.busy} onChooser={() => void browse()} onTyped={() => m.setPane("folder")} onAgents={() => m.setSource({ kind: "agents" })} onGithub={() => m.setSource({ kind: "gh" })} />;
  else right = (
    <ProjectList tabs={m.tabs} loading={repos === null} items={items} groups={groups} total={counts.all} query={query} setQuery={m.setQuery} searchRef={searchRef} hot={hot} setHot={m.setHot}
      ticked={ticked} setTicked={m.setTicked} toggleTick={m.toggleTick} hidden={hidden} workspaces={workspaces} busy={m.busy} now={now} hiddenCount={counts.hidden}
      showHidden={m.showHidden} setShowHidden={m.setShowHidden} tickedN={ticked.length} shownN={shown.length} remoteTicked={remoteTicks.length} opening={m.busy}
      onOpen={m.choose} onOpenTicked={openTicked} onForget={(r) => m.toggleHidden(r.root, r.name)} onForgetFolder={(d) => void m.forgetFolder(d)}
      onMenu={(r, x, y) => setRowMenu({ root: r.root, name: r.name, x, y })} onCopy={copy} onAddAll={(paths) => void addMany(paths)} onReset={() => { m.setTicked(initialTicks(workspaces, repos ?? [])); remoteTicks.forEach((t) => tickRemote(t, false)); }}
      emptyHint={terms.length
        ? <NoMatch query={query}>{pasted && (pasted.kind === "repo" || pasted.kind === "other-host") && <ListRow onClick={() => { setGithubStart(query); m.setPane("github"); }} leading={<RIcon name="cloud" size={ICON.sm} />} style={{ color: "var(--primary-hover)" }}>Add from GitHub: {query.trim()}</ListRow>}</NoMatch>
        : <StateCard hue="muted" icon={<RIcon name="search" size={ICON.lg} />} title="No git repositories here yet">Add another folder with Add…, or clone one.</StateCard>} />
  );

  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} className="fixed inset-0 agx-scrim" style={{ zIndex: 10000 }} onClick={m.close} />
            <div className="fixed inset-0 flex items-center justify-center p-3 pointer-events-none" style={{ zIndex: 10001 }}>
              <motion.div role="dialog" aria-modal="true" aria-label="Open projects"
                initial={{ opacity: 0, scale: 0.97, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98, y: 4 }} transition={{ duration: 0.14, ease: "easeOut" }}
                className="relative flex flex-col pointer-events-auto overflow-hidden rounded-xl"
                style={{ width: 1180, height: 760, maxWidth: "96vw", maxHeight: "94vh", background: "var(--surface-card)", border: EDGE, boxShadow: "0 30px 80px -20px rgba(0,0,0,0.6)" }}>
                <style>{SCROLLBAR_CSS}{`.agx-rail-item .agx-forget{opacity:0}.agx-rail-item:hover .agx-forget,.agx-rail-item:focus-within .agx-forget{opacity:1}.pm-px{padding-inline:18px}.pm-mx{margin-inline:18px}`}</style>
                <div className="flex items-center gap-3 shrink-0" style={{ padding: "14px 18px 10px" }}>
                  <Tile size={36} hue="primary"><BranchIcon size={ICON.md} /></Tile>
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-bold truncate" style={{ color: "var(--text)" }}>Open projects</div>
                    <div className="text-[12px] truncate" style={{ color: "var(--text3)" }} aria-live="polite">{headSub}</div>
                  </div>
                  <CloseButton onClick={m.close} title="Close (Esc)" />
                </div>
                <div className="flex flex-1 min-h-0">
                  <Rail source={sourceNow} setSource={(s) => { m.setSource(s); if (pane !== "list") m.setPane("list"); m.setQuery(""); }} counts={counts} folders={folders} ghCount={remotes.length}
                    onForgetFolder={(d) => void m.forgetFolder(d)} scopeMachine={scopeMachine} canFolders={folders.length > 0} diskNote={scopeMachine ? `Reads your disk; slower. ${counts.all} repos.` : undefined} onScope={(machine) => void m.openScope(machine ? [] : folders)}
                    onAdd={() => { setAddIndex(0); setAddOpen((v) => !v); }} addOpen={addOpen} busy={m.busy} addButtonRef={addBtn} />
                  <div className="flex flex-col flex-1 min-w-0 min-h-0">
                    {m.error && pane === "list" && <div role="alert" className="pm-mx mt-2 rounded-lg px-3 py-2 text-[12px] shrink-0" style={{ color: "var(--error)", background: wash("var(--error)", 8), overflowWrap: "anywhere" }}>{m.error}</div>}
                    {IS_DEMO && <div className="pm-mx mt-2 text-[12px] shrink-0" style={{ color: "var(--text2)" }}>The demo is never scoped — run agentglass locally to open a project</div>}
                    {right}
                  </div>
                </div>
                {addOpen && <><div className="absolute inset-0 z-[4]" onClick={() => setAddOpen(false)} /><AddMenu index={addIndex} setIndex={setAddIndex} onPick={addRoute} /></>}
                {m.toast && <UndoToast toast={m.toast} onDone={() => m.setToast(null)} />}
                {legend && <KeysLegend onClose={() => setLegend(false)} />}
                {rowMenu && (
                  <ContextMenu x={rowMenu.x} y={rowMenu.y} onClose={() => setRowMenu(null)}>
                    <MenuItem onClick={() => { copy(rowMenu.root); setRowMenu(null); }}>Copy path</MenuItem>
                    {!workspaces.includes(rowMenu.root) && (
                      <MenuItem danger={!hidden.includes(rowMenu.root)} onClick={() => { m.toggleHidden(rowMenu.root, rowMenu.name); setRowMenu(null); }}>
                        {hidden.includes(rowMenu.root) ? "Put back on the list" : "Forget this project"}
                      </MenuItem>
                    )}
                    <div className="px-2 pb-1 pt-0.5 text-[10.5px] leading-snug" style={{ color: "var(--text4)" }}>Only here — the folder is not touched</div>
                  </ContextMenu>
                )}
              </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
}
