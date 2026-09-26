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
import { DEP_LOOK, brokenHeading, depNeedsAttention, depSummary, depTone, type DepTone } from "../src/model/depLook.ts";
import { useAgentglass } from "../src/state/host-context.tsx";
import { useComputer } from "../src/state/use-computer.ts";
import { usePaletteTick } from "../src/state/use-palette.ts";
import { Chip, CommandLine, Group, GroupTitle, Note, Row, TAP } from "../src/ui.tsx";
import { Glyph, type GlyphName } from "../src/nav/glyphs.tsx";
import { C, MONO, RADIUS, SPACE, T, tint } from "../src/theme.ts";

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
  const computer = useComputer(host);

  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /* Which rows are expanded is each row's own: a required tool that is broken
     starts open — somebody on this screen is here because something is broken,
     and making them tap to find out which is the failure it exists to fix. */

  const load = useCallback(async (): Promise<void> => {
    if (!host) return;
    setBusy(true);
    const got = await ask<Answer>(host, "/dependencies");
    setBusy(false);
    if (!got.ok) { setError(got.error); return; }
    setError(null);
    setAnswer(got.value);
  }, [host]);

  useEffect(() => { void load(); }, [load]);

  const deps = answer?.deps ?? [];
  const broken = deps.filter((d) => depNeedsAttention(d.status));
  const fine = deps.filter((d) => !depNeedsAttention(d.status));
  const [allFine, setAllFine] = useState(false);
  const summary = depSummary(deps);
  const summaryInk = summary.tone === "good" ? C.success : summary.tone === "mute" ? C.text3 : C.error;
  const heading = brokenHeading(broken);

  if (!host) return null;

  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.lg, paddingTop: SPACE.xs, gap: SPACE.xs, paddingBottom: SPACE.xl }}>
      <Stack.Screen
        options={{
          title: "Troubleshooting",
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Check again"
              accessibilityState={{ busy }}
              onPress={() => { void load(); }}
              style={({ pressed }) => ({
                width: TAP, height: TAP, borderRadius: TAP / 2, alignItems: "center", justifyContent: "center",
                backgroundColor: pressed ? C.bg3 : "transparent",
              })}
            >
              {busy ? <ActivityIndicator color={C.text2} /> : <Glyph name="refresh" color={C.text2} size={22} />}
            </Pressable>
          ),
        }}
      />

      {/*
        The unreachable computer first, and alone. It is the one failure this
        screen can be reached during and cannot diagnose, so it says what to
        check rather than guessing — and nothing under it can be read.
      */}
      {live !== "open" ? (
        <Banner ink={C.error} glyph="offline" title={`Can't reach ${computer}`}>
          Nothing below can be read while the computer is unreachable. Check that agentglass is
          running on it, and that this phone is on the same network or the same tailnet.
        </Banner>
      ) : answer && deps.length ? (
        /* The answer to what somebody arrives with — is anything I need
           missing — said once, before the list it was counted from. */
        <Banner
          ink={summaryInk}
          glyph={summary.tone === "good" ? "ok_circle" : summary.tone === "mute" ? "info" : "alert"}
          title={summary.title}
        >{summary.sub}</Banner>
      ) : null}

      {error ? <Note tone="bad">{error}</Note> : null}
      {!answer && !error && live === "open" ? <ActivityIndicator color={C.text3} /> : null}
      {answer && !deps.length ? <Note>That computer reported nothing to check.</Note> : null}

      {broken.length ? (
        <>
          <GroupTitle text={heading ?? "Needs attention"} />
          <Group>
            {/* Required first, and only those start open: measured on a
                machine missing fourteen optional tools, opening every row was
                a wall of install lines over the one that mattered. */}
            {[...broken].sort((a, b) => Number(b.required) - Number(a.required)).map((dep) => (
              <Tool key={dep.id} dep={dep} open={dep.required} />
            ))}
          </Group>
        </>
      ) : null}

      {fine.length ? (
        <>
          <GroupTitle text="Found" />
          {/* Collapsed to the first few. Twenty tools with a paragraph each is a
              wall, and the ones that matter are the broken ones above. */}
          <Group inset={36}>
            {(allFine ? fine : fine.slice(0, 4)).map((dep) => <Tool key={dep.id} dep={dep} />)}
            {!allFine && fine.length > 4 ? (
              <Row title={`${fine.length - 4} more`} lead={<View style={{ width: 8 }} />} chevron onPress={() => setAllFine(true)} />
            ) : null}
          </Group>
        </>
      ) : null}

      {answer?.manager ? (
        <View style={{ paddingHorizontal: SPACE.xs, paddingTop: SPACE.sm }}>
          <Note>
            Install commands are for {answer.manager} on {answer.platform}. Run them on the computer; this
            phone deliberately cannot.
          </Note>
        </View>
      ) : null}

      <GroupTitle text="This phone" />
      <Group>
        <View style={{ paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm }}>
          <Line name="Computer" value={computer} />
          <Line name="This phone" value={host.label} />
          <Line
            name="Live connection"
            value={live === "open" ? "connected" : live === "connecting" ? "connecting…" : "offline"}
            ink={live === "open" ? C.success : live === "connecting" ? C.warning : C.error}
          />
          <Line name="Address" value={host.origin} mono />
          <Line name="Allowed to" value={host.scope} />
          <Line name="Last answer" value={fleet.at ? new Date(fleet.at).toLocaleTimeString() : "never"} />
          {fleet.error ? <Note tone="bad">{fleet.error}</Note> : null}
        </View>
      </Group>
    </ScrollView>
  );
}

