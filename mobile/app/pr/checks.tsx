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
import { Stack, useLocalSearchParams } from "expo-router";
import type { PrCheckJob } from "../../../shared/types.ts";
import { ask } from "../../src/lib/api.ts";
import { byUrgency, standingOf, tailOf } from "../../src/model/checkJobs.ts";
import { useAgentglass } from "../../src/state/host-context.tsx";
import { usePaletteTick } from "../../src/state/use-palette.ts";
import { Btn, Card, Label, Note, TAP } from "../../src/ui.tsx";
import { C, MONO, RADIUS, SPACE, T } from "../../src/theme.ts";

/** How many lines of the tail to open on.
 *
 *  120 is about four screens on a phone, which is enough to hold a stack trace
 *  and the command that produced it without being a scroll of its own. */
const TAIL = 120;

/** The ink for a standing. The words and the ordering are in
 *  src/model/checkJobs.ts, where they are tested; what stays here is the
 *  colour, which is the one part a test could not check anyway. */
const INK = { failed: C.error, running: C.warning, fine: C.success } as const;

export default function ChecksScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host } = useAgentglass();
  const { number, root } = useLocalSearchParams<{ number: string; root: string }>();

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

  const tail = useMemo(() => tailOf(log?.text ?? "", TAIL), [log]);
  const shown = whole ? (log?.text ?? "").replace(/\s+$/, "").split("\n") : tail.lines;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Stack.Screen options={{ title: open ? open.name : `Checks · #${number}` }} />

      {open ? (
        <>
          <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md }}>
            {logErr ? <Card><Label text="Cannot read it" /><Note tone="bad">{logErr}</Note></Card> : null}
            {!log && !logErr ? (
              <View style={{ padding: SPACE.xl }}><ActivityIndicator color={C.text3} /></View>
            ) : null}

            {log && !tail.total ? <Card><Note>This job wrote nothing.</Note></Card> : null}

            {shown.length ? (
              <>
                {!whole && tail.total > TAIL ? (
                  <Pressable
                    onPress={() => setWhole(true)}
                    style={{ minHeight: TAP, justifyContent: "center" }}
                  >
                    <Text style={{ color: C.primary, fontSize: T.small, fontWeight: "600" }}>
                      Show all {tail.total} lines — the last {TAIL} are below
                    </Text>
                  </Pressable>
                ) : null}
                {log?.truncated ? (
                  <Note>GitHub cut this log short; what is here is what it returned.</Note>
                ) : null}
                {/* Its own horizontal scroller. A log line is as long as it is
                    and wrapping a stack trace at 393 points makes it unreadable
                    in a different way — so the page never scrolls sideways and
                    this box does. */}
                <ScrollView horizontal contentContainerStyle={{ padding: SPACE.md }} style={{
                  backgroundColor: C.bg2, borderRadius: RADIUS.md,
                  borderWidth: 1, borderColor: C.border,
                }}>
                  <Text selectable style={{ color: C.text2, fontSize: 10.5, fontFamily: MONO, lineHeight: 16 }}>
                    {shown.join("\n")}
                  </Text>
                </ScrollView>
              </>
            ) : null}
          </ScrollView>
          <View style={{
            paddingHorizontal: SPACE.lg, paddingTop: SPACE.sm, paddingBottom: SPACE.lg,
            borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg2,
          }}>
            <Btn label="‹ Every job" onPress={() => { setOpen(null); setLog(null); setLogErr(null); }} />
          </View>
        </>
      ) : (
        <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md }}>
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
            <Card style={{ gap: SPACE.xs, padding: SPACE.md }}>
              {ordered.map((job) => {
                const { standing, word } = standingOf(job);
                return (
                  <Pressable
                    key={job.id}
                    accessibilityRole="button"
                    onPress={() => { void read(job); }}
                    style={({ pressed }) => ({
                      flexDirection: "row", alignItems: "center", gap: SPACE.sm,
                      minHeight: TAP, opacity: pressed ? 0.6 : 1,
                    })}
                  >
                    <View style={{
                      width: 8, height: 8, borderRadius: 4,
                      backgroundColor: standing === "running" ? "transparent" : INK[standing],
                      borderWidth: standing === "running" ? 1 : 0, borderColor: C.text4,
                    }} />
                    <Text numberOfLines={1} style={{ color: C.text2, fontSize: T.small, flex: 1 }}>
                      {job.name}
                    </Text>
                    <Text style={{ color: INK[standing], fontSize: T.eyebrow }}>{word}</Text>
                  </Pressable>
                );
              })}
            </Card>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}
