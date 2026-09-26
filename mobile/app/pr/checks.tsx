/*
 * Why a check failed, without going to the browser for it.
 *
 * The pull request screen could say "3 failing" and name them, and that is
 * where it stopped — which is the half of the question nobody needs. A red
 * check is not news; what it SAID is the whole reason you opened the phone.
 *
 * ── two calls, and they are both reads ───────────────────────────────────
 * `/prs/check-jobs` lists the jobs of the runs attached to this pull request,
 * and `/prs/job-log` returns one job's output. Both are GETs, so both are
 * inside a `read` grant — this screen works on a phone paired to look, which
 * matters more here than anywhere else in the app: reading why CI is red is
 * exactly what somebody does from a sofa on a device they would never give
 * write access to.
 *
 * ── why a route and not a sheet ──────────────────────────────────────────
 * A sheet is for choosing between a few things and being dismissed. A log is
 * hundreds of lines that somebody scrolls, gives up on, and comes back to; it
 * needs the whole screen, a title bar that says which job, and a back gesture
 * that returns to the pull request rather than to nothing.
 *
 * ── the log arrives whole and is drawn from the end ──────────────────────
 * A CI failure is at the BOTTOM of its log — the last thing before the process
 * exits. Opening at the top means scrolling past four hundred lines of
 * dependency resolution to reach the one line anybody wants, every time. So
 * the tail is what is shown first, with the rest one tap behind it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import type { PrCheckJob } from "../../../shared/types.ts";
import { ask } from "../../src/lib/api.ts";
import { byUrgency, foldJobLog, looksFailed, ranFor, standingOf, tailOf } from "../../src/model/checkJobs.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Btn, Card, Chip, Group, GroupTitle, Label, Note, Row, TAP } from "../../src/ui.tsx";
import { Glyph } from "../../src/nav/glyphs.tsx";
import { C, MONO, RADIUS, SPACE, T, tint } from "../../src/theme.ts";

/** How many lines of the tail to open on.
 *
 *  120 is about four screens on a phone, which is enough to hold a stack trace
 *  and the command that produced it without being a scroll of its own. */
const TAIL = 120;

/** The ink and mark for a standing. The words and the ordering are in
 *  src/model/checkJobs.ts, where they are tested; what stays here is the
 *  drawing, which is the one part a test could not check anyway. Functions,
 *  so they are read from the live palette at render time. */
const INK = { failed: () => C.error, running: () => C.warning, fine: () => C.success } as const;
const MARK = { failed: "x_circle", running: "run_circle", fine: "ok_circle" } as const;

