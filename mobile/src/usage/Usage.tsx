/*
 * What is left of the plan: a chip on every header, and the sheet it opens.
 *
 * ── why a chip, and why everywhere ───────────────────────────────────────
 * It was a card at the bottom of Settings. The question it answers — can I
 * start a long one — is asked right before starting one, from wherever you
 * are, and Settings is where nobody is at that moment. A number three taps
 * away was a number nobody looked at.
 *
 * The chip is one value: what is left of the window closest to running out,
 * across every provider. That is what actually stops a long turn — the
 * tightest window, not the average of them — and a ring around it says the
 * same thing to somebody who does not read the digits. The sheet has the rest:
 * every window, when each one resets, and how old the reading is.
 *
 * ── what it never does ───────────────────────────────────────────────────
 * Draw a number it does not have. Until an answer lands, and on a computer
 * whose agents report no quota, there is no chip at all. A phone that could
 * not reach the computer keeps the last reading (see use-usage.ts) and the
 * sheet dates it; an empty ring there would read as a spent plan, which is the
 * one error that would change what somebody does.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import type { QuotaWindow } from "../../../shared/types.ts";
import {
  accountHeading, ageLabel, planState, providerCount, quotaTone, remainingOf, resetLabel, tightestWindow, windowName,
} from "../model/quota.ts";
import { useUsage } from "../state/use-usage.ts";
import { C, RADIUS, SPACE, T, type Palette } from "../theme.ts";
import { Btn, Note, Sheet, TAP } from "../ui.tsx";

/** The tone of what is LEFT, from `quotaTone` over what was used: under 15%
 *  left is red and under 40% is amber, which are the same two lines. */
function toneOf(K: Palette, usedPercent: number): string {
  const tone = quotaTone(usedPercent);
  return tone === "crit" ? K.error : tone === "bad" ? K.warning : K.success;
}

function Ring({ left, color, track, size = 16, stroke = 2.4 }: {
  left: number;
  color: string;
  track: string;
  size?: number;
  stroke?: number;
}): React.ReactNode {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const half = size / 2;
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Circle cx={half} cy={half} r={r} fill="none" stroke={track} strokeWidth={stroke} />
      {left > 0 ? (
        <Circle
          cx={half} cy={half} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={`${(c * left) / 100} ${c}`}
          transform={`rotate(-90 ${half} ${half})`}
        />
      ) : null}
    </Svg>
  );
}

/** A clock that moves once a minute, which is the grain of every label here. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The chip. `colors` is the palette of the header it sits in — the terminal's
 * header is the desk's, not the phone's.
 */
