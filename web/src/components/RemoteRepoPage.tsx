// "Add a GitHub repo": a pane of the Open projects dialog, drawn as frame 8 of the
// mockup: found, not found with close matches, no access, offline, already listed.
//
// One input, one answer card, and Add that stays off until the card says
// "found", with the reason on its tooltip. Nothing here clones, starts an agent
// or touches the server's config: it asks `GET /gh/repo-lookup` and writes to
// this browser's list (lib/remoteRepos.ts).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { api } from "../lib/api.ts";
import { ICON } from "../lib/iconSize.ts";
import { WarningIcon } from "../lib/glyphIcons.tsx";
import { relTime } from "../lib/projectsPaths.ts";
import {
  addReason, addRemote, canAdd, cardState, findRemote, parseRepoInput, remoteRepos, saveRemotes, subscribeRemotes, tickRemote,
  type Lookup, type LookupAnswer, type RemoteRepo,
} from "../lib/remoteRepos.ts";
import { Button, INPUT, INPUT_STYLE } from "./workspace/Chrome.tsx";
import { RIcon, type RIconName } from "./remoteIcons.tsx";
import { Foot, HAIR, HUE, Kbd, PaneHead, StateCard, Status, Why, type Hue } from "./projects/ui.tsx";

const DEBOUNCE_MS = 300;
/** One re-check per repository per this long: the button is a courtesy, not a poll. */
const FRESH_GAP_MS = 5_000;
const SIGN_IN = "gh auth refresh -s repo";

/** Two names one edit or two apart, for "close matches" — drawn from the list the person already keeps. */
function distance(a: string, b: string): number {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return m[a.length][b.length];
}
export const closeMatches = (typed: string, list: readonly RemoteRepo[]): string[] =>
  list.map((r) => r.repo).filter((r) => distance(r.toLowerCase(), typed.toLowerCase()) <= 2);

/** A command to copy, with the press said out loud. */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={() => { try { void navigator.clipboard.writeText(text); } catch { /* no clipboard */ } setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="agx-btn inline-flex items-center gap-2 px-2 py-1 rounded-md text-[11px] font-mono" title="Copy"
      style={{ color: "var(--text2)" }}>
      {text}<span style={{ color: "var(--text3)" }}>{copied ? "copied" : <RIcon name="copy" size={ICON.xs} />}</span>
    </button>
  );
}