export default function ChecksScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const router = useRouter();
  const { number, root } = useLocalSearchParams<{ number: string; root: string }>();
  /* Handing a pull request to Claude opens a terminal, and a terminal needs
     the full grant: on any other pairing the button is not drawn, the same
     rule the pull request's own bar keeps. */
  const mayWrite = host?.scope === "full";

  const [jobs, setJobs] = useState<PrCheckJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The job being read, and its log. Held together so a slow log cannot land
   *  under a job somebody has already moved on from. */
  const [open, setOpen] = useState<PrCheckJob | null>(null);
  const [log, setLog] = useState<{ text: string; truncated?: boolean } | null>(null);
  const [logErr, setLogErr] = useState<string | null>(null);
  const [whole, setWhole] = useState(false);

  useEffect(() => {
    if (!host || !number || !root) return;
    let gone = false;
    void (async () => {
      const query = `root=${encodeURIComponent(root)}&number=${encodeURIComponent(number)}`;
      const answer = await ask<{ ok: boolean; jobs?: PrCheckJob[]; error?: string }>(
        host, `/prs/check-jobs?${query}`,
      );
      if (gone) return;
      if (!answer.ok) { setError(answer.error); return; }
      if (!answer.value.ok) { setError(answer.value.error || "Those checks could not be read."); return; }
      setError(null);
      setJobs(answer.value.jobs ?? []);
    })();
    return () => { gone = true; };
  }, [host, number, root]);

  const ordered = useMemo(() => byUrgency(jobs ?? []), [jobs]);

  const read = useCallback(async (job: PrCheckJob): Promise<void> => {
    if (!host || !root) return;
    setOpen(job);
    setLog(null);
    setLogErr(null);
    setWhole(false);
    const query = `root=${encodeURIComponent(root)}&job=${encodeURIComponent(job.id)}`;
    const answer = await ask<{ ok: boolean; text?: string; truncated?: boolean; error?: string }>(
      host, `/prs/job-log?${query}`,
    );
    if (!answer.ok) { setLogErr(answer.error); return; }
    if (!answer.value.ok) { setLogErr(answer.value.error || "That log could not be read."); return; }
    setLog({ text: answer.value.text ?? "", truncated: answer.value.truncated });
  }, [host, root]);

  /* GitHub's timestamp and step markers, folded for a screen with no room for
   *  either — see foldJobLog. The tail and the "show all" toggle both work on
   *  the folded text; "Copy the log" below reaches past this to `log.text`,
   *  the wire's own bytes, deliberately. */
  const folded = useMemo(() => foldJobLog(log?.text ?? ""), [log]);
  const tail = useMemo(() => tailOf(folded, TAIL), [folded]);
  const shown = whole ? folded.replace(/\s+$/, "").split("\n") : tail.lines;
  const now = Date.now();
  const [allFine, setAllFine] = useState(false);
  const bands = useMemo(() => ({
    failed: ordered.filter((j) => standingOf(j).standing === "failed"),
    running: ordered.filter((j) => standingOf(j).standing === "running"),
    fine: ordered.filter((j) => standingOf(j).standing === "fine"),
  }), [ordered]);

  const copyLog = useCallback((): void => {
    if (!log) return;
    // The ORIGINAL text, not `shown` — folding is a reading aid, and
    // whoever pastes this into an issue or a terminal wants GitHub's own
    // bytes, timestamps and all.
    void Clipboard.setStringAsync(log.text);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [log]);

  /**
   * Back to the pull request with its Claude menu open.
   *
   * The menu is not rebuilt here. The recipes, the one suggested for this
   * pull request and the read-back of the prompt all live on that screen, and
   * a second copy of them is the one that drifts; `ask=1` asks it to open
   * what it already has. `dismissTo` pops back to the screen underneath
   * rather than pushing another on top, so back from the terminal still lands
   * on one pull request and not two.
   *
   * "About it" and not "fix it": the recipe a failing pull request of yours
   * is offered first diagnoses and changes nothing, and a button that
   * promised a fix would be promising what the prompt tells Claude not to do.
   */
  const askClaude = (): void => {
    router.dismissTo({ pathname: "/pr/[number]", params: { number: String(number), root: root ?? "", ask: "1" } });
  };

  const jobRow = (job: PrCheckJob): React.ReactNode => {
    const { standing } = standingOf(job);
    return (
      <Row
        key={job.id}
        title={job.name}
        sub={ranFor(job, now)}
        lead={<Glyph name={MARK[standing]} color={INK[standing]()} size={22} weight={1.9} />}
        chevron
        onPress={() => { void read(job); }}
      />
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Stack.Screen
        options={{
          title: open ? open.name : `Checks · #${number}`,
          headerRight: open && log ? () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Copy the log"
              onPress={copyLog}
              style={({ pressed }) => ({
                width: TAP, height: TAP, borderRadius: TAP / 2, alignItems: "center", justifyContent: "center",
                backgroundColor: pressed ? C.bg3 : "transparent",
              })}
            >
              <Glyph name="copy" color={C.text2} size={20} />
            </Pressable>
          ) : undefined,
        }}
      />

      {open ? (
        <>
          {shown.length ? (
            /* How much of the log is on screen, said at the top where the
               scroll starts, with the rest one tap away. */
            <View style={{
              flexDirection: "row", alignItems: "center", minHeight: 48, paddingLeft: 20, paddingRight: SPACE.sm,
              borderBottomWidth: 1, borderBottomColor: C.border,
            }}>
              <Text style={{ color: C.text3, fontSize: 13, flex: 1 }}>
                {whole || tail.total <= TAIL ? `${shown.length} lines` : `Last ${TAIL} of ${tail.total} lines`}
                {open ? ` · ${ranFor(open, now)}` : ""}
              </Text>
              {!whole && tail.total > TAIL ? (
                <Pressable onPress={() => setWhole(true)} style={{ minHeight: TAP, justifyContent: "center", paddingHorizontal: SPACE.sm }}>
                  <Text style={{ color: C.primary, fontSize: T.body, fontWeight: "600" }}>Show all</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md }}>
            {logErr ? <Card><Label text="Cannot read it" /><Note tone="bad">{logErr}</Note></Card> : null}
            {!log && !logErr ? (
              <View style={{ padding: SPACE.xl }}><ActivityIndicator color={C.text3} /></View>
            ) : null}

            {log && !tail.total ? <Card><Note>This job wrote nothing.</Note></Card> : null}

            {shown.length ? (
              <>
                {log?.truncated ? (
                  <Note>GitHub cut this log short; what is here is what it returned.</Note>
                ) : null}
                {/* Its own horizontal scroller. A log line is as long as it is
                    and wrapping a stack trace at 393 points makes it unreadable
                    in a different way — so the page never scrolls sideways and
                    this box does. The lines a failure is written on are tinted,
                    so the eye lands on them first (see looksFailed). */}
                <ScrollView horizontal contentContainerStyle={{ paddingVertical: SPACE.md }} style={{
                  backgroundColor: C.bg2, borderRadius: RADIUS.lg,
                  borderWidth: 1, borderColor: C.border,
                }}>
                  <Text selectable style={{ fontSize: 11.5, fontFamily: MONO, lineHeight: 20 }}>
                    {shown.map((line, i) => (
                      <Text
                        key={i}
                        style={looksFailed(line)
                          ? { color: C.error, backgroundColor: tint(C.error, 0.14) }
                          : { color: C.text2 }}
                      >{`  ${line}  `}{i < shown.length - 1 ? "\n" : ""}</Text>
                    ))}
                  </Text>
                </ScrollView>
              </>
            ) : null}
          </ScrollView>
          <View style={{
            paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, paddingBottom: SPACE.lg,
            borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg2,
          }}>
            <View style={{ flexDirection: "row", gap: SPACE.sm }}>
              <Btn label="All checks" style={{ flex: 1 }} onPress={() => { setOpen(null); setLog(null); setLogErr(null); }} />
              {mayWrite && standingOf(open).standing === "failed" ? (
                <Btn label="Ask Claude about it" tone="primary" style={{ flex: 1.4 }} onPress={askClaude} />
              ) : null}
            </View>
          </View>
        </>
      ) : (
        <ScrollView contentContainerStyle={{ padding: SPACE.lg, paddingTop: SPACE.sm, gap: SPACE.xs, paddingBottom: SPACE.xl }}>
          {error ? <Card><Label text="Cannot read them" /><Note tone="bad">{error}</Note></Card> : null}
          {jobs === null && !error ? (
            <View style={{ padding: SPACE.xl }}><ActivityIndicator color={C.text3} /></View>
          ) : null}
          {jobs && !jobs.length ? (
            <Card>
              <Note>
                No jobs are attached to this pull request. A check reported by something that is
                not GitHub Actions has no log here — it is on GitHub.
              </Note>
            </Card>
          ) : null}

          {ordered.length ? (
            <View style={{ flexDirection: "row", gap: SPACE.sm, flexWrap: "wrap", paddingHorizontal: SPACE.xs, paddingBottom: SPACE.xs }}>
              {bands.failed.length ? <Chip label={`${bands.failed.length} failed`} tone="bad" /> : null}
              {bands.running.length ? <Chip label={`${bands.running.length} running`} tone="warn" /> : null}
              {bands.fine.length ? <Chip label={`${bands.fine.length} passed`} tone="good" /> : null}
            </View>
          ) : null}

          {bands.failed.length ? (
            <>
              <GroupTitle text="Failed" />
              <Group inset={52}>{bands.failed.map(jobRow)}</Group>
            </>
          ) : null}
          {bands.running.length ? (
            <>
              <GroupTitle text="Running" />
              <Group inset={52}>{bands.running.map(jobRow)}</Group>
            </>
          ) : null}
          {bands.fine.length ? (
            <>
              <GroupTitle text="Passed" />
              {/* Folded: somebody on this screen came for the red one, and forty
                  green rows between them and it are forty rows of nothing. */}
              <Group inset={52}>
                {allFine || bands.fine.length <= 3 ? bands.fine.map(jobRow) : (
                  <Row
                    title={`${bands.fine.length} checks passed`}
                    sub={`${bands.fine.slice(0, 3).map((j) => j.name).join(", ")}${bands.fine.length > 3 ? ` and ${bands.fine.length - 3} more` : ""}`}
                    lead={<Glyph name="ok_circle" color={C.success} size={22} weight={1.9} />}
                    chevron
                    onPress={() => setAllFine(true)}
                  />
                )}
              </Group>
            </>
          ) : null}
          {ordered.length ? (
            <View style={{ paddingHorizontal: SPACE.xs, paddingTop: SPACE.md }}>
              <Note>Logs are shown for GitHub Actions jobs. Checks from other services open on GitHub.</Note>
            </View>
          ) : null}
        </ScrollView>
      )}
      {!open && mayWrite && bands.failed.length ? (
        <View style={{
          paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, paddingBottom: SPACE.lg,
          borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg2,
        }}>
          <Btn label={bands.failed.length === 1 ? "Ask Claude about it" : "Ask Claude about them"} tone="primary" onPress={askClaude} />
        </View>
      ) : null}
    </View>
  );
}
