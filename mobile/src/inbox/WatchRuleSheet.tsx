/*
 * "Tell me when…" — arming a watch on one pull request, and on every new one in
 * its repository.
 *
 * The rules are the computer's (`server/src/prNotifyWatch.ts`): they keep
 * running while the phone is in a pocket, and the fire arrives here whether the
 * app was open or not. This sheet is a view of that state, so it opens by
 * reading what is armed rather than by assuming nothing is — a switch that looks
 * off while a rule is running is how somebody arms the same rule twice and
 * wonders why the buzzes came in pairs.
 *
 * Done posts the DIFFERENCE (`model/watchRules.ts`: `writesFor`), not everything
 * on the screen: pressing the bell twice is not two rules, and the server would
 * answer one row anyway. The skip list is only armed with "Everything is green"
 * — `ci-pass.ignore` is that rule's field, and `ci-fail` takes no names.
 */
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { Host } from "../lib/host.ts";
import { ask } from "../lib/api.ts";
import { WHY_NOT } from "../model/inbox.ts";
import type { PrCheck, PrWatch, PrWatchPreset } from "../../../shared/types.ts";
import {
  SAME_FOR_NEW_SUB, WATCH_KINDS, addBody, armedLine, defaultBody, draftOf, liveLine, skipNames, writesFor,
  type WatchDraft,
} from "../model/watchRules.ts";
import { Btn, Eyebrow, Field, Label, Note, Row, Sheet, Switch, Toggle, toneInk } from "../ui.tsx";
import { Glyph } from "../nav/glyphs.tsx";
import { C, RADIUS, SPACE, T } from "../theme.ts";
import { greenMeansLine, runGroups, type RunSquare } from "../model/checkJobs.ts";

/** One of the sheet's states, in the mock's shape: an eyebrow, the sentence
 *  that is the answer, one line of why, and whatever it can still offer. */
function StateCard({ eyebrow, title, line, quiet, children }: {
  eyebrow: string;
  title: string;
  line: string;
  /** Dashed and transparent: the state the sheet cannot change from here. */
  quiet?: boolean;
  children?: React.ReactNode;
}): React.ReactNode {
  return (
    <View style={{
      paddingVertical: 13, paddingHorizontal: 14, borderRadius: RADIUS.lg, borderWidth: 1,
      borderStyle: quiet ? "dashed" : "solid", borderColor: C.border,
      backgroundColor: quiet ? "transparent" : C.bg2,
    }}>
      <Eyebrow text={eyebrow} style={{ paddingHorizontal: 0, paddingTop: 0, paddingBottom: 6 }} />
      <Text style={{ color: C.text, fontSize: 14.5, fontWeight: "600", lineHeight: 19 }}>{title}</Text>
      <Text style={{ color: C.text3, fontSize: T.small, lineHeight: 17.5, marginTop: 4 }}>{line}</Text>
      {children}
    </View>
  );
}

/** The shape of a rule arriving, so the read is visible as a read. */
function SkeletonRule(): React.ReactNode {
  return (
    <View
      accessibilityElementsHidden
      style={{
        marginTop: 8, paddingVertical: 9, paddingHorizontal: 10, gap: 6,
        borderRadius: RADIUS.sm, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg2,
      }}
    >
      <View style={{ height: 8, width: "60%", borderRadius: 6, backgroundColor: C.bg3 }} />
      <View style={{ height: 8, width: "35%", borderRadius: 6, backgroundColor: C.bg3 }} />
    </View>
  );
}

/** The four inks the run's squares are drawn in, the same as the pull
 *  request's Checks card. Functions so the palette is read at render time. */
const SQUARE = {
  pass: () => C.success,
  fail: () => C.error,
  run: () => C.warning,
  skip: () => "transparent",
} as const;

const SQUARE_INK = {
  pass: () => C.success,
  fail: () => C.error,
  run: () => C.warning,
  skip: () => C.text4,
} as const;

export interface WatchPr {
  root: string;
  repo: string;
  number: number;
  title: string;
}

