import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { parseUnifiedDiff } from "../lib/prBody.ts";
import { Screen, Sheet, Seg, Empty, Act, useConfirm } from "./mobileUi.tsx";
import { MobileDiff, FileRow } from "./MobileDiff.tsx";
import { fmtAgo } from "../lib/format.ts";
import type { PrDetail, PrCheck } from "../../../shared/types.ts";

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

const MERGE_WHY: Record<string, string> = {
  BLOCKED: "A required review or check has not passed",
  BEHIND: "The base branch has moved — update the branch first",
  DIRTY: "There are conflicts with the base branch",
  UNSTABLE: "A check is failing",
  DRAFT: "This is a draft",
  HAS_HOOKS: "A repository hook is blocking the merge",
  UNKNOWN: "GitHub has not finished working it out",
};

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
  const [comment, setComment] = useState("");

  useEffect(() => {
    if (!open || number == null) return;
    setTab("overview"); setD(null); setErr(""); setDiff(""); setSeen([]); setComment("");
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
  const { confirm, sheet: confirmSheet } = useConfirm();

  const canMerge = d?.mergeState === "CLEAN";
  const openThreads = d?.threads.filter((t) => !t.isResolved).length ?? 0;

  return (
    <>
      {confirmSheet}
      <Screen
        open={open && diffAt == null}
        title={d ? `#${d.number} · ${d.author}` : number != null ? `#${number}` : ""}
        sub={d ? `${d.headRefName} → ${d.baseRefName}` : undefined}
        onBack={onBack}
        right={<button className="mb-press" style={{ minHeight: 42, minWidth: 42, fontSize: 17, color: "var(--text3)", background: "transparent" }}
          onClick={() => setMore(true)} aria-label="More">⋯</button>}
        foot={d ? (
          <>
            {!canMerge && (
              <div className="absolute left-0 right-0 text-center text-[10.5px] px-4"
                style={{ top: -21, color: "var(--text3)" }}>
                {MERGE_WHY[d.mergeState] ?? "Not mergeable"}
              </div>
            )}
            <Act small onAct={() => act("Approved", () => api.prReview(root, d.number, "approve", ""))}
              disabled={d.viewerDidAuthor} title={d.viewerDidAuthor ? "You cannot approve your own pull request" : undefined}>
              ✓ Approve
            </Act>
            <Act kind="acc" full disabled={!canMerge}
              title={canMerge ? undefined : MERGE_WHY[d.mergeState]}
              onAct={() => confirm({
                verb: "Squash & merge", subject: `#${d.number}`,
                warn: "Every commit becomes one, and the head branch is deleted straight after. Neither step is reversible from here.",
                run: () => act(`Merged #${d.number}`, () => api.prMerge(root, d.number, "squash", { deleteBranch: true })),
              })}>
              {canMerge ? "Squash & merge" : "Blocked"}
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
                    <dd style={{ color: "var(--text2)" }}>{d.reviewers.join(", ")}</dd></>)}
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
                        {canMerge ? "Nothing is standing in the way" : (MERGE_WHY[d.mergeState] ?? "Not mergeable")}
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

            {tab === "checks" && <Checks d={d} openLog={openLog} onOpenLog={setOpenLog}
              onRerun={() => act("Re-running the failed checks", () => api.prRerun(root, d.number))}
              onAsk={onOpenChatWith ? (c) => handOver(root, d.number,
                `The check "${c.name}" is failing on pull request #${d.number} (${d.title}). Work out why and propose the fix.`,
                onOpenChatWith, toast) : undefined} />}

            {tab === "talk" && (
              <>
                <Talk d={d} />
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
        onBack={() => setDiffAt(null)} />

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
              <Act full small kind="dang" onAct={() => confirm({
                verb: "Close", subject: `#${d.number}`,
                warn: "It stops being reviewable and drops off the queue. Reopening it means going to GitHub.",
                run: () => act("Pull request closed", () => api.prClose(root, d.number))
                  .then(() => { setMore(false); onBack(); }),
              })}>
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

function Checks({ d, openLog, onOpenLog, onRerun, onAsk }: {
  d: PrDetail; openLog: string | null; onOpenLog: (k: string | null) => void;
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
                  <div className="px-3 pb-3 flex gap-2 flex-wrap">
                    {onAsk && <Act small kind="acc" onAct={() => onAsk(k)}>✦ Ask Claude why</Act>}
                    {k.url && <Act small onAct={() => { window.open(k.url, "_blank", "noopener,noreferrer"); }}>Open run ↗</Act>}
                    <Act small onAct={onRerun}>↻ Re-run failed</Act>
                    <div className="text-[10px] w-full mt-1" style={{ color: "var(--text3)" }}>
                      The log itself lives on GitHub — the phone does not download run logs.
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

/** One timeline, oldest first — the order the replies were written in. */
function Talk({ d }: { d: PrDetail }) {
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
    for (const t of d.threads) {
      const first = t.comments[0];
      if (first) out.push({ at: first.createdAt, who: first.author, bot: first.isBot, body: `${t.path}${t.line ? `:${t.line}` : ""} — ${first.body}` });
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }, [d]);

  if (!entries.length) return <Empty glyph="▤" title="Nobody has said anything" body="No reviews, comments or line threads on this pull request yet." />;

  return (
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