export function UsageChip({ colors = C }: { colors?: Palette }): React.ReactNode {
  const K = colors;
  const { rows } = useUsage();
  const [open, setOpen] = useState(false);
  const top = tightestWindow(rows);
  if (!top) return null;
  const left = remainingOf(top.window);
  const tone = toneOf(K, top.window.usedPercent);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Usage: ${left}% of the ${windowName(top.window.label)} window left. Opens usage.`}
        onPress={() => setOpen(true)}
        hitSlop={{ top: 6, bottom: 6 }}
        style={({ pressed }) => ({
          flexDirection: "row", alignItems: "center", gap: 6,
          height: 32, paddingLeft: 9, paddingRight: 11, borderRadius: 16,
          backgroundColor: pressed ? K.bg4 : K.bg3, borderWidth: 1, borderColor: K.border,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        })}
      >
        <Ring left={left} color={tone} track={K.border2} />
        <Text style={{ color: K.text, fontSize: T.small, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
          {left}%
        </Text>
        <Text style={{ color: K.text3, fontSize: T.small }}>{top.window.label}</Text>
      </Pressable>
      <UsageSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** One window, as a bar of what is LEFT of it.
 *
 *  Left, not used, and the direction is the point: the question anybody has in
 *  front of this number is "can I start a long one", and a bar that fills up as
 *  you work answers the opposite one. A window with nothing left draws no bar at
 *  all, because the single thing this must never do is overstate what is there. */
function Meter({ label, window: w, now }: { label: string; window: QuotaWindow; now: number }): React.ReactNode {
  const left = remainingOf(w);
  const tone = toneOf(C, w.usedPercent);
  const resets = resetLabel(w.resetsAt, now);
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`${label}: ${left}% left${resets ? `, resets ${resets}` : ""}`}
      style={{ gap: SPACE.sm, paddingVertical: SPACE.md }}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline" }}>
        <Text style={{ color: C.text, fontSize: T.body, fontWeight: "500", flex: 1 }} numberOfLines={1}>{label}</Text>
        <Text style={{ color: tone, fontSize: T.body, fontWeight: "600" }}>{left}% left</Text>
      </View>
      <View style={{ height: 8, borderRadius: 4, backgroundColor: C.bg4, overflow: "hidden" }}>
        {left > 0 ? <View style={{ width: `${left}%`, height: "100%", borderRadius: 4, backgroundColor: tone }} /> : null}
      </View>
      {resets ? <Text style={{ color: C.text3, fontSize: T.small }}>Resets {resets}</Text> : null}
    </View>
  );
}

/**
 * Every window, the tightest stated once at full size.
 *
 * Four states, and none of them collapsed. The expensive one is "could not
 * reach the computer", which must never be drawn as an empty bar: a phone off
 * the network would otherwise report the plan as spent. `planState` in
 * model/quota.ts is what keeps the four apart.
 */
export function UsageSheet({ open, onClose }: { open: boolean; onClose: () => void }): React.ReactNode {
  const { rows, loaded, error, reload } = useUsage();
  const now = useMinute();
  const state = planState(loaded, rows);
  const top = tightestWindow(rows);
  /* Only worth naming the provider on each bar when more than one is
     reporting. On a machine with Claude alone, "Claude 5h" on every row is one
     word of signal and one of furniture. Two logins of one provider are still
     one provider: the heading over each login's bars tells them apart. */
  const available = (rows ?? []).filter((r) => r.available);
  const several = providerCount(available) > 1;
  const age = top ? ageLabel(top.observedAt, now) : "";

  return (
    <Sheet open={open} onClose={onClose} title="Usage">
      <View style={{ gap: SPACE.sm, paddingBottom: SPACE.md }}>
        {state === "loading" ? <Note>Asking the computer…</Note> : null}
        {state === "unreachable" ? (
          <Note tone="bad">{error ?? "The computer did not answer about the plan."}</Note>
        ) : null}
        {state === "empty" ? <Note>No agent on this computer reports a plan quota.</Note> : null}

        {top ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.md, paddingVertical: SPACE.xs }}>
            <Text style={{
              color: toneOf(C, top.window.usedPercent), fontSize: 44, fontWeight: "600", lineHeight: 50,
            }}>{remainingOf(top.window)}%</Text>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: C.text, fontSize: T.body, fontWeight: "500" }}>
                left in the {windowName(top.window.label).toLowerCase()} window
              </Text>
              <Text style={{ color: C.text3, fontSize: T.small }}>
                {[
                  several ? top.provider : "",
                  top.window.resetsAt ? `resets ${resetLabel(top.window.resetsAt, now)}` : "",
                  // The age belongs beside the number it qualifies. The computer
                  // holds an Anthropic reading for fifteen minutes and keeps
                  // serving the last good one for up to a day while that endpoint
                  // rate-limits, so a stale percentage looks exactly like a live
                  // one unless it says so.
                  age,
                ].filter(Boolean).join(" · ")}
              </Text>
            </View>
          </View>
        ) : null}

        {available.length ? (
          <View style={{
            backgroundColor: C.bg3, borderRadius: RADIUS.lg, paddingHorizontal: SPACE.lg,
          }}>
            {available.map((row, n) => {
              const heading = accountHeading(row);
              return (
                <View
                  key={`${row.provider}:${row.account?.label ?? ""}`}
                  style={n > 0 ? { borderTopWidth: 1, borderTopColor: C.border } : undefined}
                >
                  {/* Read-only on purpose: switching a login is the desk's.
                      "active" is a word, so it reads without the colour. */}
                  {heading ? (
                    <View style={{ flexDirection: "row", alignItems: "baseline", paddingTop: SPACE.md }}>
                      <Text style={{ color: C.text2, fontSize: T.small, fontWeight: "600", flex: 1 }} numberOfLines={1}>{heading}</Text>
                      {row.account?.active ? <Text style={{ color: C.text3, fontSize: T.small }}>active</Text> : null}
                    </View>
                  ) : null}
                  {row.windows.map((w, i) => (
                    <View key={w.label} style={i > 0 ? { borderTopWidth: 1, borderTopColor: C.border } : undefined}>
                      <Meter
                        label={several ? `${row.label} · ${windowName(w.label)}` : windowName(w.label)}
                        window={w}
                        now={now}
                      />
                    </View>
                  ))}
                </View>
              );
            })}
          </View>
        ) : null}

        {top ? (
          <Text style={{ color: C.text3, fontSize: T.small, paddingTop: SPACE.xs }}>
            The chip on every header is the tightest window. It turns amber under 40% left and red under 15%.
          </Text>
        ) : null}

        {/* Only on the failure. The poll comes back by itself every five minutes
            and again on the way into the app, so a button here is for the one
            case where waiting five minutes to find out whether the wifi came
            back is the wrong offer. */}
        {state === "unreachable" ? <Btn label="Ask again" onPress={reload} style={{ minHeight: TAP }} /> : null}
      </View>
    </Sheet>
  );
}