interface WatchState {
  ok?: boolean;
  error?: string;
  watches?: PrWatch[];
  presets?: PrWatchPreset[];
}

/** What the computer has armed for one pull request. */
type Armed =
  | { error: string }
  | { watches: PrWatch[]; preset: PrWatchPreset | null; draft: WatchDraft };

/** One read of what is armed. Shared by the read on open and by the re-read
 *  after a write that only partly landed. */
async function readArmed(host: Host, pr: WatchPr): Promise<Armed> {
  const answer = await ask<WatchState>(host, "/prs/notify-watch");
  if (!answer.ok) return { error: answer.error };
  if (!answer.value.ok) return { error: answer.value.error || "The computer would not list the watches." };
  const mine = (answer.value.watches ?? []).filter((w) => w.repo === pr.repo && w.number === pr.number);
  const preset = (answer.value.presets ?? []).find((p) => p.repo === pr.repo) ?? null;
  return { watches: mine, preset, draft: draftOf({ watches: mine, preset }) };
}

export function WatchRuleSheet({ open, onClose, host, pr, mayWrite, checks = [], onArmed }: {
  open: boolean;
  onClose: () => void;
  host: Host;
  /** The pull request the sheet was opened from. Without one there is nothing
   *  to arm, and the sheet says so rather than drawing dead switches. */
  pr: WatchPr | null;
  /** Arming a rule is a POST: a phone paired to look only opens this and is
   *  told why it cannot press Done. */
  mayWrite: boolean;
  /** The run's checks, for the second page: what "green" would count. */
  checks?: readonly PrCheck[];
  onArmed: () => void;
}): React.ReactNode {
  const [draft, setDraft] = useState<WatchDraft | null>(null);
  /** The sheet has two pages: the rules (the mock's s40), and the run those
   *  rules would count (s41). One Modal, because the second is a question
   *  about the first and going back must not lose the switches. */
  const [page, setPage] = useState<"rules" | "green">("rules");
  /** What the server had when the sheet opened: the comparison, so Done posts
   *  the difference and the "same for new PRs" switch knows if it moved. */
  const [before, setBefore] = useState<WatchDraft | null>(null);
  const [watches, setWatches] = useState<PrWatch[]>([]);
  const [preset, setPreset] = useState<PrWatchPreset | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Bumped by Retry: one read of what is armed, opening or asking again. */
  const [again, setAgain] = useState(0);

  useEffect(() => {
    if (!open || !pr) return;
    let live = true;
    // Nothing is drawn from the last time this sheet was open: a Done pressed
    // before the read answers would post the difference between two old reads.
    setDraft(null);
    setBefore(null);
    setWatches([]);
    setPreset(null);
    setSaid(null);
    setLoadError(null);
    setBusy(false);
    setPage("rules");
    void (async () => {
      const read = await readArmed(host, pr);
      if (!live) return;
      if ("error" in read) { setLoadError(read.error); return; }
      setWatches(read.watches);
      setPreset(read.preset);
      setDraft(read.draft);
      setBefore(read.draft);
    })();
    return () => { live = false; };
  }, [open, host, pr?.repo, pr?.number, again]);

  /* Dismissed mid-flight is dismissed: the writes below stop at the next rule
     rather than arming the rest with no sheet on screen. */
  const alive = useRef(false);
  useEffect(() => {
    alive.current = open;
    return () => { alive.current = false; };
  }, [open]);

  const set = (patch: Partial<WatchDraft>): void => setDraft((d) => (d ? { ...d, ...patch } : d));

  const done = async (): Promise<void> => {
    if (!pr || !draft || !before) { onClose(); return; }
    if (!mayWrite) return;
    const writes = writesFor(draft, { watches, preset }, before);
    if (!writes.add.length && !writes.remove.length && !writes.preset) { onClose(); return; }
    setBusy(true);
    setSaid(null);
    const failures: string[] = [];
    for (const rule of writes.add) {
      if (!alive.current) return;
      const answer = await ask<{ ok?: boolean; error?: string }>(host, "/prs/notify-watch/add", {
        method: "POST", body: addBody(pr, rule),
      });
      if (!answer.ok) failures.push(answer.error);
      else if (!answer.value.ok) failures.push(answer.value.error || "A rule was refused.");
    }
    for (const id of writes.remove) {
      if (!alive.current) return;
      const answer = await ask<{ ok?: boolean; error?: string }>(host, "/prs/notify-watch/remove", {
        method: "POST", body: { id },
      });
      if (!answer.ok) failures.push(answer.error);
      else if (!answer.value.ok) failures.push(answer.value.error || "A rule could not be removed.");
    }
    if (writes.preset && alive.current) {
      const answer = await ask<{ ok?: boolean; error?: string }>(host, "/prs/notify-watch/default", {
        method: "POST", body: defaultBody(pr.repo, writes.preset.rules, writes.preset.auto),
      });
      if (!answer.ok) failures.push(answer.error);
      else if (!answer.value.ok) failures.push(answer.value.error || "The repository default was refused.");
    }
    if (failures.length) {
      // Part of the write landed: read what the computer holds now, so the list
      // under the switches is not the state from before the press.
      const again = await readArmed(host, pr);
      if (!alive.current) return;
      if (!("error" in again)) { setWatches(again.watches); setPreset(again.preset); }
      setBusy(false);
      setSaid(failures[0]!);
      return;
    }
    setBusy(false);
    onArmed();
    onClose();
  };

  const skips = draft ? skipNames(draft.skip).length : 0;
  const now = Date.now();
  const groups = runGroups(checks);
  const running = checks.filter((c) => c.state === "pending").length;
  const skippedChecks = checks.filter((c) => c.state === "skipped").length;
  /** "49 checks in 3 jobs · 4 skipped": the row that opens the run. */
  const runLine = `${checks.length} check${checks.length === 1 ? "" : "s"} in ${groups.length} job${groups.length === 1 ? "" : "s"}`
    + `${skippedChecks ? ` · ${skippedChecks} skipped` : ""}`;
  const greenSub = pr
    ? `#${pr.number} · ${groups.length} job${groups.length === 1 ? "" : "s"} · ${checks.length} check${checks.length === 1 ? "" : "s"}${running ? ` · ${running} running` : ""}.`
    : undefined;
  /** Nothing is armed on the computer: no rule for this pull request and no
   *  repository default. The card above the switches says what that means; the
   *  switches stay, because turning one on is the way out of it. */
  const nothingOn = !!draft && !watches.length && !preset
    && !draft.green && !draft.fails && !draft.comments && !draft.sameForNew;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={page === "green" ? "What counts as green" : "Tell me when…"}
      subtitle={page === "green"
        ? greenSub
        : pr ? `#${pr.number} · ${pr.repo} · the rules keep running on the computer.` : undefined}
      footer={page === "green" ? (
        <>
          <Btn label="Back" onPress={() => setPage("rules")} disabled={busy} style={{ flex: 1 }} />
          <Btn label="Watch this run" tone="primary" onPress={() => { void done(); }} busy={busy} disabled={!pr || !draft || !mayWrite} style={{ flex: 1 }} />
        </>
      ) : (
        <Btn label="Done" tone="primary" onPress={() => { void done(); }} busy={busy} disabled={!pr || !draft || !mayWrite} />
      )}
    >
      {page === "green" && draft ? (
        <View style={{ gap: SPACE.md, paddingBottom: SPACE.md }}>
          {groups.length ? (
            <View>
              {groups.map((group) => (
                <View key={group.name} style={{
                  flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10,
                  borderTopWidth: 1, borderTopColor: C.border,
                }}>
                  <View style={{ width: 104 }}>
                    <Text numberOfLines={1} style={{ color: C.text, fontSize: 12.5, fontWeight: "600" }}>{group.name}</Text>
                    <Text style={{ color: C.text3, fontSize: T.small }}>
                      {group.count} check{group.count === 1 ? "" : "s"}
                    </Text>
                  </View>
                  <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
                    {group.squares.map((square, i) => (
                      <View key={i} style={{
                        width: 12, height: 12, borderRadius: 3,
                        backgroundColor: SQUARE[square](),
                        borderWidth: square === "skip" ? 1 : 0, borderColor: C.border2,
                      }} />
                    ))}
                  </View>
                  <Text style={{
                    color: group.tone === "failed" ? C.error
                      : group.tone === "running" ? C.warning
                        : group.tone === "fine" ? C.success : C.text4,
                    fontSize: T.small, fontWeight: "600",
                  }}>{group.word}</Text>
                </View>
              ))}
            </View>
          ) : (
            <Note>No checks are attached to this pull request yet. Green will mean the first run that arrives.</Note>
          )}

          {/* The legend. Four words, each with the square it names, because a
              hollow square and a green one are the whole difference between
              "never ran" and "passed". */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
            {(["pass", "fail", "run", "skip"] as RunSquare[]).map((square) => (
              <View key={square} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <View style={{
                  width: 12, height: 12, borderRadius: 3,
                  backgroundColor: SQUARE[square](),
                  borderWidth: square === "skip" ? 1 : 0, borderColor: C.border2,
                }} />
                <Text style={{ color: C.text3, fontSize: 12 }}>
                  {square === "pass" ? "passed" : square === "fail" ? "failed" : square === "run" ? "running" : "does not run"}
                </Text>
              </View>
            ))}
          </View>

          {mayWrite ? (
            <Field
              label="Skip checks that do not block"
              value={draft.skip}
              onChangeText={(v) => set({ skip: v })}
              placeholder="docs-lint, changelog"
            />
          ) : (
            <Label text={`Skip checks that do not block · ${draft.skip.trim() || "none"}`} />
          )}
          <Text style={{ color: C.text3, fontSize: T.small, lineHeight: 18 }}>
            Exact check names, separated by commas. {greenMeansLine(checks.length, skips)}.
          </Text>

          <Toggle
            on={draft.sameForNew}
            label="Same for my new PRs in this repo"
            sub={draft.sameForNew ? SAME_FOR_NEW_SUB : "Off · these rules apply to this pull request only."}
            disabled={!mayWrite}
            onPress={() => set({ sameForNew: !draft.sameForNew })}
          />

          <Note>A job that does not run on this pull request is empty, not green. Counting it as green would say a run passed when it never happened.</Note>

          {said ? (
            <Text accessibilityLiveRegion="polite" style={{ color: toneInk("bad"), fontSize: T.small }}>{said}</Text>
          ) : null}
        </View>
      ) : !pr ? (
        <Note>Open this from a pull request — a rule needs one to watch.</Note>
      ) : loadError ? (
        <StateCard
          eyebrow="Offline"
          title="The watch still runs on the computer"
          line={`${loadError} The rules keep watching from there; this sheet cannot read them right now.`}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 7, marginTop: 10 }}>
            <Glyph name="offline" color={C.text3} size={15} />
            <Text style={{ flex: 1, color: C.text3, fontSize: T.small }}>
              No earlier read is kept to show.
            </Text>
            <Btn label="Retry" onPress={() => setAgain((n) => n + 1)} />
          </View>
        </StateCard>
      ) : !draft ? (
        <StateCard
          eyebrow="Loading the run"
          title="Reading the rules"
          line="The rules live on the computer, so the switches fill in as that read answers."
        >
          <SkeletonRule />
          <SkeletonRule />
        </StateCard>
      ) : (
        <View style={{ gap: SPACE.md, paddingBottom: SPACE.md }}>
          {mayWrite ? null : (
            <StateCard
              quiet
              eyebrow="Read-only"
              title="You can see the rules, not change them"
              line={WHY_NOT.watch}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 7, marginTop: 9 }}>
                <Glyph name="lock" color={C.text3} size={15} />
                <Text style={{ color: C.text3, fontSize: T.small }}>Set to read-only on the computer</Text>
              </View>
            </StateCard>
          )}
          {mayWrite && nothingOn ? (
            <StateCard
              eyebrow="Nothing watched"
              title="This pull request tells you nothing yet"
              line="No rule is on. The run on the pull request is still read; turning one on is what sends a notification."
            />
          ) : null}
          {/* The mock's rules (40): the sentence, what the rule is doing right
              now under it, and the switch on the right. The live line is the
              half a row of switches without it cannot say — an armed rule and
              one that fired an hour ago look the same when off. */}
          {WATCH_KINDS.map((kind) => {
            const on = kind.id === "green" ? draft.green : kind.id === "fails" ? draft.fails : draft.comments;
            return (
              <Row
                key={kind.id}
                title={kind.label}
                sub={kind.sub}
                live={liveLine(kind.id, draft, watches, now, {
                  passed: checks.filter((c) => c.state === "success").length,
                  total: checks.length,
                  running: checks.filter((c) => c.state === "pending").length,
                })}
                liveInk={!on ? C.text3 : kind.id === "green" ? C.success : kind.id === "fails" ? C.warning : C.text2}
                checked={on}
                trail={<Switch on={on} disabled={!mayWrite} />}
                disabled={!mayWrite}
                onPress={() => set(kind.id === "green"
                  ? { green: !draft.green }
                  : kind.id === "fails" ? { fails: !draft.fails } : { comments: !draft.comments })}
              />
            );
          })}

          {/* The door to the run those switches count (mock 40 → 41). It sits
              under the rules because it answers a question about them, and it
              is a row rather than a fourth switch: it opens something. */}
          <Row
            title="What counts as green"
            sub={runLine}
            lead={(
              <View style={{
                width: 30, height: 30, borderRadius: 9, alignItems: "center", justifyContent: "center",
                backgroundColor: C.bg3,
              }}>
                <Glyph name="grid" color={C.text2} size={16} weight={1.8} />
              </View>
            )}
            chevron
            onPress={() => setPage("green")}
          />

          {/* The skip list only exists under "Everything is green": it is
              `ci-pass.ignore`, and a failure rule has no names to skip. */}
          {draft.green ? (
            <View style={{ gap: SPACE.xs }}>
              {mayWrite ? (
                <Field
                  label="Checks that never block"
                  value={draft.skip}
                  onChangeText={(v) => set({ skip: v })}
                  placeholder="docs-lint, changelog"
                />
              ) : (
                // Read-only: the names are stated, not offered as a field with
                // no way to save what it took.
                <Label text={`Checks that never block · ${draft.skip.trim() || "none"}`} />
              )}
              <Text style={{ color: C.text3, fontSize: T.small, lineHeight: 18 }}>
                Exact check names, separated by commas.{" "}
                {skips ? `${skips} skipped, by name.` : "None skipped: every check counts."}{" "}
                A job that does not run is not green.
              </Text>
            </View>
          ) : null}

          <Row
            title="Same for my new PRs in this repo"
            sub={draft.sameForNew
              ? SAME_FOR_NEW_SUB
              : "Off · these rules apply to this pull request only."}
            live={draft.sameForNew
              ? (preset ? `On · ${preset.rules.length} rule${preset.rules.length === 1 ? "" : "s"} already follow it` : `On · the next pull request you open here starts with these`)
              : "Off · a new pull request here starts with nothing armed"}
            liveInk={draft.sameForNew ? C.success : C.text3}
            checked={draft.sameForNew}
            trail={<Switch on={draft.sameForNew} disabled={!mayWrite} />}
            disabled={!mayWrite}
            onPress={() => set({ sameForNew: !draft.sameForNew })}
          />

          {/* A rule this phone cannot draw as one of the three — a named check
              — would otherwise be invisible, and then removed by a Done that
              never showed it. The mock has three rules; the computer can hold
              more, and the extra ones are stated rather than hidden. */}
          {watches.some((w) => w.rule.type === "check") ? (
            <Text style={{ color: C.text3, fontSize: T.small }}>
              Also on the computer: {watches.filter((w) => w.rule.type === "check").map(armedLine).join(" · ")}
            </Text>
          ) : null}

          {said ? (
            <Text accessibilityLiveRegion="polite" style={{ color: toneInk("bad"), fontSize: T.small }}>{said}</Text>
          ) : null}
        </View>
      )}
    </Sheet>
  );
}
