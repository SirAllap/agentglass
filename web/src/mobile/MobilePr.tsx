import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { parseUnifiedDiff } from "../lib/prBody.ts";
import { Screen, Sheet, Seg, Empty, Act, useAsk } from "./mobileUi.tsx";
import { MobileDiff, FileRow } from "./MobileDiff.tsx";
import { fmtAgo } from "../lib/format.ts";
import type { PrDetail, PrCheck, PrCheckJob } from "../../../shared/types.ts";
import {
  EMPTY, canSubmit, commentAt, countFor, annotatedPaths, setComment as withRemark, summarise,
  type ReviewDraft, type Side, type Verb,
} from "./reviewDraft.ts";
import { orderThreads, openCount, type ThreadRow } from "./threads.ts";
import { mergeMove, MERGE_WHY, whyBlocked } from "./mergeMove.ts";
import { failureWindow, jobFor, type LogWindow } from "./joblog.ts";

/**
 * Reviewing a pull request from a phone.
 *
 * The desktop panel has six sections and a masthead that survives them. Here
 * there are four, and the masthead only appears on Overview: the sticky header
 * already carries the number, the author and the branch, and on Files or Talk
 * those three hundred pixels are worth more as content than as repetition.
 *
 * Merge and approve live in a pinned footer rather than at the bottom of a
 * scroll, because they are what you came to do. When merge is off it says why
 * directly above itself — a greyed-out primary with no reason is the commonest
 * lie a review UI tells.
 */

type Tab = "overview" | "files" | "checks" | "talk";


