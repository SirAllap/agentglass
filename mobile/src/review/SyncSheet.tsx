/*
 * Syncing a branch — one pull request, or a whole lane as N single syncs.
 *
 * `/prs/update-branch` has no bulk form, so this sheet never pretends there is
 * one: it makes one call per branch that is actually behind and counts the
 * answers in model/prSync.ts. A lane sync that said "Synced 3" over two moved
 * branches and a conflict is the bug that model exists to prevent.
 *
 * ── the hold ─────────────────────────────────────────────────────────────
 * Updating a branch writes a merge commit other people read, so the press
 * holds (model/confirmPolicy.ts: `pr.branch.update`). It is one hold for the
 * whole lane, not one per branch: the list under it says exactly what will be
 * tried, and the summary afterwards says what happened to each.
 *
 * ── the conflict ─────────────────────────────────────────────────────────
 * GitHub refuses with `conflict: true` and nothing moves — not the remote
 * branch, not a checkout on the computer. The refusal is turned into a
 * sentence by the model, and this sheet reads `/prs/conflict-files` to name
 * the files. Resolving them is the computer's job in a worktree; the phone
 * says so rather than offering a merge it cannot do.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { PrActionResult, PrLocalHead } from "../../../shared/types.ts";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import {
  behindLine, bringLine, incomingLines, outcomeOf, outcomeWord, skippedOutcome, syncCount, syncSummary,
  syncSubtitle, syncTitle, unreachableOutcome, unreadOutcome,
  type IncomingCommit, type SyncOutcome, type SyncTarget,
} from "../model/prSync.ts";
import { Btn, Chip, HoldButton, Label, Note, Sheet } from "../ui.tsx";
import { Glyph, type GlyphName } from "../nav/glyphs.tsx";
import { C, MONO, SPACE, T, tint } from "../theme.ts";

type Phase = "reading" | "ready" | "syncing" | "done";

/** One step of a sync, as the mock draws it (screens 38 and 39): a dot, what
 *  happened, and the sentence under it. */
function Step({ state, icon, title, sub, trail, mono }: {
  state: "done" | "todo" | "bad";
  icon: GlyphName;
  title: string;
  sub: string;
  /** What the row adds up to: "3" behind, or "clean" (mock 38). */
  trail?: React.ReactNode;
  /** The sentence is a list of lines in the mono face (mock 38's commits). */
  mono?: boolean;
}): React.ReactNode {
  const ink = state === "bad" ? C.error : state === "done" ? C.success : C.warning;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.md, paddingVertical: SPACE.xs }}>
      <View style={{
        width: 30, height: 30, borderRadius: 10, alignItems: "center", justifyContent: "center",
        backgroundColor: tint(ink, 0.14),
      }}>
        <Glyph name={icon} color={ink} size={16} weight={1.9} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={{ color: C.text, fontSize: 13.5, fontWeight: "600" }}>{title}</Text>
        <Text style={{ color: C.text3, fontSize: T.small, lineHeight: mono ? 19 : 17, ...(mono ? { fontFamily: MONO } : {}) }}>{sub}</Text>
      </View>
      {trail}
    </View>
  );
}

