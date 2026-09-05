/*
 * Why something is not working, from the phone.
 *
 * ── the gap this fills ───────────────────────────────────────────────────
 * Half the screens in this app have a red note on them that names a missing
 * tool: "the GitHub CLI (gh) is not installed", "tmux has to have a client
 * attached", "ClickUp is not connected". Each is correct and each is the end
 * of the road — the phone cannot install anything, and until now it could not
 * even say what ELSE was missing, so the answer to "why is half of this grey"
 * meant walking to the computer to find out.
 *
 * `/dependencies` is the same answer the desktop's own panel draws, and it has
 * been a GET the whole time. This screen is that list, plus the two facts the
 * phone alone knows: whether it can reach the machine at all, and what it was
 * granted when it paired.
 *
 * ── it does not offer to fix anything ────────────────────────────────────
 * Deliberately. Every remedy here is a package install on somebody else's
 * computer, and a phone that could run those would be a phone that can run
 * arbitrary commands as whoever owns the machine — which is precisely the
 * grant this app spends its scope rules refusing. The install line is SHOWN so
 * it can be read out or copied; running it is done where the machine is.
 *
 * ── read-only, so it works when nothing else does ────────────────────────
 * Both reads are GETs, which is the point: the moment somebody wants this
 * screen is the moment something is refusing them, and a diagnostic that
 * needed `full` would be unavailable exactly when a `read` phone is trying to
 * work out why it is a `read` phone.
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { Stack } from "expo-router";
import type { DepStatus } from "../../shared/deps.ts";
import { ask } from "../src/lib/api.ts";
import { DEP_LOOK, depNeedsAttention, type DepTone } from "../src/model/depLook.ts";
import { useAgentglass } from "../src/state/host-context.tsx";
import { usePaletteTick } from "../src/state/use-palette.ts";
import { Btn, Note, Section, TAP, groupEdge } from "../src/ui.tsx";
import { C, MONO, RADIUS, SPACE, T } from "../src/theme.ts";

/** One row of `/dependencies`. Declared here rather than in shared/ — it is
 *  this route's reply, and the desktop reads its own copy of the same shape. */
interface Dep {
  id: string;
  title: string;
  bin: string;
  /** Why this app cares. The sentence the desktop shows, not a rewrite. */
  what: string;
  required: boolean;
  /** The server's union, imported: the local copy was one entry short of it
   *  (`unsupported`) and the table below threw on the missing key. */
  status: DepStatus;
  /** A version, or what is wrong with the one that is there. */
  detail?: string;
  /** The command that would install it, for this machine's package manager. */
  install?: string;
  url?: string;
}

interface Answer { deps?: Dep[]; manager?: string; platform?: string }

/** The tone `src/model/depLook.ts` assigns, in this palette. Resolved here and
 *  not there because the palette is the screen's — see usePaletteTick. */
const INK: Record<DepTone, () => string> = {
  good: () => C.success,
  warn: () => C.warning,
  bad: () => C.error,
  mute: () => C.text4,
};

