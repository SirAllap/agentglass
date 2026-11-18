/*
 * The sheet a board card's dots open (mock 62): what you can do to that pull
 * request without leaving the board.
 *
 * The rows are `actionRows` from model/prActions.ts, which is where the
 * decisions live — a row this phone cannot carry out is not drawn, and one with
 * nothing to do is not offered.
 *
 * ── why approve and changes ask for a note first ──────────────────────────
 * A verdict is a permanent write on somebody's work, and GitHub's own review
 * form puts a sentence beside it for the same reason: "changes requested" with
 * no words is a notification nobody can act on. The note is optional, as it is
 * there, and the verdict and the note go in ONE call (`/prs/review-with`), so a
 * dropped connection cannot leave half a review behind.
 *
 * The sync row hands off to the sheet that already does it (SyncSheet) rather
 * than repeating its read and its hold: one branch compared once. Request a
 * review, Tell me when and Merge hand off the same way (ReviewersSheet,
 * WatchRuleSheet, the merge sheet on the pull request): the desktop card offers
 * each of them, and each already has a phone sheet that does it.
 *
 * The merge lock is read when the sheet opens (`/prs/merge-lock`), so Merge is
 * drawn off with the lock's sentence, as the desktop menu greys it.
 *
 * ── one sheet for the board and the pull request ──────────────────────────
 * The board's dots (mock 62) and the pull request's More (mock 37) used to be
 * two sheets, and a write added to one was missing from the other. It is one
 * sheet now: the first group is what you do to the review (verdicts, re-run,
 * sync, watch, merge), the second is what you do to the pull request itself
 * (labels, reviewers, edit, draft, branch, GitHub, close). A row appears when
 * the screen under the sheet can carry it out: the board has no description,
 * so it has no Edit; the pull request is already open, so it has no Open.
 *
 * Close and reopen hold (model/confirmPolicy.ts), because they stop work on
 * somebody's branch. `blocked` draws the pull-request rows disabled, with the
 * sentence on top: a control that disappears teaches nobody that pairing with
 * Everything would offer it, and a 403 after the gesture is worse than both.
 */