export function MobilePr({ open, root, number, onBack, toast, onOpenChatWith }: {
  open: boolean; root: string; number: number | null; onBack: () => void;
  toast: (m: string, bad?: boolean) => void;
  onOpenChatWith?: (cwd: string, prompt: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [d, setD] = useState<PrDetail | null>(null);
  const [err, setErr] = useState("");
  const [diff, setDiff] = useState("");
  const [seen, setSeen] = useState<string[]>([]);
  const [diffAt, setDiffAt] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  const [openLog, setOpenLog] = useState<string | null>(null);
  /**
   * The jobs behind the checks, and the log of whichever one is open.
   *
   * The tab said "the phone does not download run logs" under every failure,
   * while `jobLog` was on the server and `api.prJobLog` was in the client — so
   * the queue card you are most likely to be woken by ended at a sentence
   * telling you to go and use a browser.
   */
  const [jobs, setJobs] = useState<PrCheckJob[]>([]);
  const [log, setLog] = useState<{ for: string; window: LogWindow; truncated: boolean } | null>(null);
  const [logging, setLogging] = useState(false);
  const [comment, setComment] = useState("");
  /**
   * The review being written, and where it is being written.
   *
   * GitHub's own model: you read, you leave remarks as you go, and you submit
   * them together with a verdict — one notification for the author instead of a
   * scatter. `MobileDiff` has rendered every line as a button and printed "Tap
   * a line to comment on it" since it was written, and nothing ever passed it
   * an `onLine`, so none of this was reachable from a phone.
   */
  const [draft, setDraft] = useState<ReviewDraft>(EMPTY);
  const [at, setAt] = useState<{ path: string; line: number; side: Side } | null>(null);
  const [note, setNote] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [replyTo, setReplyTo] = useState<ThreadRow | null>(null);
  const [replyText, setReplyText] = useState("");
  const [verb, setVerb] = useState<Verb | null>(null);
  const verdict = canSubmit(draft, verb, !!d?.viewerDidAuthor);

  useEffect(() => {
    if (!open || number == null) return;
    setTab("overview"); setD(null); setErr(""); setDiff(""); setSeen([]); setComment("");
    // A review is written about one pull request. Carrying remarks from the
    // last one into the next would post them against lines that mean nothing.
    setDraft(EMPTY); setVerb(null); setAt(null); setNote(""); setReviewing(false);
    setReplyTo(null); setReplyText("");
    setJobs([]); setLog(null); setLogging(false);
    api.prDetail(root, number).then((r) => {
      if (r.ok && r.detail) setD(r.detail); else setErr(r.error || "Could not load it");
    }).catch((e) => setErr(String(e)));
    api.prDiff(root, number).then((r) => setDiff(r.text || "")).catch(() => setDiff(""));
  }, [open, root, number]);

  const byPath = useMemo(
    () => new Map(parseUnifiedDiff(diff).map((f) => [f.path, f])),
    [diff],
  );
  const paths = d?.files.map((f) => f.path) ?? [];

  const reload = () => {
    if (number == null) return;
    api.prDetail(root, number, true).then((r) => { if (r.ok && r.detail) setD(r.detail); }).catch(() => {});
  };
  const act = async (label: string, run: () => Promise<{ ok: boolean; error?: string; detail?: string }>) => {
    try {
      const r = await run();
      toast(r.ok ? (r.detail || label) : (r.error || `${label} failed`), !r.ok);
      if (r.ok) reload();
    } catch (e) { toast(String(e), true); }
  };
  // Only when the tab is opened: this is several requests to GitHub behind the
  // scenes and most visits to a pull request never look at the checks.
  useEffect(() => {
    if (!open || tab !== "checks" || number == null || jobs.length) return;
    api.prCheckJobs(root, number).then((r) => { if (r.ok && r.jobs) setJobs(r.jobs); }).catch(() => {});
  }, [open, tab, root, number, jobs.length]);

  const fetchLog = async (check: PrCheck) => {
    const job = jobFor(check.name, jobs);
    if (!job) { toast("No job on this run matches that check", true); return; }
    setLogging(true);
    try {
      const r = await api.prJobLog(root, job.id);
      if (!r.ok || !r.text) { toast(r.error || "Could not read the log", true); return; }
      setLog({ for: check.name, window: failureWindow(r.text), truncated: !!r.truncated });
    } catch (e) { toast(String(e), true); }
    finally { setLogging(false); }
  };

  const { ask, dialog: askDialog } = useAsk();

  const canMerge = d?.mergeState === "CLEAN";
  /** The one thing worth putting on the primary button — see mergeMove.ts. */
  const mergeFacts = d && {
    state: d.mergeState, isDraft: d.isDraft,
    autoMerge: !!d.autoMerge,
    anyFailing: d.checks.failure > 0,
  };
  const move = mergeFacts ? mergeMove(mergeFacts) : null;
  const why = mergeFacts ? whyBlocked(mergeFacts) : "";

  const openThreads = d?.threads.filter((t) => !t.isResolved).length ?? 0;

  return (
    <>
      {askDialog}
      <Screen
        // Stays open under its own file diff, which is drawn on top of it —
        // closing it here made the diff open and shut in the same frame.
        open={open}
        title={d ? `#${d.number} · ${d.author}` : number != null ? `#${number}` : ""}
        sub={d ? `${d.headRefName} → ${d.baseRefName}` : undefined}
        onBack={onBack}
        right={<button className="mb-press" style={{ minHeight: 42, minWidth: 42, fontSize: 17, color: "var(--text3)", background: "transparent" }}
          onClick={() => setMore(true)} aria-label="More">⋯</button>}
        foot={d ? (
          <>
            {move?.kind !== "merge" && (
              <div className="absolute left-0 right-0 text-center text-[10.5px] px-4"
                style={{ top: -21, color: "var(--text3)" }}>
                {why}
              </div>
            )}
            <Act small onAct={() => act("Approved", () => api.prReview(root, d.number, "approve", ""))}
              disabled={d.viewerDidAuthor} title={d.viewerDidAuthor ? "You cannot approve your own pull request" : undefined}>
              ✓ Approve
            </Act>
            {/* The next useful move rather than a dead "Blocked". The reason
                stays above it either way — it was the good part. */}
            <Act kind={move?.kind === "merge" ? "acc" : move?.kind === "none" ? undefined : "ok"}
              full disabled={!move || move.kind === "none"}
              title={move?.kind === "none" ? why : undefined}
              onAct={async () => {
                if (!move) return;
                if (move.kind === "merge") {
                  if (!(await ask({
                    title: `Squash & merge #${d.number}?`, danger: true, confirmLabel: "Squash & merge",
                    body: "Every commit becomes one, and the head branch is deleted straight after. Neither step is reversible from here.",
                  }))) return;
                  await act(`Merged #${d.number}`, () => api.prMerge(root, d.number, "squash", { deleteBranch: true }));
                } else if (move.kind === "update") {
                  await act("Branch updated from the base", () => api.prUpdateBranch(root, d.number));
                } else if (move.kind === "auto") {
                  // Arming this is a decision that outlives the screen: it
                  // merges without you when the run turns green.
                  if (!(await ask({
                    title: `Merge #${d.number} when the checks pass?`, confirmLabel: "Arm it",
                    body: "GitHub squashes and merges it on its own the moment everything required is green, and deletes the head branch. Nobody presses anything.",
                  }))) return;
                  await act("Armed — it merges when the checks pass",
                    () => api.prMerge(root, d.number, "squash", { auto: true, deleteBranch: true }));
                } else if (move.kind === "rerun") {
                  await act("Re-running the failed checks", () => api.prRerun(root, d.number));
                }
              }}>
              {move?.label ?? "…"}
            </Act>
          </>
        ) : undefined}
      >
        {err ? <Empty glyph="✕" title="Could not open it" body={err} />
        : !d ? <div className="text-[11.5px] p-3" style={{ color: "var(--text3)" }}>Loading #{number}…</div>
        : (
          <>
            {tab === "overview" && (
              <div className="pb-3 mb-3" style={{ borderBottom: "1px solid var(--mb-line)" }}>
                <h1 className="text-[16px] font-semibold leading-snug mb-2.5" style={{ textWrap: "balance" }}>
                  <span style={{ color: "var(--text3)", fontWeight: 400 }}>#{d.number}</span> {d.title}
                </h1>
                <dl className="grid gap-y-1.5 gap-x-3 text-[11.5px]" style={{ gridTemplateColumns: "auto 1fr" }}>
                  <dt style={{ color: "var(--text3)" }}>Author</dt><dd style={{ color: "var(--text2)" }}>{d.author}</dd>
                  <dt style={{ color: "var(--text3)" }}>Changes</dt>
                  <dd className="mb-tnum" style={{ color: "var(--text2)" }}>
                    <span style={{ color: "var(--success)" }}>+{d.additions}</span>{" "}
                    <span style={{ color: "var(--error)" }}>−{d.deletions}</span> · {d.changedFiles} files
                  </dd>
                  {d.reviewers.length > 0 && (<><dt style={{ color: "var(--text3)" }}>Reviewers</dt>
                    <dd style={{ color: "var(--text2)" }}>{d.reviewers.map((r) => r.login).join(", ")}</dd></>)}
                </dl>
              </div>
            )}

            <Seg sticky value={tab} onPick={setTab} options={[
              { id: "overview", label: "Overview" },
              { id: "files", label: "Files", n: d.files.length },
              { id: "checks", label: "Checks", n: d.checks.total || null },
              { id: "talk", label: "Talk", n: (d.comments.length + d.reviews.length + d.threads.length) || null },
            ]} />

            {tab === "overview" && (
              <>
                <div className="mb-card overflow-hidden mb-3">
                  <div className="flex gap-3 items-start p-3.5">
                    <span className="shrink-0 grid place-items-center rounded-full font-bold"
                      style={{ width: 28, height: 28, background: canMerge ? "var(--success)" : "var(--error)", color: "var(--bg)" }}>
                      {canMerge ? "✓" : "!"}
                    </span>
                    <span>
                      <b className="block text-[14.5px]">{canMerge ? "Ready to merge" : "Merging is blocked"}</b>
                      <span className="block text-[11.5px] mt-0.5" style={{ color: "var(--text3)" }}>
                        {canMerge ? MERGE_WHY.CLEAN : why}
                      </span>
                    </span>
                  </div>
                  {openThreads > 0 && (
                    <Why glyph="○" tint="var(--warning)" onGo={() => setTab("talk")}>
                      {openThreads} review thread{openThreads === 1 ? "" : "s"} still open
                    </Why>
                  )}
                  {d.checks.failure > 0 && (
                    <Why glyph="✕" tint="var(--error)" onGo={() => setTab("checks")}>
                      {d.checks.failing.slice(0, 2).map((c) => c.name).join(", ")} failing
                    </Why>
                  )}
                  {d.checks.failure === 0 && d.checks.total > 0 && (
                    <Why glyph="✓" tint="var(--success)">{d.checks.total} checks passed</Why>
                  )}
                </div>
                <div className="mb-eyebrow mb-2">Description</div>
                <div className="mb-card p-3.5 text-[12.5px] leading-relaxed whitespace-pre-wrap break-words"
                  style={{ color: "var(--text2)" }}>
                  {d.body.trim() || "No description."}
                </div>
                {onOpenChatWith && (
                  <Act kind="acc" full small onAct={() => handOver(root, d.number, `Review pull request #${d.number}`, onOpenChatWith, toast)}>
                    ✦ Review locally with Claude
                  </Act>
                )}
              </>
            )}

            {tab === "files" && (
              <>
                <div className="flex items-center gap-2 mb-2.5 text-[11px]" style={{ color: "var(--text3)" }}>
                  <span className="mb-tnum">{seen.length} of {d.files.length} viewed</span>
                </div>
                <div className="flex flex-col gap-2.5">
                  {d.files.map((f, i) => (
                    <FileRow key={f.path} path={f.path} add={f.additions} del={f.deletions}
                      note={`${f.status}${f.comments ? ` · ${f.comments} open thread` : ""}`}
                      on={seen.includes(f.path)} switchLabel={`Mark ${f.path} viewed`}
                      onToggle={() => setSeen((s) => s.includes(f.path) ? s.filter((x) => x !== f.path) : [...s, f.path])}
                      onOpen={() => setDiffAt(i)} />
                  ))}
                </div>
              </>
            )}

            {tab === "checks" && <Checks d={d} openLog={openLog} onOpenLog={(k) => { setOpenLog(k); setLog(null); }}
              jobs={jobs} log={log} logging={logging} onFetchLog={fetchLog}
              onRerun={() => act("Re-running the failed checks", () => api.prRerun(root, d.number))}
              onAsk={onOpenChatWith ? (c) => handOver(root, d.number,
                `The check "${c.name}" is failing on pull request #${d.number} (${d.title}). Work out why and propose the fix.`,
                onOpenChatWith, toast) : undefined} />}

            {tab === "talk" && (
              <>
                <Talk d={d}
                  onReply={(t) => { setReplyTo(t); setReplyText(""); }}
                  onResolve={(t) => act(
                    t.thread.isResolved ? "Reopened" : "Resolved",
                    () => api.prSetThreadResolved(root, t.thread.id, !t.thread.isResolved))} />
                <div className="mb-card overflow-hidden mt-3">
                  <textarea value={comment} onChange={(e) => setComment(e.target.value)}
                    placeholder="Leave a comment…"
                    className="w-full p-3 text-[13px] resize-none bg-transparent outline-none"
                    style={{ minHeight: 76, color: "var(--text)", lineHeight: 1.6 }} />
                  <div className="flex px-3 py-2.5" style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 25%, transparent)" }}>
                    <span className="flex-1" />
                    <Act small kind="acc" disabled={!comment.trim()} title={comment.trim() ? undefined : "Write something first"}
                      onAct={async () => { await act("Comment posted", () => api.prComment(root, d.number, comment)); setComment(""); }}>
                      Comment
                    </Act>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </Screen>

      <MobileDiff open={diffAt != null} files={paths} index={diffAt ?? 0} onIndex={setDiffAt}
        file={diffAt != null ? byPath.get(paths[diffAt] ?? "") : undefined}
        onBack={() => setDiffAt(null)}
        onLine={(path, line, side) => {
          if (!line) return; // a hunk header has no address
          setAt({ path, line, side });
          setNote(commentAt(draft, path, line, side)?.body ?? "");
        }}
        markOn={(path, line, side) => !!commentAt(draft, path, line, side)}
        extra={draft.comments.length > 0 ? (
          <Act small kind="acc" onAct={() => setReviewing(true)}>
            Finish review · {draft.comments.length}
          </Act>
        ) : undefined} />

      {/* One line, one remark. Opening on a line you have already annotated
          pre-fills it, so editing and deleting are the same gesture as writing. */}
      <Sheet open={!!at} title={at ? `Line ${at.line}` : ""}
        sub={at ? `${at.path.split("/").pop()} · ${at.side === "LEFT" ? "the old file" : "the new file"}` : undefined}
        onClose={() => setAt(null)}>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={5}
          placeholder="What is wrong with this line, or what you would rather see"
          className="w-full rounded-xl p-3 text-[13px]"
          style={{ background: "var(--bg2)", border: "1px solid var(--mb-line)", color: "var(--text)", resize: "vertical" }} />
        <div className="flex gap-2 mt-3">
          <Act small full onAct={() => setAt(null)}>Cancel</Act>
          <Act small full kind="acc" onAct={() => {
            if (!at) return;
            setDraft((cur) => withRemark(cur, at.path, at.line, at.side, note));
            // Saying it is queued matters more here than anywhere else: nothing
            // has gone to GitHub yet, and a remark that vanished into a closing
            // sheet would be written twice or not at all.
            toast(note.trim() ? "Queued for the review" : "Remark removed");
            setAt(null);
          }}>{note.trim() ? "Save" : "Remove"}</Act>
        </div>
      </Sheet>

      <Sheet open={!!replyTo} title="Reply" sub={replyTo?.where} onClose={() => setReplyTo(null)}>
        <textarea value={replyText} onChange={(e) => setReplyText(e.target.value)} rows={5}
          placeholder="Answer the thread"
          className="w-full rounded-xl p-3 text-[13px]"
          style={{ background: "var(--bg2)", border: "1px solid var(--mb-line)", color: "var(--text)", resize: "vertical" }} />
        <div className="flex gap-2 mt-3">
          <Act small full onAct={() => setReplyTo(null)}>Cancel</Act>
          <Act small full kind="acc" disabled={!replyText.trim() || !d || replyTo?.replyTo == null}
            onAct={async () => {
              if (!d || !replyTo || replyTo.replyTo == null) return;
              await act("Replied", () => api.prReply(root, d.number, replyTo.replyTo!, replyText));
              setReplyTo(null); setReplyText("");
            }}>Send</Act>
        </div>
      </Sheet>

      <ReviewSheet open={reviewing} draft={draft} verb={verb} verdict={verdict}
        mine={!!d?.viewerDidAuthor}
        onVerb={setVerb} onBody={(b) => setDraft((cur) => ({ ...cur, body: b }))}
        onDrop={(c) => setDraft((cur) => withRemark(cur, c.path, c.line, c.side, ""))}
        onClose={() => setReviewing(false)}
        onSubmit={async () => {
          if (!d || !verdict.ok || !verb) return;
          await act(verb === "approve" ? "Approved" : verb === "request_changes" ? "Changes requested" : "Review sent",
            () => api.prReviewWith(root, d.number, verb, draft.body, draft.comments));
          setDraft(EMPTY); setVerb(null); setReviewing(false);
        }} />

      <Sheet open={more} title="Pull request" sub="Things you do to it, rather than in it."
        onClose={() => setMore(false)}>
        <div className="flex flex-col gap-2.5">
          {d && (
            <>
              <Act full small onAct={async () => {
                try { await navigator.clipboard.writeText(d.url); toast("Link copied"); }
                catch { toast("Could not reach the clipboard", true); }
                setMore(false);
              }}>Copy link</Act>
              <Act full small onAct={() => { window.open(d.url, "_blank", "noopener,noreferrer"); setMore(false); }}>
                Open on GitHub ↗
              </Act>
              <Act full small onAct={() => act(d.isDraft ? "Marked ready" : "Converted to draft",
                () => api.prDraft(root, d.number, !d.isDraft)).then(() => setMore(false))}>
                {d.isDraft ? "Mark ready for review" : "Convert to draft"}
              </Act>
              <Act full small kind="dang" onAct={async () => {
                if (!(await ask({
                  title: `Close #${d.number}?`, danger: true, confirmLabel: "Close it",
                  body: "It stops being reviewable and drops off the queue. Reopening it means going to GitHub.",
                }))) return;
                await act("Pull request closed", () => api.prClose(root, d.number));
                setMore(false); onBack();
              }}>
                Close pull request
              </Act>
            </>
          )}
        </div>
      </Sheet>
    </>
  );
}

function Why({ glyph, tint, children, onGo }: { glyph: string; tint: string; children: React.ReactNode; onGo?: () => void }) {
  return (
    <div className="flex gap-2.5 items-center px-3 py-3 text-[12px]"
      style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 22%, transparent)", color: "var(--text2)" }}>
      <span className="shrink-0 w-3.5 text-center" style={{ color: tint }}>{glyph}</span>
      <span className="min-w-0">{children}</span>
      {onGo && <button onClick={onGo} className="ml-auto shrink-0 text-[11px] pl-2.5 mb-press"
        style={{ minHeight: 36, color: "var(--primary-hover)", background: "transparent" }}>Open ›</button>}
    </div>
  );
}

function Checks({ d, openLog, onOpenLog, jobs, log, logging, onFetchLog, onRerun, onAsk }: {
  d: PrDetail; openLog: string | null; onOpenLog: (k: string | null) => void;
  jobs: PrCheckJob[];
  log: { for: string; window: LogWindow; truncated: boolean } | null;
  logging: boolean;
  onFetchLog: (c: PrCheck) => void;
  onRerun: () => void; onAsk?: (c: PrCheck) => void;
}) {
  const groups = useMemo(() => {
    const m = new Map<string, PrCheck[]>();
    for (const k of d.checksAll) {
      const g = k.workflow || "Checks";
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(k);
    }
    const rank = (l: PrCheck[]) => l.some((k) => k.state === "failure") ? 0 : l.some((k) => k.state === "pending") ? 1 : 2;
    return [...m.entries()].sort((a, b) => rank(a[1]) - rank(b[1]) || a[0].localeCompare(b[0]));
  }, [d.checksAll]);

  if (!d.checksAll.length) return <Empty glyph="○" title="No checks" body="Nothing runs on this pull request yet." />;

  return (
    <div className="flex flex-col gap-2.5">
      {groups.map(([name, list]) => (
        <div key={name} className="rounded-2xl overflow-hidden" style={{ border: "1px solid color-mix(in srgb, var(--border) 32%, transparent)" }}>
          <div className="flex items-center gap-2 px-3 py-2.5 text-[11.5px]" style={{ background: "color-mix(in srgb, var(--bg3) 46%, transparent)" }}>
            <b>{name}</b><span style={{ color: "var(--text3)" }}>· {list.length}</span>
          </div>
          {list.map((k, i) => {
            const bad = k.state === "failure";
            const id = `${name}:${k.name}:${i}`;
            const on = openLog === id;
            return (
              <div key={id} style={{ borderTop: "1px solid color-mix(in srgb, var(--border) 20%, transparent)", background: bad ? "color-mix(in srgb, var(--error) 9%, transparent)" : "color-mix(in srgb, var(--bg2) 55%, transparent)" }}>
                <button className="w-full flex items-center gap-2.5 px-3 py-3 text-[12.5px] mb-press"
                  style={{ minHeight: 48, background: "transparent" }}
                  onClick={() => bad && onOpenLog(on ? null : id)} disabled={!bad}>
                  <span style={{ color: bad ? "var(--error)" : k.state === "success" ? "var(--success)" : "var(--text3)" }}>
                    {bad ? "✕" : k.state === "success" ? "✓" : k.state === "pending" ? "•" : "⊘"}
                  </span>
                  <span className="min-w-0 truncate">{k.name}</span>
                  <span className="flex-1" />
                  <span className="text-[9.5px] uppercase tracking-wide shrink-0"
                    style={{ color: bad ? "var(--error)" : "var(--text3)" }}>{k.state}</span>
                </button>
                {on && (
                  <div className="px-3 pb-3">
                    {log?.for === k.name ? (
                      <div className="mb-log">
                        <div className="lh">
                          <b>{log.window.why}</b>
                          {log.window.hidden > 0 && <span>· {log.window.hidden} lines above</span>}
                          {log.truncated && <span>· the start was cut by the server</span>}
                        </div>
                        {/* Opened at the failure, not at the top of the
                            window. Twenty-four lines of context is right when
                            you want it and wrong as a thing to scroll past —
                            a run that printed a hundred "✓ suite passed" lines
                            fills the box with them otherwise. */}
                        <pre ref={(el) => {
                          if (!el || log.window.at < 0) return;
                          const line = el.children[log.window.at] as HTMLElement | undefined;
                          if (line) el.scrollTop = Math.max(0, line.offsetTop - el.clientHeight * 0.55);
                        }}>{log.window.lines.map((l, n) => (
                          <span key={n} className={l.startsWith("##[error]") ? "e" : undefined}>
                            {l.replace(/^##\[error\]/, "")}{"\n"}
                          </span>
                        ))}</pre>
                      </div>
                    ) : (
                      <div className="mb-2.5">
                        {/* The reason a phone shows a window rather than a
                            file: an Actions log is tens of thousands of lines
                            with a 28-character timestamp on every one. */}
                        <Act small full kind="acc" disabled={logging || !jobFor(k.name, jobs)}
                          title={jobFor(k.name, jobs) ? undefined
                            : jobs.length ? "No job on this run matches that check" : "Still finding the job"}
                          onAct={() => onFetchLog(k)}>
                          {logging ? "Reading the log…" : "Show the failure"}
                        </Act>
                      </div>
                    )}
                    <div className="flex gap-2 flex-wrap">
                      {onAsk && <Act small kind="acc" onAct={() => onAsk(k)}>✦ Ask Claude why</Act>}
                      {k.url && <Act small onAct={() => { window.open(k.url, "_blank", "noopener,noreferrer"); }}>Open run ↗</Act>}
                      <Act small onAct={onRerun}>↻ Re-run failed</Act>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * A line thread, drawn as one.
 *
 * Every reply is shown. A collapsed "3 replies" is the shape that made the old
 * rendering useless in the first place: the count is never the thing you needed
 * — the answer is — and on a phone there is nowhere else to go and read it.
 */
export const THREAD_CSS = `
/* A CI log on a phone. Monospace and small, wrapping rather than scrolling
   sideways — a stack trace read one word at a time is not read. */
.mb-log{border-radius:11px;overflow:hidden;margin-bottom:10px;
  background:color-mix(in srgb,#000 45%,transparent);
  border:1px solid color-mix(in srgb,var(--border) 34%,transparent)}
.mb-log .lh{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;font-size:10px;color:var(--text3);
  background:color-mix(in srgb,var(--bg3) 40%,transparent)}
.mb-log .lh b{color:var(--text2);font-weight:600}
.mb-log pre{margin:0;padding:9px 10px;font-size:10.5px;line-height:1.5;color:var(--text2);
  white-space:pre-wrap;overflow-wrap:anywhere;max-height:52vh;overflow-y:auto}
.mb-log pre .e{color:var(--error);font-weight:600}

.mb-thr{border-radius:15px;overflow:hidden;background:var(--mb-card);
  border:1px solid color-mix(in srgb,var(--border) 38%,transparent);box-shadow:var(--mb-edge)}
.mb-thr.quiet{opacity:.62;border-style:dashed}
.mb-thr .th{display:flex;align-items:center;gap:8px;padding:9px 12px;font-size:11px;
  background:color-mix(in srgb,var(--bg3) 44%,transparent);min-width:0}
.mb-thr .th b{font-weight:600;color:var(--primary-hover);min-width:0}
.mb-thr .tc{padding:10px 12px 0}
.mb-thr .tc .w{display:flex;align-items:center;gap:7px;font-size:11px}
.mb-thr .tc .w b{font-weight:600}
.mb-thr .tc .b{font-size:12.5px;line-height:1.55;color:var(--text2);margin-top:4px;
  white-space:pre-wrap;overflow-wrap:anywhere}
/* Between the opening remark and the answers to it, so a thread reads as a
   question with replies rather than as a stack of equals. */
.mb-thr .tc .sep{height:1px;margin:10px 0 0;background:color-mix(in srgb,var(--border) 40%,transparent)}
.mb-thr .ta{display:flex;gap:9px;padding:11px 12px 12px}
`;

/**
 * One timeline, oldest first — the order the replies were written in.
 *
 * Line threads are drawn as threads now rather than folded into this list as
 * their opening sentence. The conversation about one line is the thing that
 * decides whether a pull request can merge, and it was the one part of the
 * screen reduced to a single quote with every answer discarded.
 */
function Talk({ d, onReply, onResolve }: {
  d: PrDetail;
  onReply: (t: ThreadRow) => void;
  onResolve: (t: ThreadRow) => void;
}) {
  const rows = useMemo(() => orderThreads(d.threads), [d.threads]);
  const entries = useMemo(() => {
    const out: { at: string; who: string; verdict?: string; body: string; bot: boolean }[] = [];
    for (const r of d.reviews) {
      if (!r.body.trim() && r.state === "COMMENTED") continue;
      out.push({
        at: r.submittedAt, who: r.author, bot: r.isBot,
        verdict: r.state === "CHANGES_REQUESTED" ? "requested changes" : r.state === "APPROVED" ? "approved" : undefined,
        body: r.body.trim() || `(${r.state.toLowerCase().replace("_", " ")}, no note)`,
      });
    }
    for (const c of d.comments) out.push({ at: c.createdAt, who: c.author, bot: c.isBot, body: c.digest || c.body });
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }, [d]);

  if (!entries.length && !rows.length) {
    return <Empty glyph="▤" title="Nobody has said anything" body="No reviews, comments or line threads on this pull request yet." />;
  }

  const threadList = rows.length > 0 && (
    <>
      <div className="mb-eyebrow" style={{ margin: "0 0 9px" }}>
        Line threads · {openCount(d.threads)} open of {rows.length}
      </div>
      <div className="flex flex-col gap-2.5 mb-4">
        {rows.map((r) => (
          <div key={r.thread.id} className={`mb-thr${r.quiet ? " quiet" : ""}`}>
            <div className="th">
              <b className="truncate">{r.where}</b>
              {r.quiet && <span className="mb-chip" style={{ color: "var(--text3)" }}>{r.quiet}</span>}
            </div>
            {r.thread.comments.map((c, i) => (
              <div className="tc" key={c.id}>
                <div className="w">
                  <b>{c.author}</b>
                  {c.isBot && <span className="mb-chip" style={{ color: "var(--info)" }}>bot</span>}
                  <span className="ml-auto" style={{ color: "var(--text3)" }}>{fmtAgo(Date.parse(c.createdAt))}</span>
                </div>
                <div className="b">{c.body}</div>
                {/* Every reply is shown. The count under a collapsed thread is
                    the thing nobody can act on. */}
                {i === 0 && r.replies > 0 && <div className="sep" />}
              </div>
            ))}
            <div className="ta">
              <Act small full disabled={r.replyTo == null}
                title={r.replyTo == null ? "GitHub gave this thread no id to reply to" : undefined}
                onAct={() => onReply(r)}>Reply</Act>
              <Act small full kind={r.thread.isResolved ? undefined : "ok"} onAct={() => onResolve(r)}>
                {r.thread.isResolved ? "Reopen" : "Resolve"}
              </Act>
            </div>
          </div>
        ))}
      </div>
    </>
  );

  if (!entries.length) return <div>{threadList}</div>;

  return (
    <div>
      {threadList}
      {rows.length > 0 && <div className="mb-eyebrow" style={{ margin: "0 0 9px" }}>Conversation</div>}
      <div className="flex flex-col gap-2.5">
      {entries.map((e, i) => (
        <div key={i} className="mb-card overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2.5 text-[11.5px]" style={{ background: "color-mix(in srgb, var(--bg3) 44%, transparent)" }}>
            <b className="font-semibold">{e.who}</b>
            {e.bot && <span className="mb-chip" style={{ color: "var(--info)" }}>bot</span>}
            {e.verdict && <span className="mb-chip" style={{ color: e.verdict === "approved" ? "var(--success)" : "var(--error)" }}>{e.verdict}</span>}
            <span className="ml-auto" style={{ color: "var(--text3)" }}>{fmtAgo(Date.parse(e.at))}</span>
          </div>
          <div className="p-3 text-[12.5px] leading-relaxed whitespace-pre-wrap break-words" style={{ color: "var(--text2)" }}>{e.body}</div>
        </div>
      ))}
      </div>
    </div>
  );
}

/** Hand the job to the chat with the right working directory and prompt, so
 *  the answer is written against the code rather than guessed at. Reads only —
 *  nothing is fetched and nothing is left behind. */
async function handOver(
  root: string, number: number, prompt: string,
  onOpenChatWith: (cwd: string, prompt: string) => void,
  toast: (m: string, bad?: boolean) => void,
) {
  try {
    const r = await api.prReviewPrompt(root, number);
    if (!r.ok || !r.cwd) { toast(r.error || "Could not check it out", true); return; }
    onOpenChatWith(r.cwd, r.prompt && prompt.startsWith("Review pull request") ? r.prompt : prompt);
    toast(`Checked out #${number} — it is waiting in chat`);
  } catch (e) { toast(String(e), true); }
}

/**
 * The verdict, and everything queued under it.
 *
 * Three verbs, not one. The screen could approve and it could merge, which
 * covers exactly the review that has nothing to say — and a phone is where you
 * are most likely to be reading something you want to push back on, because you
 * are not at the keyboard that would let you fix it yourself.
 *
 * The queued remarks are listed and removable from here, so the last thing you
 * see before sending is everything you are about to send. A review you cannot
 * re-read before submitting is one you write more carefully than you should
 * have to.
 */
function ReviewSheet({ open, draft, verb, verdict, mine, onVerb, onBody, onDrop, onClose, onSubmit }: {
  open: boolean;
  draft: ReviewDraft;
  verb: Verb | null;
  verdict: { ok: true } | { ok: false; why: string };
  mine: boolean;
  onVerb: (v: Verb) => void;
  onBody: (b: string) => void;
  onDrop: (c: { path: string; line: number; side: Side }) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const VERBS: { id: Verb; label: string; hint: string }[] = [
    { id: "approve", label: "Approve", hint: "It can go in" },
    { id: "request_changes", label: "Request changes", hint: "Not until these are addressed" },
    { id: "comment", label: "Comment", hint: "Thoughts, no verdict" },
  ];
  return (
    <Sheet open={open} title="Submit review" sub={summarise(draft)} onClose={onClose}>
      <div className="flex flex-col gap-2">
        {VERBS.map((v) => {
          // Both of these are refused by GitHub on your own pull request. Saying
          // so on the option is better than letting it be chosen and then
          // disabling the button underneath with a reason nobody connects to it.
          const barred = mine && v.id !== "comment";
          const on = verb === v.id;
          return (
            <button key={v.id} disabled={barred} onClick={() => onVerb(v.id)}
              className={`mb-row mb-press${barred ? " dis" : ""}`}
              style={{
                opacity: barred ? 0.4 : 1,
                borderColor: on ? "var(--primary-hover)" : undefined,
                background: on ? "color-mix(in srgb, var(--primary) 14%, transparent)" : undefined,
              }}>
              <span className="i">
                <b style={{ color: on ? "var(--primary-hover)" : undefined }}>{v.label}</b>
                <span>{barred ? "Not on your own pull request" : v.hint}</span>
              </span>
              {on && <span className="r" style={{ color: "var(--primary-hover)" }}>✓</span>}
            </button>
          );
        })}
      </div>

      <textarea value={draft.body} onChange={(e) => onBody(e.target.value)} rows={4}
        placeholder="A covering note (optional for an approval)"
        className="w-full rounded-xl p-3 text-[13px] mt-3"
        style={{ background: "var(--bg2)", border: "1px solid var(--mb-line)", color: "var(--text)", resize: "vertical" }} />

      {annotatedPaths(draft).length > 0 && (
        <>
          <div className="mb-eyebrow" style={{ margin: "16px 0 8px" }}>Queued remarks</div>
          <div className="flex flex-col gap-2">
            {annotatedPaths(draft).map((path) => (
              <div key={path}>
                <div className="text-[10.5px] mb-1.5 truncate" style={{ color: "var(--text3)" }}>
                  {path} · {countFor(draft, path)}
                </div>
                {draft.comments.filter((c) => c.path === path).map((c) => (
                  <div key={`${c.side}${c.line}`} className="flex items-start gap-2 mb-1.5">
                    <span className="mb-tnum text-[10.5px] pt-1" style={{ color: "var(--text3)", flex: "none", minWidth: 34 }}>
                      {c.side === "LEFT" ? "−" : "+"}{c.line}
                    </span>
                    <span className="flex-1 min-w-0 text-[11.5px]" style={{ color: "var(--text2)", overflowWrap: "anywhere" }}>
                      {c.body}
                    </span>
                    <button className="mb-press" aria-label={`Remove the remark on line ${c.line}`}
                      onClick={() => onDrop(c)}
                      style={{ flex: "none", minHeight: 40, minWidth: 40, borderRadius: 10, color: "var(--text3)", background: "transparent" }}>✕</button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}

      {!verdict.ok && (
        <p className="text-[11px] mt-4" style={{ color: "var(--warning)" }}>{verdict.why}</p>
      )}
      <div className="mt-3">
        <Act full kind="acc" disabled={!verdict.ok} onAct={onSubmit}>Submit review</Act>
      </div>
    </Sheet>
  );
}