export function SyncSheet({ open, onClose, host, root, base, targets, mayWrite, blocked, onDone, onAgent }: {
  open: boolean;
  onClose: () => void;
  host: Host | null;
  root: string;
  base: string;
  /** Memoised by the caller: the read below re-runs when this identity moves. */
  targets: SyncTarget[];
  mayWrite: boolean;
  blocked: string | null;
  /** A sync was attempted: re-read the pull request or the lane. */
  onDone: () => void;
  /** The agent, when this sheet is over a screen that has the menu (mock 39). */
  onAgent?: () => void;
}): React.ReactNode {
  const [rows, setRows] = useState<SyncTarget[]>(targets);
  const [outcomes, setOutcomes] = useState<Record<number, SyncOutcome>>({});
  const [phase, setPhase] = useState<Phase>("ready");
  const [readErr, setReadErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRows(targets);
    setOutcomes({});
    setErr(null);
    setReadErr(null);
    const unknown = targets.filter((t) => t.behind === undefined);
    if (!host || !unknown.length) { setPhase("ready"); return; }
    let gone = false;
    setPhase("reading");
    void (async () => {
      const answers = await Promise.all(unknown.map(async (t) => {
        const answer = await ask<{ ok: boolean; behind?: number; ahead?: number; incoming?: IncomingCommit[]; local?: PrLocalHead; error?: string }>(
          host, `/prs/behind?root=${encodeURIComponent(root)}&number=${t.number}`,
        );
        return { t, answer };
      }));
      if (gone) return;
      let failure: string | null = null;
      const facts = new Map<number, { behind: number; ahead: number; incoming: IncomingCommit[]; syncLocal: boolean }>();
      for (const { t, answer } of answers) {
        if (!answer.ok) { failure ??= answer.error; continue; }
        if (!answer.value.ok) { failure ??= answer.value.error ?? "GitHub would not compare the branches."; continue; }
        facts.set(t.number, {
          behind: Number(answer.value.behind ?? 0),
          ahead: Number(answer.value.ahead ?? 0),
          incoming: Array.isArray(answer.value.incoming) ? answer.value.incoming : [],
          syncLocal: answer.value.local?.sync === "ff",
        });
      }
      setRows((was) => was.map((t) => ({ ...t, ...(facts.get(t.number) ?? {}) })));
      setReadErr(failure);
      setPhase("ready");
    })();
    return () => { gone = true; };
  }, [open, host, root, targets]);

  const work = useMemo(() => syncCount(rows), [rows]);
  const summary = useMemo(() => syncSummary(Object.values(outcomes), base), [outcomes, base]);
  const conflicted = phase === "done" && rows.some((t) => outcomes[t.number]?.status === "conflict");
  const title = phase === "done" ? "Sync result" : syncTitle(targets, base);
  const subtitle = syncSubtitle(rows, base);

  /* Dismissed mid-flight is dismissed: the read below is already dropped when
     the sheet closes, and the writes are too. Branch 3 of 5 must not land
     after the person's last action was "close this". */
  const live = useRef(false);
  useEffect(() => {
    live.current = open;
    return () => { live.current = false; };
  }, [open]);

  const sync = useCallback(async (): Promise<void> => {
    if (!host || !mayWrite) return;
    if (!rows.some((t) => (t.behind ?? 0) > 0)) return;
    setPhase("syncing");
    setErr(null);
    const next: Record<number, SyncOutcome> = {};
    for (const t of rows) {
      if (!live.current) return;
      // An unread comparison is not "up to date": nothing compared this branch,
      // so nothing may claim it has nothing to bring.
      if (t.behind === undefined) {
        next[t.number] = unreadOutcome(t.number, base);
        setOutcomes({ ...next });
        continue;
      }
      if (t.behind <= 0) {
        next[t.number] = skippedOutcome(t.number, base);
        setOutcomes({ ...next });
        continue;
      }
      const answer = await ask<PrActionResult>(host, "/prs/update-branch", {
        method: "POST",
        body: { root, number: t.number, syncLocal: t.syncLocal === true },
      });
      let out = answer.ok ? outcomeOf(t.number, answer.value) : unreachableOutcome(t.number, answer.error);
      next[t.number] = out;
      setOutcomes({ ...next });
      if (out.status === "conflict") {
        const files = await ask<{ ok: boolean; conflicts?: string[]; error?: string }>(
          host, `/prs/conflict-files?root=${encodeURIComponent(root)}&number=${t.number}`,
        );
        if (files.ok && files.value.ok && Array.isArray(files.value.conflicts)) {
          out = { ...out, conflicts: files.value.conflicts };
          next[t.number] = out;
          setOutcomes({ ...next });
        }
      }
    }
    if (!live.current) return;
    setPhase("done");
    onDone();
  }, [host, mayWrite, rows, root, base, onDone]);

  const footer = phase === "done" ? (
    conflicted && onAgent ? (
      <View style={{ flex: 1, gap: SPACE.sm }}>
        <Btn label="Let the agent resolve it" tone="primary" onPress={() => { onClose(); onAgent(); }} />
        <Btn label="Done" onPress={onClose} />
      </View>
    ) : (
      <Btn label="Done" tone="primary" onPress={onClose} style={{ flex: 1 }} />
    )
  ) : (
    <HoldButton
      action="pr.branch.update"
      label={phase === "reading"
        ? "Reading…"
        : readErr && !rows.some((t) => t.behind !== undefined)
          ? "Could not read"
          : !work
            ? rows.some((t) => t.behind === undefined) ? "Not read" : "Up to date"
          : rows.length === 1
            ? `Sync ${rows[0]!.behind} commit${rows[0]!.behind === 1 ? "" : "s"}`
            : `Sync ${work} branch${work === 1 ? "" : "es"}`}
      onConfirm={() => { void sync(); }}
      onRelease={(line) => setErr(line)}
      disabled={!mayWrite || !work || phase !== "ready"}
      style={{ flex: 1 }}
    />
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      subtitle={blocked ?? subtitle}
      footer={footer}
    >
      {phase === "reading" ? (
        <View style={{ paddingVertical: SPACE.lg, alignItems: "center" }}>
          <ActivityIndicator color={C.text3} />
        </View>
      ) : null}

      {readErr ? (
        <View style={{ paddingBottom: SPACE.sm }}>
          <Note tone="bad">How far behind could not be read: {readErr}</Note>
        </View>
      ) : null}

      {rows.length === 1 ? (
        <View style={{ gap: SPACE.sm, paddingTop: SPACE.sm }}>
          {/* The three steps, before the press: what will happen, in the order
              it happens, and the one that is already true. */}
          {phase === "done" ? (
            <View>
              {(() => {
                const out = outcomes[rows[0]!.number];
                const synced = out?.status === "synced" || out?.status === "requested";
                return (
                  <>
                    <Step
                      icon="down"
                      state={out ? "done" : "todo"}
                      title="Syncing"
                      sub={`${bringLine(rows[0]!, base)} ${out ? "" : "Not started."}`.trim()}
                    />
                    <Step
                      icon={out?.status === "conflict" ? "alert" : "merge"}
                      state={synced ? "done" : out ? "bad" : "todo"}
                      title={synced ? "Synced" : out?.status === "conflict" ? "Conflict" : "Merge the base into the branch"}
                      sub={out?.line ?? "One commit on top, made on the computer."}
                    />
                    <Step
                      icon="refresh"
                      state={synced ? "done" : "todo"}
                      title="Push, and read the checks again"
                      sub="The card moves when the new run comes back."
                    />
                  </>
                );
              })()}
            </View>
          ) : (
            <View>
              {/* The mock's rows (38): how far behind, whether it applies, and
                  the two things the press will do. Each carries the number or
                  word it adds up to on the right. */}
              <Step
                icon="down"
                state={rows[0]!.behind === undefined ? "todo" : "done"}
                title={behindLine(rows[0]!, base)}
                sub={rows[0]!.ahead ? `${base} is ${rows[0]!.behind ?? 0} ahead; this branch has ${rows[0]!.ahead} commit${rows[0]!.ahead === 1 ? "" : "s"} ${base} does not.` : "The branch is read; nothing has moved yet."}
                trail={rows[0]!.behind ? <Chip label={String(rows[0]!.behind)} tone="warn" /> : undefined}
              />
              <Step
                icon={rows[0]!.conflict ? "alert" : "check"}
                state={rows[0]!.conflict ? "bad" : "done"}
                title={rows[0]!.conflict ? "Conflicts" : "No conflicts"}
                sub={rows[0]!.conflict ? "A sync will be refused and nothing will move." : "Git applies them without asking."}
                trail={<Chip label={rows[0]!.conflict ? "conflicts" : "clean"} tone={rows[0]!.conflict ? "bad" : "good"} />}
              />
              {incomingLines(rows[0]!).length ? (
                <Step
                  icon="merge"
                  state="todo"
                  title={`What ${base} brings`}
                  sub={incomingLines(rows[0]!).join("\n")}
                  mono
                />
              ) : null}
              <Step icon="merge" state="todo" title={`Merge ${base} into the branch`} sub="One commit on top, made on the computer." />
              <Step icon="refresh" state="todo" title="Push, and read the checks again" sub="The card moves when the new run comes back." />
            </View>
          )}
          <Note>
            <Text style={{ fontWeight: "700", color: C.text2 }}>Sync runs on the computer.</Text>
            {" "}The branch is untouched until you press. It merges {base} into {rows[0]!.head ?? "the branch"} and
            pushes it; a conflict stops here and the pull request&apos;s own sheet offers the agent.
          </Note>
          {rows[0]!.conflict ? (
            <Note tone="bad">
              GitHub already says this branch conflicts with {base}. A sync will be refused and nothing will move.
            </Note>
          ) : null}

        </View>
      ) : (
        <View style={{ gap: SPACE.sm, paddingTop: SPACE.sm }}>
          <Note>
            One call per branch that is behind; there is no bulk route. A clean local copy follows each one;
            anything dirty, ahead or mid-merge is left alone. The summary counts what GitHub accepted.
          </Note>
          <Label text={`${work} of ${rows.length} need it`} />
        </View>
      )}

      <View style={{ paddingTop: SPACE.md, gap: SPACE.md }}>
        {rows.map((t) => {
          const out = outcomes[t.number];
          return (
            <View key={t.number} style={{ gap: 2 }}>
              <Text style={{ color: C.text, fontSize: T.body, fontWeight: "600" }}>#{t.number}</Text>
              <Text style={{ color: C.text3, fontSize: T.small }}>{behindLine(t, base)}</Text>
              {out ? (
                <>
                  <Text style={{
                    color: out.status === "synced" ? C.success
                      : out.status === "conflict" || out.status === "failed" ? C.error
                      : out.status === "unknown" || out.status === "unread" ? C.warning : C.text2,
                    fontSize: T.small, fontWeight: "600",
                  }}>{outcomeWord(out.status)}</Text>
                  <Text style={{ color: C.text2, fontSize: T.small, lineHeight: 18 }}>{out.line}</Text>
                  {out.conflicts?.length ? (
                    <View style={{ paddingTop: SPACE.xs, gap: 2 }}>
                      <Text style={{ color: C.text3, fontSize: T.eyebrow }}>FILES GITHUB NAMES</Text>
                      {out.conflicts.slice(0, 5).map((path) => (
                        <Text key={path} numberOfLines={1} ellipsizeMode="head" style={{
                          color: C.text2, fontSize: T.small, fontFamily: MONO,
                        }}>{path}</Text>
                      ))}
                      {out.conflicts.length > 5 ? (
                        <Text style={{ color: C.text3, fontSize: T.small }}>
                          and {out.conflicts.length - 5} more
                        </Text>
                      ) : null}
                      <Text style={{ color: C.text3, fontSize: T.small, lineHeight: 18, paddingTop: SPACE.xs }}>
                        Resolving it happens on the computer, in a worktree of its own. Nothing on this phone
                        merges a conflict.
                      </Text>
                    </View>
                  ) : null}
                </>
              ) : null}
              {!out && phase === "syncing" ? (
                <Text style={{ color: C.text3, fontSize: T.small }}>Trying…</Text>
              ) : null}
            </View>
          );
        })}
      </View>

      {phase === "done" ? (
        <View style={{ paddingTop: SPACE.md, gap: SPACE.sm }}>
          {conflicted ? (
            <Note tone="bad">
              <Text style={{ fontWeight: "700", color: C.text2 }}>Nothing is half-written.</Text>
              {" "}The branch is exactly as it was before the sync until you choose.
            </Note>
          ) : null}
          <Note tone={summary.conflicts || summary.failed || summary.unknown || summary.unread ? "bad" : "quiet"}>{summary.line}</Note>
        </View>
      ) : null}

      {err ? <View style={{ paddingTop: SPACE.md }}><Note tone="bad">{err}</Note></View> : null}
    </Sheet>
  );
}