import { useEffect, useMemo, useState } from "react";
import { Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { PrDetail, PrSummary } from "../../../shared/types.ts";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import { actionRows, lockSaid, rerunSaid, type PrActionId } from "../model/prActions.ts";
import { openHttp } from "../lib/openHttp.ts";
import { repoOf } from "../model/prRef.ts";
import { draftAction, editPatch, labelsOf, stateAction } from "../model/prManage.ts";
import { reviewerRows } from "../model/prOverview.ts";
import { ActionRow, Btn, Chip, Group, HoldButton, Label, Note, Row, Sheet, Switch, useFlash } from "../ui.tsx";
import { Glyph, type GlyphName } from "../nav/glyphs.tsx";
import { C, MONO, RADIUS, SPACE, T } from "../theme.ts";

/** The mark each row leads with, as the mock draws them. */
const LEAD: Record<PrActionId, { glyph: GlyphName; tone?: "good" | "bad" | "warn" }> = {
  approve: { glyph: "check", tone: "good" },
  changes: { glyph: "comment", tone: "bad" },
  comment: { glyph: "comment" },
  reviewers: { glyph: "people" },
  watch: { glyph: "bell" },
  merge: { glyph: "merge" },
  rerun: { glyph: "refresh", tone: "warn" },
  sync: { glyph: "branch" },
  open: { glyph: "pr" },
};

/** "ana approved · sam asked for changes", as the More sheet's row says it. */
function reviewersWords(detail: PrDetail): string {
  const rows = reviewerRows(detail).filter((r) => !r.bot);
  if (!rows.length) return "Nobody asked yet";
  return rows.map((r) => `${r.login} ${r.word.toLowerCase()}`).join(" · ");
}

type Mode = "list" | "approve" | "changes" | "comment" | "draft" | "close" | "edit";

const LEAD_INK = { good: () => C.success, bad: () => C.error, warn: () => C.warning } as const;

export function PrActionsSheet({ open, onClose, host, root, pr, detail, forMe, mayWrite, blocked, onOpen, onSync, onReviewers, onWatch, onMerge, onLabels, onAskClaude, onChanged }: {
  open: boolean;
  onClose: () => void;
  host: Host | null;
  root: string;
  /** The card's row. The board holds summaries, not details — see PrSummary. */
  pr: PrSummary | null;
  /** The full pull request, when the screen under the sheet has read it: it adds Edit and the reviewers line. */
  detail?: PrDetail | null;
  /** The card is in the lane that waits on the reader. */
  forMe: boolean;
  mayWrite: boolean;
  /** Why this phone may not write, or null. */
  blocked: string | null;
  /** Each hand-off is optional: a row is drawn only when the screen under the sheet can carry it out. */
  onOpen?: () => void;
  onSync?: () => void;
  onReviewers: () => void;
  onWatch?: () => void;
  onMerge?: () => void;
  onLabels?: () => void;
  /** The Claude menu, which lives on the screen this sheet is over. */
  onAskClaude?: () => void;
  onChanged: () => void;
}): React.ReactNode {
  const [mode, setMode] = useState<Mode>("list");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lock, setLock] = useState<string | null>(null);
  const [title, setTitle] = useState(detail?.title ?? "");
  const [body, setBody] = useState(detail?.body ?? "");
  const [copied, flash] = useFlash();
  /** The two extra writes the close sheet offers (mock 54). */
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [sayWhy, setSayWhy] = useState(false);
  const [why, setWhy] = useState("");

  useEffect(() => {
    if (!open) return;
    setMode("list");
    setNote("");
    setBusy(false);
    setSaid(null);
    setErr(null);
    setLock(null);
    setDeleteBranch(false);
    setSayWhy(false);
    setWhy("");
  }, [open]);

  const number = pr?.number;
  useEffect(() => {
    if (!open || !host || !root || number == null) return;
    let live = true;
    void ask<{ ok: boolean; state?: { locked: boolean; reason: string } | null }>(
      host, `/prs/merge-lock?root=${encodeURIComponent(root)}&number=${number}`,
    ).then((a) => { if (live) setLock(a.ok ? lockSaid(a.value) : null); });
    return () => { live = false; };
  }, [open, host, root, number]);

  /* Hooks stay above the early return: the sheet is mounted with no pull request until a card is pressed. */
  const draft = useMemo(() => draftAction(pr?.isDraft ?? false), [pr?.isDraft]);
  const close = useMemo(() => (pr ? stateAction(pr.state) : null), [pr]);
  const patch = useMemo(() => (detail ? editPatch(detail, title, body) : null), [detail, title, body]);

  if (!pr) return null;
  const repo = repoOf(pr.url) ?? "this repository";

  const rows = actionRows({
    mayWrite, state: pr.state, forMe, failure: pr.checks?.failure ?? 0, base: pr.baseRefName, mergeLock: lock,
  });

  const write = async (path: string, payload: Record<string, unknown>): Promise<void> => {
    if (!host || !mayWrite) return;
    setBusy(true);
    setErr(null);
    const answer = await ask<{ ok: boolean; error?: string }>(host, path, {
      method: "POST",
      body: { root, number: pr.number, ...payload },
    });
    setBusy(false);
    if (!answer.ok) { setErr(answer.error); return; }
    if (!answer.value.ok) { setErr(answer.value.error ?? "GitHub refused that change."); return; }
    onChanged();
    onClose();
  };

  const setTheDraft = (): void => {
    if (!mayWrite) return;
    void write("/prs/draft", { draft: draft.draft });
  };

  /**
   * Close (or reopen) first, then the two things the sheet offered beside it.
   *
   * One order, and it is the order the words say: the pull request is what is
   * being closed; a branch and a goodbye are consequences. When one of those
   * two fails the sheet stays up and says the pull request IS closed — a
   * blank success would hide a branch that outlived its request.
   */
  const runTheClose = async (): Promise<void> => {
    if (!host || !mayWrite || !close) return;
    setBusy(true);
    setErr(null);
    const answer = await ask<{ ok: boolean; error?: string }>(host, "/prs/close", {
      method: "POST",
      body: { root, number: pr.number, reopen: close.verb === "reopen" },
    });
    if (!answer.ok || !answer.value.ok) {
      setBusy(false);
      setErr(answer.ok ? (answer.value.error ?? "GitHub refused that.") : answer.error);
      return;
    }
    const rest: string[] = [];
    if (close.verb === "close" && deleteBranch) {
      const gone = await ask<{ ok: boolean; error?: string }>(host, "/git/branch-delete", {
        method: "POST", body: { root, name: pr.headRefName },
      });
      if (!gone.ok || !gone.value.ok) {
        rest.push(`the branch ${pr.headRefName} is still there: ${gone.ok ? gone.value.error : gone.error}`);
      }
    }
    if (close.verb === "close" && sayWhy && why.trim()) {
      const said = await ask<{ ok: boolean; error?: string }>(host, "/prs/comment", {
        method: "POST", body: { root, number: pr.number, body: why.trim() },
      });
      if (!said.ok || !said.value.ok) {
        rest.push(`the comment did not land: ${said.ok ? said.value.error : said.error}`);
      }
    }
    setBusy(false);
    if (rest.length) {
      setErr(`#${pr.number} is ${close.verb === "close" ? "closed" : "reopened"}, but ${rest.join("; and ")}.`);
      onChanged();
      return;
    }
    onChanged();
    onClose();
  };

  const saveEdit = (): void => {
    if (!patch?.changed || !mayWrite) return;
    const fields: Record<string, unknown> = {};
    if (patch.title !== undefined) fields.title = patch.title;
    if (patch.body !== undefined) fields.body = patch.body;
    void write("/prs/edit", fields);
  };

  const review = async (verb: "approve" | "request_changes"): Promise<void> => {
    if (!host || !mayWrite) return;
    setBusy(true);
    setErr(null);
    const answer = await ask<{ ok: boolean; error?: string }>(host, "/prs/review-with", {
      method: "POST",
      body: { root, number: pr.number, verb, body: note.trim(), comments: [] },
    });
    setBusy(false);
    if (!answer.ok) { setErr(answer.error); return; }
    if (!answer.value.ok) { setErr(answer.value.error ?? "GitHub refused that review."); return; }
    onChanged();
    onClose();
  };

  const comment = async (): Promise<void> => {
    if (!host || !mayWrite || !note.trim()) return;
    setBusy(true);
    setErr(null);
    const answer = await ask<{ ok: boolean; error?: string }>(host, "/prs/comment", {
      method: "POST",
      body: { root, number: pr.number, body: note.trim() },
    });
    setBusy(false);
    if (!answer.ok) { setErr(answer.error); return; }
    if (!answer.value.ok) { setErr(answer.value.error ?? "GitHub refused that comment."); return; }
    onChanged();
    onClose();
  };

  const rerun = async (): Promise<void> => {
    if (!host || !mayWrite) return;
    setBusy(true);
    setErr(null);
    setSaid(null);
    const answer = await ask<{ ok: boolean; detail?: string; error?: string }>(host, "/prs/rerun", {
      method: "POST",
      body: { root, number: pr.number },
    });
    setBusy(false);
    if (!answer.ok) { setErr(answer.error); return; }
    setSaid(rerunSaid(answer.value.ok, answer.value.ok ? answer.value.detail : answer.value.error));
    if (answer.value.ok) onChanged();
  };

  const pick = (id: PrActionId): void => {
    setErr(null);
    if (id === "open") { onClose(); onOpen?.(); return; }
    if (id === "sync") { onClose(); onSync?.(); return; }
    if (id === "reviewers") { onClose(); onReviewers(); return; }
    if (id === "watch") { onClose(); onWatch?.(); return; }
    if (id === "merge") { onClose(); onMerge?.(); return; }
    if (id === "rerun") { void rerun(); return; }
    setMode(id);
  };

  if (mode === "close" && close) {
    return (
      <Sheet
        open={open}
        onClose={onClose}
        title={`${close.verb === "close" ? "Close" : "Reopen"} #${pr.number}?`}
        subtitle={blocked ?? `${repo} · ${pr.headRefName} · ${close.verb === "close" ? "closing keeps the branch." : "it goes back in the queue."}`}
        footer={
          <View style={{ flex: 1, gap: SPACE.sm }}>
            <Btn label="Keep it open" onPress={onClose} />
            <HoldButton
              action={close.verb === "close" ? "pr.close" : "pr.reopen"}
              label={close.verb === "close" ? `Close #${pr.number}` : `Reopen #${pr.number}`}
              onConfirm={() => { void runTheClose(); }}
              onRelease={(line) => setErr(line)}
              disabled={!mayWrite || busy}
            />
          </View>
        }
      >
        <View style={{ gap: SPACE.md, paddingTop: SPACE.sm }}>
          <Note tone={close.verb === "close" ? "bad" : "quiet"}>
            <Text style={{ fontWeight: "700", color: C.text2 }}>Nothing merges.</Text>
            {" "}{close.line}
          </Note>
          {close.verb === "close" ? (
            <>
              <Row
                title={`Also delete ${pr.headRefName}`}
                sub="Only if it exists for this pull request alone."
                checked={deleteBranch}
                trail={<Switch on={deleteBranch} disabled={!mayWrite} />}
                disabled={!mayWrite}
                onPress={() => setDeleteBranch((v) => !v)}
              />
              <Row
                title="Leave a comment"
                sub={why.trim() ? `“${why.trim()}”` : "Say why, so the author is not left guessing."}
                checked={sayWhy}
                trail={<Switch on={sayWhy} disabled={!mayWrite} />}
                disabled={!mayWrite}
                onPress={() => setSayWhy((v) => !v)}
              />
              {sayWhy ? (
                <TextInput
                  value={why}
                  onChangeText={setWhy}
                  placeholder="Closing in favour of the phone board."
                  placeholderTextColor={C.text4}
                  accessibilityLabel="The comment left with the close"
                  multiline
                  style={{
                    minHeight: 72, borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.border2,
                    backgroundColor: C.bg, color: C.text, fontSize: T.body, padding: SPACE.md,
                  }}
                />
              ) : null}
            </>
          ) : null}
          {close.verb === "close" ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.md }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: C.text, fontSize: 14.5, fontWeight: "600" }}>Reopen later</Text>
                <Text style={{ color: C.text3, fontSize: T.small, lineHeight: 17 }}>Any maintainer can; this phone too.</Text>
              </View>
              <Chip label="always" />
            </View>
          ) : null}
          {err ? <Note tone="bad">{err}</Note> : null}
        </View>
      </Sheet>
    );
  }

  if (mode === "draft") {
    return (
      <Sheet
        open={open}
        onClose={onClose}
        title={pr.isDraft ? `Mark #${pr.number} ready?` : `Mark #${pr.number} as a draft?`}
        subtitle={blocked ?? `${repo} · drafts do not ask for review and do not merge by accident.`}
        footer={
          <View style={{ flex: 1, gap: SPACE.sm }}>
            <Btn label={draft.label} tone="primary" busy={busy} disabled={!mayWrite || busy} onPress={setTheDraft} />
            <Btn label="Cancel" onPress={onClose} />
          </View>
        }
      >
        <View style={{ gap: SPACE.md, paddingTop: SPACE.sm }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.md }}>
            <View style={{ width: 30, height: 30, borderRadius: 10, backgroundColor: C.bg3, alignItems: "center", justifyContent: "center" }}>
              <Glyph name="eye" color={C.text2} size={16} weight={1.8} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: C.text, fontSize: 14.5, fontWeight: "600" }}>Hide it from the review queue</Text>
              <Text style={{ color: C.text3, fontSize: T.small, lineHeight: 17 }}>
                {pr.isDraft
                  ? "It comes back to the same queue."
                  : (detail && reviewersWords(detail) !== "Nobody asked yet"
                    ? "Reviewers keep their history; nobody new is asked."
                    : "Nobody is asked while it is a draft.")}
              </Text>
            </View>
            <Chip label="good" tone="accent" />
          </View>
          <Row
            title="Keep the checks running"
            sub="A draft can still be green while it is being written."
            checked
            trail={<Switch on />}
            disabled
            onPress={() => undefined}
          />
          <Note>
            <Text style={{ fontWeight: "700", color: C.text2 }}>Draft is a state, not a second pull request.</Text>
            {" "}{draft.line}
          </Note>
          {err ? <Note tone="bad">{err}</Note> : null}
        </View>
      </Sheet>
    );
  }

  if (mode === "edit" && patch) {
    return (
      <Sheet
        open={open}
        onClose={onClose}
        title={`Edit #${pr.number}`}
        subtitle={blocked ?? `${repo} · the title and the description are the two things the desktop edits.`}
        tall
        footer={
          <View style={{ flex: 1, gap: SPACE.sm }}>
            <Btn
              label={patch.problem ? "Nothing to save" : "Save changes"}
              tone="primary"
              busy={busy}
              disabled={!mayWrite || !patch.changed || busy}
              onPress={saveEdit}
            />
            <Btn label="Cancel" onPress={onClose} />
          </View>
        }
      >
        <View style={{ gap: SPACE.md, paddingTop: SPACE.sm }}>
          <View style={{ gap: SPACE.xs }}>
            <Label text="Title" />
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="A title"
              placeholderTextColor={C.text4}
              accessibilityLabel="Title"
              style={{
                minHeight: 48, borderRadius: 22, borderWidth: 1, borderColor: C.border2,
                backgroundColor: C.bg2, color: C.text, fontSize: T.body, fontWeight: "600", paddingHorizontal: SPACE.lg,
              }}
            />
          </View>
          <View style={{ gap: SPACE.xs }}>
            <Label text="Description" />
            <TextInput
              value={body}
              onChangeText={setBody}
              placeholder="What this pull request does"
              placeholderTextColor={C.text4}
              accessibilityLabel="Description"
              multiline
              style={{
                minHeight: 160, borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.border2,
                backgroundColor: C.bg2, color: C.text, fontSize: T.body, padding: SPACE.md,
              }}
            />
          </View>
          <Note>
            <Text style={{ fontWeight: "700", color: C.text2 }}>Saving rewrites the same field GitHub shows.</Text>
            {" "}It does not create a new comment or a new revision.
          </Note>
          {patch.problem ? <Note tone="bad">{patch.problem}</Note> : null}
          {err ? <Note tone="bad">{err}</Note> : null}
        </View>
      </Sheet>
    );
  }

  if (mode === "comment") {
    return (
      <Sheet
        open={open}
        onClose={onClose}
        title={`Comment on #${pr.number}`}
        subtitle={blocked ?? `${pr.headRefName} → ${pr.baseRefName} · ${pr.author}`}
        footer={
          <>
            <Btn label="Cancel" onPress={() => setMode("list")} style={{ flex: 1 }} />
            <Btn
              label="Comment"
              tone="primary"
              busy={busy}
              disabled={!mayWrite || busy || !note.trim()}
              onPress={() => { void comment(); }}
              style={{ flex: 2 }}
            />
          </>
        }
      >
        <View style={{ gap: SPACE.md, paddingTop: SPACE.sm }}>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="Leave a comment…"
            placeholderTextColor={C.text4}
            accessibilityLabel="Your comment"
            multiline
            style={{
              minHeight: 96, borderWidth: 1, borderColor: C.border, borderRadius: RADIUS.md,
              backgroundColor: C.bg, color: C.text, padding: SPACE.md, fontSize: T.body,
            }}
          />
          {err ? <Note tone="bad">{err}</Note> : null}
        </View>
      </Sheet>
    );
  }

  if (mode === "approve" || mode === "changes") {
    const approving = mode === "approve";
    return (
      <Sheet
        open={open}
        onClose={onClose}
        title={approving ? `Approve #${pr.number}` : `Request changes on #${pr.number}`}
        subtitle={blocked ?? `${pr.headRefName} → ${pr.baseRefName} · ${pr.author}`}
        footer={
          <>
            <Btn label="Cancel" onPress={() => setMode("list")} style={{ flex: 1 }} />
            <Btn
              label={approving ? "Approve it" : "Request changes"}
              tone={approving ? "primary" : "danger"}
              busy={busy}
              disabled={!mayWrite || busy}
              onPress={() => { void review(approving ? "approve" : "request_changes"); }}
              style={{ flex: 2 }}
            />
          </>
        }
      >
        <View style={{ gap: SPACE.md, paddingTop: SPACE.sm }}>
          <Note>
            {approving
              ? "Your approval is recorded on GitHub as this phone's review."
              : "GitHub shows this as your review, and it blocks the merge until you approve again."}
          </Note>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder={approving ? "A note with your approval — optional" : "What has to change before this lands…"}
            placeholderTextColor={C.text4}
            accessibilityLabel="A note with your review"
            multiline
            style={{
              minHeight: 96, borderWidth: 1, borderColor: C.border, borderRadius: RADIUS.md,
              backgroundColor: C.bg, color: C.text, padding: SPACE.md, fontSize: T.body,
            }}
          />
          {err ? <Note tone="bad">{err}</Note> : null}
          <Note>The verdict and the note go in one call, so a dropped connection cannot leave half a review.</Note>
        </View>
      </Sheet>
    );
  }

  const handed: Partial<Record<PrActionId, boolean>> = {
    open: !!onOpen, sync: !!onSync, watch: !!onWatch, merge: !!onMerge,
  };
  const draw = (row: (typeof rows)[number]): React.ReactNode => {
    const lead = LEAD[row.id];
    const ink = lead.tone ? LEAD_INK[lead.tone]() : C.text2;
    const asked = row.id === "reviewers" && detail;
    return (
      <ActionRow
        key={row.id}
        title={row.label}
        sub={asked ? reviewersWords(detail) : row.sub}
        tone={lead.tone ?? "neutral"}
        lead={<Glyph name={lead.glyph} color={ink} size={18} weight={1.8} />}
        chevron={row.id === "open" || row.id === "reviewers"}
        disabled={busy || !!row.off || (row.id === "reviewers" && !!blocked)}
        onPress={() => pick(row.id)}
      />
    );
  };
  /* Reviewers is a pull-request row (mock 37) and Open is the way out (mock 62):
     the model's order is kept for the review group, the other two move. */
  const reviewGroup = rows.filter((r) => r.id !== "reviewers" && r.id !== "open" && handed[r.id] !== false);
  const reviewersRow = rows.find((r) => r.id === "reviewers");
  const openRow = rows.find((r) => r.id === "open");
  const draftable = pr.state !== "MERGED";
  const icon = { color: C.text2, size: 18, weight: 1.7 } as const;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={detail ? `More on #${pr.number}` : `#${pr.number}`}
      subtitle={blocked ?? `${repo} · ${pr.headRefName} · ${pr.author}`}
      tall={!!detail}
      footer={detail ? undefined : <Btn label="Cancel" onPress={onClose} style={{ flex: 1 }} />}
    >
      {blocked ? <View style={{ paddingTop: SPACE.sm }}><Note tone="bad">{blocked}</Note></View> : null}
      {onAskClaude && mayWrite ? (
        <View style={{ paddingTop: SPACE.sm }}>
          <Group inset={52}>
            <ActionRow
              title="Ask the agent to fix it"
              sub="Opens the pane for this branch, with the failing check and the files in it."
              tone="accent"
              lead={<Glyph name="spark" color={C.primary} size={18} weight={1.8} />}
              trail={<Chip label="Agent" tone="accent" />}
              disabled={!!blocked}
              onPress={onAskClaude}
            />
          </Group>
        </View>
      ) : null}
      {reviewGroup.length || openRow ? (
        <View style={{ paddingTop: SPACE.sm }}>
          <Group inset={52}>
            {reviewGroup.map(draw)}
            {openRow && handed.open ? draw(openRow) : null}
          </Group>
        </View>
      ) : null}
      <View style={{ paddingTop: SPACE.sm }}>
        <Group inset={52}>
          {onLabels ? (
            <ActionRow
              title="Labels"
              sub={labelsOf(pr).join(" · ") || "None yet"}
              lead={<Glyph name="tag" {...icon} />}
              chevron
              disabled={!!blocked}
              onPress={onLabels}
            />
          ) : null}
          {reviewersRow ? draw(reviewersRow) : null}
          {detail ? (
            <ActionRow
              title="Edit the title and description"
              sub={`#${pr.number} · the same two fields the desktop writes`}
              lead={<Glyph name="file" {...icon} />}
              chevron
              disabled={!!blocked}
              onPress={() => { setTitle(detail.title); setBody(detail.body); setErr(null); setMode("edit"); }}
            />
          ) : null}
          {draftable ? (
            <ActionRow
              title={draft.label}
              sub="Takes it out of the review queue, checks keep running"
              lead={<Glyph name="draft_circle" {...icon} />}
              chevron
              disabled={!!blocked}
              onPress={() => { setErr(null); setMode("draft"); }}
            />
          ) : null}
          <ActionRow
            title={pr.headRefName}
            sub={copied ? "Copied to the clipboard" : "Copy the branch name"}
            lead={<Glyph name="branch" {...icon} />}
            trail={<Text style={{ color: copied ? C.success : C.text3, fontSize: T.small, fontFamily: MONO }}>{copied ? "Copied" : "Copy"}</Text>}
            onPress={() => { void Clipboard.setStringAsync(pr.headRefName); flash(); }}
          />
          <ActionRow
            title="Open on GitHub"
            lead={<Glyph name="external" {...icon} />}
            chevron
            onPress={() => { openHttp(pr.url); }}
          />
          {close ? (
            <ActionRow
              title={close.label}
              sub={close.verb === "close" ? "Closes without merging. The branch is kept." : "It goes back in the queue."}
              tone={close.verb === "close" ? "bad" : "neutral"}
              danger={close.verb === "close"}
              lead={<Glyph name={close.verb === "close" ? "close" : "refresh"} color={close.verb === "close" ? C.error : C.text2} size={18} weight={1.7} />}
              chevron
              disabled={!!blocked}
              onPress={() => { setErr(null); setMode("close"); }}
            />
          ) : null}
        </Group>
      </View>
      {said ? <View style={{ paddingTop: SPACE.md }}><Note>{said}</Note></View> : null}
      {err ? <View style={{ paddingTop: SPACE.md }}><Note tone="bad">{err}</Note></View> : null}
    </Sheet>
  );
}