export default function TroubleshootScreen(): React.ReactNode {
  usePaletteTick(); // a scene repaints only if it asks — see use-palette.ts
  const { host, live, fleet } = useAgentglass();

  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Which rows are expanded. Collapsed by default: twenty tools with a
   *  paragraph each is a wall, and the ones that matter are the broken ones —
   *  which is why those are open from the start. */
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async (): Promise<void> => {
    if (!host) return;
    setBusy(true);
    const got = await ask<Answer>(host, "/dependencies");
    setBusy(false);
    if (!got.ok) { setError(got.error); return; }
    setError(null);
    setAnswer(got.value);
    // Anything not fine starts expanded. Somebody on this screen is here
    // because something is broken, and making them tap to find out which is
    // the whole failure it exists to fix.
    setOpen(new Set((got.value.deps ?? []).filter((d) => depNeedsAttention(d.status)).map((d) => d.id)));
  }, [host]);

  useEffect(() => { void load(); }, [load]);

  const deps = answer?.deps ?? [];
  const broken = deps.filter((d) => depNeedsAttention(d.status));

  if (!host) return null;

  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.lg, paddingBottom: SPACE.xl }}>
      <Stack.Screen options={{ title: "Troubleshooting" }} />

      <Section
        label="This phone"
        note="What it can reach, and what it was allowed to do when it paired."
      >
        <Row name="Computer" value={host.label} />
        <Row
          name="Live connection"
          value={live === "open" ? "connected" : live === "connecting" ? "connecting…" : "offline"}
          ink={live === "open" ? C.success : live === "connecting" ? C.warning : C.error}
        />
        <Row name="Address" value={host.origin} mono />
        <Row name="Allowed to" value={host.scope} />
        <Row
          name="Last answer"
          value={fleet.at ? new Date(fleet.at).toLocaleTimeString() : "never"}
        />
        {fleet.error ? <Note tone="bad">{fleet.error}</Note> : null}
        {live !== "open" ? (
          <Note tone="bad">
            {/* The one failure this screen can be reached during and cannot
                diagnose, so it says what to check rather than guessing. */}
            Nothing below can be read while the computer is unreachable. Check that agentglass is
            running on it, and that this phone is on the same network or the same tailnet.
          </Note>
        ) : null}
      </Section>

      <Section
        label="On the computer"
        note={
          broken.length === 0 && deps.length
            ? "Everything this app shells out to is installed."
            : "What is missing here is what is greyed out or refusing on the other screens."
        }
      >
        {error ? <Note tone="bad">{error}</Note> : null}
        {!answer && !error ? <ActivityIndicator color={C.text3} /> : null}
        {answer && !deps.length ? <Note>That computer reported nothing to check.</Note> : null}

        {deps.map((dep, i) => {
          const look = DEP_LOOK[dep.status] ?? DEP_LOOK.attention;
          const ink = INK[look.tone]();
          const shown = open.has(dep.id);
          return (
            <Pressable
              key={dep.id}
              onPress={() => setOpen((was) => {
                const next = new Set(was);
                if (next.has(dep.id)) next.delete(dep.id); else next.add(dep.id);
                return next;
              })}
              accessibilityRole="button"
              accessibilityLabel={`${dep.title}, ${look.word}`}
              style={[
                groupEdge(i === 0, i === deps.length - 1),
                {
                  paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, gap: SPACE.xs,
                  // The tap target is the row itself, so the floor belongs here
                  // rather than on the line inside it — which is what
                  // test/tap-floor.test.ts caught when it was the other way
                  // round.
                  minHeight: TAP,
                },
              ]}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, flex: 1 }}>
                <View style={{
                  width: 8, height: 8, borderRadius: 4, backgroundColor: ink,
                }} />
                <Text numberOfLines={1} style={{ color: C.text, fontSize: T.small, flex: 1 }}>
                  {dep.title}
                  {dep.required ? null : (
                    <Text style={{ color: C.text4, fontSize: T.eyebrow }}>  optional</Text>
                  )}
                </Text>
                <Text style={{ color: ink, fontSize: T.eyebrow }}>
                  {dep.status === "ok" && dep.detail ? dep.detail : look.word}
                </Text>
              </View>

              {shown ? (
                <View style={{ gap: SPACE.xs, paddingBottom: SPACE.xs }}>
                  {/* The desktop's own sentence, not a rewrite. Two places
                      describing one dependency in two ways is how they drift. */}
                  <Text style={{ color: C.text3, fontSize: T.small, lineHeight: 18 }}>{dep.what}</Text>
                  {dep.status !== "ok" && dep.detail ? (
                    // "not used on linux" is a fact, not a warning; it keeps
                    // the row's own ink rather than borrowing the amber.
                    <Text style={{ color: look.tone === "mute" ? ink : C.warning, fontSize: T.eyebrow }}>{dep.detail}</Text>
                  ) : null}
                  {dep.install ? (
                    <View style={{
                      backgroundColor: C.bg, borderRadius: RADIUS.sm,
                      borderWidth: 1, borderColor: C.border, padding: SPACE.sm,
                    }}>
                      {/* Selectable and not runnable. Every remedy here is a
                          package install on somebody else's computer, and a
                          phone that could run one would be a phone that can run
                          anything as whoever owns it. */}
                      <Text selectable style={{ color: C.text2, fontSize: 11, fontFamily: MONO }}>
                        {dep.install}
                      </Text>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </Pressable>
          );
        })}

        {answer?.manager ? (
          <Note>
            Those lines are for {answer.manager} on {answer.platform}. Run them where the computer
            is — this phone deliberately cannot.
          </Note>
        ) : null}
      </Section>

      <Section label="Ask again" note="Re-reads what is installed on that computer.">
        <Btn label="Check again" busy={busy} onPress={() => { void load(); }} />
      </Section>
    </ScrollView>
  );
}

/** A name and a value on one line. Its own component because the block above
 *  has five of them and the alignment is the point. */
function Row({ name, value, mono, ink }: {
  name: string;
  value: string;
  mono?: boolean;
  ink?: string;
}): React.ReactNode {
  return (
    /* No minimum height: this is not a tap target, and a floor on a line of
       text is a floor the lock in test/tap-floor.test.ts has to be argued out
       of for nothing. The type sets the height. */
    <View style={{
      flexDirection: "row", justifyContent: "space-between",
      gap: SPACE.md, alignItems: "center", paddingVertical: 2,
    }}>
      <Text style={{ color: C.text3, fontSize: T.small }}>{name}</Text>
      <Text
        numberOfLines={1}
        style={{
          color: ink ?? C.text2, fontSize: T.small,
          fontFamily: mono ? MONO : undefined, flexShrink: 1, textAlign: "right",
        }}
      >{value}</Text>
    </View>
  );
}