/** A tinted box with a mark, a line and a sentence: the screen's verdict. */
function Banner({ ink, glyph, title, children }: {
  ink: string;
  glyph: GlyphName;
  title: string;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <View
      accessibilityRole="summary"
      style={{
        flexDirection: "row", gap: 14, alignItems: "center", padding: SPACE.lg,
        borderRadius: RADIUS.lg, backgroundColor: tint(ink, 0.14),
      }}
    >
      <Glyph name={glyph} color={ink} size={28} weight={1.9} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: C.text, fontSize: 16, fontWeight: "600" }}>{title}</Text>
        <Text style={{ color: C.text2, fontSize: 13, lineHeight: 18 }}>{children}</Text>
      </View>
    </View>
  );
}

/** One tool. Open, it says why this app cares, what is wrong and the line
 *  that installs it; closed, it is a dot, a name and a version. */
function Tool({ dep, open: startOpen }: {
  dep: Dep;
  open?: boolean;
}): React.ReactNode {
  const [open, setOpen] = useState(!!startOpen);
  const look = DEP_LOOK[dep.status] ?? DEP_LOOK.attention;
  const ink = INK[depTone(dep)]();
  return (
    <Pressable
      onPress={() => setOpen((v) => !v)}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={`${dep.title}, ${look.word}`}
      style={({ pressed }) => ({
        paddingHorizontal: SPACE.lg, paddingVertical: SPACE.md, gap: SPACE.sm, minHeight: 48,
        justifyContent: "center", backgroundColor: pressed ? C.bg3 : "transparent",
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.md }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: ink }} />
        <Text numberOfLines={1} style={{ color: C.text, fontSize: 15, fontWeight: "500", flexShrink: 1 }}>{dep.title}</Text>
        {dep.required ? null : <Chip label="optional" />}
        <View style={{ flex: 1 }} />
        <Text numberOfLines={1} style={{
          color: dep.status === "ok" ? C.text3 : ink, fontSize: 13, fontFamily: dep.status === "ok" ? MONO : undefined,
          fontWeight: dep.status === "ok" ? "400" : "500", flexShrink: 1,
        }}>
          {dep.status === "ok" && dep.detail ? dep.detail : look.word}
        </Text>
      </View>

      {open ? (
        <View style={{ gap: SPACE.sm, paddingLeft: 20 }}>
          {/* The desktop's own sentence, not a rewrite. Two places describing
              one dependency in two ways is how they drift. */}
          <Text style={{ color: C.text3, fontSize: 13, lineHeight: 18 }}>{dep.what}</Text>
          {dep.status !== "ok" && dep.detail ? (
            // "not used on linux" is a fact, not a warning; it keeps the row's
            // own ink rather than borrowing the amber.
            <Text style={{ color: depTone(dep) === "mute" ? ink : C.warning, fontSize: T.small }}>{dep.detail}</Text>
          ) : null}
          {dep.install ? (
            <CommandLine line={dep.install} />
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

/** A name and a value on one line. Its own component because the block above
 *  has six of them and the alignment is the point. */
function Line({ name, value, mono, ink }: {
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