export function RemoteRepoPage({ initial, onCancel, onAdded, onShow }: {
  /** Text to start with: what was typed in the list's filter. */
  initial?: string;
  onCancel: () => void;
  /** Added, and ticked. `pr` is set when the pasted link named a pull request. */
  onAdded: (repo: string, pr?: number) => void;
  /** "Already on your list": leave this pane and look at the GitHub list. */
  onShow?: (repo: string) => void;
}) {
  const [text, setText] = useState(initial ?? "");
  const [lookup, setLookup] = useState<Lookup>({ phase: "idle" });
  const list = useSyncExternalStore(subscribeRemotes, remoteRepos, () => []);
  const parsed = useMemo(() => parseRepoInput(text), [text]);
  const repoKey = parsed.kind === "repo" ? parsed.repo : "";
  const asked = useRef(0);
  const lastFresh = useRef<Record<string, number>>({});

  const ask = (repo: string, fresh: boolean) => {
    const id = ++asked.current;
    setLookup({ phase: "checking" });
    api.ghRepoLookup(repo, fresh)
      .then((answer) => { if (id === asked.current) setLookup({ phase: "done", answer }); })
      .catch(() => { if (id === asked.current) setLookup({ phase: "done", answer: { found: false, error: "unreachable" } }); });
  };

  // One request per settled input. An answer that arrives after the text has
  // moved on is dropped by `asked`, not drawn over the newer one.
  useEffect(() => {
    asked.current++;
    if (!repoKey || findRemote(remoteRepos(), repoKey)) { setLookup({ phase: "idle" }); return; }
    setLookup({ phase: "checking" });
    const t = setTimeout(() => ask(repoKey, false), DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoKey]);

  const card = cardState(parsed, lookup, list);
  const answer: LookupAnswer | null = lookup.phase === "done" ? lookup.answer : null;
  const found = answer?.found ? answer : null;
  const pr = parsed.kind === "repo" ? parsed.pr : undefined;
  const listed = repoKey ? findRemote(list, repoKey) : undefined;

  const recheck = () => {
    if (!repoKey) return;
    const now = Date.now();
    if (now - (lastFresh.current[repoKey.toLowerCase()] ?? 0) < FRESH_GAP_MS) return;
    lastFresh.current[repoKey.toLowerCase()] = now;
    ask(repoKey, true);
  };

  const add = () => {
    if (!found || !canAdd(card)) return;
    saveRemotes(addRemote(remoteRepos(), found, Date.now()));
    tickRemote(found.repo, true);
    onAdded(found.repo, pr);
  };

  const field: Hue | undefined = card === "found" ? "success" : card === "not-found" || card === "no-access" ? "error" : undefined;
  const near = card === "not-found" ? closeMatches(repoKey, list) : [];
  const hueOf = (h: Hue | undefined) => (h ? HUE[h] : "var(--border)");

  const body = ((): { hue: Hue; icon: ReactNode; title: ReactNode; badge?: ReactNode; text?: ReactNode; actions?: ReactNode; mono?: boolean; spin?: boolean } | null => {
    const account = answer && !answer.found ? answer.account : undefined;
    const rio = (n: RIconName) => <RIcon name={n} size={ICON.lg} />;
    switch (card) {
      case "only-github":
        return { hue: "warning", icon: <WarningIcon size={ICON.lg} />, title: "Only github.com repositories", text: "This link is on another host. Paste an owner/repo or a github.com link." };
      case "checking":
        return { hue: "muted", icon: rio("cloud"), spin: true, title: `Looking up ${repoKey} on GitHub…`, text: "Reading it with the gh sign-in this machine already has." };
      case "found":
        return {
          hue: "info", icon: rio("cloud"), mono: true, title: found!.repo,
          badge: <>
            {found!.private && <Status hue="primary"><RIcon name="lock" size={ICON.xs} />Private</Status>}
            <Status hue="info"><RIcon name="eye" size={ICON.xs} />Read-only</Status>
          </>,
          text: <>
            {found!.description || "No description."}
            {pr ? <> Your link points at <b>#{pr}</b>; it opens after adding.</> : null}
            <span className="flex items-center gap-1.5 flex-wrap mt-2">
              {found!.openPrs !== undefined && <Status>{found!.openPrs} open PRs</Status>}
              {found!.defaultBranch && <Status>default {found!.defaultBranch}</Status>}
              <Status hue="success">nothing is cloned</Status>
            </span>
          </>,
        };
      case "not-found":
        return { hue: "warning", icon: <WarningIcon size={ICON.lg} />, title: `Not found: ${repoKey}`, text: <>GitHub has no repository with that name, or it is private and your account cannot see it.{near.length ? " Did you mean:" : ""}</> };
      case "no-access":
        return {
          hue: "warning", icon: rio("lock"), title: `Your sign-in cannot read ${repoKey}`, badge: <Status hue="warning">403</Status>,
          text: <>The repository exists, but the token you signed in with has no access to it{account ? <> (signed in as <b>{account}</b>)</> : null}.</>,
          actions: <><Button tone="primary" onClick={recheck}>Re-run sign-in</Button><Button onClick={recheck}>Check again</Button><Command text={SIGN_IN} /></>,
        };
      case "not-signed-in":
        return { hue: "warning", icon: rio("key"), title: "Not signed in to GitHub", text: "agentglass reads GitHub through gh, and gh has no account yet. Run this in any terminal, then check again:", actions: <><Command text="gh auth login" /><Button onClick={recheck}>Check again</Button></> };
      case "gh-missing":
        return { hue: "warning", icon: rio("key"), title: "gh is not installed", text: "agentglass reads GitHub through the GitHub CLI, and it is not on this machine's PATH.", actions: <Button onClick={recheck}>Check again</Button> };
      case "unreachable":
        return {
          hue: "muted", icon: <WarningIcon size={ICON.lg} />, title: "You appear to be offline",
          text: "Could not reach api.github.com. Your list is not changed.",
          actions: <><Button tone="primary" onClick={recheck}>Retry</Button><Button onClick={() => setText("")}>Change URL</Button></>,
        };
      case "already":
        return {
          hue: "success", icon: rio("check"), title: "Already on your list",
          text: <>{listed && relTime(listed.addedAt, Date.now()) ? <><code>{listed.repo}</code> was added {relTime(listed.addedAt, Date.now())}.</> : <><code>{repoKey}</code> is already here.</>}</>,
          actions: <>{onShow && <Button tone="primary" onClick={() => onShow(listed?.repo ?? repoKey)}>Show it in the list</Button>}<Button onClick={onCancel}>Cancel</Button></>,
        };
      case "full":
        return { hue: "warning", icon: rio("cloud"), title: "The list is full (30)", text: "Forget one first. Nothing is removed for you." };
      default:
        return null;
    }
  })();

  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0" data-remote-card={card}>
      <PaneHead title="Add a GitHub repo" sub="review only" onBack={onCancel} />
      <div className="agx-scroll flex-1 min-h-0 overflow-y-auto">
        <div className="pm-px mt-0.5 grid gap-1.5">
          <label htmlFor="gh-repo" className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text3)" }}>Repository</label>
          <input id="gh-repo" autoFocus value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} autoComplete="off"
            aria-invalid={field === "error"} onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder="orbit/api  ·  https://github.com/orbit/api/pull/322"
            className={`w-full font-mono ${INPUT}`} style={{ ...INPUT_STYLE, ...(field ? { borderColor: hueOf(field), boxShadow: `0 0 0 1px ${hueOf(field)}`, "--primary": hueOf(field) } as React.CSSProperties : null) }} />
          {!body && <div className="text-[11.5px]" style={{ color: "var(--text3)" }}>Type <code>owner/repo</code>, paste a repo URL or a pull request link. Add stays off until a repo is found.</div>}
        </div>
        {body && <StateCard hue={body.hue} icon={body.icon} title={body.title} badge={body.badge} actions={body.actions} mono={body.mono} spin={body.spin}>{body.text}</StateCard>}
        {near.length > 0 && (
          <div className="pm-mx rounded-xl overflow-hidden" style={{ border: HAIR }}>
            {near.map((n) => {
              const r = findRemote(list, n);
              return (
                <div key={n} className="flex items-center gap-2.5 px-3" style={{ height: 36, borderBottom: HAIR }}>
                  <span style={{ color: "var(--text3)" }}><RIcon name="cloud" size={ICON.sm} /></span>
                  <b className="font-mono text-[12px] min-w-0 flex-1 truncate" title={n}>{n}</b>
                  {r?.private !== undefined && <span className="text-[11px]" style={{ color: "var(--text3)" }}>{r.private ? "private" : "public"}</span>}
                  <Button size="compact" onClick={() => setText(n)}>Use this</Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <Foot hint={<><span><Kbd>Esc</Kbd> back</span><span><Kbd>⏎</Kbd> add</span></>}>
        <Button onClick={onCancel}>Cancel</Button>
        <Why reason={addReason(card)}>
          <Button tone="primary" disabled={!canAdd(card)} onClick={add} className="px-4">{pr && canAdd(card) ? `Add and open #${pr}` : "Add repo"}</Button>
        </Why>
      </Foot>
    </div>
  );
}
